// The launch guard record, checked against Jig's own reader and writer: the plugin's worker writes
// its heartbeat and a launch marker into a real directory, Jig's plugin/shared/orca-guard.ts reads
// them, and an admission Jig writes makes the worker refuse the launch. Run with Bun, which runs
// Jig's TypeScript: `JIG_DIR=<a checkout of jig-harness/jig> bun tests/contracts/guard-record.mjs`.
// Not a `*.test.mjs` file, so `node --test` leaves it to the Contracts workflow.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { guardKey } from '../../lib/guard.mjs'
import { createDispatcher } from '../../main.mjs'

const jigDir = process.env.JIG_DIR
if (!jigDir) {
  console.error('JIG_DIR must name a checkout of jig-harness/jig')
  process.exit(2)
}
const jig = await import(pathToFileURL(join(jigDir, 'plugin', 'shared', 'orca-guard.ts')).href)

const WORKTREE = '/work/acme-wt/feature'
const WORKSPACE_ID = `repo-1::${WORKTREE}`
const DENIED = { deny: 'jig gc is removing this worktree' }

/** The worker against a minimal Orca whose guard directory setting names `root`, with the real fs and clock. */
function worker(root, logs) {
  const host = {
    has: () => false,
    async call(method) {
      if (method === 'settings.get') return { settings: { guardDirectory: root } }
      if (method === 'storage.get') return { value: null }
      return {}
    }
  }
  return createDispatcher({ host, log: (message) => logs.push(message), home: root, pluginVersion: '0.0.0-contract' })
}

function launch() {
  return { agent: 'claude', workspaceId: WORKSPACE_ID, workspaceKind: 'worktree', terminalId: 't-1', command: 'claude', env: {} }
}

const checks = []
const check = (name, body) => checks.push({ name, body })

check('the key is the one Jig computes, for every spelling of a path', () => {
  for (const path of [
    WORKTREE,
    `${WORKTREE}/`,
    '/home/ada/Ünïcødé/工作区/topic',
    'C:\\Users\\ada\\orca\\topic'
  ])
    assert.equal(guardKey(path), jig.guardKey(path), JSON.stringify(path))
})

check("the heartbeat makes Jig's gc see the plugin as guarding", async ({ dispatcher, root }) => {
  dispatcher.startGuard()
  await dispatcher.settled()
  const state = jig.guardState(root, Date.now())
  assert.equal(state.guarded, true, state.reason)
})

check("a launch marker reads in Jig as a launch after gc's admission", ({ dispatcher, root }) => {
  assert.equal(dispatcher.onLaunchBefore(launch()), undefined, 'no admission: the launch passes')
  const file = join(root, 'launches', `${jig.guardKey(WORKTREE)}.json`)
  assert.ok(existsSync(file), `${file} was written`)
  const at = JSON.parse(readFileSync(file, 'utf8')).at
  const before = new Date(Date.parse(at) - 1000).toISOString()
  const veto = jig.launchVeto({ key: jig.guardKey(WORKTREE), at: before }, root, Date.now())
  assert.ok(veto?.startsWith('Orca launched an agent in the worktree at'), veto)
  // A marker every field of which reads keeps nothing once settled: Jig found no fault in it.
  const later = new Date(Date.parse(at) + 1000).toISOString()
  assert.equal(jig.launchVeto({ key: jig.guardKey(WORKTREE), at: later }, root, Date.parse(at) + 600_000), null)
})

check("Jig's admission makes the hook refuse the launch, and its release lets it through", ({ dispatcher, root }) => {
  const admission = jig.admit(WORKTREE, root)
  assert.ok(admission.ok, admission.ok ? '' : admission.failure.reason)
  try {
    assert.deepEqual(dispatcher.onLaunchBefore(launch()), DENIED)
  } finally {
    admission.value.release()
  }
  assert.equal(dispatcher.onLaunchBefore(launch()), undefined)
})

const root = mkdtempSync(join(tmpdir(), 'jig-guard-contract-'))
const logs = []
const dispatcher = worker(root, logs)
let failures = 0
try {
  await dispatcher.onWorkspaceCreated({ workspaceId: WORKSPACE_ID, kind: 'worktree', path: WORKTREE, branch: 'feature' })
  for (const { name, body } of checks) {
    try {
      await body({ dispatcher, root })
      console.log(`ok - ${name}`)
    } catch (error) {
      failures++
      console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).replaceAll('\n', '\n  ')}`)
    }
  }
} finally {
  dispatcher.dispose()
  rmSync(root, { recursive: true, force: true })
}
if (failures) {
  console.log(`worker log:\n  ${logs.join('\n  ')}`)
  console.log(`${failures} of ${checks.length} guard record checks failed`)
  process.exit(1)
}
console.log(`all ${checks.length} guard record checks passed`)
