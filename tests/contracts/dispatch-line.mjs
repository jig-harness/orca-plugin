// The dispatch line, checked against Jig's own `jig dispatch line --json`: the pinned Jig runs in
// a fresh home, through the plugin's own runner, and the plugin's lineStatus reads what it prints,
// first with no tick yet, then after Jig's line store holds a tick's line, among them the lines of a
// drive that stopped with no recorded exit. Run with Bun, which runs
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
const { settleNoCauseStops, noCauseFacts } = await load('dispatch/lib/no-cause-stops.ts')

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

/** A drive's ledger that stopped with no recorded exit, as Jig's sources/ledgers.ts reads it. */
const noExitDrive = {
  number: 7,
  title: 'Recover the stopped drive',
  url: 'https://github.com/acme/app/pull/7',
  head: 'feature/7',
  class: 're-armable',
  why: 'no recorded cause',
  evidence: { noCause: true, legacyNoCause: false, generation: 3, heartbeat: null, exit: null, round: 1 }
}

/** The drive after Jig's no-cause budget (plugin/dispatch/lib/no-cause-stops.ts) counts `attempts` recoveries in the last hour. */
function settled(attempts) {
  const now = Date.now()
  const claim = (id) => {
    const at = new Date(now - id * 1000).toISOString()
    const end = { state: 'ended', at, exit: null, outcome: null }
    const says = { pr: 7, attempt: id, at, run: 'tick', action: 'rearm', record: `launch-${id}`, host: 'host', owner: true }
    return {
      id,
      stage: 'drive',
      login: 'drive-bot',
      createdAt: at,
      trusted: true,
      says: { ok: true, value: { ...says, facts: noCauseFacts(noExitDrive), change: null, conflictStop: false, end, legacy: false } }
    }
  }
  const claims = new Map([[7, { ok: true, value: Array.from({ length: attempts }, (_, i) => claim(i + 1)) }]])
  return settleNoCauseStops([noExitDrive], [], claims, now)[0]
}

/** The line a tick writes for `drive`: a re-arm session while it is re-armable, else a need for a person. */
function noExitLine(drive) {
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const base = { repo: 'acme/app', target: 'PR #7', pr: 7, item: null, url: drive.url, title: drive.title }
  const session = {
    ...base,
    record: 'launch-4',
    account: 'work-a',
    vendor: 'claude',
    stage: 'rearm',
    createdAt: since,
    launch: 'alive',
    launchReason: null,
    agent: null,
    round: 1,
    samples: [],
    heartbeat: null,
    passTimeoutSec: null,
    workspace: null,
    replaces: null
  }
  const need = {
    ...base,
    cause: 'stopped-unknown',
    stage: 'rearm',
    since,
    reason: drive.why,
    decisions: [],
    notified: null,
    workspaces: []
  }
  const stopped = drive.class === 'stopped-unknown'
  return { ...tickLine(60_000), runId: 'contract-no-exit', sessions: stopped ? [] : [session], needs: stopped ? [need] : [] }
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

check('a no-exit stop within its recovery budget is driven again and needs no one', async () => {
  const drive = settled(2)
  assert.equal(drive.class, 're-armable')
  writeLine(noExitLine(drive), '{}', stateRoot)
  closeStateDb(stateRoot)
  const { result, item } = await read()
  const { line } = JSON.parse(result.stdout).value
  assert.deepEqual([line.needs.length, line.sessions.map((s) => s.stage)], [0, ['rearm']])
  assert.equal(item.text, 'Jig 0 need you', `${item.tooltip}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  assert.equal(item.tone, 'neutral')
})

check('a no-exit stop past its recovery budget needs a person', async () => {
  const drive = settled(3)
  assert.equal(drive.class, 'stopped-unknown')
  assert.match(drive.why, /^repeated no-cause stops: needs a person; /)
  writeLine(noExitLine(drive), '{}', stateRoot)
  closeStateDb(stateRoot)
  const { result, item } = await read()
  const { line } = JSON.parse(result.stdout).value
  assert.deepEqual(line.needs.map((n) => [n.cause, n.stage, n.reason]), [['stopped-unknown', 'rearm', drive.why]])
  assert.equal(item.text, 'Jig 1 need you', `${item.tooltip}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  assert.equal(item.tone, 'warning')
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
