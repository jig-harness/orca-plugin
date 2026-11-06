// The panel in Orca's frame: asks the worker for the line, draws the inbox, and answers its
// buttons. The pull request opens through `orca.shell.openExternal`, which needs the click; the
// workspace opens through the worker; the answer line is copied here. Drafts live only in this
// page, so the panel stores nothing.
import { answerKeys, answerText, draftKey, needKey, openableUrl, panelHtml } from './inbox.mjs'

/** How often the open panel reads again when no tick told it to. */
const POLL_MS = 60_000
/** The worker's read may run 30 s; the request waits a little longer. */
const REQUEST_TIMEOUT_MS = 45_000

const orca = window.orca
const app = document.getElementById('app')

const view = {
  answer: null,
  /** `performance.now()` at the read, so the line's clock moves on with this page's. */
  readAt: 0,
  drafts: new Map(),
  replying: new Set(),
  folds: new Map(),
  note: null,
  pending: false
}

const request = (name, input) => orca.plugin.request(name, input, { timeoutMs: REQUEST_TIMEOUT_MS })

function nowMs() {
  const said = Date.parse(view.answer?.now ?? '')
  return Number.isFinite(said) ? said + (performance.now() - view.readAt) : Date.now()
}

function render() {
  // A redraw would take the cursor out of a reply being typed; it waits for the box to lose focus.
  if (document.activeElement?.tagName === 'TEXTAREA' && app.contains(document.activeElement)) {
    view.pending = true
    return
  }
  view.pending = false
  if (!view.answer) return
  for (const fold of app.querySelectorAll('details[data-fold]')) view.folds.set(fold.dataset.fold, fold.open)
  app.innerHTML = panelHtml(view.answer, {
    nowMs: nowMs(),
    drafts: view.drafts,
    replying: view.replying,
    note: view.note
  })
  for (const fold of app.querySelectorAll('details[data-fold]'))
    if (view.folds.has(fold.dataset.fold)) fold.open = view.folds.get(fold.dataset.fold)
}

async function load(fresh = false) {
  try {
    const answer = await request('line.get', fresh ? { fresh: true } : {})
    view.answer = answer
    view.readAt = performance.now()
  } catch (error) {
    view.answer = { state: 'unreadable', why: `the worker did not answer (${error?.code ?? 'error'}: ${error?.message ?? error}).` }
  }
  render()
}

function needOf(key) {
  return view.answer?.line?.needs.find((n) => needKey(n) === key) ?? null
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
  if (d.copyAnswer !== undefined) {
    const need = needOf(d.copyAnswer)
    if (!need) return
    const keys = answerKeys(need)
    const text = answerText(keys, keys.map((k) => view.drafts.get(draftKey(need, k)) ?? ''))
    return say(copy(text) ? `Copied the answer line for ${need.target}.` : 'The frame refused the copy.')
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

document.getElementById('refresh')?.addEventListener('click', () => {
  view.note = null
  load(true)
})

orca.plugin.on?.('line.changed', () => load())
setInterval(() => load(), POLL_MS)
app.innerHTML = '<p class="sm mut pad">Reading the line…</p>'
load()
