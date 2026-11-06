// The panel's requests: `line.get` through the status bar's read, `workspace.open` through the
// workspace map; and the inbox's order and answer line, as the dashboard has them.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ANSWER_BUDGET_BYTES, needPaths, panelAnswer } from '../lib/panel.mjs'
import { LINE_READ_DEADLINE_MS, LINE_REFRESH_MS } from '../lib/status-bar.mjs'
import { answerText, groups, openableUrl, panelHtml } from '../panel/src/inbox.mjs'
import { fixtureAnswer, harness, lineAnswer, printed } from './fake-orca.mjs'

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
    const served = await panelAnswer(kept(fixture, { readAt: 1_000 }), idAt, 1_000 + 59_000)
    assert.equal(Date.parse(served.now), said + 59_000)
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
    assert.ok(Buffer.byteLength(JSON.stringify(served)) <= ANSWER_BUDGET_BYTES + 1000)
    const [cutNeed] = served.line.needs
    assert.deepEqual(cutNeed.decisions.map((d) => d.key), need.decisions.map((d) => d.key))
    for (const d of cutNeed.decisions) assert.match(d.lines.at(-1), /cut here/)
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

  test('the answer line is the dashboard’s: one `answer <key>: …` per decision', () => {
    assert.equal(answerText(['T1', 'F-3'], [' take A ', '']), 'answer T1: take A\n\nanswer F-3: ')
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
