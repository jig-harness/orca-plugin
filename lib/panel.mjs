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

/**
 * What `line.get` answers for one `lineAnswer`: its `state` and `why`, the clock and zone the
 * line was read with, and for a line the parts the inbox draws, each need with `open`, the
 * paths of its workspaces that `idAt` finds in Orca.
 */
export async function panelAnswer(answer, idAt) {
  if (answer === null) return { state: 'unreadable', why: 'the plugin is stopping.' }
  const { state, why = null, value = null } = answer
  const base = { state, why, now: value?.now ?? null, timeZone: value?.timeZone ?? null, line: null }
  if (state !== 'line') return base
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
  return {
    ...base,
    line: {
      runId: line.runId,
      startedAt: line.startedAt,
      finishedAt: line.finishedAt,
      intervalMs: line.intervalMs ?? null,
      sessions: Array.isArray(line.sessions) ? line.sessions.length : 0,
      queue: Array.isArray(line.queue) ? line.queue.length : 0,
      needs
    }
  }
}

/** The panel's handlers for the worker's context `ctx`. */
export function createPanel(ctx, workspaces, statusBar) {
  const { host, log, call } = ctx

  /** `line.get`: the newest line, read again first when `fresh` or older than a minute. */
  async function getLine(input) {
    const answer = await statusBar.latestLine({ maxAgeMs: input?.fresh ? 0 : LINE_REFRESH_MS })
    return panelAnswer(answer, workspaces.workspaceIdAt)
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
