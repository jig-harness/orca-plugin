// `jig ask` and `jig send`, checked against Jig's own commands: the pinned Jig runs in a fresh home
// through the plugin's own address handlers, and each answer reads as the plugin expects. Only
// cases that call no forge are run: what waits with no line, a usage error that is Jig's own (not
// a jig too old), and an answer Jig refuses before any read. Run with Bun:
// `JIG_DIR=<a checkout of jig-harness/jig> bun tests/contracts/ask-send.mjs`.
// Not a `*.test.mjs` file, so `node --test` leaves it to the Contracts workflow.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAddresses } from '../../lib/addresses.mjs'
import { runProgram } from '../../lib/jig-command.mjs'

const jigDir = process.env.JIG_DIR
if (!jigDir) {
  console.error('JIG_DIR must name a checkout of jig-harness/jig')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'jig-address-contract-'))
const command = [
  process.execPath,
  '--no-env-file',
  `--config=${join(jigDir, 'plugin', 'dispatch', 'bunfig.toml')}`,
  join(jigDir, 'plugin', 'jig.ts')
]

/** The plugin's address handlers, running the pinned Jig in the fresh home with `extraEnv`. */
function handlers(extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv }
  if (!('JIG_LAUNCH' in extraEnv)) delete env.JIG_LAUNCH
  const ctx = {
    log: () => {},
    run: runProgram,
    clock: { now: () => Date.now(), setTimeout, clearTimeout },
    env,
    platform: process.platform
  }
  const statusBar = { latestLine: async () => ({ state: 'no-tick' }) }
  return createAddresses(ctx, { jigCommand: async () => command }, statusBar, 900_000)
}

const checks = []
const check = (name, body) => checks.push({ name, body })

check('with no line, jig ask --waiting answers version 1 with nothing waiting and says why', async () => {
  const list = await handlers().listAddresses({ fresh: true })
  assert.equal(list.state, 'list', `${list.why}`)
  assert.deepEqual(list.addresses, [])
  assert.match(list.unread, /no line to read/)
})

check("a usage error of jig ask is Jig's own, not a jig too old", async () => {
  const answer = await handlers().getAddress({ address: 'drive@acme/app#x' })
  assert.equal(answer.state, 'unreadable', JSON.stringify(answer))
  assert.match(answer.why, /^"x" is not a pull request/)
})

check('an answer from a session the line started is refused by Jig, in its words, and not sent', async () => {
  const result = await handlers({ JIG_LAUNCH: 'contract-record' }).send({
    address: 'drive@acme/app#1',
    verb: 'answer',
    key: 'k1',
    text: '--dry-run is part of the answer'
  })
  assert.equal(result.sent, false)
  assert.match(result.why, /^refused: answer is a person's command, and this session was started by the line \(JIG_LAUNCH=contract-record\)/)
})

check("an answer of two lines is Jig's usage error, not a jig too old", async () => {
  const result = await handlers().send({ address: 'drive@acme/app#1', verb: 'answer', key: 'k1', text: 'two\nlines' })
  assert.equal(result.sent, false)
  assert.match(result.why, /line break/)
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
  console.log(`${failures} of ${checks.length} ask and send checks failed`)
  process.exit(1)
}
console.log(`all ${checks.length} ask and send checks passed`)
