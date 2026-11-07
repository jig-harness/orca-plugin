// The inbox, as pure functions of what the worker's `line.get` answers: what needs the person,
// in the order and the words of the dashboard's What needs you (Jig's dashboard/src/needs-view.ts),
// drawn as HTML text. Nothing here reaches Orca; app.mjs wires it to the frame.
import { answerBoxesHtml, boxKey } from './answer.mjs'
import { MINUTE_MS, ago, esc, openableUrl, plural, span } from './util.mjs'

/** The causes a person decides; every other need is one to check. */
const TO_DECIDE = new Set(['parked', 'needs-person', 'stopped-unknown'])

/** Each stage's mark, as the dashboard draws it. */
const STAGES = { pickup: '+', rearm: '↻', takeover: '⇄', followup: '»', notify: '*', steer: '^' }

function recordedWord(need) {
  if (need.cause === 'parked') return 'parked for a person'
  if (need.cause === 'assigner-cannot-write') return 'assigner cannot write'
  return need.cause
}

function goLabel(need) {
  if (need.pr === null) return 'Open in the tracker'
  if (need.cause === 'needs-person') return 'Read the handoff on the pull request'
  if (['followup-failed', 'nudge-unanswered', 'stopped-unknown'].includes(need.cause))
    return 'Open the pull request'
  return 'Answer on the pull request'
}

const byAge = (a, b) => Date.parse(a.since) - Date.parse(b.since)

/** The needs in the dashboard's groups: to decide, then to check, oldest first in each. */
export function groups(needs) {
  return [
    { head: 'To decide, on the pull request', needs: needs.filter((n) => TO_DECIDE.has(n.cause)).sort(byAge) },
    { head: 'To check', needs: needs.filter((n) => !TO_DECIDE.has(n.cause)).sort(byAge) }
  ].filter((g) => g.needs.length > 0)
}

/** The decision keys a person answers, once each. */
export function answerKeys(need) {
  return [...new Set((need.decisions ?? []).map((d) => d.key))]
}

/** A need's key across reads, for its drafts and its open folds. */
export function needKey(need) {
  return `${need.repo} ${need.target} ${need.cause}`
}

/**
 * Enough Markdown for a framed decision: headings, bullets, bold and code. Raw HTML stays text
 * and nothing becomes a link, since the text comes from pull requests.
 */
export function markdown(lines) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  let html = ''
  let list = false
  for (const line of lines) {
    const bullet = /^\s*[-*] (.*)/.exec(line)
    if (!bullet && list) {
      html += '</ul>'
      list = false
    }
    const heading = /^#{1,6} (.*)/.exec(line)
    if (heading) html += `<h4>${inline(heading[1])}</h4>`
    else if (bullet) {
      if (!list) html += '<ul>'
      list = true
      html += `<li>${inline(bullet[1])}</li>`
    } else if (line.trim()) html += `<p>${inline(line)}</p>`
  }
  return html + (list ? '</ul>' : '')
}

/** The head of the inbox: the line's answer to whether anything needs the person, and its tick. */
export function headHtml(answer, nowMs) {
  const { line } = answer
  const needs = line.needs
  const omitted = Number.isInteger(line.omitted) && line.omitted > 0 ? line.omitted : 0
  const total = needs.length + omitted
  const interval = Number.isFinite(line.intervalMs) && line.intervalMs > 0 ? line.intervalMs : null
  const age = nowMs - Date.parse(line.finishedAt)
  const overdue = interval !== null && age > 2 * interval
  let title
  let sub
  if (total > 0) {
    title = total === 1 ? '1 needs a person.' : `${total} need a person.`
  } else {
    title = 'Nothing needs a person.'
  }
  if (needs.length > 0) {
    const ordered = groups(needs).flatMap((g) => g.needs)
    const oldest = Math.min(...needs.map((n) => Date.parse(n.since)))
    sub = `Oldest ${span((nowMs - oldest) / MINUTE_MS)}. First: ${ordered[0].target}, ${recordedWord(ordered[0])}.`
  } else if (omitted > 0) {
    sub = 'None of them fits in the answer.'
  } else {
    sub = `${plural(line.sessions, 'session')} in a slot; ${line.queue > 0 ? `${plural(line.queue, 'item')} queued` : 'queue empty'}.`
  }
  return `<header class="band${total > 0 ? ' loud' : ''}">
    <p class="title">${esc(title)}</p>
    <p class="sm mut">${esc(sub)}</p>${
      omitted > 0
        ? `\n    <p class="sm warn" role="alert">${esc(`${omitted} of ${total} needs are left out because the line is too large to show; read them with jig dispatch dashboard or jig dispatch line --json.`)}</p>`
        : ''
    }
    <p class="sm tick${overdue ? ' overdue' : ' mut'}" title="${esc(`Tick ${line.runId}, finished ${line.finishedAt}`)}">${
      overdue
        ? `Tick overdue: the newest finished ${esc(ago(line.finishedAt, nowMs))} ago, past twice the ${esc(span(interval / MINUTE_MS))} interval.`
        : `Tick finished ${esc(ago(line.finishedAt, nowMs))} ago.`
    }</p>
  </header>`
}

function decisionHtml(need, decision, open) {
  const lines = Array.isArray(decision.lines) ? decision.lines : []
  const named = decision.decisionClass ? `${decision.decisionClass}, ` : ''
  return `<details class="decision" data-fold="${esc(`${needKey(need)}\n${decision.key}`)}"${open ? ' open' : ''}>
    <summary><span class="q">${esc(decision.question ?? `Decision ${decision.key}`)}</span>
      <span class="sm mut"> ${esc(named)}${esc(decision.kind)} <span class="m">${esc(decision.key)}</span></span></summary>
    ${lines.length > 0 ? `<div class="md">${markdown(lines)}</div>` : '<p class="sm mut">The drive framed no question for this decision.</p>'}
  </details>`
}

/** A park's questions, each key once, with the question its first decision under that key frames. */
export function needQuestions(need) {
  return answerKeys(need).map((key) => ({
    key,
    question: (need.decisions ?? []).find((d) => d.key === key)?.question ?? null
  }))
}

/**
 * One need as the inbox draws it. `drafts` and `sends` are the answer boxes' (answer.mjs), and
 * `replying` the keys of the needs whose answer boxes are open. The `first` need, the one the
 * head names, opens its first decision.
 */
export function needHtml(
  need,
  nowMs,
  { drafts = new Map(), sends = new Map(), replying = new Set(), first: isFirst = false } = {}
) {
  // A park's decisions carry its questions and recommendations; any other need says its reason.
  const first = need.decisions?.[0]
  const mark = STAGES[need.stage] ?? ''
  const url = openableUrl(need.url)
  const address = typeof need.address === 'string' && need.address !== '' ? need.address : null
  // An answer goes to the drive's address; a park the line names no address for has no box.
  const keys = address === null ? [] : answerKeys(need)
  const drafted = keys.some((k) => (drafts.get(boxKey(address, k)) ?? '').trim() !== '' || sends.has(boxKey(address, k)))
  const writing = replying.has(needKey(need))
  const open = Array.isArray(need.open) ? need.open : []
  const workspaceButtons = open
    .map(
      (path) =>
        `<button type="button" data-open-workspace="${esc(path)}" title="${esc(path)}">${
          open.length > 1 ? `Open ${esc(path.split('/').filter(Boolean).pop())}` : 'Open the workspace'
        }</button>`
    )
    .join('')
  return `<article class="need" data-need="${esc(needKey(need))}">
    <div class="rowTop"><span class="dot"></span><span class="tgt">${esc(need.target)}</span>
      <span class="m sm mut end">${esc(ago(need.since, nowMs))}</span></div>
    <div class="sm"><span class="m mut">${esc(need.repo)}</span> <span class="stage" title="${esc(need.stage)}">${esc(mark ? `${mark} ${need.stage}` : need.stage)}</span></div>
    ${need.title ? `<div class="sm ttl">${esc(need.title)}</div>` : ''}
    <div class="sm"><span class="m">${esc(recordedWord(need))}</span><span class="mut">${
      first ? esc(`${first.decisionClass ? `, class ${first.decisionClass}` : ''}, ${first.kind}`) : ''
    }</span>${keys.length > 1 ? ` <b>· ${keys.length} to answer</b>` : ''}</div>
    ${first ? '' : `<p class="q">${esc(need.reason)}</p>`}
    <div class="acts">
      ${url ? `<button type="button" class="primary" data-open-url="${esc(url)}">${esc(goLabel(need))} ↗</button>` : ''}
      ${!url && need.url === null ? `<span class="sm mut">No tracker link: look up ${esc(need.target)} in the tracker.</span>` : ''}
      ${keys.length > 0 ? `<button type="button" aria-expanded="${writing}" data-reply="${esc(needKey(need))}">${writing ? 'Hide answer' : drafted ? 'Your answer' : 'Answer here'}</button>` : ''}
      ${address ? `<button type="button" class="ghost" data-open-address="${esc(address)}">Thread</button>` : ''}
      ${workspaceButtons}
    </div>
    ${keys.length > 0 && writing ? answerBoxesHtml(address, needQuestions(need), { drafts, sends }) : ''}
    ${(need.decisions ?? []).length > 0 ? `<div class="decisions">${need.decisions.map((d, i) => decisionHtml(need, d, isFirst && i === 0)).join('')}</div>` : ''}
    <details class="fold" data-fold="${esc(`${needKey(need)}\ndetails`)}"><summary class="sm">Details</summary>
      <dl class="kv sm">
        <dt>since</dt><dd class="m">${esc(need.since)}</dd>
        ${first ? `<dt>reason</dt><dd>${esc(need.reason)}</dd>` : ''}
        ${need.url ? `<dt>link</dt><dd class="m">${esc(need.url)}</dd>` : ''}
        ${need.notified ? `<dt>notified</dt><dd>${esc(need.notified.at ? `${need.notified.at}, to its workspace` : need.notified.outcome)}</dd>` : ''}
        ${(need.workspaces ?? []).map((p, i) => `<dt>workspace ${i + 1}</dt><dd class="m">${esc(p)}</dd>`).join('')}
      </dl>
    </details>
  </article>`
}

/** The whole panel for one `line.get` answer. */
export function panelHtml(answer, { nowMs, drafts = new Map(), sends = new Map(), replying = new Set(), note = null } = {}) {
  const noteHtml = note ? `<div class="note sm" role="status">${esc(note)}</div>` : ''
  if (answer.state === 'no-tick')
    return `${noteHtml}<div class="empty"><b>No tick has run on this host.</b><p class="sm mut">The timer writes the first line at its first tick.</p></div>`
  if (answer.state === 'too-old')
    return `${noteHtml}<div class="empty"><b>This jig is too old for the panel.</b><p class="sm mut">It has no <span class="m">jig dispatch line</span>; update the jig plugin to see the line here.</p></div>`
  if (answer.state === 'not-found')
    return `${noteHtml}<div class="empty bad"><b>Jig not found.</b><p class="sm">${esc(answer.why)}</p></div>`
  if (answer.state !== 'line')
    return `${noteHtml}<div class="empty bad"><b>The line could not be read.</b><p class="sm">${esc(answer.why ?? 'no reason was given.')}</p></div>`
  const ordered = groups(answer.line.needs)
  const lead = ordered[0]?.needs[0]
  const body = ordered
    .map(
      (g) => `<section class="group"><h2 class="groupHead">${esc(g.head)} <span class="mut">${g.needs.length}</span></h2>${g.needs
        .map((n) => needHtml(n, nowMs, { drafts, sends, replying, first: n === lead }))
        .join('')}</section>`
    )
    .join('')
  return `${headHtml(answer, nowMs)}${noteHtml}${body}`
}
