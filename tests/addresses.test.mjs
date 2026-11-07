// The panel's address requests: `addresses.list` from `jig ask --waiting` and the line's
// sessions, `address.get` from `jig ask <address> --thread`, and `address.send`, which runs
// `jig send <address> answer <key> <text>` and nothing else.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ASK_DEADLINE_MS, BUSY_WAIT_MS, REQUEST_DEADLINE_MS, addressList, boundThread, lineAddress, sendRows } from '../lib/addresses.mjs'
import { askFixture, fixtureAnswer, harness, printed, sentOutput } from './fake-orca.mjs'

const PARKED = 'drive@jig-harness/jig#456'
const TOO_OLD = { code: 2, stdout: '', stderr: 'Error: Unexpected option or subcommand: `ask`.\n' }

const asked = (name) => () => ({ code: 0, stdout: JSON.stringify(askFixture(name)), stderr: '' })

/** A harness whose line is the park fixture and whose `jig ask` prints `name`'s fixture. */
function parkHarness(options = {}) {
  return harness({ lineResult: printed(fixtureAnswer('park-three-decisions')), askResult: asked('thread-long'), ...options })
}

describe('an address on the line', () => {
  test('a need or a session is the address of its station, as jig ask --waiting names it', () => {
    const base = { repo: 'jig-harness/jig', pr: 456, item: null }
    assert.equal(lineAddress({ ...base, stage: 'rearm' }), PARKED)
    assert.equal(lineAddress({ ...base, stage: 'takeover' }), PARKED)
    assert.equal(lineAddress({ ...base, stage: 'followup' }), 'followup@jig-harness/jig#456')
    assert.equal(lineAddress({ ...base, stage: 'steer' }), PARKED)
    assert.equal(lineAddress({ repo: 'acme/api', stage: 'pickup', pr: null, item: 'API-77' }), 'pickup@acme/api#API-77')
    assert.equal(lineAddress({ repo: 'acme/api', stage: 'pickup', pr: null, item: '#12' }), 'pickup@acme/api#12')
    assert.equal(lineAddress({ repo: '/work/acme', stage: 'rearm', pr: 7, item: null }), null, 'a path is no repository')
    assert.equal(lineAddress({ repo: 'acme/api', stage: 'pickup', pr: null, item: null }), null)
  })

  test('the list puts what waits first, oldest first, then what the sessions hold, once each', () => {
    const line = fixtureAnswer('park-three-decisions').value.line
    const held = { ...line.sessions[0], repo: 'jig-harness/jig', pr: 456, target: 'PR #456' }
    const list = addressList(askFixture('waiting'), { ...line, sessions: [...line.sessions, held] })
    assert.deepEqual(list.map((a) => a.address), [
      'pickup@example-org/api#API-77',
      PARKED,
      'followup@example-org/web#461',
      'drive@example-org/web#485'
    ])
    const parked = list[1]
    assert.equal(parked.waiting.act, 'answer')
    assert.equal(parked.held.stage, 'rearm', 'a waiting address the line holds says so')
    assert.equal(list[3].waiting, null)
    assert.equal(list[3].held.round, 2)
  })
})

describe('the address worker', () => {
  test('addresses.list reads jig ask --waiting once a minute and the line beside it', async () => {
    const h = parkHarness({ askResult: asked('waiting') })
    const answer = await h.dispatcher.listAddresses({})
    assert.equal(answer.state, 'list')
    assert.equal(answer.tick.runId, '20261105T164500Z')
    assert.deepEqual(answer.addresses.map((a) => a.address), [
      'pickup@example-org/api#API-77',
      PARKED,
      'followup@example-org/web#461',
      'drive@example-org/web#485'
    ])
    await h.dispatcher.listAddresses({})
    assert.deepEqual(h.asks(), [['--waiting', '--json']], 'the kept list answers within the minute')
    await h.dispatcher.listAddresses({ fresh: true })
    assert.equal(h.asks().length, 2)
  })

  test('address.get gives the thread, oldest first, and the questions the line has it parked on', async () => {
    const h = parkHarness()
    const answer = await h.dispatcher.getAddress({ address: PARKED })
    assert.deepEqual(h.asks(), [['--thread', '--json', '--', PARKED]])
    assert.equal(answer.state, 'answer')
    assert.equal(answer.value.address, PARKED)
    assert.equal(answer.value.thread.length, 16)
    assert.equal(answer.value.threadOmitted, 3)
    const at = answer.value.thread.map((e) => Date.parse(e.at))
    assert.deepEqual(at, [...at].sort((a, b) => a - b))
    assert.deepEqual(answer.parked.map((q) => q.key), ['PRRT_kwDOa1', 'F-3', 'PRRT_kwDOa4'])
    await h.dispatcher.getAddress({ address: PARKED, all: true })
    assert.deepEqual(h.asks()[1], ['--thread', '--all', '--json', '--', PARKED])
  })

  test('an empty thread is an answer with no entries, and no parked question', async () => {
    const h = parkHarness({ askResult: asked('thread-empty') })
    const answer = await h.dispatcher.getAddress({ address: 'drive@example-org/web#485' })
    assert.equal(answer.state, 'answer')
    assert.deepEqual(answer.value.thread, [])
    assert.equal(answer.value.holder.stage, 'rearm')
    assert.deepEqual(answer.parked, [])
  })

  test('a jig without jig ask is too old, for the list and the thread alike', async () => {
    const h = parkHarness({ askResult: () => TOO_OLD })
    assert.equal((await h.dispatcher.getAddress({ address: PARKED })).state, 'too-old')
    const list = await h.dispatcher.listAddresses({})
    assert.equal(list.state, 'too-old')
    assert.deepEqual(list.addresses.map((a) => a.address), ['drive@example-org/web#485'], 'the sessions still list')
  })

  test("jig ask's own usage error and a key that names nothing give Jig's words", async () => {
    const h = parkHarness({
      askResult: (argv) =>
        argv.at(-1).endsWith('#1')
          ? { code: 1, stdout: '', stderr: 'jig ask: jig-harness/jig has no pull request 1\n' }
          : { code: 2, stdout: '', stderr: 'jig ask: "456" is not a pull request number\n' }
    })
    assert.deepEqual(await h.dispatcher.getAddress({ address: 'drive@jig-harness/jig#1' }), {
      state: 'nothing',
      why: 'jig-harness/jig has no pull request 1',
      address: 'drive@jig-harness/jig#1',
      parked: []
    })
    const usage = await h.dispatcher.getAddress({ address: PARKED })
    assert.deepEqual([usage.state, usage.why], ['unreadable', '"456" is not a pull request number'])
  })

  test('an address not in full is refused before jig runs', async () => {
    const h = parkHarness()
    for (const address of ['drive#456', 'drive@jig 456', '--all', 'drive@jig-harness/jig#456 --as x', 'hold@a/b#1', null])
      assert.equal((await h.dispatcher.getAddress({ address })).state, 'refused', String(address))
    assert.deepEqual(h.asks(), [])
  })

  test('one jig ask at a time: the same question shares its read, another waits its turn', async () => {
    const h = parkHarness({ holdAsks: true })
    const first = h.dispatcher.getAddress({ address: PARKED })
    const again = h.dispatcher.getAddress({ address: PARKED })
    const other = h.dispatcher.getAddress({ address: 'drive@example-org/web#485' })
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.asks().length, 1)
    h.releaseAsk()
    assert.equal((await first).state, 'answer')
    assert.equal((await again).state, 'answer')
    for (let i = 0; i < 20 && h.asks().length < 2; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.asks().length, 2, 'the other read starts once the first has finished')
    h.releaseAsk()
    assert.equal((await other).state, 'answer')
  })

  test('a read that waits past BUSY_WAIT_MS is busy, and a busy list is not kept', async () => {
    const h = parkHarness({ holdAsks: true })
    const first = h.dispatcher.getAddress({ address: PARKED })
    for (let i = 0; i < 20 && h.asks().length < 1; i++) await new Promise((resolve) => setImmediate(resolve))
    const list = h.dispatcher.listAddresses({})
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
    h.clock.advance(BUSY_WAIT_MS)
    const busy = await list
    assert.equal(busy.state, 'unreadable')
    assert.match(busy.why, /another address is being read/)
    h.releaseAsk()
    await first
    const again = h.dispatcher.listAddresses({})
    for (let i = 0; i < 20 && h.asks().length < 2; i++) await new Promise((resolve) => setImmediate(resolve))
    h.releaseAsk()
    await again
    assert.deepEqual(h.asks()[1], ['--waiting', '--json'], 'the busy answer was not kept: the list was asked again')
  })

  test('a read slow in several stages is answered by REQUEST_DEADLINE_MS, inside the panel’s own', async () => {
    const h = parkHarness({ holdAsks: true, holdLines: true })
    const flush = async (until = () => false) => {
      for (let i = 0; i < 20 && !until(); i++) await new Promise((resolve) => setImmediate(resolve))
    }
    const first = h.dispatcher.getAddress({ address: PARKED })
    await flush(() => h.asks().length === 1)
    const second = h.dispatcher.listAddresses({ fresh: true })
    await flush()
    h.clock.advance(BUSY_WAIT_MS - 1000)
    h.releaseAsk()
    await flush()
    h.releaseLine()
    await first
    await flush(() => h.asks().length === 2)
    h.clock.advance(ASK_DEADLINE_MS - 5000)
    h.releaseAsk()
    await flush()
    h.clock.advance(REQUEST_DEADLINE_MS - (BUSY_WAIT_MS - 1000) - (ASK_DEADLINE_MS - 5000))
    const answer = await second
    assert.equal(answer.state, 'unreadable')
    assert.match(answer.why, new RegExp(`past ${REQUEST_DEADLINE_MS / 1000}s`))
    assert.ok(REQUEST_DEADLINE_MS < 110_000, 'inside the panel’s 110 s')
  })

  test('an ask that runs past its deadline is unreadable, and the next ask runs once its process is gone', async () => {
    const h = parkHarness({ holdAsks: true })
    const late = h.dispatcher.getAddress({ address: PARKED })
    for (let i = 0; i < 20 && h.asks().length < 1; i++) await new Promise((resolve) => setImmediate(resolve))
    h.clock.advance(ASK_DEADLINE_MS)
    const answer = await late
    assert.equal(answer.state, 'unreadable')
    assert.match(answer.why, /ran past 50s/)
    const next = h.dispatcher.getAddress({ address: PARKED })
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.asks().length, 1, 'cleanup still holds admission after caller times out')
    h.releaseAsk()
    for (let i = 0; i < 20 && h.asks().length < 2; i++) await new Promise((resolve) => setImmediate(resolve))
    h.releaseAsk()
    assert.equal((await next).state, 'answer')
  })

  test('malformed command-specific output is unreadable', async () => {
    for (const value of [{ v: 1 }, { v: 1, waiting: {} }, { ...askFixture('thread-empty'), sources: { records: {} } }]) {
      const h = parkHarness({ askResult: () => ({ code: 0, stdout: JSON.stringify(value), stderr: '' }) })
      assert.equal((await h.dispatcher.getAddress({ address: PARKED })).state, 'unreadable')
      assert.equal((await h.dispatcher.listAddresses({})).state, 'unreadable')
    }
  })

  test('oversized metadata produces a bounded explicit unreadable response', async () => {
    const value = { ...askFixture('thread-empty'), title: 'x'.repeat(1_100_000) }
    const h = parkHarness({ askResult: () => ({ code: 0, stdout: JSON.stringify(value), stderr: '' }) })
    const answer = await h.dispatcher.getAddress({ address: PARKED })
    assert.equal(answer.state, 'unreadable')
    assert.ok(Buffer.byteLength(JSON.stringify(answer)) < 900_000)
  })

  test('the whole response, not the value alone, stays within the budget', () => {
    const value = askFixture('thread-long')
    const big = { ...value, thread: value.thread.map((e) => ({ ...e, text: 'x'.repeat(1000) })) }
    const parked = [{ key: 'K', question: 'q'.repeat(3000) }]
    const frame = (v) => ({ state: 'answer', why: null, address: PARKED, value: v, parked })
    const bound = boundThread(big, 6000, frame)
    assert.ok(Buffer.byteLength(JSON.stringify(frame(bound))) <= 6000)
    assert.ok(bound.thread.length > 0)
  })

  test('a thread past the answer budget keeps its newest entries and counts the rest', () => {
    const value = askFixture('thread-long')
    const big = { ...value, thread: value.thread.map((e) => ({ ...e, text: 'x'.repeat(1000) })) }
    const bound = boundThread(big, 6000)
    assert.ok(Buffer.byteLength(JSON.stringify(bound)) <= 6000)
    assert.deepEqual(bound.thread, big.thread.slice(-bound.thread.length))
    assert.equal(bound.threadOmitted, 3 + big.thread.length - bound.thread.length)
  })
})

describe('sending an answer', () => {
  const answer = { address: PARKED, verb: 'answer', key: 'PRRT_kwDOa1', text: ' A, records only ' }

  test('a send that succeeds runs exactly jig send -- <address> answer <key> <text> and says what Jig wrote', async () => {
    const h = parkHarness()
    const result = await h.dispatcher.sendToAddress(answer)
    assert.deepEqual(h.sends(), [['--', PARKED, 'answer', 'PRRT_kwDOa1', 'A, records only']])
    assert.equal(result.sent, true)
    assert.equal(result.wrote, 'https://github.com/jig-harness/jig/pull/456#issuecomment-6699001')
    assert.equal(result.writesAs, 'liqweed, the login the forge client here is signed in as')
    assert.equal(result.printed, sentOutput().trimEnd())
  })

  test('an oversized send keeps its receipt and cuts only what jig printed', async () => {
    const h = parkHarness({ sendResult: () => ({ code: 0, stdout: `${sentOutput()}${'x'.repeat(1_000_000)}`, stderr: '' }) })
    const result = await h.dispatcher.sendToAddress(answer)
    assert.equal(result.sent, true)
    assert.equal(result.wrote, 'https://github.com/jig-harness/jig/pull/456#issuecomment-6699001')
    assert.match(result.writesAs, /^liqweed/)
    assert.match(result.printed, /exceeded the panel limit/)
  })

  test('text that looks like an option stays the answer’s words', async () => {
    const h = parkHarness()
    await h.dispatcher.sendToAddress({ ...answer, text: '--dry-run --as someone' })
    assert.deepEqual(h.sends(), [['--', PARKED, 'answer', 'PRRT_kwDOa1', '--dry-run --as someone']])
  })

  test('a verb off the panel’s list is refused before jig runs', async () => {
    const h = parkHarness()
    for (const verb of ['hold', 'release', 'drive', 'stop', 'assign', 'answer --dry-run', undefined]) {
      const result = await h.dispatcher.sendToAddress({ ...answer, verb })
      assert.equal(result.sent, false, String(verb))
      assert.match(result.why, /the panel sends only answer/)
    }
    assert.deepEqual(h.sends(), [])
  })

  test('a malformed address, key or text is refused before jig runs', async () => {
    const h = parkHarness()
    assert.equal((await h.dispatcher.sendToAddress({ ...answer, address: 'drive#456' })).sent, false)
    assert.equal((await h.dispatcher.sendToAddress({ ...answer, key: 'two words' })).sent, false)
    assert.equal((await h.dispatcher.sendToAddress({ ...answer, key: '' })).sent, false)
    assert.equal((await h.dispatcher.sendToAddress({ ...answer, text: '   ' })).sent, false)
    assert.equal((await h.dispatcher.sendToAddress({ ...answer, text: 7 })).sent, false)
    assert.deepEqual(h.sends(), [])
  })

  test("a send Jig refuses is not sent, with Jig's reason and all it printed", async () => {
    const stderr =
      'jig send: refused: PRRT_kwDOa1 is already answered by a trusted comment after its park; a second answer is not sent\n'
    const h = parkHarness({ sendResult: () => ({ code: 1, stdout: '', stderr }) })
    const result = await h.dispatcher.sendToAddress(answer)
    assert.deepEqual(result, {
      sent: false,
      why: 'refused: PRRT_kwDOa1 is already answered by a trusted comment after its park; a second answer is not sent',
      printed: stderr.trimEnd()
    })
  })

  test("a write that fails after the plan printed is not sent, and shows the plan", async () => {
    const plan = sentOutput().split('\n').slice(0, 8).join('\n')
    const h = parkHarness({
      sendResult: () => ({ code: 1, stdout: `${plan}\n`, stderr: 'jig send: not sent: gh: HTTP 502\n' })
    })
    const result = await h.dispatcher.sendToAddress(answer)
    assert.equal(result.sent, false)
    assert.equal(result.why, 'not sent: gh: HTTP 502')
    assert.match(result.printed, /writes as {2}liqweed/)
  })

  test('a session the line started is refused by Jig, and the panel says so', async () => {
    const stderr =
      "jig send: refused: answer is a person's command, and this session was started by the line (JIG_LAUNCH=20261105T160102Z-web-485); a person sends it from their own session\n"
    const h = parkHarness({ sendResult: () => ({ code: 1, stdout: '', stderr }) })
    const result = await h.dispatcher.sendToAddress(answer)
    assert.equal(result.sent, false)
    assert.match(result.why, /JIG_LAUNCH/)
  })

  test('a jig without jig send is too old', async () => {
    const h = parkHarness({ sendResult: () => ({ ...TOO_OLD, stderr: 'Error: Unexpected option or subcommand: `send`.\n' }) })
    const result = await h.dispatcher.sendToAddress(answer)
    assert.equal(result.sent, false)
    assert.match(result.why, /this jig has no jig send/)
  })

  test('the rows of what jig send printed, by name', () => {
    const rows = sendRows(sentOutput())
    assert.equal(rows.repository, 'jig-harness/jig')
    assert.equal(rows.sent, 'https://github.com/jig-harness/jig/pull/456#issuecomment-6699001')
  })
})
