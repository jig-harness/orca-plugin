// Waking Jig's dispatcher: an agent that stops for input or finishes in a repository that uses
// Jig asks for one tick of that repository, at most one per window and never two at once, and
// the tick's receipt is shown to the person.
import { JigCommandError, firstLine } from './jig-command.mjs'

/** Agent states that mean a session may want the dispatcher: it needs a person, or it ended. */
export const WAKE_STATES = new Set(['waiting', 'blocked', 'done'])

/** At most one tick per repository in this window. */
export const TICK_WINDOW_MS = 60_000

/** How long a tick may run before it is stopped; the dispatcher's own timer allows as much. */
export const TICK_DEADLINE_MS = 6 * 3600_000

/** A tick that finds the dispatcher's lock held is tried again this many times, a window apart. */
export const LOCK_HELD_RETRIES = 5

const LOCK_HELD_EXIT = 3

/** Whether a status change should wake the dispatcher: its own state or its main agent's. */
export function wakesDispatcher(payload) {
  return WAKE_STATES.has(payload?.state) || WAKE_STATES.has(payload?.mainAgent?.state)
}

/** The tick's receipt as one line, from what `jig dispatch --json` prints. */
export function receiptLine(receipt, repo) {
  const report = receipt?.repos?.find((r) => r.path === repo) ?? receipt?.repos?.[0]
  const name = report?.slug ?? repo
  if (!report) return `${name}: the tick read no repository (tick ${receipt?.runId ?? '?'})`
  if (report.refused) return `${name}: refused: ${report.refused}`
  const tick = `tick ${receipt.runId}`
  if (receipt.applyWithheld) return `${name}: nothing started, ${receipt.applyWithheld} (${tick})`
  const started = (report.launches ?? []).filter((l) =>
    ['launched', 'retried'].includes(l.outcome)
  ).length
  const notified = (report.notifications ?? []).filter((n) => n.outcome === 'sent').length
  const steered = (report.steers ?? []).length
  const parts = [
    `${(report.actions ?? []).length} wanted`,
    `${started} started`,
    `${notified} notified`,
    ...(steered ? [`${steered} nudged`] : []),
    `${(report.running ?? []).length} running`
  ]
  const exit = receipt.exitStatus ? `, exit ${receipt.exitStatus}` : ''
  return `${name}: ${parts.join(', ')}${exit} (${tick})`
}

/** The receipt's detail as log lines: each action, launch, notification and nudge. */
export function receiptDetail(receipt) {
  const lines = []
  for (const r of receipt?.repos ?? []) {
    for (const a of r.actions ?? []) lines.push(`  wants ${a.stage} ${a.target}: ${a.reason}`)
    for (const l of r.launches ?? [])
      lines.push(`  ${l.outcome} ${l.action} ${l.target}: ${l.detail}`)
    for (const n of r.notifications ?? [])
      lines.push(`  ${n.outcome} notify ${n.target} (${n.cause}): ${n.detail}`)
    for (const s of r.steers ?? []) lines.push(`  ${s.outcome} steer ${s.target}: ${s.detail}`)
    for (const u of r.unplaced ?? []) lines.push(`  unplaced ${u.target}: ${u.reason}`)
  }
  for (const a of receipt?.accountsNotAdmitted ?? [])
    lines.push(`  account ${a.account} not admitted: ${a.reason}`)
  return lines
}

/**
 * The dispatcher's wake-ups for the worker's context `ctx`: finds jig through `jigCommand`,
 * repositories through `workspaces`, and asks the status bar to re-read through `refreshLine`.
 */
export function createWake(ctx, { jigCommand }, workspaces, { refreshLine }) {
  const { log, run, clock, env, platform, call, track } = ctx
  const repos = new Map()
  let disposed = false

  async function notify(title, body) {
    try {
      await call('notifications.show', { title, body })
    } catch (error) {
      log(`could not show a notification: ${error.message}`)
    }
  }

  /** One tick for `repo`; resolves whether to try again because another tick held the lock. */
  async function tick(repo) {
    let command
    try {
      command = await jigCommand()
    } catch (error) {
      const why = error instanceof JigCommandError ? error.message : String(error?.message)
      log(`jig dispatch not run for ${repo}: ${why}`)
      await notify('Jig dispatch did not run', why)
      return false
    }
    const argv = [...command, 'dispatch', '--apply', '--repo', repo, '--json']
    log(`tick for ${repo}: ${argv.join(' ')}`)
    const result = await run(argv, { timeoutMs: TICK_DEADLINE_MS, env, platform })
    if (result.code === LOCK_HELD_EXIT && !result.error) {
      log(`tick for ${repo}: another tick holds the lock: ${firstLine(result.stderr)}`)
      return true
    }
    let receipt = null
    try {
      receipt = JSON.parse(result.stdout)
    } catch {
      receipt = null
    }
    if (result.error || !receipt || !Array.isArray(receipt.repos)) {
      const why =
        result.error?.code === 'ENOENT'
          ? `${argv[0]} was not found`
          : result.error?.message ||
            firstLine(result.stderr) ||
            firstLine(result.stdout) ||
            `exit ${result.code}`
      log(`tick for ${repo} failed (exit ${result.code}): ${why}`)
      if (result.stderr.trim()) log(result.stderr.trim())
      await notify('Jig dispatch failed', `${repo}: ${why}`)
      return false
    }
    const line = receiptLine(receipt, repo)
    log(line)
    for (const detail of receiptDetail(receipt)) log(detail)
    log(`full receipt: jig dispatch receipts ${receipt.runId}`)
    await notify('Jig dispatch', line)
    return false
  }

  function state(repo) {
    let s = repos.get(repo)
    if (!s) {
      s = { lastStart: null, running: false, pending: false, timer: null, lockRetries: 0 }
      repos.set(repo, s)
    }
    return s
  }

  /**
   * Asks for a tick of `repo`: now when none ran in the last window, else one at the window's
   * end. Requests while one is scheduled join it; a request while a tick runs schedules exactly
   * one more, so no request is dropped and no two ticks of one repository overlap.
   */
  function requestTick(repo) {
    if (disposed) return
    const s = state(repo)
    if (s.running) {
      s.pending = true
      return
    }
    if (s.timer) return
    const wait = s.lastStart === null ? 0 : s.lastStart + TICK_WINDOW_MS - clock.now()
    if (wait <= 0) {
      startTick(repo)
      return
    }
    s.timer = clock.setTimeout(() => {
      s.timer = null
      startTick(repo)
    }, wait)
  }

  function startTick(repo) {
    const s = state(repo)
    s.running = true
    s.lastStart = clock.now()
    track(
      tick(repo)
        .catch((error) => {
          log(`tick for ${repo} failed: ${error?.stack ?? error}`)
          return false
        })
        .then((lockHeld) => {
          s.running = false
          refreshLine()
          if (lockHeld && s.lockRetries < LOCK_HELD_RETRIES) {
            s.lockRetries += 1
            s.pending = true
          } else {
            if (lockHeld) log(`tick for ${repo}: lock still held after ${LOCK_HELD_RETRIES} tries`)
            s.lockRetries = 0
          }
          if (s.pending) {
            s.pending = false
            requestTick(repo)
          }
        })
    )
  }

  async function handleAgentStatus(payload) {
    if (!wakesDispatcher(payload)) return
    const workspaceId = payload?.workspaceId
    if (!workspaceId) {
      log(`agent ${payload?.state ?? '?'} in no known workspace (pane ${payload?.paneKey}); ignored`)
      return
    }
    const path = await workspaces.workspacePath(workspaceId)
    if (!path) {
      log(`agent ${payload.state} in workspace ${workspaceId}: its path is unknown; ignored`)
      return
    }
    const repo = await workspaces.jigRepository(path)
    if (!repo) return
    requestTick(repo)
  }

  /** Cancels every scheduled tick and schedules no more; a tick already running finishes. */
  function dispose() {
    disposed = true
    for (const s of repos.values()) if (s.timer) clock.clearTimeout(s.timer)
  }

  return { requestTick, handleAgentStatus, dispose }
}
