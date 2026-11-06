// The dispatch line, checked against Jig's own `jig dispatch line --json`: the pinned Jig runs in
// a fresh home, through the plugin's own runner, and the plugin's lineStatus reads what it prints,
// first with no tick yet, then after Jig's line store holds a tick's line. Run with Bun, which runs
// Jig's TypeScript: `JIG_DIR=<a checkout of jig-harness/jig> bun tests/contracts/dispatch-line.mjs`.
// Not a `*.test.mjs` file, so `node --test` leaves it to the Contracts workflow.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProgram } from '../../lib/jig-command.mjs'
import { lineStatus } from '../../lib/status-bar.mjs'

const jigDir = process.env.JIG_DIR
if (!jigDir) {
  console.error('JIG_DIR must name a checkout of jig-harness/jig')
  process.exit(2)
}
const load = (path) => import(pathToFileURL(join(jigDir, 'plugin', ...path.split('/'))).href)
const { writeLine } = await load('dispatch/lib/line-store.ts')
const { closeStateDb } = await load('dispatch/lib/state.ts')

const INTERVAL_MS = 300_000
const home = mkdtempSync(join(tmpdir(), 'jig-line-contract-'))
// Where Jig's stateRoot() puts the dispatcher's state under a home.
const stateRoot = join(home, '.local', 'state', 'jig', 'dispatch')

/** `jig dispatch line --json` from the pinned Jig, as the installed plugin's command runs it, read by the plugin. */
async function read() {
  const argv = [
    process.execPath,
    '--no-env-file',
    `--config=${join(jigDir, 'plugin', 'dispatch', 'bunfig.toml')}`,
    join(jigDir, 'plugin', 'jig.ts'),
    'dispatch',
    'line',
    '--json'
  ]
  const result = await runProgram(argv, {
    timeoutMs: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    platform: process.platform
  })
  return { result, item: lineStatus(result, { intervalMs: INTERVAL_MS, now: Date.now() }) }
}

/** A tick's line that finished `agoMs` ago with two needs, in the form Jig's line store keeps. */
function tickLine(agoMs) {
  const finished = Date.now() - agoMs
  const need = (target) => ({
    cause: 'parked',
    stage: 'drive',
    repo: '/work/acme',
    target,
    since: new Date(finished - 3_600_000).toISOString(),
    reason: 'waits on a decision',
    decisions: [],
    workspaces: []
  })
  return {
    version: 1,
    runId: `contract-${agoMs}`,
    startedAt: new Date(finished - 30_000).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    exitStatus: 0,
    apply: true,
    applyWithheld: null,
    intervalMs: INTERVAL_MS,
    longestTickMs: 30_000,
    plugin: null,
    accounts: [],
    lastAccount: null,
    sessions: [],
    needs: [need('PR #7'), need('ENG-4')],
    queue: [],
    repos: []
  }
}

const checks = []
const check = (name, body) => checks.push({ name, body })

check('with no tick yet the status bar says so', async () => {
  const { result, item } = await read()
  assert.equal(item.text, 'Jig no tick yet', `${item.tooltip}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
})

check("a fresh tick's line shows its needs", async () => {
  writeLine(tickLine(60_000), '{}', stateRoot)
  closeStateDb(stateRoot)
  const { result, item } = await read()
  assert.equal(item.text, 'Jig 2 need you', `${item.tooltip}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  assert.equal(item.tone, 'warning')
  assert.match(item.tooltip, /tick contract-60000 finished/)
})

check('a tick older than twice its interval is overdue', async () => {
  writeLine(tickLine(30 * 60_000), '{}', stateRoot)
  closeStateDb(stateRoot)
  const { result, item } = await read()
  assert.equal(item.text, 'Jig tick overdue · 2 need you', `${item.tooltip}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  assert.equal(item.tone, 'danger')
})

let failures = 0
try {
  for (const { name, body } of checks) {
    try {
      await body()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures++
      console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).replaceAll('\n', '\n  ')}`)
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
if (failures) {
  console.log(`${failures} of ${checks.length} dispatch line checks failed`)
  process.exit(1)
}
console.log(`all ${checks.length} dispatch line checks passed`)
