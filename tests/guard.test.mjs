// The launch guard and its heartbeat, against the guard record contract.
import assert from 'node:assert/strict'
import * as realFs from 'node:fs'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { GUARD_HEARTBEAT_MS, defaultGuardDirectory, guardKey } from '../lib/guard.mjs'
import { createDispatcher } from '../main.mjs'
import {
  ADMISSION,
  GUARD,
  MARKER,
  WORKTREE,
  WT_ID,
  WT_KEY,
  created,
  fakeFs,
  guardedHarness,
  harness,
  launch
} from './fake-orca.mjs'

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
