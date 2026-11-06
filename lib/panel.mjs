// The panel's two requests: `line.get` gives the panel the line the status bar reads, with the
// workspaces Orca can open for each need, and `workspace.open` shows one of them. The panel
// draws the line; what it shows and in what order follows Jig's dashboard, not this worker.
import { LINE_REFRESH_MS } from './status-bar.mjs'

/** The panel, as `contributes.panels` names it. */
export const PANEL_ID = 'inbox'

/**
 * The workspace paths the line names for one need, nearest first: the sessions that hold its
 * target, then the need's own workspaces (a double claim's), then the one its notification
 * went to.
 */
export function needPaths(need, line) {
  const paths = [
    ...(line.sessions ?? [])
      .filter((s) => s?.repo === need.repo && s.target === need.target && s.workspace)
      .map((s) => s.workspace),
    ...(Array.isArray(need.workspaces) ? need.workspaces : []),
    ...(need.notified?.workspace ? [need.notified.workspace] : [])
  ]
  return [...new Set(paths.filter((p) => typeof p === 'string' && p !== ''))]
}

/** What one answer may weigh: Orca limits a request's answer to 1 MiB, so the decision text keeps to less. */
export const ANSWER_BUDGET_BYTES = 900_000

/** The fields of a need and of a decision that are text for the person to read, which may be cut short. */
const NEED_TEXT = ['title', 'reason']
const DECISION_TEXT = ['question', 'recommendation']

const CUT_LINE = 'The rest of this text is cut here; read it on the pull request.'

/**
 * Cuts the framed text of `needs` so the whole answer stays within `ANSWER_BUDGET_BYTES`. Every
 * need and every decision stays; only the text of a decision shrinks: its lines, each to an equal
 * share of what the rest of the answer leaves, ending in a line that says so, then, when the
 * other fields alone are still too much, each of its text fields, to a length that fits.
 */
export function boundDecisions(needs, answer) {
  const size = (value) => Buffer.byteLength(JSON.stringify(value))
  if (size({ ...answer, line: { ...answer.line, needs } }) <= ANSWER_BUDGET_BYTES) return needs
  const decisions = needs.flatMap((n) => n.decisions ?? [])
  const bare = needs.map((n) => ({
    ...n,
    decisions: (n.decisions ?? []).map((d) => ({ ...d, lines: [] }))
  }))
  const room = ANSWER_BUDGET_BYTES - size({ ...answer, line: { ...answer.line, needs: bare } })
  const share = Math.max(0, Math.floor(room / Math.max(1, decisions.length)) - 2 * CUT_LINE.length)
  const cut = (lines) => {
    if (!Array.isArray(lines)) return lines
    const kept = []
    let used = 0
    for (const line of lines) {
      const bytes = Buffer.byteLength(JSON.stringify(line)) + 1
      if (used + bytes > share) return [...kept, CUT_LINE]
      kept.push(line)
      used += bytes
    }
    return kept
  }
  const cutNeeds = needs.map((n) => ({
    ...n,
    decisions: Array.isArray(n.decisions) ? n.decisions.map((d) => ({ ...d, lines: cut(d.lines) })) : n.decisions
  }))
  const fits = (list) => size({ ...answer, line: { ...answer.line, needs: list } }) <= ANSWER_BUDGET_BYTES
  if (fits(cutNeeds)) return cutNeeds
  // The lines are gone and the answer is still over: the display text left carries the rest.
  // Only that text shrinks; every other field is the panel's to act on (paths, urls, times, causes).
  const text = (value, max) => (typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value)
  const clip = (n, max) => ({
    ...n,
    ...Object.fromEntries(NEED_TEXT.filter((k) => k in n).map((k) => [k, text(n[k], max)])),
    decisions: Array.isArray(n.decisions)
      ? n.decisions.map((d) => ({
          ...d,
          ...Object.fromEntries(DECISION_TEXT.filter((k) => k in d).map((k) => [k, text(d[k], max)]))
        }))
      : n.decisions
  })
  let clipped = cutNeeds
  for (let max = 4096; max >= 0 && !fits(clipped); max = max === 0 ? -1 : Math.floor(max / 2))
    clipped = cutNeeds.map((n) => clip(n, max))
  return clipped
}

/**
 * Brings `answer` within `ANSWER_BUDGET_BYTES` whatever the line holds: the text of the needs is
 * cut first (`boundDecisions`), then, when the needs themselves are too many, the last of them
 * are left out: `why` says how many, and `line.omitted` carries the count for the panel to show.
 * An answer no cut brings within the budget is unreadable.
 */
export function boundAnswer(answer) {
  const size = (value) => Buffer.byteLength(JSON.stringify(value))
  const withNeeds = (needs, why = answer.why, omitted = 0) => ({
    ...answer,
    why,
    line: { ...answer.line, needs, ...(omitted > 0 ? { omitted } : {}) }
  })
  const needs = boundDecisions(answer.line.needs, answer)
  if (size(withNeeds(needs)) <= ANSWER_BUDGET_BYTES) return withNeeds(needs)
  // Each size is of a prefix, so the longest one that fits is found by halving, not by stepping.
  const probe = 'x'.repeat(200)
  const fitting = (n) => size(withNeeds(needs.slice(0, n), probe, needs.length)) <= ANSWER_BUDGET_BYTES
  let low = 0
  let high = needs.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fitting(mid)) low = mid
    else high = mid - 1
  }
  const kept = low
  const left = needs.length - kept
  const why = `${left} of ${needs.length} needs are left out because the line is too large to show; read them with jig dispatch dashboard or jig dispatch line --json.`
  const result = withNeeds(needs.slice(0, kept), why, left)
  if (size(result) <= ANSWER_BUDGET_BYTES) return result
  return { state: 'unreadable', why: 'the line is too large to show.', now: answer.now, timeZone: answer.timeZone, line: null }
}

/**
 * What `line.get` answers for one `lineAnswer`: its `state` and `why`, the clock and zone the
 * line was read with, and for a line the parts the inbox draws, each need with `open`, the
 * paths of its workspaces that `idAt` finds in Orca. `clock` reads the time in milliseconds,
 * after those lookups, which can take a while.
 */
export async function panelAnswer(answer, idAt, clock = Date.now) {
  if (answer === null) return { state: 'unreadable', why: 'the plugin is stopping.' }
  const { state, why = null, value = null } = answer
  // The kept answer's clock is its read's; it moves on by the time since, so a cached answer is not younger than it is.
  const said = Date.parse(value?.now ?? '')
  const movedOn = () =>
    Number.isFinite(said) && Number.isFinite(answer.readAt)
      ? new Date(said + Math.max(0, clock() - answer.readAt)).toISOString()
      : (value?.now ?? null)
  if (state !== 'line') return { state, why, now: movedOn(), timeZone: value?.timeZone ?? null, line: null }
  const { line } = value
  const known = new Map()
  const needs = []
  for (const need of line.needs) {
    const open = []
    for (const path of needPaths(need, line)) {
      if (!known.has(path)) known.set(path, (await idAt(path)) !== null)
      if (known.get(path)) open.push(path)
    }
    needs.push({ ...need, open })
  }
  const base = { state, why, now: movedOn(), timeZone: value?.timeZone ?? null, line: null }
  const intervalMs = [line.intervalMs, answer.intervalMs].find((n) => Number.isFinite(n) && n > 0) ?? null
  const result = {
    ...base,
    line: {
      runId: line.runId,
      startedAt: line.startedAt,
      finishedAt: line.finishedAt,
      intervalMs,
      sessions: Array.isArray(line.sessions) ? line.sessions.length : 0,
      queue: Array.isArray(line.queue) ? line.queue.length : 0,
      needs
    }
  }
  return boundAnswer(result)
}

/** The panel's handlers for the worker's context `ctx`. */
export function createPanel(ctx, workspaces, statusBar) {
  const { host, log, call, clock } = ctx

  /** `line.get`: the newest line, read again first when `fresh` or older than a minute. */
  async function getLine(input) {
    const answer = await statusBar.latestLine({ maxAgeMs: input?.fresh ? 0 : LINE_REFRESH_MS })
    return panelAnswer(answer, workspaces.workspaceIdAt, () => clock.now())
  }

  /** `workspace.open`: shows the workspace at `path`; says why when it cannot. */
  async function openWorkspace(input) {
    const path = input?.path
    if (typeof path !== 'string' || path === '') return { opened: false, why: 'no workspace path was given.' }
    if (!host.has?.('workspace.open'))
      return { opened: false, why: 'this Orca does not let a plugin open a workspace.' }
    const workspaceId = await workspaces.workspaceIdAt(path)
    if (workspaceId === null) return { opened: false, why: `Orca knows no workspace at ${path}.` }
    try {
      await call('workspace.open', { workspaceId })
      return { opened: true }
    } catch (error) {
      log(`could not open workspace ${workspaceId}: ${error.message}`)
      return { opened: false, why: `Orca did not open it: ${error.message}` }
    }
  }

  return { getLine, openWorkspace }
}
