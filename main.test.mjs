import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  GUARD_HEARTBEAT_MS,
  LOCK_HELD_RETRIES,
  TICK_WINDOW_MS,
  claudePluginDirectory,
  codexPluginDirectory,
  createDispatcher,
  defaultGuardDirectory,
  guardKey,
  mainCheckout,
  receiptLine,
  splitCommand,
  wakesDispatcher
} from './main.mjs'

/** A clock whose timers fire only when the test moves time forward. */
function fakeClock() {
  let now = 1_000_000
  let next = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++next
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    /** Moves time to `now + ms`, firing each timer due on the way in order. */
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    }
  }
}

/**
 * The synchronous fs calls the launch guard makes, against a map of files. `ops` records each
 * call in order; `fail(op, path)` may return an error for that call to throw.
 */
function fakeFs({ fail = () => null } = {}) {
  const files = new Map()
  const ops = []
  const check = (op, path) => {
    ops.push([op, path])
    const error = fail(op, path)
    if (error) throw error
  }
  return {
    files,
    ops,
    mkdirSync(path) {
      check('mkdir', path)
    },
    writeFileSync(path, data) {
      check('write', path)
      files.set(path, String(data))
    },
    renameSync(from, to) {
      check('rename', to)
      files.set(to, files.get(from))
      files.delete(from)
    },
    unlinkSync(path) {
      check('unlink', path)
      files.delete(path)
    },
    statSync(path, { throwIfNoEntry } = {}) {
      check('stat', path)
      if (files.has(path)) return { isFile: () => true }
      if (throwIfNoEntry === false) return undefined
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    /** The parsed JSON at `path`, after checking it is compact JSON and one newline. */
    record(path) {
      const text = files.get(path)
      assert.ok(text, `${path} was written`)
      assert.ok(text.endsWith('\n') && !text.slice(0, -1).includes('\n'), 'one line and a newline')
      assert.equal(text, `${JSON.stringify(JSON.parse(text))}\n`, 'compact JSON')
      return JSON.parse(text)
    }
  }
}

const REPO = '/work/acme'
const WORKTREE = '/work/acme-wt/feature'

function receipt(repo = REPO, extra = {}) {
  return {
    version: 1,
    runId: 'run-1',
    apply: true,
    exitStatus: 0,
    repos: [
      {
        path: repo,
        slug: 'acme/app',
        refused: null,
        actions: [{ stage: 'rearm', target: 'PR #4', reason: 'stopped on a usage limit' }],
        launches: [{ outcome: 'launched', action: 'rearm', target: 'PR #4', detail: 'ok' }],
        notifications: [],
        running: [],
        unplaced: [],
        ...extra
      }
    ]
  }
}

/**
 * A dispatcher against a fake Orca and a fake machine: `files` are the paths that exist,
 * `workspaces` what `workspace.created` or `workspace.list` would report. Every program run is
 * recorded; a tick waits for `release()` when `holdTicks` is set.
 */
function harness({
  files = [`${REPO}/.config/jig.yaml`, '/bin/bun', '/bin/claude', '/plugin/jig.ts'],
  list = null,
  setting = '',
  tickResult = () => ({ code: 0, stdout: JSON.stringify(receipt()), stderr: '' }),
  holdTicks = false,
  hostCall = null,
  fs = fakeFs(),
  guardDirectory = ''
} = {}) {
  const clock = fakeClock()
  const logs = []
  const notifications = []
  const runs = []
  const store = new Map()
  const pending = []
  const host = {
    has: (method) => list !== null && method === 'workspace.list',
    async call(method, params) {
      if (hostCall) {
        const answered = await hostCall(method, params)
        if (answered !== undefined) return answered
      }
      if (method === 'notifications.show') {
        notifications.push(params)
        return { delivered: true }
      }
      if (method === 'storage.get') return { value: store.get(params.key) ?? null }
      if (method === 'storage.set') {
        store.set(params.key, params.value)
        return { ok: true }
      }
      if (method === 'storage.keys') return { keys: [...store.keys()] }
      if (method === 'settings.get') return { settings: { jigCommand: setting, guardDirectory } }
      if (method === 'workspace.list') return { workspaces: list, truncated: false }
      throw Object.assign(new Error(`unexpected ${method}`), { code: 'unknown_method' })
    }
  }
  async function run(argv) {
    runs.push(argv)
    if (argv[0] === 'git' && argv[3] === 'worktree') {
      const path = argv[2]
      if (path === REPO || path === WORKTREE)
        return {
          code: 0,
          stdout: `worktree ${REPO}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD def\n`,
          stderr: ''
        }
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
    }
    if (argv[1] === 'plugin' && argv[2] === 'list')
      return {
        code: 0,
        stdout: JSON.stringify([{ id: 'jig@jig', scope: 'user', installPath: '/plugin' }]),
        stderr: ''
      }
    if (argv.includes('dispatch')) {
      if (holdTicks) await new Promise((resolve) => pending.push(resolve))
      return tickResult(argv)
    }
    throw new Error(`unexpected program ${argv.join(' ')}`)
  }
  const dispatcher = createDispatcher({
    host,
    log: (message) => logs.push(message),
    run,
    exists: (path) => files.includes(path),
    fs,
    clock,
    env: { PATH: '/bin' },
    platform: 'linux',
    home: '/home/me',
    hostName: 'laptop',
    pid: 4242,
    pluginVersion: '0.2.0'
  })
  const ticks = () => runs.filter((argv) => argv.includes('dispatch'))
  return {
    dispatcher,
    clock,
    logs,
    notifications,
    runs,
    store,
    ticks,
    fs,
    /** Lets the oldest held tick finish. */
    release: () => pending.shift()?.(),
    settle: () => dispatcher.settled()
  }
}

async function created(h, id = 'repo-1::' + REPO, path = REPO) {
  await h.dispatcher.onWorkspaceCreated({ workspaceId: id, kind: 'worktree', path, branch: 'main' })
}

function status(state, extra = {}) {
  return { workspaceId: 'repo-1::' + REPO, paneKey: 'tab:1', state, receivedAt: 1, ...extra }
}

describe('the state filter', () => {
  test('waiting, blocked and done wake the dispatcher; working does not', () => {
    for (const state of ['waiting', 'blocked', 'done']) assert.equal(wakesDispatcher({ state }), true)
    assert.equal(wakesDispatcher({ state: 'working' }), false)
    assert.equal(wakesDispatcher(null), false)
  })

  test("the main agent's state counts as well", () => {
    assert.equal(wakesDispatcher({ state: 'working', mainAgent: { state: 'done' } }), true)
  })

  test('a working agent starts no tick', async () => {
    const h = harness()
    await created(h)
    await h.dispatcher.onAgentStatusChanged(status('working'))
    await h.settle()
    assert.equal(h.ticks().length, 0)
  })

  test('an event with no workspace is logged and ignored', async () => {
    const h = harness()
    await h.dispatcher.onAgentStatusChanged(status('done', { workspaceId: null }))
    await h.settle()
    assert.equal(h.ticks().length, 0)
    assert.match(h.logs.join('\n'), /no known workspace/)
  })
})

describe('the .config/jig.yaml gate', () => {
  test('a repository with .config/jig.yaml gets a tick naming its main checkout', async () => {
    const h = harness()
    await created(h, 'repo-1::' + WORKTREE, WORKTREE)
    await h.dispatcher.onAgentStatusChanged(status('done', { workspaceId: 'repo-1::' + WORKTREE }))
    await h.settle()
    assert.deepEqual(h.ticks(), [
      [
        '/bin/bun',
        '--no-env-file',
        '--config=/plugin/dispatch/bunfig.toml',
        '/plugin/jig.ts',
        'dispatch',
        '--apply',
        '--repo',
        REPO,
        '--json'
      ]
    ])
  })

  test('a repository without it gets none', async () => {
    const h = harness({ files: ['/bin/bun', '/bin/claude', '/plugin/jig.ts'] })
    await created(h)
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await h.settle()
    assert.equal(h.ticks().length, 0)
  })

  test('a workspace that is not a Git checkout gets none', async () => {
    const h = harness()
    await created(h, 'f::/notes', '/notes')
    await h.dispatcher.onAgentStatusChanged(status('done', { workspaceId: 'f::/notes' }))
    await h.settle()
    assert.equal(h.ticks().length, 0)
    assert.match(h.logs.join('\n'), /not a Git checkout/)
  })

  test('an unknown workspace is ignored when Orca cannot list workspaces', async () => {
    const h = harness()
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await h.settle()
    assert.equal(h.ticks().length, 0)
    assert.match(h.logs.join('\n'), /path is unknown/)
  })

  test('workspace.list resolves a workspace the plugin never saw created', async () => {
    const h = harness({
      list: [
        {
          id: 'identity:wt2:local:1',
          kind: 'worktree',
          name: 'app',
          path: REPO,
          branch: 'main',
          hostId: 'local'
        }
      ]
    })
    await h.dispatcher.onAgentStatusChanged(status('waiting'))
    await h.settle()
    assert.equal(h.ticks().length, 1)
  })

  test('a workspace on another host gets no tick', async () => {
    const h = harness({
      list: [{ id: 'repo-1::' + REPO, kind: 'worktree', name: 'app', path: REPO, branch: 'main', hostId: 'ssh:box' }]
    })
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await h.settle()
    assert.equal(h.ticks().length, 0)
  })

  test('workspace.created is remembered across restarts through storage', async () => {
    const h = harness()
    await created(h)
    assert.deepEqual(h.store.get('workspaces'), { ['repo-1::' + REPO]: REPO })
    assert.match(h.logs[0], /workspace created: worktree \/work\/acme/)
    assert.equal(h.ticks().length, 0)
  })
})

describe('per-repository coalescing', () => {
  test('a second event inside the minute schedules one tick at its end', async () => {
    const h = harness()
    await created(h)
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await h.settle()
    assert.equal(h.ticks().length, 1)

    h.clock.advance(10_000)
    await h.dispatcher.onAgentStatusChanged(status('waiting'))
    await h.dispatcher.onAgentStatusChanged(status('blocked'))
    await h.settle()
    assert.equal(h.ticks().length, 1, 'nothing runs inside the window')

    h.clock.advance(TICK_WINDOW_MS - 10_001)
    await h.settle()
    assert.equal(h.ticks().length, 1)
    h.clock.advance(1)
    await h.settle()
    assert.equal(h.ticks().length, 2, 'exactly one more at the end of the window')

    h.clock.advance(TICK_WINDOW_MS * 3)
    await h.settle()
    assert.equal(h.ticks().length, 2, 'never a second one for the same requests')
  })

  test('a tick never overlaps another for the same repository', async () => {
    const h = harness({ holdTicks: true })
    await created(h)
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.ticks().length, 1)

    h.clock.advance(TICK_WINDOW_MS * 2)
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await h.dispatcher.onAgentStatusChanged(status('done'))
    assert.equal(h.ticks().length, 1, 'the running tick is not joined by another')

    h.release()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.ticks().length, 2, 'one tick follows, the window having passed')
    h.release()
    await h.settle()
    assert.equal(h.ticks().length, 2)
  })

  test('repositories are coalesced separately', async () => {
    const other = '/work/other'
    const h = harness({
      files: [`${REPO}/.config/jig.yaml`, `${other}/.config/jig.yaml`, '/bin/bun', '/bin/claude', '/plugin/jig.ts']
    })
    h.dispatcher.requestTick(REPO)
    h.dispatcher.requestTick(other)
    await h.settle()
    assert.deepEqual(
      h.ticks().map((argv) => argv[argv.indexOf('--repo') + 1]),
      [REPO, other]
    )
  })

  test('a held dispatcher lock is tried again a window later, a bounded number of times', async () => {
    const h = harness({ tickResult: () => ({ code: 3, stdout: '', stderr: 'lock held' }) })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    for (let i = 0; i < LOCK_HELD_RETRIES + 2; i++) {
      h.clock.advance(TICK_WINDOW_MS)
      await h.settle()
    }
    assert.equal(h.ticks().length, LOCK_HELD_RETRIES + 1)
    assert.equal(h.notifications.length, 0)
  })
})

describe('the receipt path', () => {
  test("the tick's one-line receipt becomes the notification; the detail goes to the log", async () => {
    const h = harness()
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.notifications, [
      { title: 'Jig dispatch', body: 'acme/app: 1 wanted, 1 started, 0 notified, 0 running (tick run-1)' }
    ])
    const log = h.logs.join('\n')
    assert.match(log, /wants rearm PR #4: stopped on a usage limit/)
    assert.match(log, /jig dispatch receipts run-1/)
  })

  test('a refused repository says why', () => {
    assert.equal(
      receiptLine(receipt(REPO, { refused: 'no forge' }), REPO),
      'acme/app: refused: no forge'
    )
  })

  test('the setting replaces the installed plugin, its quotes kept', async () => {
    const h = harness({ setting: `env "JIG HOME=/x y" jig` })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.ticks()[0], ['env', 'JIG HOME=/x y', 'jig', 'dispatch', '--apply', '--repo', REPO, '--json'])
  })

  test('a missing jig command is a notification, not a crash', async () => {
    const h = harness({
      setting: 'jig',
      tickResult: () => ({
        code: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('spawn jig ENOENT'), { code: 'ENOENT' })
      })
    })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.notifications, [{ title: 'Jig dispatch failed', body: `${REPO}: jig was not found` }])
  })

  test('no installed plugin is a notification naming the setting', async () => {
    const h = harness({ files: [`${REPO}/.config/jig.yaml`, '/bin/bun'] })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.equal(h.ticks().length, 0)
    assert.equal(h.notifications[0].title, 'Jig dispatch did not run')
    assert.match(h.notifications[0].body, /set the Jig command setting/)
  })

  test('a failing tick shows its first error line', async () => {
    const h = harness({
      tickResult: () => ({ code: 2, stdout: '', stderr: 'jig dispatch --apply needs the machine file\n' })
    })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.notifications, [
      { title: 'Jig dispatch failed', body: `${REPO}: jig dispatch --apply needs the machine file` }
    ])
  })

  test('a failing notification is logged, never thrown', async () => {
    const h = harness({
      hostCall: (method) => {
        if (method === 'notifications.show') throw new Error('capability_denied')
      }
    })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.match(h.logs.join('\n'), /could not show a notification: capability_denied/)
  })
})

describe('parsing', () => {
  test('splitCommand keeps quoted spaces and expands nothing', () => {
    assert.deepEqual(splitCommand(` bun  '--config=/a b/c' "$HOME" `), ['bun', '--config=/a b/c', '$HOME'])
    assert.deepEqual(splitCommand('""'), [''])
    assert.throws(() => splitCommand('bun "x'), /unclosed/)
  })

  test('mainCheckout reads the first worktree and marks a bare one', () => {
    assert.deepEqual(mainCheckout(`worktree /r\nHEAD a\n\nworktree /w\n`), { path: '/r', bare: false })
    assert.deepEqual(mainCheckout(`worktree /r.git\nbare\n\nworktree /w\n`), { path: '/r.git', bare: true })
  })

  test('the plugin directory is found as the launcher finds it', () => {
    assert.equal(
      claudePluginDirectory([
        { id: 'jig@jig', scope: 'project', installPath: '/p' },
        { id: 'jig@jig', scope: 'user', installPath: '/u', readFromFolder: '/f' }
      ]),
      '/f'
    )
    assert.equal(
      codexPluginDirectory({ installed: [{ pluginId: 'jig@jig', version: '1.2.3' }] }, '/h'),
      '/h/.codex/plugins/cache/jig/jig/1.2.3'
    )
  })
})

const GUARD = '/home/me/.local/state/jig/orca-guard'
const WT_ID = 'repo-1::' + WORKTREE
const WT_KEY = guardKey(WORKTREE)
const MARKER = `${GUARD}/launches/${WT_KEY}.json`
const ADMISSION = `${GUARD}/admissions/${WT_KEY}.json`

function launch(extra = {}) {
  return {
    agent: 'claude',
    workspaceId: WT_ID,
    workspaceKind: 'worktree',
    terminalId: 't-1',
    command: 'claude',
    env: {},
    ...extra
  }
}

async function guardedHarness(options) {
  const h = harness(options)
  await created(h, WT_ID, WORKTREE)
  return h
}

describe('the launch guard', () => {
  test('the key and the directory follow the guard record contract', () => {
    // The worked example in jig's plugin/gc/README.md, "The launch guard record".
    assert.equal(
      guardKey('/home/ada/orca/workspaces/app/topic'),
      '481ad110b5d9b30b0c46972739bb0e3d2aeb2c05c5dd3804e8a124048162f2ca'
    )
    assert.equal(defaultGuardDirectory('/home/me'), GUARD)
  })

  test('a launch into a worktree gc holds an admission for is refused', async () => {
    const h = await guardedHarness()
    h.fs.files.set(ADMISSION, '{"kind":"orca-guard-admission"}\n')
    assert.deepEqual(h.dispatcher.onLaunchBefore(launch()), { deny: 'jig gc is removing this worktree' })
    assert.match(h.logs.join('\n'), /launch guard: refused claude in \/work\/acme-wt\/feature/)
  })

  test('a launch with no admission passes and leaves its marker', async () => {
    const h = await guardedHarness()
    h.clock.advance(13_002)
    assert.equal(h.dispatcher.onLaunchBefore(launch()), undefined)
    assert.deepEqual(h.fs.record(MARKER), {
      kind: 'orca-guard-launch',
      v: 1,
      key: WT_KEY,
      writer: { host: 'laptop', pid: 4242 },
      at: new Date(1_013_002).toISOString(),
      path: WORKTREE,
      workspaceId: WT_ID,
      agent: 'claude'
    })
    assert.deepEqual(Object.keys(h.fs.record(MARKER)), ['kind', 'v', 'key', 'writer', 'at', 'path', 'workspaceId', 'agent'])
    assert.equal([...h.fs.files.keys()].filter((path) => path.endsWith('.tmp')).length, 0)
  })

  test('the marker is in place before the admission is read', async () => {
    const h = await guardedHarness()
    h.dispatcher.onLaunchBefore(launch())
    const ops = h.fs.ops.map(([op, path]) => `${op} ${path.replace(GUARD, '')}`)
    const placed = ops.indexOf(`rename /launches/${WT_KEY}.json`)
    const read = ops.indexOf(`stat /admissions/${WT_KEY}.json`)
    assert.ok(placed >= 0 && read > placed, ops.join('\n'))
    const temporary = h.fs.ops.find(([op]) => op === 'write')[1]
    assert.match(temporary, /\/launches\/\.[0-9a-f]{64}\.json\.\d+\.[0-9a-f]+\.tmp$/)
  })

  test('the hook awaits nothing: it answers synchronously', async () => {
    const h = await guardedHarness()
    h.fs.files.set(ADMISSION, '')
    const answer = h.dispatcher.onLaunchBefore(launch())
    assert.equal(typeof answer?.then, 'undefined')
    assert.deepEqual(answer, { deny: 'jig gc is removing this worktree' })
  })

  test('an unknown workspace, a folder or no workspace passes without a marker', async () => {
    const h = await guardedHarness()
    h.fs.files.set(ADMISSION, '')
    for (const event of [
      launch({ workspaceId: 'repo-1::/elsewhere' }),
      launch({ workspaceKind: 'folder' }),
      launch({ workspaceId: null, workspaceKind: null })
    ])
      assert.equal(h.dispatcher.onLaunchBefore(event), undefined)
    assert.equal(h.fs.ops.length, 0)
  })

  test('an unreadable admission refuses the launch', (t) => {
    if (process.getuid?.() === 0 || process.platform === 'win32') return t.skip('root reads any file')
    const home = realFs.mkdtempSync(join(tmpdir(), 'jig-guard-'))
    t.after(() => realFs.rmSync(home, { recursive: true, force: true }))
    const dispatcher = createDispatcher({ host: { call: async () => ({}) }, log: () => {}, home })
    const directory = defaultGuardDirectory(home)
    const admission = join(directory, 'admissions', `${WT_KEY}.json`)
    realFs.mkdirSync(join(directory, 'admissions'), { recursive: true })
    realFs.writeFileSync(admission, 'not json')
    realFs.chmodSync(admission, 0o000)
    return dispatcher.onWorkspaceCreated({ workspaceId: WT_ID, kind: 'worktree', path: WORKTREE }).then(() => {
      assert.deepEqual(dispatcher.onLaunchBefore(launch()), { deny: 'jig gc is removing this worktree' })
      const marker = realFs.readFileSync(join(directory, 'launches', `${WT_KEY}.json`), 'utf8')
      assert.equal(JSON.parse(marker).kind, 'orca-guard-launch')
      assert.ok(marker.endsWith('}\n'))
    })
  })

  test('an fs error lets the launch through and is logged', async () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    for (const failing of ['write', 'rename', 'stat']) {
      const h = await guardedHarness({ fs: fakeFs({ fail: (op) => (op === failing ? eacces : null) }) })
      h.fs.files.set(ADMISSION, '')
      assert.equal(h.dispatcher.onLaunchBefore(launch()), undefined, failing)
      assert.match(
        h.logs.join('\n'),
        /launch guard: let claude in \/work\/acme-wt\/feature through on an error: EACCES/,
        failing
      )
      assert.equal([...h.fs.files.keys()].filter((path) => path.endsWith('.tmp')).length, 0, failing)
    }
  })

  test('workspace.list answers for workspaces the plugin never saw created', async () => {
    const h = harness({
      list: [
        { id: 'identity:wt:local:1', kind: 'worktree', name: 'f', path: WORKTREE, branch: 'f', hostId: 'local' },
        { id: 'identity:wt:ssh:1', kind: 'worktree', name: 'r', path: '/remote', branch: 'r', hostId: 'ssh:box' }
      ]
    })
    h.dispatcher.startGuard()
    await h.settle()
    h.fs.files.set(ADMISSION, '')
    assert.deepEqual(h.dispatcher.onLaunchBefore(launch({ workspaceId: 'identity:wt:local:1' })), {
      deny: 'jig gc is removing this worktree'
    })
    assert.equal(h.dispatcher.onLaunchBefore(launch({ workspaceId: 'identity:wt:ssh:1' })), undefined)
    h.dispatcher.dispose()
  })

  test('the guard directory setting moves the record', async () => {
    const h = harness({ guardDirectory: '/srv/guard' })
    await created(h, WT_ID, WORKTREE)
    h.dispatcher.startGuard()
    await h.settle()
    h.fs.files.set(`/srv/guard/admissions/${WT_KEY}.json`, '')
    assert.deepEqual(h.dispatcher.onLaunchBefore(launch()), { deny: 'jig gc is removing this worktree' })
    assert.ok(h.fs.files.has('/srv/guard/heartbeat.json'))
    h.dispatcher.dispose()
  })
})

describe('the heartbeat', () => {
  test('is written at once and about every minute, in the guard record format', async () => {
    const h = harness()
    h.dispatcher.startGuard()
    await h.settle()
    const first = h.fs.record(`${GUARD}/heartbeat.json`)
    assert.deepEqual(first, {
      kind: 'orca-guard-heartbeat',
      v: 1,
      key: 'heartbeat',
      writer: { host: 'laptop', pid: 4242 },
      at: new Date(1_000_000).toISOString(),
      pid: 4242,
      pluginVersion: '0.2.0'
    })
    assert.deepEqual(Object.keys(first), ['kind', 'v', 'key', 'writer', 'at', 'pid', 'pluginVersion'])
    h.clock.advance(GUARD_HEARTBEAT_MS)
    await h.settle()
    assert.equal(h.fs.record(`${GUARD}/heartbeat.json`).at, new Date(1_000_000 + GUARD_HEARTBEAT_MS).toISOString())
    h.dispatcher.dispose()
  })

  test('a heartbeat that cannot be written is logged', async () => {
    const h = harness({ fs: fakeFs({ fail: () => new Error('EROFS: read-only file system') }) })
    h.dispatcher.startGuard()
    await h.settle()
    assert.match(h.logs.join('\n'), /could not write the heartbeat: EROFS/)
    h.dispatcher.dispose()
  })
})

describe('workspace.removed', () => {
  test('forgets the workspace and wakes its repository', async () => {
    const h = await guardedHarness()
    await h.dispatcher.onAgentStatusChanged(status('done', { workspaceId: WT_ID }))
    await h.settle()
    assert.equal(h.ticks().length, 1)

    h.clock.advance(TICK_WINDOW_MS)
    await h.dispatcher.onWorkspaceRemoved({ workspaceId: WT_ID, kind: 'worktree', path: WORKTREE })
    await h.settle()
    assert.equal(h.ticks().length, 2, 'a tick for the repository the worktree belonged to')
    assert.deepEqual(h.ticks()[1].slice(-3), ['--repo', REPO, '--json'])
    assert.deepEqual(h.store.get('workspaces'), {})
    h.fs.files.set(ADMISSION, '')
    assert.equal(h.dispatcher.onLaunchBefore(launch()), undefined, 'the hook no longer knows it')
  })

  test('forgets every id the path went by, not only the event\'s', async () => {
    const h = await guardedHarness()
    h.dispatcher.onWorkspaceCreated({ workspaceId: WT_ID, kind: 'worktree', path: WORKTREE })
    await h.settle()
    await h.dispatcher.onWorkspaceRemoved({ workspaceId: 'identity-id', kind: 'worktree', path: WORKTREE })
    await h.settle()
    h.fs.files.set(ADMISSION, '')
    assert.equal(h.dispatcher.onLaunchBefore(launch()), undefined, 'the hook no longer knows the path')
  })

  test('a workspace whose repository was never resolved wakes nothing', async () => {
    const h = await guardedHarness()
    await h.dispatcher.onWorkspaceRemoved({ workspaceId: WT_ID, kind: 'worktree', path: WORKTREE })
    await h.settle()
    assert.equal(h.ticks().length, 0)
    assert.match(h.logs.join('\n'), /workspace removed: worktree \/work\/acme-wt\/feature/)
  })
})
