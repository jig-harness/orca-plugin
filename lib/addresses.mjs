// The panel's addresses: the list of addresses with recent activity, an address's holder and
// thread, and an answer to a parked question. The list and the thread are what `jig ask` prints
// (`--waiting`, and `<address> --thread`), beside the line's sessions; an answer is one
// `jig send <address> answer <key> <text>`. The commands and their output are Jig's
// (plugin/README.md, "Asking a station where it stands" and "Telling a station what to do"); the
// worker builds their arguments from fixed fields, and sends only the verbs on its own list.
import { JigCommandError, firstLine } from './jig-command.mjs'
import { LINE_REFRESH_MS } from './status-bar.mjs'

/** How long one `jig ask` may run: Jig gives up on its sources at 45 s and prints without them. */
export const ASK_DEADLINE_MS = 50_000

/** How long one `jig send` may run: it reads the address first, then writes one record. */
export const SEND_DEADLINE_MS = 50_000

/** How long a read waits for the one before it: with its own `ASK_DEADLINE_MS` it stays inside the panel's 110 s. */
export const BUSY_WAIT_MS = 50_000

/** The verbs the panel sends. Every other verb of `jig send` is refused here, before Jig runs. */
export const SEND_VERBS = Object.freeze(['answer'])

const USAGE_EXIT = 2

/**
 * An address as Jig prints one in full, `station@owner/name#key`; nothing else is passed to
 * `jig ask` or `jig send`, so no word the panel hands over can be read as an option.
 */
const ADDRESS = /^(pickup|drive|followup)@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** Whether `text` is an address in full. */
export function isAddress(text) {
  return typeof text === 'string' && ADDRESS.test(text)
}

/**
 * The station a need or a session is about, as `jig ask --waiting` reads a need
 * (Jig's plugin/ask/lib/waiting.ts): a follow-up's, a pick-up's, else a drive's.
 */
function stationOf(stage, item) {
  if (stage === 'followup') return 'followup'
  if (stage === 'pickup') return 'pickup'
  if (stage === 'steer') return item === null ? 'drive' : 'pickup'
  return 'drive'
}

/** The address of a need or a session on the line, or null for one keyed by nothing. */
export function lineAddress(entry) {
  if (!entry || typeof entry.repo !== 'string') return null
  const station = stationOf(entry.stage, entry.item ?? null)
  const raw = station === 'pickup' ? entry.item : Number.isInteger(entry.pr) ? String(entry.pr) : null
  if (typeof raw !== 'string' || raw === '') return null
  const address = `${station}@${entry.repo}#${raw.startsWith('#') ? raw.slice(1) : raw}`
  return isAddress(address) ? address : null
}

/** The parked questions the line names for `address`: each decision's key and question, once each. */
export function parkedQuestions(address, line) {
  const seen = new Set()
  const out = []
  for (const need of line?.needs ?? []) {
    if (lineAddress(need) !== address) continue
    for (const d of need.decisions ?? []) {
      if (typeof d?.key !== 'string' || seen.has(d.key)) continue
      seen.add(d.key)
      out.push({ key: d.key, question: d.question ?? null })
    }
  }
  return out
}

/** Whether a usage error is Jig's own (`jig ask: …`), or an older jig that has no such command. */
function tooOld(read, command) {
  return read.code === USAGE_EXIT && !String(read.stderr ?? '').trimStart().startsWith(`jig ${command}:`)
}

/** Jig's own words for a refusal, without the command's name before them. */
function jigWhy(stderr, command) {
  return firstLine(stderr).replace(new RegExp(`^jig ${command}:\\s*`), '')
}

/**
 * What one run of `jig ask … --json` gave: `state` is `answer` (with `value`), `nothing` (the
 * key names nothing), `too-old`, or `unreadable`, each with `why` where Jig gave one.
 */
export function askAnswer(read, waiting = false) {
  if (read.error)
    return {
      state: 'unreadable',
      why: read.error.code === 'ENOENT' ? 'the jig command was not found' : read.error.message
    }
  if (tooOld(read, 'ask')) return { state: 'too-old' }
  if (read.code === 1) return { state: 'nothing', why: jigWhy(read.stderr, 'ask') || 'the key names nothing' }
  if (read.code !== 0) return { state: 'unreadable', why: jigWhy(read.stderr, 'ask') || `exit ${read.code}` }
  let value = null
  try {
    value = JSON.parse(read.stdout)
  } catch {
    return { state: 'unreadable', why: 'it did not print JSON' }
  }
  if (value?.v !== 1)
    return { state: 'unreadable', why: `its answer is version ${value?.v ?? '?'}, which this plugin does not read; update it.` }
  const valid = waiting
    ? Array.isArray(value.waiting) && value.waiting.every((w) => isAddress(w?.address) && Array.isArray(w.questions) && w.questions.every((q) => typeof q === 'string'))
    : isAddress(value.address) && Array.isArray(value.thread) && Array.isArray(value.sources?.records) && value.thread.every((e) => e && typeof e === 'object') && value.sources.records.every((r) => r && typeof r === 'object')
  if (!valid) return { state: 'unreadable', why: 'its answer has an unreadable shape.' }
  return { state: 'answer', value }
}

const byTime = (key) => (a, b) => (Date.parse(a[key]) || 0) - (Date.parse(b[key]) || 0)

/**
 * The addresses with recent activity: every address `jig ask --waiting` lists, oldest first,
 * then those the line's sessions hold, newest first. An address that waits and is held is listed
 * once, with both.
 */
export function addressList(waiting, line) {
  const out = new Map()
  for (const w of [...(waiting?.waiting ?? [])].sort(byTime('since'))) {
    if (!isAddress(w?.address) || out.has(w.address)) continue
    out.set(w.address, {
      address: w.address,
      title: w.title ?? null,
      url: w.url ?? null,
      waiting: { act: w.act, since: w.since, reason: w.reason, questions: w.questions ?? [] },
      held: null
    })
  }
  for (const s of [...(line?.sessions ?? [])].sort(byTime('createdAt')).reverse()) {
    const address = lineAddress(s)
    if (address === null) continue
    const held = { stage: s.stage, since: s.createdAt, launch: s.launch, round: s.round ?? null }
    const known = out.get(address)
    if (known) {
      known.held ??= held
      continue
    }
    out.set(address, { address, title: s.title ?? null, url: s.url ?? null, waiting: null, held })
  }
  return [...out.values()]
}

/**
 * Keeps a thread within `budget` bytes: its oldest entries go first, and are counted as left
 * out. The bytes counted are those of `frame(value)`, the whole response the value goes into.
 */
export function boundThread(value, budget, frame = (v) => v) {
  const size = (v) => Buffer.byteLength(JSON.stringify(frame(v)))
  if (!Array.isArray(value.thread) || size(value) <= budget) return value
  const omitted = Number.isInteger(value.threadOmitted) ? value.threadOmitted : 0
  let low = 0, high = value.thread.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (size({ ...value, thread: value.thread.slice(mid), threadOmitted: omitted + mid }) <= budget) high = mid
    else low = mid + 1
  }
  return { ...value, thread: value.thread.slice(low), threadOmitted: omitted + low }
}

/** The rows `jig send` prints (`  writes as  …`), by name. */
export function sendRows(stdout) {
  const rows = {}
  for (const line of String(stdout ?? '').split('\n')) {
    const row = /^ {2}(repository|writes as|record|where|read by|undo|note|sent|next) +(.*)$/.exec(line)
    if (row && !(row[1] in rows)) rows[row[1]] = row[2].trim()
  }
  return rows
}

/** What one run of `jig send` gave: sent with what it printed, or not sent with why. */
export function sendAnswer(read) {
  const printed = [read.stdout, read.stderr].map((s) => String(s ?? '').trimEnd()).filter(Boolean).join('\n')
  if (read.error)
    return {
      sent: false,
      unknown: read.error.code !== 'ENOENT',
      why: read.error.code === 'ENOENT' ? 'the jig command was not found.' : `${read.error.message}; whether it wrote is not known, so read the pull request before sending again.`,
      printed
    }
  if (tooOld(read, 'send'))
    return { sent: false, why: 'this jig has no jig send; update the jig plugin to answer from the panel.', printed }
  if (read.code !== 0) return { sent: false, why: jigWhy(read.stderr, 'send') || `exit ${read.code}`, printed }
  const rows = sendRows(read.stdout)
  return { sent: true, wrote: rows.sent ?? null, writesAs: rows['writes as'] ?? null, printed }
}

/** The address handlers for the worker's context `ctx`, running jig through `jigCommand`. */
export function createAddresses(ctx, { jigCommand }, statusBar, budget) {
  const { log, run, clock, env, platform } = ctx
  const state = { reads: new Map(), running: false, cleanup: null, waiting: null, sending: false, disposed: false, aborts: new Set() }
  const waiters = new Set()
  const wake = () => {
    for (const resume of [...waiters]) resume()
  }

  /** Runs `args` after the command, within `deadlineMs`, the command's resolution included. */
  function runJig(args, deadlineMs, maxBytes, trackAsk = false) {
    const control = new AbortController()
    state.aborts.add(control)
    let timer = null
    const deadline = new Promise((settle) => {
      timer = clock.setTimeout(() => {
        control.abort()
        settle({ code: null, stdout: '', stderr: '', error: new Error(`it ran past ${deadlineMs / 1000}s`) })
      }, deadlineMs)
    })
    const once = (async () => {
      let command
      try {
        command = await jigCommand(control.signal)
      } catch (error) {
        if (control.signal.aborted) throw error
        return { notFound: error instanceof JigCommandError ? error.message : String(error?.message) }
      }
      const process = run([...command, ...args], { timeoutMs: deadlineMs, maxBytes, env, platform, signal: control.signal })
      // Only a started process holds admission: resolving the command (a host call that cannot be
      // cancelled) never does, so one that stalls cannot refuse every later ask.
      if (trackAsk) {
        const cleanup = process.catch(() => {})
        state.cleanup = cleanup
        cleanup.finally(() => {
          if (state.cleanup === cleanup) state.cleanup = null
          wake()
        })
      }
      return process
    })()
    once.catch(() => {})
    return Promise.race([once, deadline]).finally(() => {
      clock.clearTimeout(timer)
      state.aborts.delete(control)
    })
  }

  /** Waits until no read runs and no process is being cleaned up, and takes the turn; false after `BUSY_WAIT_MS`. */
  async function admitted() {
    let timer = null
    let over = false
    const expired = new Promise((resolve) => {
      timer = clock.setTimeout(() => {
        over = true
        resolve()
      }, BUSY_WAIT_MS)
    })
    try {
      while ((state.running || state.cleanup) && !state.disposed && !over) {
        let resume
        const turn = new Promise((resolve) => waiters.add((resume = resolve)))
        await Promise.race([turn, expired])
        waiters.delete(resume)
      }
      if (over && (state.running || state.cleanup)) return false
      if (!state.disposed) state.running = true
      return true
    } finally {
      clock.clearTimeout(timer)
    }
  }

  /**
   * One `jig ask` at a time: the same question asked while it waits or runs shares its answer,
   * and any other waits its turn, up to `BUSY_WAIT_MS`, then is answered `busy`.
   */
  function ask(args) {
    const key = JSON.stringify(args)
    const known = state.reads.get(key)
    if (known) return known
    const turn = (async () => {
      if (state.disposed) return { state: 'unreadable', why: 'the plugin is stopping.' }
      if (!(await admitted())) return { state: 'unreadable', busy: true, why: 'another address is being read; try again when it finishes.' }
      try {
        if (state.disposed) return { state: 'unreadable', why: 'the plugin is stopping.' }
        const read = await runJig(['ask', ...args], ASK_DEADLINE_MS, 8 * 1024 * 1024, true)
        if (read.notFound !== undefined) return { state: 'not-found', why: read.notFound }
        return askAnswer(read, args.includes('--waiting'))
      } finally {
        state.running = false
        wake()
      }
    })()
    const settled = turn.catch((error) => ({ state: 'unreadable', why: String(error?.message ?? error) }))
    state.reads.set(key, settled)
    settled.finally(() => state.reads.delete(key))
    return settled
  }

  /** `addresses.list`: what waits on a person and what the line's sessions hold, read again when `fresh`. */
  async function listAddresses(input) {
    const fresh = input?.fresh === true
    const kept = state.waiting
    const waiting =
      !fresh && kept && clock.now() - kept.at <= LINE_REFRESH_MS
        ? kept.answer
        : await ask(['--waiting', '--json']).then((answer) => {
            // A read that only waited its turn is not a read: it is asked again, not kept.
            if (!answer.busy) state.waiting = { answer, at: clock.now() }
            return answer
          })
    const lineRead = await statusBar.latestLine({ maxAgeMs: fresh ? 0 : LINE_REFRESH_MS })
    const line = lineRead?.state === 'line' ? lineRead.value.line : null
    if (waiting.state !== 'answer')
      return { state: waiting.state, why: waiting.why ?? null, tick: null, unread: null, addresses: addressList(null, line) }
    const value = waiting.value
    return {
      state: 'list',
      why: null,
      tick: value.tick ?? null,
      unread: value.unread ?? null,
      addresses: addressList(value, line)
    }
  }

  /** `address.get`: the address's holder, state and thread, `--all` of it when asked, and the questions the line has it waiting on. */
  async function getAddress(input) {
    const address = input?.address
    if (!isAddress(address)) return { state: 'refused', why: 'that is not an address the panel reads.', address: null }
    const answer = await ask(['--thread', ...(input?.all === true ? ['--all'] : []), '--json', '--', address])
    if (answer.state !== 'answer') return { state: answer.state, why: answer.why ?? null, address, parked: [] }
    const lineRead = await statusBar.latestLine({ maxAgeMs: LINE_REFRESH_MS })
    const line = lineRead?.state === 'line' ? lineRead.value.line : null
    const parked = parkedQuestions(address, line)
    const frame = (value) => ({ state: 'answer', why: null, address, value, parked })
    return frame(boundThread(answer.value, budget, frame))

  }

  /**
   * `address.send`: `jig send -- <address> <verb> <key> <text>` for a verb on `SEND_VERBS`,
   * one send at a time. It answers only once Jig has: sent, with what it printed, or not sent,
   * with why.
   */
  async function send(input) {
    const { address, verb, key, text } = input ?? {}
    if (!SEND_VERBS.includes(verb))
      return { sent: false, why: `the panel sends only ${SEND_VERBS.join(', ')}; ${JSON.stringify(String(verb ?? ''))} is not on its list.` }
    if (!isAddress(address)) return { sent: false, why: 'that is not an address the panel sends to.' }
    if (typeof key !== 'string' || !/^\S+$/.test(key)) return { sent: false, why: 'the answer names no parked question.' }
    if (typeof text !== 'string' || text.trim() === '') return { sent: false, why: 'the answer is empty.' }
    if (state.disposed) return { sent: false, why: 'the plugin is stopping.' }
    if (state.sending) return { sent: false, why: 'another answer is being sent; send this one when it has.' }
    state.sending = true
    try {
      const read = await runJig(['send', '--', address, verb, key, text.trim()], SEND_DEADLINE_MS, 1024 * 1024)
      if (read.notFound !== undefined) return { sent: false, why: read.notFound }
      const result = sendAnswer(read)
      log(`jig send ${address} ${verb} ${key}: ${result.sent ? `sent ${result.wrote ?? ''}`.trim() : `not sent: ${result.why}`}`)
      return result
    } finally {
      state.sending = false
    }
  }

  function dispose() {
    state.disposed = true
    wake()
    for (const control of state.aborts) control.abort()
  }

  const bounded = (handler, sending = false) => async (input) => {
    const answer = await handler(input)
    if (Buffer.byteLength(JSON.stringify(answer)) <= budget) return answer
    const small = (v) => (typeof v === 'string' ? v.slice(0, 2048) : null)
    if (sending) return { sent: answer.sent, unknown: answer.unknown ?? false,
      why: answer.why ? String(answer.why).slice(0, 512) : null,
      wrote: small(answer.wrote), writesAs: small(answer.writesAs),
      printed: 'The command output exceeded the panel limit; read the pull request for the full record.' }
    return { state: 'unreadable', why: 'The address response exceeded the panel limit; read it with jig ask.',
      address: isAddress(input?.address) && input.address.length <= 1024 ? input.address : null, parked: [], addresses: [] }
  }
  return { listAddresses: bounded(listAddresses), getAddress: bounded(getAddress), send: bounded(send, true), dispose }
}
