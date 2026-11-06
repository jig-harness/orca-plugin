// The fakes the tests share: a fake Orca host, a fake clock, a fake process runner and a fake
// file system, wired into a dispatcher by `harness`, and the fixtures the tests read.
import assert from 'node:assert/strict'
import { createDispatcher } from '../main.mjs'
import { guardKey } from '../lib/guard.mjs'

/** A clock whose timers fire only when the test moves time forward. */
export function fakeClock() {
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
export function fakeFs({ fail = () => null } = {}) {
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

export const REPO = '/work/acme'
export const WORKTREE = '/work/acme-wt/feature'

export function receipt(repo = REPO, extra = {}) {
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
 * recorded; a tick waits for `release()` when `holdTicks` is set. With `statusBar`, Orca has
 * `statusBar.update`, each update is recorded, and a line read waits for `releaseLine()` when
 * `holdLines` is set.
 */
export function harness({
  files = [`${REPO}/.config/jig.yaml`, '/bin/bun', '/bin/claude', '/plugin/jig.ts'],
  list = null,
  setting = '',
  tickResult = () => ({ code: 0, stdout: JSON.stringify(receipt()), stderr: '' }),
  holdTicks = false,
  hostCall = null,
  fs = fakeFs(),
  guardDirectory = '',
  statusBar = false,
  lineResult = () => ({ code: 0, stdout: JSON.stringify(lineAnswer()), stderr: '' }),
  holdLines = false,
  intervalSetting = 5
} = {}) {
  const clock = fakeClock()
  const logs = []
  const notifications = []
  const runs = []
  const store = new Map()
  const pending = []
  const pendingLines = []
  const items = []
  const host = {
    has: (method) =>
      (list !== null && method === 'workspace.list') || (statusBar && method === 'statusBar.update'),
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
      if (method === 'settings.get')
        return { settings: { jigCommand: setting, guardDirectory, dispatchIntervalMinutes: intervalSetting } }
      if (method === 'statusBar.update') {
        items.push(params)
        return { ok: true }
      }
      if (method === 'workspace.list') return { workspaces: list, truncated: false }
      throw Object.assign(new Error(`unexpected ${method}`), { code: 'unknown_method' })
    }
  }
  const runOptions = []
  async function run(argv, options) {
    runs.push(argv)
    runOptions.push(options)
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
    if (argv.includes('dispatch') && argv.includes('line')) {
      if (holdLines) return new Promise((resolve) => pendingLines.push(() => resolve(lineResult(argv))))
      return lineResult(argv)
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
  const ticks = () => runs.filter((argv) => argv.includes('dispatch') && !argv.includes('line'))
  const lineReads = () => runs.filter((argv) => argv.includes('dispatch') && argv.includes('line'))
  return {
    dispatcher,
    clock,
    logs,
    notifications,
    runs,
    store,
    ticks,
    lineReads,
    runOptions,
    items,
    fs,
    /** Lets the oldest held tick finish. */
    release: () => pending.shift()?.(),
    /** Lets the oldest held line read finish. */
    releaseLine: () => pendingLines.shift()?.(),
    settle: () => dispatcher.settled()
  }
}

export const NOW = '2026-11-05T12:00:00.000Z'

export function need(target, repo = REPO) {
  return { cause: 'parked', stage: 'drive', repo, target, pr: 7, item: null, url: null, title: null,
    since: NOW, reason: 'waits on a decision', decisions: [], notified: null, workspaces: [] }
}

/** What `jig dispatch line --json` prints: `line` overrides the snapshot's fields, or is null. */
export function lineAnswer(line = {}) {
  return {
    ok: true,
    value: {
      now: NOW,
      timeZone: 'Europe/Berlin',
      plugin: '1.0.0',
      schema: 3,
      line:
        line === null
          ? null
          : {
              version: 1,
              runId: 'run-9',
              startedAt: '2026-11-05T11:58:00.000Z',
              finishedAt: '2026-11-05T11:58:30.000Z',
              exitStatus: 0,
              apply: true,
              applyWithheld: null,
              intervalMs: 300_000,
              longestTickMs: 30_000,
              plugin: '1.0.0',
              accounts: [],
              lastAccount: null,
              sessions: [],
              needs: [need('PR #7'), need('ENG-4', '/work/other')],
              queue: [],
              repos: [],
              ...line
            }
    }
  }
}

export const printed = (answer) => () => ({ code: 0, stdout: JSON.stringify(answer), stderr: '' })

export async function created(h, id = 'repo-1::' + REPO, path = REPO) {
  await h.dispatcher.onWorkspaceCreated({ workspaceId: id, kind: 'worktree', path, branch: 'main' })
}

export function status(state, extra = {}) {
  return { workspaceId: 'repo-1::' + REPO, paneKey: 'tab:1', state, receivedAt: 1, ...extra }
}

export const GUARD = '/home/me/.local/state/jig/orca-guard'
export const WT_ID = 'repo-1::' + WORKTREE
export const WT_KEY = guardKey(WORKTREE)
export const MARKER = `${GUARD}/launches/${WT_KEY}.json`
export const ADMISSION = `${GUARD}/admissions/${WT_KEY}.json`

export function launch(extra = {}) {
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

export async function guardedHarness(options) {
  const h = harness(options)
  await created(h, WT_ID, WORKTREE)
  return h
}
