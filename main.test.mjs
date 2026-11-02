import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  LOCK_HELD_RETRIES,
  TICK_WINDOW_MS,
  claudePluginDirectory,
  codexPluginDirectory,
  createDispatcher,
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
  hostCall = null
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
      if (method === 'settings.get') return { settings: { jigCommand: setting } }
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
    clock,
    env: { PATH: '/bin' },
    platform: 'linux',
    home: '/home/me'
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
