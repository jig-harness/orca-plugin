// The workspaces: the .config/jig.yaml gate and forgetting a removed workspace.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { TICK_WINDOW_MS } from '../lib/wake.mjs'
import {
  ADMISSION,
  REPO,
  WORKTREE,
  WT_ID,
  created,
  guardedHarness,
  harness,
  launch,
  status
} from './fake-orca.mjs'

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
    const h = await guardedHarness({ list: [{ id: 'identity-id', path: WORKTREE }] })
    const denied = { deny: 'jig gc is removing this worktree' }
    h.fs.files.set(ADMISSION, '{"kind":"orca-guard-admission"}\n')
    assert.deepEqual(h.dispatcher.onLaunchBefore(launch()), denied, 'the event\'s id is guarded')
    assert.deepEqual(h.dispatcher.onLaunchBefore(launch({ workspaceId: 'identity-id' })), denied, 'so is the listed id')

    await h.dispatcher.onWorkspaceRemoved({ workspaceId: WT_ID, kind: 'worktree', path: WORKTREE })
    await h.settle()
    h.fs.files.set(ADMISSION, '')
    assert.equal(h.dispatcher.onLaunchBefore(launch()), undefined, 'the event\'s id is gone')
    assert.equal(h.dispatcher.onLaunchBefore(launch({ workspaceId: 'identity-id' })), undefined, 'the listed id is gone')
    assert.deepEqual(h.store.get('workspaces'), {})
  })

  test('a list that was pending during the removal does not restore the workspace', async () => {
    let hold = false
    let answer = null
    const h = await guardedHarness({
      list: [],
      hostCall: (method) => {
        if (method === 'workspace.list' && hold)
          return new Promise((resolve) => {
            answer = () => resolve({ workspaces: [{ id: 'identity-id', path: WORKTREE }], truncated: false })
          })
      }
    })
    hold = true
    h.dispatcher.onWorkspaceCreated({ workspaceId: 'other-id', kind: 'worktree', path: '/work/other' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(answer, 'the list is outstanding')

    await h.dispatcher.onWorkspaceRemoved({ workspaceId: WT_ID, kind: 'worktree', path: WORKTREE })
    hold = false
    answer()
    await h.settle()
    h.fs.files.set(ADMISSION, '{"kind":"orca-guard-admission"}\n')
    assert.equal(
      h.dispatcher.onLaunchBefore(launch({ workspaceId: 'identity-id' })),
      undefined,
      'the earlier snapshot did not bring the removed workspace back'
    )
  })

  test('an older list response does not prune what a newer one listed', async () => {
    let hold = false
    let older = null
    const list = []
    const h = harness({
      list,
      hostCall: (method) => {
        if (method === 'workspace.list' && hold)
          return new Promise((resolve) => {
            older = () => resolve({ workspaces: [], truncated: false })
          })
      }
    })
    hold = true
    h.dispatcher.onWorkspaceCreated({ workspaceId: 'a-id', kind: 'worktree', path: '/work/a' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(older, 'the first list is outstanding')

    hold = false
    list.push({ id: 'identity-id', path: WORKTREE })
    await h.dispatcher.onWorkspaceCreated({ workspaceId: 'b-id', kind: 'worktree', path: '/work/b' })
    older()
    await h.settle()
    h.fs.files.set(ADMISSION, '{"kind":"orca-guard-admission"}\n')
    assert.deepEqual(h.dispatcher.onLaunchBefore(launch({ workspaceId: 'identity-id' })), {
      deny: 'jig gc is removing this worktree'
    })
  })

  test('a workspace whose repository was never resolved wakes nothing', async () => {
    const h = await guardedHarness()
    await h.dispatcher.onWorkspaceRemoved({ workspaceId: WT_ID, kind: 'worktree', path: WORKTREE })
    await h.settle()
    assert.equal(h.ticks().length, 0)
    assert.match(h.logs.join('\n'), /workspace removed: worktree \/work\/acme-wt\/feature/)
  })
})
