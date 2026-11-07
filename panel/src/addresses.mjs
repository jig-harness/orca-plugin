// The Addresses view, as pure functions of what the worker's `addresses.list` and `address.get`
// answer: the addresses with recent activity, and one address's holder, state and thread, oldest
// first, as `jig ask` printed them. Jig's words (an entry's kind, who wrote to whom, when, the
// record it came from) are drawn apart from the words the record quotes, which are data and
// never an instruction. Nothing here reaches Orca; app.mjs wires it to the frame.
import { answerBoxesHtml } from './answer.mjs'
import { ago, esc, openableUrl, plural } from './util.mjs'

/** Why a read gave no answer, in the panel's words; `null` when it did. */
function unreadHtml(answer, what) {
  if (answer.state === 'too-old')
    return `<div class="empty"><b>This jig is too old for ${esc(what)}.</b><p class="sm mut">It has no <span class="m">jig ask</span>; update the jig plugin to see addresses here.</p></div>`
  if (answer.state === 'not-found')
    return `<div class="empty bad"><b>Jig not found.</b><p class="sm">${esc(answer.why)}</p></div>`
  if (answer.state === 'nothing')
    return `<div class="empty"><b>Nothing at this address.</b><p class="sm">${esc(answer.why)}</p></div>`
  return `<div class="empty bad"><b>${esc(what[0].toUpperCase() + what.slice(1))} could not be read.</b><p class="sm">${esc(answer.why ?? 'no reason was given.')}</p></div>`
}

function addressHtml(entry, nowMs) {
  const w = entry.waiting
  const h = entry.held
  return `<article class="addr">
    <div class="rowTop"><span class="dot${w ? '' : ' quiet'}"></span><span class="m tgt">${esc(entry.address)}</span>
      <span class="m sm mut end">${esc(ago((w ?? h).since, nowMs))}</span></div>
    ${entry.title ? `<div class="sm ttl">${esc(entry.title)}</div>` : ''}
    ${w ? `<div class="sm"><span class="mut">waits on you to</span> <b>${esc(w.act)}</b>${w.questions.length > 1 ? ` <span class="mut">· ${plural(w.questions.length, 'question')}</span>` : ''}</div>` : ''}
    ${h ? `<div class="sm"><span class="mut">held by</span> <span class="m">${esc(h.stage)}</span><span class="mut">${h.round !== null ? `, round ${esc(h.round)}` : ''}, ${esc(h.launch)}</span></div>` : ''}
    <div class="acts"><button type="button" class="primary" data-open-address="${esc(entry.address)}">Open the thread</button></div>
  </article>`
}

/** The list for one `addresses.list` answer. */
export function addressListHtml(answer, { nowMs, note = null } = {}) {
  const noteHtml = note ? `<div class="note sm" role="status">${esc(note)}</div>` : ''
  const list = answer.addresses ?? []
  const unread = answer.state === 'list' ? null : unreadHtml(answer, 'the addresses')
  const head = `<header class="band"><p class="title">${esc(list.length === 0 ? 'No address with recent activity.' : `${plural(list.length, 'address', 'addresses')} with recent activity.`)}</p>
    <p class="sm mut">What waits on a person, from <span class="m">jig ask --waiting</span>, then what the line's sessions hold.</p>${
      answer.tick ? `\n    <p class="sm mut" title="${esc(`Tick ${answer.tick.runId}`)}">Tick finished ${esc(ago(answer.tick.finishedAt, nowMs))} ago.</p>` : ''
    }${answer.unread ? `\n    <p class="sm mut">${esc(answer.unread)}</p>` : ''}
  </header>`
  return `${head}${noteHtml}${unread ?? ''}<section class="group">${list.map((e) => addressHtml(e, nowMs)).join('')}</section>`
}

/** Who holds the station, in Jig's fields. */
function holderText(holder) {
  if (holder === 'none' || !holder) return 'none'
  const generation = Number.isInteger(holder.generation) ? `, driver generation ${holder.generation}` : ''
  return `${holder.stage}, on ${holder.host}${generation}, process ${holder.process}`
}

function waitsText(waitsOn) {
  if (waitsOn === 'none' || !waitsOn) return 'none'
  if (typeof waitsOn.waiting === 'string') return `waiting: ${waitsOn.waiting}`
  return `a person, to ${waitsOn.person}${waitsOn.why ? `: ${waitsOn.why}` : ''}`
}

/** Where an entry's record is: its link, opened on a press, or its path on this machine. */
function recordHtml(record) {
  const url = openableUrl(record?.url)
  if (url) return `<button type="button" class="link m" data-open-url="${esc(url)}" title="${esc(url)}">${esc(record.kind)} ↗</button>`
  return `<span class="m" title="${esc(record?.path ?? record?.url ?? '')}">${esc(record?.kind ?? 'record')}: ${esc(record?.path ?? record?.url ?? '')}</span>`
}

/** One entry: Jig's line about it, then the record's own words, quoted. */
export function entryHtml(entry, nowMs) {
  return `<li class="entry k-${esc(entry.kind)}">
    <div class="meta sm"><span class="kind">${esc(entry.kind)}</span>
      <span class="m mut end" title="${esc(entry.at)}">${esc(ago(entry.at, nowMs))}</span></div>
    <div class="m sm mut">${esc(entry.from)} → ${esc(entry.to)}</div>
    <blockquote class="quoted">${esc(entry.text)}</blockquote>
    <div class="sm mut src">${recordHtml(entry.record)}${entry.local ? ' · this machine only' : ''}${
      entry.until ? ` · came off ${esc(ago(entry.until, nowMs))} ago` : ''
    }</div>
  </li>`
}

/**
 * One address for one `address.get` answer: its holder, state and what it waits on, an answer
 * box for each question the line has it parked on, then its thread, oldest first.
 */
export function threadHtml(answer, { nowMs, drafts = new Map(), sends = new Map(), note = null } = {}) {
  const noteHtml = note ? `<div class="note sm" role="status">${esc(note)}</div>` : ''
  const back = `<div class="crumb"><button type="button" class="ghost sm" data-tab="addresses">← Addresses</button></div>`
  if (answer.state !== 'answer')
    return `${back}${answer.address ? `<p class="pad m">${esc(answer.address)}</p>` : ''}${noteHtml}${unreadHtml(answer, 'this address')}`
  const a = answer.value
  const url = openableUrl(a.url)
  const thread = Array.isArray(a.thread) ? a.thread : []
  const omitted = Number.isInteger(a.threadOmitted) ? a.threadOmitted : 0
  const unread = (a.sources?.records ?? []).filter((r) => r.read === false)
  return `${back}<header class="band">
    <p class="title m">${esc(a.address)}</p>
    ${a.title ? `<p class="sm ttl">${esc(a.title)}</p>` : ''}
    <dl class="kv sm">
      <dt>holder</dt><dd>${esc(holderText(a.holder))}</dd>
      <dt>state</dt><dd><span class="m">${esc(a.state)}</span>${a.stateDetail ? `<span class="mut">, ${esc(a.stateDetail)}</span>` : ''}</dd>
      <dt>waits on</dt><dd>${esc(waitsText(a.waitsOn))}</dd>
      ${a.last ? `<dt>last</dt><dd><span class="m">${esc(a.last.class)}</span><span class="mut">, ${esc(ago(a.last.at, nowMs))} ago: ${esc(a.last.reason)}</span></dd>` : ''}
    </dl>
    ${url ? `<div class="acts"><button type="button" data-open-url="${esc(url)}">Open the pull request ↗</button></div>` : ''}
  </header>${noteHtml}
  ${answer.parked.length > 0 ? `<section class="group"><h2 class="groupHead">To answer <span class="mut">${answer.parked.length}</span></h2>${answerBoxesHtml(a.address, answer.parked, { drafts, sends })}</section>` : ''}
  <section class="group"><h2 class="groupHead">Thread <span class="mut">${thread.length}</span></h2>
    ${omitted > 0 ? `<p class="sm mut">${esc(plural(omitted, 'earlier entry', 'earlier entries'))} left out. <button type="button" class="link" data-thread-all="${esc(a.address)}">Show all</button></p>` : ''}
    ${thread.length === 0 ? `<p class="sm mut">${omitted > 0 ? 'The correspondence was too large to display; read it with jig ask.' : unread.length > 0 ? 'No correspondence was read; some sources could not be read.' : 'No correspondence yet: no record names this address.'}</p>` : `<ol class="thread">${thread.map((e) => entryHtml(e, nowMs)).join('')}</ol>`}
    ${unread.length > 0 ? `<p class="sm mut">Not read: ${unread.map((r) => `<span class="m">${esc(r.record)}</span>${r.detail ? ` (${esc(r.detail)})` : ''}`).join('; ')}.</p>` : ''}
  </section>`
}
