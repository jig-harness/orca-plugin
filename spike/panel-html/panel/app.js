// Spike: the Jig panel as an HTML page in Orca's frame (`ui: "html"`).
// Views: Inbox (landing), Board (three layouts), Addresses with one thread.
// Buttons are wired to nothing: they ask the worker's `act` handler, which
// only says what it would do. Ages are measured against the fixture's `now`.
const orca = window.orca
const app = document.getElementById('app')
const editor = document.documentElement.dataset.surface === 'editor'

const ui = { view: 'inbox', layout: 'strip', column: 'ready', address: 'drive@jig#456', note: null }
let state = null
let thread = null
/** Reply drafts by decision key, for this page's life only: the panel stores nothing. */
const drafts = new Map()

const request = (name, input) => orca.plugin.request(name, input, { timeoutMs: 10_000 })

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function age(fromIso) {
  const min = Math.max(0, Math.round((Date.parse(state.now) - Date.parse(fromIso)) / 60_000))
  if (min < 60) return `${min}m`
  if (min < 48 * 60) return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`
  return `${Math.floor(min / 1440)}d`
}

const shortRepo = (repo) => repo.split('/')[1] ?? repo
const stationOf = (n) => (n.stage === 'followup' ? 'followup' : n.stage === 'pickup' ? 'pickup' : 'drive')
const addressOf = (n) => `${stationOf(n)}@${shortRepo(n.repo)}#${n.pr ?? n.item}`

/** Just enough Markdown for a framed decision: headings, bullets, bold and code. */
function md(lines) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  let html = ''
  let list = false
  for (const line of lines) {
    const bullet = /^- (.*)/.exec(line)
    if (!bullet && list) {
      html += '</ul>'
      list = false
    }
    if (/^## /.test(line)) html += `<h4>${inline(line.slice(3))}</h4>`
    else if (bullet) {
      if (!list) html += '<ul>'
      list = true
      html += `<li>${inline(bullet[1])}</li>`
    } else if (line.trim()) html += `<p>${inline(line)}</p>`
  }
  return html + (list ? '</ul>' : '')
}

const CAUSE = {
  parked: ['Parked', 'accent'],
  'needs-person': ['Needs a person', 'warn'],
  'stopped-unknown': ['Stopped, unknown', 'bad'],
  'followup-failed': ['Follow-up failed', 'bad'],
  'nudge-unanswered': ['Nudge unanswered', 'warn'],
  stalled: ['Stalled pickup', 'warn'],
  'double-claim': ['Double claim', 'bad'],
  'assigner-cannot-write': ['Assigner cannot write', 'mut']
}
const FLOW = [
  ['coming', 'Coming'],
  ['picking-up', 'Picking up'],
  ['driven', 'Driven'],
  ['needs-you', 'Needs you'],
  ['ready', 'Ready to merge'],
  ['merged', 'Merged']
]
const PHONE_ORDER = ['ready', 'needs-you', 'driven', 'picking-up', 'coming', 'merged']
const LANES = [
  ['merge-now', 'Merge now'],
  ['approve-first', 'Approve first'],
  ['update-next', 'Update next']
]

function needHtml(n) {
  const [label, tone] = CAUSE[n.cause] ?? [n.cause, 'mut']
  const addr = addressOf(n)
  const decisions = n.decisions
    .map(
      (d, i) => `
      <details class="decision" ${i === 0 ? 'open' : ''}>
        <summary><span class="q">${esc(d.question ?? `Decision ${d.key}`)}</span>
          <span class="chips"><span class="chip">${esc(d.decisionClass ?? 'unclassed')}</span><span class="m sm mut">${esc(d.key)}</span></span></summary>
        ${d.lines.length ? `<div class="md">${md(d.lines)}</div>` : '<p class="sm mut">The drive framed no question for this decision.</p>'}
        <label class="reply"><span class="sm mut">Reply to <span class="m">${esc(d.key)}</span></span>
          <textarea rows="2" data-key="${esc(d.key)}" placeholder="Your answer, such as an option and why">${esc(drafts.get(d.key) ?? '')}</textarea></label>
      </details>`
    )
    .join('')
  return `
    <article class="need">
      <div class="top"><span class="dot ${tone}"></span><span class="tgt">${esc(n.target)}</span>
        <span class="title">${esc(n.title ?? '')}</span><span class="m sm mut end">${age(n.since)}</span></div>
      <div class="sub sm mut"><span class="m">${esc(shortRepo(n.repo))}</span> · <span class="chip ${tone}">${esc(label)}</span> · ${esc(n.stage)}${
        n.decisions.length ? ` · <b>${n.decisions.length} to answer</b>` : ''
      }</div>
      <blockquote class="quoted sm">${esc(n.reason)}</blockquote>
      ${decisions}
      <div class="acts">
        ${n.decisions.length ? `<button class="primary" data-act="send answer" data-target="${esc(addr)}">Send answer</button><button data-copy="${esc(n.decisions.map((d) => d.key).join(' '))}">Copy answer</button>` : ''}
        ${n.url ? `<button data-act="open the pull request" data-target="${esc(n.url)}">${n.pr ? 'Pull request' : 'Tracker'} ↗</button>` : ''}
        <button data-act="open the workspace" data-target="${esc(addr)}">Workspace</button>
        <button class="ghost" data-thread="${esc(addr)}">Thread</button>
      </div>
    </article>`
}

const MARK = {
  none: ['no conflicts', 'ok'],
  conflicting: ['conflicting', 'bad'],
  behind: ['behind', 'warn'],
  green: ['checks green', 'ok'],
  running: ['checks running', 'mut'],
  failing: ['checks failing', 'bad'],
  'merge-now': ['merge now', 'ok'],
  'approve-first': ['approve first', 'accent'],
  'update-next': ['update next', 'warn'],
  'not-ready': ['not ready', 'mut']
}
const mark = (key) => {
  const [text, tone] = MARK[key] ?? [key, 'mut']
  return `<span class="mk ${tone}" title="${esc(text)}"><i></i>${esc(text)}</span>`
}

function cardHtml(c) {
  const s = c.status
  return `
    <div class="card ${c.waitsOn.kind === 'person' ? 'person' : ''}">
      <div class="top"><span class="tgt">${esc(shortRepo(c.repo))} ${esc(c.target)}</span><span class="m sm mut end">${age(c.enteredAt)}</span></div>
      <div class="title sm">${esc(c.title)}</div>
      ${c.previous ? `<div class="back sm">↩ was ${esc(c.previous.column)}${c.previous.lane ? ` · ${esc(c.previous.lane)}` : ''} ${esc(c.previous.was)}: ${esc(c.previous.cause)}</div>` : ''}
      ${s ? `<div class="marks">${mark(s.conflicts)}${mark(s.checks)}<span class="mk ${s.threads ? 'warn' : 'mut'}"><i></i>${s.threads} threads</span>${mark(s.merge)}</div>` : ''}
      <div class="foot sm"><span class="${c.waitsOn.kind === 'person' ? 'you' : 'mut'}">${
        c.waitsOn.kind === 'person' ? `You: ${esc(c.waitsOn.act)}` : `Waits for ${esc(c.waitsOn.what)}`
      }</span>${c.lane === 'merge-now' ? `<button class="primary xs" data-act="merge" data-target="${esc(c.key)}">Merge</button>` : ''}</div>
    </div>`
}

function columnBody(cards, id) {
  const inCol = cards.filter((c) => c.column === id)
  if (id !== 'ready') return inCol.map(cardHtml).join('')
  return LANES.map(([lane, label]) => {
    const inLane = inCol.filter((c) => c.lane === lane)
    return inLane.length ? `<div class="lane sm">${label} · ${inLane.length}</div>${inLane.map(cardHtml).join('')}` : ''
  }).join('')
}

function boardHtml() {
  const cards = state.line.board?.cards ?? []
  const count = (id) => cards.filter((c) => c.column === id).length
  const layouts = editor
    ? ''
    : `<div class="seg sm" role="tablist">${[
        ['strip', 'Strip'],
        ['stacked', 'Stacked'],
        ['columns', 'Six columns']
      ]
        .map(([id, label]) => `<button role="tab" aria-selected="${ui.layout === id}" data-layout="${id}">${label}</button>`)
        .join('')}</div>`
  if (ui.layout === 'columns' || editor) {
    return `${layouts}<div class="cols">${FLOW.map(
      ([id, label]) => `<section class="col ${count(id) ? '' : 'empty'} ${id === 'ready' ? 'readycol' : ''}">
        <h3 class="sm">${label} <span class="mut">${count(id)}</span></h3>${columnBody(cards, id)}</section>`
    ).join('')}</div>`
  }
  if (ui.layout === 'stacked') {
    return `${layouts}${PHONE_ORDER.map((id) => {
      const [, label] = FLOW.find(([c]) => c === id)
      return `<details class="stack" ${count(id) && count(id) <= 6 ? 'open' : ''}><summary class="sm"><b>${label}</b> <span class="mut">${count(id)}</span></summary>${columnBody(cards, id)}</details>`
    }).join('')}`
  }
  // The strip: the six columns as one row of counts in flow order; one column's cards below.
  return `${layouts}<div class="strip" role="tablist">${FLOW.map(
    ([id, label]) => `<button role="tab" class="${id === 'ready' ? 'readycol' : ''}" aria-selected="${ui.column === id}" data-column="${id}">
      <b>${count(id)}</b><span>${label}</span></button>`
  ).join('')}</div>
  <div class="colbody">${columnBody(cards, ui.column) || '<p class="sm mut pad">Nothing in this column.</p>'}</div>`
}

function inboxHtml() {
  const l = state.line
  const ready = (l.board?.cards ?? []).filter((c) => c.column === 'ready')
  const rank = (n) => (n.cause === 'parked' ? 0 : 1)
  const needs = [...l.needs].sort((a, b) => rank(a) - rank(b) || Date.parse(a.since) - Date.parse(b.since))
  if (!needs.length && !ready.length) return '<div class="empty-state"><b>Nothing waits on you</b><p class="sm mut">The line runs on its own.</p></div>'
  const readyBlock = ready.length
    ? `<details class="stack" ${needs.length ? '' : 'open'}><summary class="sm"><b>Ready to merge</b> <span class="mut">${ready.length}</span>
        <span class="sm mut">· ${LANES.map(([lane, label]) => `${ready.filter((c) => c.lane === lane).length} ${label.toLowerCase()}`).join(' · ')}</span></summary>${columnBody(ready, 'ready')}</details>`
    : ''
  const decisionsN = needs.reduce((n, x) => n + x.decisions.length, 0)
  return `${readyBlock}<div class="grouphead sm mut">${needs.length} needs · ${decisionsN} decisions to answer</div>${needs.map(needHtml).join('')}`
}

const KIND = { request: 'accent', question: 'warn', answer: 'ok', outcome: 'mut', launch: 'mut' }

function threadHtml() {
  const l = state.line
  const known = new Map()
  for (const n of l.needs) known.set(addressOf(n), n.title ?? '')
  for (const c of l.board?.cards ?? []) known.set(c.address, c.title ?? '')
  if (!known.has(ui.address)) known.set(ui.address, '')
  const list = `<details class="stack addrs"><summary class="sm"><b>Addresses</b> <span class="mut">${known.size} with recent activity</span></summary>
    <ul class="addrlist">${[...known]
      .map(([a, t]) => `<li><button class="${a === ui.address ? 'current' : ''}" data-thread="${esc(a)}"><span class="m">${esc(a)}</span><span class="sm mut">${esc(t)}</span></button></li>`)
      .join('')}</ul></details>`
  if (!thread) return `${list}<div class="empty-state"><b class="m">${esc(ui.address)}</b><p class="sm mut">No thread for this address in the fixtures.</p></div>`
  const t = thread
  const h = t.holder
  const entries = t.thread
    .map((e) => {
      const back = e.inReplyTo ? ` <span class="mut">↳ ${esc(e.inReplyTo)}</span>` : ''
      const via = e.via && e.via !== t.address ? `<span class="via m">${esc(e.via)}</span>` : ''
      const quoted = !e.quoted
        ? ''
        : e.kind === 'question'
          ? `<details class="decision"><summary class="sm">The decision as recorded</summary><div class="md">${md(e.quoted.text.split('\n'))}</div></details>`
          : `<blockquote class="quoted sm">${esc(e.quoted.text)}</blockquote>`
      const link = e.record.url
        ? `<a class="sm" href="#" data-act="open the record" data-target="${esc(e.record.url)}">${esc(e.record.kind)} ${esc(e.record.id)} ↗</a>`
        : `<span class="sm mut m">${esc(e.record.kind)} ${esc(e.record.id)}</span>`
      return `<li class="entry ${e.kind}"><span class="rail ${KIND[e.kind]}"></span>
        <div class="top sm"><span class="chip ${KIND[e.kind]}">${esc(e.kind)}</span><span class="who">${esc(e.from.name)} → ${esc(e.to.name)}</span><span class="m mut end">${age(e.at)}</span></div>
        <div class="sum">${esc(e.summary)}${back}</div>${via}${quoted}${link}</li>`
    })
    .join('')
  return `${list}
    <section class="thread">
      <h2 class="m">${esc(t.address)}</h2>
      <div class="sm">${esc(t.target.title)} <span class="mut">(${esc(t.target.state)})</span></div>
      <dl class="kv sm">
        <dt>Holder</dt><dd>${h ? `${esc(h.state)}${h.launch ? ` · <span class="m">${esc(h.launch)}</span>` : ''}` : 'nobody'}</dd>
        ${h?.account ? `<dt>Account</dt><dd>${esc(h.account)} on ${esc(h.host)}</dd>` : ''}
        <dt>Waits on</dt><dd class="${t.waitsOn.kind === 'person' ? 'you' : ''}">${t.waitsOn.kind === 'person' ? `you: ${esc(t.waitsOn.act)}` : esc(t.waitsOn.what)}</dd>
        ${t.reads.some((r) => !r.ok) ? `<dt>Not read</dt><dd>${t.reads.filter((r) => !r.ok).map((r) => esc(r.source)).join(', ')}</dd>` : ''}
      </dl>
      <div class="acts"><button data-act="open the pull request" data-target="${esc(t.target.url)}">Pull request ↗</button>
        <button data-act="open the workspace" data-target="${esc(t.address)}">Workspace</button></div>
      <div class="grouphead sm mut">Thread · ${t.thread.length} entries, oldest first</div>
      <ol class="entries">${entries}</ol>
    </section>`
}

function render() {
  if (!state) return
  const l = state.line
  const asks = l.needs.length
  const ready = (l.board?.cards ?? []).filter((c) => c.column === 'ready').length
  const views = [
    ['inbox', `Inbox <span class="n">${asks}</span>`],
    ['board', 'Board'],
    ['thread', 'Addresses']
  ]
  const body = editor ? boardHtml() : ui.view === 'board' ? boardHtml() : ui.view === 'thread' ? threadHtml() : inboxHtml()
  app.innerHTML = `
    <header class="bar">
      <span class="pill ${asks ? 'warn' : 'ok'}">${asks} ask you</span><span class="pill ${ready ? 'accent' : 'mut'}">${ready} ready</span>
      <span class="sm mut end">tick ${age(l.startedAt)} ago</span>
    </header>
    ${editor ? '' : `<nav class="tabs" role="tablist">${views.map(([id, label]) => `<button role="tab" aria-selected="${ui.view === id}" data-view="${id}">${label}</button>`).join('')}</nav>`}
    ${ui.note ? `<div class="note sm">${esc(ui.note)}</div>` : ''}
    <div class="body">${body}</div>`
}

async function openThread(address) {
  ui.address = address
  ui.view = 'thread'
  thread = await request('thread.get', { address })
  render()
}

app.addEventListener('input', (event) => {
  const key = event.target?.dataset?.key
  if (key) drafts.set(key, event.target.value)
})
app.addEventListener('click', async (event) => {
  const el = event.target.closest('button, a')
  if (!el) return
  const d = el.dataset
  if (el.tagName === 'A') event.preventDefault()
  if (d.view) ui.view = d.view
  else if (d.layout) ui.layout = d.layout
  else if (d.column) ui.column = d.column
  else if (d.thread) return openThread(d.thread)
  else if (d.copy) {
    // The frame refuses navigator.clipboard; execCommand works inside a click.
    const text = d.copy.split(' ').map((k) => `answer ${k}: ${(drafts.get(k) ?? '').trim()}`).join('\n\n')
    const area = Object.assign(document.createElement('textarea'), { value: text })
    document.body.append(area)
    area.select()
    ui.note = document.execCommand('copy') ? 'Copied the answer lines.' : 'The frame refused the copy.'
    area.remove()
  } else if (d.act) ui.note = (await request('act', { act: d.act, target: d.target })).would
  render()
})

async function start() {
  try {
    const opening = await request('view.get')
    ui.address = opening.address
    if (opening.view === 'board-stacked') Object.assign(ui, { view: 'board', layout: 'stacked' })
    else if (opening.view === 'board-columns') Object.assign(ui, { view: 'board', layout: 'columns' })
    else ui.view = opening.view
    state = await request('line.get')
    // The strip opens on the first column that waits on the person.
    const cards = state.line.board?.cards ?? []
    ui.column = ['ready', 'needs-you'].find((id) => cards.some((c) => c.column === id)) ?? 'driven'
    thread = await request('thread.get', { address: ui.address })
    render()
  } catch (error) {
    app.innerHTML = `<div class="note bad">The worker did not answer: ${esc(error?.code ?? '')} ${esc(error?.message ?? error)}</div>`
  }
}
start()
