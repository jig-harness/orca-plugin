// The panel in Orca's frame: asks the worker for the line and the addresses, draws the inbox,
// the address list and a thread, and answers their buttons. The pull request opens through
// `orca.shell.openExternal`, which needs the click; the workspace opens through the worker; an
// answer is sent by the worker through `jig send`, and shown as sent only once it says so.
// Drafts live only in this page, so the panel stores nothing.
import { addressListHtml, threadHtml } from './addresses.mjs'
import { boxKey } from './answer.mjs'
import { panelHtml } from './inbox.mjs'
import { esc, openableUrl } from './util.mjs'

/** How often the open panel reads again when no tick told it to. */
const POLL_MS = 60_000
/** The worker's read may run 30 s; the request waits a little longer. */
const REQUEST_TIMEOUT_MS = 45_000
/** One `jig ask` or `jig send` may run 50 s, and wait for one before it; Orca allows 120 s. */
const ADDRESS_TIMEOUT_MS = 110_000

const orca = window.orca
const app = document.getElementById('app')

const view = {
  /** `inbox`, `addresses` or `thread`. */
  tab: 'inbox',
  answer: null,
  /** `performance.now()` at the read, so the line's clock moves on with this page's. */
  readAt: 0,
  list: null,
  thread: null,
  /** The address the thread view shows, and whether all of its thread was asked for. */
  address: null,
  all: false,
  drafts: new Map(),
  /** Each answer box's step, by `boxKey`: review, sending, sent or failed. */
  sends: new Map(),
  replying: new Set(),
  folds: new Map(),
  note: null,
  pending: false
}

const request = (name, input, timeoutMs = REQUEST_TIMEOUT_MS) => orca.plugin.request(name, input, { timeoutMs })

const workerSilent = (error) => `the worker did not answer (${error?.code ?? 'error'}: ${error?.message ?? error}).`

function nowMs() {
  const said = Date.parse(view.answer?.now ?? '')
  return Number.isFinite(said) ? said + (performance.now() - view.readAt) : Date.now()
}

function bodyHtml() {
  const options = { nowMs: nowMs(), drafts: view.drafts, sends: view.sends, note: view.note }
  if (view.tab === 'addresses')
    return view.list ? addressListHtml(view.list, options) : '<p class="sm mut pad">Reading the addresses…</p>'
  if (view.tab === 'thread')
    return view.thread && view.thread.address === view.address
      ? threadHtml(view.thread, options)
      : `<p class="sm mut pad">Reading the thread of <span class="m">${esc(view.address)}</span>…</p>`
  return view.answer ? panelHtml(view.answer, { ...options, replying: view.replying }) : '<p class="sm mut pad">Reading the line…</p>'
}

function render() {
  // A redraw would take the cursor out of an answer being typed; it waits for the box to lose focus.
  if (document.activeElement?.tagName === 'TEXTAREA' && app.contains(document.activeElement)) {
    view.pending = true
    return
  }
  view.pending = false
  for (const tab of document.querySelectorAll('.bar [data-tab]'))
    tab.setAttribute('aria-pressed', String(tab.dataset.tab === (view.tab === 'thread' ? 'addresses' : view.tab)))
  for (const fold of app.querySelectorAll('details[data-fold]')) view.folds.set(fold.dataset.fold, fold.open)
  app.innerHTML = bodyHtml()
  for (const fold of app.querySelectorAll('details[data-fold]'))
    if (view.folds.has(fold.dataset.fold)) fold.open = view.folds.get(fold.dataset.fold)
}

async function loadLine(fresh = false) {
  try {
    view.answer = await request('line.get', fresh ? { fresh: true } : {})
    view.readAt = performance.now()
    if (view.tab === 'thread' && view.address) loadThread(view.address)
  } catch (error) {
    view.answer = { state: 'unreadable', why: workerSilent(error) }
  }
  render()
}

async function loadList(fresh = false) {
  try {
    view.list = await request('addresses.list', fresh ? { fresh: true } : {}, ADDRESS_TIMEOUT_MS)
  } catch (error) {
    view.list = { state: 'unreadable', why: workerSilent(error), addresses: [] }
  }
  render()
}

let threadRead = 0
async function loadThread(address) {
  const generation = ++threadRead
  const all = view.all
  let answer
  try {
    answer = await request('address.get', { address, all }, ADDRESS_TIMEOUT_MS)
  } catch (error) {
    answer = { state: 'unreadable', why: workerSilent(error), address }
  }
  // A thread asked for before the person moved on is not drawn over the one they opened.
  if (view.address !== address || view.all !== all || threadRead !== generation) return
  view.thread = answer
  render()
}

function show(tab) {
  view.tab = tab
  view.note = null
  render()
  if (tab === 'addresses') loadList()
  if (tab === 'inbox') loadLine()
}

function openAddress(address) {
  view.tab = 'thread'
  view.address = address
  view.all = false
  view.thread = null
  view.note = null
  render()
  loadThread(address)
}

/** Copies `text` the one way a frame allows: `execCommand` inside the click. */
function copy(text) {
  const area = Object.assign(document.createElement('textarea'), { value: text })
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  let done = false
  try {
    done = document.execCommand('copy')
  } catch {
    done = false
  }
  area.remove()
  return done
}

function say(note) {
  view.note = note
  render()
}

/** The review, send and edit steps of one answer box. */
function answerStep(step, address, key) {
  const k = boxKey(address, key)
  if (step === 'edit') {
    view.sends.delete(k)
    return render()
  }
  if (step === 'review') {
    const text = (view.drafts.get(k) ?? '').trim()
    if (text === '') return say('Write the answer first.')
    view.sends.set(k, { stage: 'review', text })
    return render()
  }
  const send = view.sends.get(k)
  if (step !== 'send' || send?.stage !== 'review') return
  view.sends.set(k, { stage: 'sending', text: send.text })
  render()
  request('address.send', { address, verb: 'answer', key, text: send.text }, ADDRESS_TIMEOUT_MS)
    .then((result) => {
      view.sends.set(k, { stage: result?.sent === true ? 'sent' : 'failed', text: send.text, result })
      if (result?.sent === true) view.drafts.delete(k)
    })
    .catch((error) =>
      view.sends.set(k, {
        stage: 'failed',
        text: send.text,
        result: { unknown: true, why: `${workerSilent(error)} Whether it was sent is not known: read the pull request before sending again.` }
      })
    )
    .finally(render)
}

app.addEventListener('input', (event) => {
  const key = event.target?.dataset?.draft
  if (key !== undefined) view.drafts.set(key, event.target.value)
})

app.addEventListener('focusout', () => {
  if (view.pending) setTimeout(render, 0)
})

app.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button || !app.contains(button)) return
  const d = button.dataset
  if (d.openUrl !== undefined) {
    const url = openableUrl(d.openUrl)
    if (!url) return say('Only an https link from the line opens.')
    // Called inside the click: Orca opens a link only on the person's own press.
    if (orca.shell?.openExternal)
      orca.shell
        .openExternal(url)
        .then((r) => (r?.opened === false ? say('Not opened.') : undefined))
        .catch((error) => say(`Orca did not open the link: ${error?.message ?? error}`))
    else say(copy(url) ? 'This Orca client opens no links from a panel; the link is copied.' : `Open ${url}`)
    return
  }
  if (d.answer !== undefined) return answerStep(d.answer, d.address, d.key)
  if (d.openAddress !== undefined) return openAddress(d.openAddress)
  if (d.tab !== undefined) return show(d.tab)
  if (d.threadAll !== undefined) {
    view.all = true
    view.thread = null
    render()
    return loadThread(d.threadAll)
  }
  if (d.reply !== undefined) {
    if (view.replying.has(d.reply)) view.replying.delete(d.reply)
    else view.replying.add(d.reply)
    return render()
  }
  if (d.openWorkspace !== undefined) {
    request('workspace.open', { path: d.openWorkspace })
      .then((r) => say(r?.opened ? null : `Not opened: ${r?.why ?? 'no reason was given.'}`))
      .catch((error) => say(`Not opened: ${error?.message ?? error}`))
  }
})

for (const tab of document.querySelectorAll('.bar [data-tab]')) tab.addEventListener('click', () => show(tab.dataset.tab))

document.getElementById('refresh')?.addEventListener('click', () => {
  view.note = null
  if (view.tab === 'addresses') return loadList(true)
  if (view.tab === 'thread') {
    view.thread = null
    render()
    return loadThread(view.address)
  }
  loadLine(true)
})

// The line keeps the inbox, the answer boxes' questions and the ages current; the list follows it.
orca.plugin.on?.('line.changed', () => {
  loadLine()
  if (view.tab === 'addresses') loadList()
})
setInterval(() => loadLine(), POLL_MS)
render()
loadLine()

