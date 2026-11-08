// The panel's requests: `line.get` through the status bar's read, `workspace.open` through the
// workspace map; and the inbox's order and answer line, as the dashboard has them.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ANSWER_BUDGET_BYTES, needPaths, panelAnswer } from '../lib/panel.mjs'
import { LINE_READ_DEADLINE_MS, LINE_REFRESH_MS } from '../lib/status-bar.mjs'
import { addressListHtml, threadHtml } from '../panel/src/addresses.mjs'
import { answerLine, boxKey, questionBoxHtml } from '../panel/src/answer.mjs'
import { groups, panelHtml } from '../panel/src/inbox.mjs'
import { openableUrl } from '../panel/src/util.mjs'
import { askFixture, fixtureAnswer, harness, lineAnswer, printed } from './fake-orca.mjs'

const PARK = '/home/me/orca/workspaces/jig/pr-456'

/** The park fixture, its need notified in the workspace that holds the drive. */
function parkAnswer() {
  const answer = fixtureAnswer('park-three-decisions')
  answer.value.line.needs[0].notified = { at: answer.value.now, outcome: 'sent', workspace: PARK }
  return answer
}

/** Waits until `count` line reads have started. */
async function readsStarted(h, count) {
  for (let i = 0; i < 50 && h.lineReads().length < count; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.lineReads().length, count)
}

const row = (id, path, extra = {}) => ({ id, kind: 'worktree', name: id, path, branch: null, hostId: null, ...extra })

describe('the panel worker', () => {
  test('line.get gives the fixture line with each decision, and the workspaces Orca can open', async () => {
    const h = harness({ lineResult: printed(parkAnswer()), list: [row('wt-456', PARK)] })
    const answer = await h.dispatcher.getLine({})
    assert.equal(answer.state, 'line')
    assert.equal(answer.now, '2026-11-05T16:47:30.000Z')
    assert.equal(answer.line.runId, '20261105T164500Z')
    assert.equal(answer.line.needs.length, 1)
    const [need] = answer.line.needs
    assert.equal(need.target, 'PR #456')
    assert.deepEqual(need.decisions.map((d) => d.key), ['PRRT_kwDOa1', 'F-3', 'PRRT_kwDOa4'])
    assert.deepEqual(need.open, [PARK])
    assert.equal(h.lineReads().length, 1)
  })

  test('no line yet', async () => {
    const h = harness({ lineResult: printed(lineAnswer(null)) })
    const answer = await h.dispatcher.getLine({})
    assert.equal(answer.state, 'no-tick')
    assert.equal(answer.line, null)
    assert.match(panelHtml(answer, { nowMs: 0 }), /No tick has run on this host/)
  })

  test('a jig too old for `dispatch line` says so', async () => {
    const h = harness({ lineResult: () => ({ code: 2, stdout: '', stderr: 'unknown command line' }) })
    const answer = await h.dispatcher.getLine({})
    assert.equal(answer.state, 'too-old')
    assert.match(panelHtml(answer, { nowMs: 0 }), /too old for the panel/)
  })

  test('an unreadable line gives its reason', async () => {
    const h = harness({ lineResult: () => ({ code: 1, stdout: '', stderr: 'line-unreadable: not JSON\n' }) })
    const answer = await h.dispatcher.getLine({})
    assert.deepEqual([answer.state, answer.why], ['unreadable', 'line-unreadable: not JSON'])
  })

  test('a workspace Orca does not know gets no button, and opening it says why', async () => {
    const h = harness({ lineResult: printed(parkAnswer()), list: [row('other', '/elsewhere')], canOpen: true })
    const answer = await h.dispatcher.getLine({})
    assert.deepEqual(answer.line.needs[0].open, [])
    assert.doesNotMatch(panelHtml(answer, { nowMs: Date.parse(answer.now) }), /data-open-workspace/)
    const result = await h.dispatcher.openWorkspace({ path: PARK })
    assert.deepEqual(result, { opened: false, why: `Orca knows no workspace at ${PARK}.` })
    assert.deepEqual(h.opened, [])
  })

  test('workspace.open shows the workspace by the id workspace.list gives its path', async () => {
    const h = harness({ list: [row('remote', PARK, { hostId: 'ssh:box' }), row('wt-456', PARK)], canOpen: true })
    assert.deepEqual(await h.dispatcher.openWorkspace({ path: PARK }), { opened: true })
    assert.deepEqual(h.opened, ['wt-456'], 'the local workspace, not another host’s at the same path')
  })

  test('an Orca without workspace.open opens nothing', async () => {
    const h = harness({ list: [row('wt-456', PARK)] })
    const result = await h.dispatcher.openWorkspace({ path: PARK })
    assert.equal(result.opened, false)
    assert.match(result.why, /does not let a plugin open a workspace/)
  })

  test('a double claim offers each workspace that holds the item', () => {
    const answer = fixtureAnswer('long-needs')
    const claim = answer.value.line.needs.find((n) => n.cause === 'double-claim')
    assert.deepEqual(needPaths(claim, answer.value.line), claim.workspaces)
    assert.equal(claim.workspaces.length, 2)
  })

  test("a need's own workspace stands over the sessions and the notification", () => {
    const answer = parkAnswer()
    const line = answer.value.line
    const need = { ...line.needs[0], workspace: '/home/me/orca/workspaces/jig/held-here' }
    line.sessions = [{ repo: need.repo, target: need.target, workspace: '/elsewhere/session' }]
    assert.deepEqual(needPaths(need, line), ['/home/me/orca/workspaces/jig/held-here'])
  })

  test('a need whose workspace is null offers none, rather than the notification’s', () => {
    const answer = parkAnswer()
    const need = { ...answer.value.line.needs[0], workspace: null }
    assert.equal(need.notified.workspace, PARK)
    assert.deepEqual(needPaths(need, answer.value.line), [])
  })

  test('a double claim with no named workspace still offers the workspaces that hold it', () => {
    const claim = { ...fixtureAnswer('long-needs').value.line.needs.find((n) => n.cause === 'double-claim'), workspace: null }
    assert.deepEqual(needPaths(claim, { sessions: [] }), claim.workspaces)
  })

  test('a line from before Jig named the workspace falls back to the notification’s', () => {
    const answer = parkAnswer()
    const [need] = answer.value.line.needs
    assert.equal(Object.hasOwn(need, 'workspace'), false, 'the fixture is a line from before the field')
    assert.deepEqual(needPaths(need, answer.value.line), [PARK])
  })

  test('the line is read once for concurrent requests, and kept for a minute', async () => {
    const h = harness({ statusBar: true, holdLines: true })
    const first = h.dispatcher.getLine({})
    const second = h.dispatcher.getLine({})
    await readsStarted(h, 1)
    h.releaseLine()
    const answers = await Promise.all([first, second])
    assert.deepEqual(answers.map((a) => a.state), ['line', 'line'])
    assert.equal(h.lineReads().length, 1)
    assert.equal(h.items.length, 1, 'the same read updated the status bar')
    assert.deepEqual(h.posts, [['line.changed', {}]])

    h.clock.advance(LINE_REFRESH_MS - 1)
    const kept = h.dispatcher.getLine({})
    assert.equal((await kept).state, 'line')
    assert.equal(h.lineReads().length, 1, 'a read under a minute old is reused')

    const fresh = h.dispatcher.getLine({ fresh: true })
    await readsStarted(h, 2)
    h.releaseLine()
    await fresh
    assert.equal(h.lineReads().length, 2, '`fresh` reads again')
  })

  test('an Orca without a status bar still reads the line for the panel', async () => {
    const h = harness()
    assert.equal((await h.dispatcher.getLine({})).state, 'line')
    assert.equal(h.lineReads().length, 1)
    assert.equal(h.items.length, 0)
  })

  test('a read past its deadline answers the panel as unreadable', async () => {
    const h = harness({ holdLines: true })
    const pending = h.dispatcher.getLine({})
    await new Promise((resolve) => setImmediate(resolve))
    h.clock.advance(LINE_READ_DEADLINE_MS)
    const answer = await pending
    assert.equal(answer.state, 'unreadable')
    assert.match(answer.why, /ran past 30s/)
  })

  test('after dispose a waiting request is answered, not left hanging', async () => {
    const h = harness({ holdLines: true })
    const pending = h.dispatcher.getLine({})
    await new Promise((resolve) => setImmediate(resolve))
    h.dispatcher.dispose()
    h.releaseLine()
    assert.equal((await pending).state, 'unreadable')
  })
})

describe('the panel answer', () => {
  const idAt = async () => null
  /** A `lineAnswer` for the fixture `scenario`, as the status bar keeps it. */
  const kept = (answer, extra = {}) => ({ state: 'line', value: answer.value, ...extra })

  test('a kept answer\'s clock moves on by the time since its read', async () => {
    const fixture = fixtureAnswer('quiet')
    const said = Date.parse(fixture.value.now)
    const served = await panelAnswer(kept(fixture, { readAt: 1_000 }), idAt, () => 1_000 + 59_000)
    assert.equal(Date.parse(served.now), said + 59_000)
  })

  test('the clock is read after the workspace lookups, which can take a while', async () => {
    const fixture = fixtureAnswer('long-needs')
    const said = Date.parse(fixture.value.now)
    let ms = 1_000
    const slow = async () => {
      ms += 20_000
      return null
    }
    const served = await panelAnswer(kept(fixture, { readAt: 1_000 }), slow, () => ms)
    assert.ok(ms > 1_000, 'the fixture needs a workspace lookup to run')
    assert.equal(Date.parse(served.now), said + (ms - 1_000))
  })

  test('a line carrying no interval gets the one the status bar used', async () => {
    const answer = fixtureAnswer('quiet')
    delete answer.value.line.intervalMs
    assert.equal((await panelAnswer(kept(answer, { intervalMs: 300_000 }), idAt)).line.intervalMs, 300_000)
    assert.equal((await panelAnswer(kept(answer), idAt)).line.intervalMs, null)
  })

  test('decision text over the transport limit is cut, every need and decision kept', async () => {
    const answer = parkAnswer()
    const [need] = answer.value.line.needs
    for (const d of need.decisions) d.lines = Array.from({ length: 200 }, () => 'x'.repeat(10_000))
    const served = await panelAnswer(kept(answer), idAt)
    assert.ok(Buffer.byteLength(JSON.stringify(served)) <= ANSWER_BUDGET_BYTES)
    const [cutNeed] = served.line.needs
    assert.deepEqual(cutNeed.decisions.map((d) => d.key), need.decisions.map((d) => d.key))
    for (const d of cutNeed.decisions) assert.match(d.lines.at(-1), /cut here/)
  })

  test('decision fields other than the lines are cut when the lines alone leave it over', async () => {
    const answer = parkAnswer()
    const [need] = answer.value.line.needs
    for (const d of need.decisions) {
      d.lines = ['a line']
      d.question = 'q'.repeat(300_000)
      d.recommendation = 'r'.repeat(300_000)
    }
    const served = await panelAnswer(kept(answer), idAt)
    assert.ok(Buffer.byteLength(JSON.stringify(served)) <= ANSWER_BUDGET_BYTES)
    const [cutNeed] = served.line.needs
    assert.deepEqual(cutNeed.decisions.map((d) => d.key), need.decisions.map((d) => d.key))
  })

  test('a need whose own text is over the limit is cut, with no decisions at all', async () => {
    const answer = parkAnswer()
    const [need] = answer.value.line.needs
    need.decisions = []
    need.reason = 'r'.repeat(1_100_000)
    const served = await panelAnswer(kept(answer), idAt)
    assert.ok(Buffer.byteLength(JSON.stringify(served)) <= ANSWER_BUDGET_BYTES)
    assert.equal(served.state, 'line')
    assert.equal(served.line.needs.length, 1)
    assert.equal(served.line.needs[0].target, need.target)
    assert.ok(served.line.needs[0].reason.length < 1_100_000)
    assert.ok(!served.line.omitted)
  })

  test('many large needs leave the last out and say so', async () => {
    const answer = parkAnswer()
    const [need] = answer.value.line.needs
    answer.value.line.needs = Array.from({ length: 3_000 }, (_, i) => ({
      ...need,
      decisions: [],
      target: `t${i}`,
      reason: 'r'.repeat(1_000),
      extra: Array.from({ length: 40 }, (_, j) => `field ${j} ${'e'.repeat(100)}`)
    }))
    const served = await panelAnswer(kept(answer), idAt)
    assert.ok(Buffer.byteLength(JSON.stringify(served)) <= ANSWER_BUDGET_BYTES)
    assert.ok(served.line.needs.length > 0 && served.line.needs.length < 3_000)
    assert.match(served.why, /left out/)
    assert.equal(served.line.omitted, 3_000 - served.line.needs.length)
    const html = panelHtml(served, { nowMs: Date.parse(served.now) })
    assert.match(html, /role="alert"/)
    assert.match(html, new RegExp(`${served.line.needs.length + served.line.omitted} need a person`))
  })

  test('clipping leaves paths, urls, times and causes as the line gave them', async () => {
    const answer = parkAnswer()
    const [need] = answer.value.line.needs
    const longPath = `/work/${'p'.repeat(6_000)}`
    need.decisions = []
    need.workspaces = [longPath]
    need.url = `https://example.test/${'u'.repeat(6_000)}`
    need.reason = 'r'.repeat(1_100_000)
    const served = await panelAnswer(kept(answer), async () => 'id')
    const [cut] = served.line.needs
    assert.equal(cut.url, need.url)
    assert.equal(cut.since, need.since)
    assert.equal(cut.cause, need.cause)
    assert.deepEqual(cut.workspaces, [longPath])
    assert.ok(cut.open.includes(longPath))
    assert.ok(cut.reason.length < need.reason.length)
  })

  test('thousands of needs over the limit are bounded without serialising the answer per need', async () => {
    const answer = parkAnswer()
    const [need] = answer.value.line.needs
    answer.value.line.needs = Array.from({ length: 20_000 }, (_, i) => ({
      ...need,
      decisions: [],
      target: `t${i}`,
      reason: 'r'.repeat(100),
      extra: 'e'.repeat(200)
    }))
    const began = Date.now()
    const served = await panelAnswer(kept(answer), idAt)
    assert.ok(Date.now() - began < 5_000)
    assert.ok(Buffer.byteLength(JSON.stringify(served)) <= ANSWER_BUDGET_BYTES)
    assert.ok(served.line.omitted > 0)
  })
})

describe('the inbox', () => {
  test('decisions come before checks, oldest first in each, as on the dashboard', () => {
    const needs = fixtureAnswer('long-needs').value.line.needs
    const [decide, check] = groups(needs)
    assert.equal(decide.head, 'To decide, on the pull request')
    assert.equal(check.head, 'To check')
    assert.ok(decide.needs.every((n) => ['parked', 'needs-person', 'stopped-unknown'].includes(n.cause)))
    assert.equal(decide.needs.length + check.needs.length, needs.length)
    for (const group of [decide, check])
      for (let i = 1; i < group.needs.length; i++)
        assert.ok(Date.parse(group.needs[i - 1].since) <= Date.parse(group.needs[i].since))
  })

  test('the answer line is the one jig send writes: `answer <key>: <text>`', () => {
    assert.equal(answerLine('T1', ' take A '), 'answer T1: take A')
  })

  test('a park on the line opens one answer box per question, to its drive’s address', async () => {
    const h = harness({ lineResult: printed(parkAnswer()) })
    const answer = await h.dispatcher.getLine({})
    const [need] = answer.line.needs
    assert.equal(need.address, 'drive@jig-harness/jig#456')
    const key = `${need.repo} ${need.target} ${need.cause}`
    const closed = panelHtml(answer, { nowMs: Date.parse(answer.now) })
    assert.doesNotMatch(closed, /Copy answer/)
    assert.match(closed, /data-reply=.*>Answer here</)
    assert.match(closed, /data-open-address="drive@jig-harness\/jig#456"/)
    const open = panelHtml(answer, { nowMs: Date.parse(answer.now), replying: new Set([key]) })
    assert.equal(open.match(/data-answer="review"/g).length, 3)
  })

  test('before it sends the box shows the text and the address; after, what jig send said', async () => {
    const h = harness({ lineResult: printed(parkAnswer()) })
    const answer = await h.dispatcher.getLine({})
    const [need] = answer.line.needs
    const replying = new Set([`${need.repo} ${need.target} ${need.cause}`])
    const k = boxKey(need.address, 'PRRT_kwDOa1')
    const draw = (send) => panelHtml(answer, { nowMs: Date.parse(answer.now), replying, sends: new Map([[k, send]]) })
    const review = draw({ stage: 'review', text: 'A, records only' })
    assert.match(review, /Sends to <span class="m">drive@jig-harness\/jig#456<\/span>/)
    assert.match(review, /<pre class="line">answer PRRT_kwDOa1: A, records only<\/pre>/)
    assert.match(review, /data-answer="send"/)
    assert.doesNotMatch(draw({ stage: 'sending', text: 'A' }), /data-answer="send"/)
    const sent = draw({ stage: 'sent', text: 'A', result: { sent: true, wrote: 'https://github.com/jig-harness/jig/pull/456#issuecomment-1', writesAs: 'liqweed', printed: 'sent …' } })
    assert.match(sent, /<b>Sent\.<\/b>/)
    assert.match(sent, /As liqweed\./)
    const failed = draw({ stage: 'failed', text: 'A', result: { sent: false, why: 'refused: <b>no</b>', printed: '' } })
    assert.match(failed, /Not sent:<\/b> refused: &lt;b&gt;no&lt;\/b&gt;/)
    assert.match(failed, /data-draft=/, 'a failed answer can be edited and sent again')
  })

  test('a no-exit stop within its recovery budget is a session being driven again, not a need', async () => {
    // The quiet fixture's line: a re-arm session in a slot and no need.
    const h = harness({ lineResult: printed(fixtureAnswer('quiet')) })
    const answer = await h.dispatcher.getLine({})
    assert.deepEqual([answer.line.sessions, answer.line.needs.length], [1, 0])
    const html = panelHtml(answer, { nowMs: Date.parse(answer.now) })
    assert.match(html, /Nothing needs a person\./)
    assert.match(html, /1 session in a slot/)
    assert.doesNotMatch(html, /class="need"/)
  })

  test('a no-exit stop past its recovery budget waits on a person, under To decide with its reason', async () => {
    const line = fixtureAnswer('long-needs')
    line.value.line.needs = line.value.line.needs.filter((n) => n.cause === 'stopped-unknown')
    const h = harness({ lineResult: printed(line) })
    const answer = await h.dispatcher.getLine({})
    const [need] = answer.line.needs
    assert.match(need.reason, /^repeated no-cause stops: needs a person; /)
    assert.deepEqual(groups(answer.line.needs).map((g) => g.head), ['To decide, on the pull request'])
    const html = panelHtml(answer, { nowMs: Date.parse(answer.now) })
    assert.match(html, /1 needs a person\./)
    assert.match(html, /To decide, on the pull request/)
    assert.match(html, /repeated no-cause stops: needs a person; 3 recovery attempts within one hour/)
    assert.match(html, /Open the pull request/)
  })

  test('only an https link from the line opens', () => {
    assert.equal(openableUrl('https://github.com/jig-harness/jig/pull/456'), 'https://github.com/jig-harness/jig/pull/456')
    for (const url of ['http://github.com/x', 'javascript:alert(1)', 'file:///etc/passwd', null, 'https://'])
      assert.equal(openableUrl(url), null)
  })

  test('text from a pull request is drawn as text', () => {
    const answer = parkAnswer().value
    answer.line.needs[0].title = '<img src=x onerror=alert(1)>'
    const html = panelHtml(
      { state: 'line', now: answer.now, line: { ...answer.line, sessions: 0, queue: 0, needs: answer.line.needs.map((n) => ({ ...n, open: [] })) } },
      { nowMs: Date.parse(answer.now) }
    )
    assert.doesNotMatch(html, /<img/)
    assert.match(html, /&lt;img src=x/)
  })
})

describe('the addresses view', () => {
  const nowMs = Date.parse('2026-11-05T16:47:30.000Z')
  const thread = (value, parked = []) => ({ state: 'answer', address: value.address, value, parked })

  test('the thread lists every entry oldest first, its words quoted apart from Jig’s, each linked to its record', () => {
    const value = askFixture('thread-long')
    const html = threadHtml(thread(value), { nowMs })
    assert.equal(html.match(/<li class="entry/g).length, value.thread.length)
    assert.equal(html.match(/<blockquote class="quoted">/g).length, value.thread.length)
    assert.match(html, /3 earlier entries left out/)
    const kinds = [...html.matchAll(/<span class="kind">(\w+)<\/span>/g)].map((m) => m[1])
    assert.deepEqual(kinds, value.thread.map((e) => e.kind))
    const linked = value.thread.filter((e) => e.record.url).length
    assert.equal(html.match(/class="link m" data-open-url=/g).length, linked)
    assert.doesNotMatch(html, /<!-- not a marker/, "a record's words are text")
    assert.match(html, /&lt;!-- not a marker/)
  })

  test('an empty thread says so, and names what it did not read', () => {
    const html = threadHtml(thread(askFixture('thread-empty')), { nowMs })
    assert.match(html, /No correspondence was read/)
    assert.match(html, /rearm, on this machine, driver generation 2, process alive/)
    assert.match(html, /Not read: <span class="m">dispatch-launch-claim<\/span> \(the comments did not read within 15 seconds\)/)
  })

  test('an omitted empty thread does not claim correspondence is absent', () => {
    const value = { ...askFixture('thread-empty'), threadOmitted: 1 }
    const html = threadHtml(thread(value), { nowMs })
    assert.match(html, /too large to display/)
    assert.doesNotMatch(html, /no record names this address/)
  })

  test('a thread the line has parked shows an answer box per question', () => {
    const value = askFixture('thread-long')
    const html = threadHtml(thread(value, [{ key: 'PRRT_kwDOa1', question: 'Q?' }, { key: 'F-3', question: null }]), { nowMs })
    assert.equal(html.match(/data-answer="review"/g).length, 2)
  })

  test('a jig too old for jig ask says so, in the list and the thread', () => {
    assert.match(addressListHtml({ state: 'too-old', addresses: [] }, { nowMs }), /too old for the addresses/)
    assert.match(threadHtml({ state: 'too-old', address: 'drive@a/b#1' }, { nowMs }), /too old for this address/)
  })

  test('the list opens each address', () => {
    const html = addressListHtml(
      { state: 'list', tick: null, unread: null, addresses: [{ address: 'drive@a/b#1', title: 'T', url: null, waiting: { act: 'answer', since: '2026-11-05T16:00:00Z', reason: 'r', questions: ['a', 'b'] }, held: null }] },
      { nowMs }
    )
    assert.match(html, /1 address with recent activity/)
    assert.match(html, /data-open-address="drive@a\/b#1"/)
    assert.match(html, /waits on you to<\/span> <b>answer<\/b>/)
  })
})

describe('an answer whose delivery is unknown', () => {
  test('offers the way back once the person has checked the pull request', () => {
    const q = { key: 'PRRT_kwDOa1', question: 'Which?' }
    const sends = new Map([[boxKey('drive@a/b#1', q.key), { stage: 'failed', text: 'A', result: { unknown: true, why: 'it timed out.' } }]])
    const html = questionBoxHtml('drive@a/b#1', q, { sends })
    assert.match(html, /Delivery unknown/)
    assert.match(html, /data-answer="edit"/)
  })
})
