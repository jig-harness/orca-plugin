// The status bar item: reads `jig dispatch line --json`, the answer the dashboard's `GET /state`
// gives, and shows the line's counts, re-reading after each tick and on a timer.
import { JigCommandError, firstLine } from './jig-command.mjs'

/** How often the status bar re-reads the line when no tick asked it to. */
export const LINE_REFRESH_MS = 60_000

/** How long one read of the line may run. */
export const LINE_READ_DEADLINE_MS = 30_000

/** The dispatch interval the overdue check assumes when the line carries none, in minutes. */
export const DEFAULT_DISPATCH_INTERVAL_MINUTES = 5

/** The status bar item, as `contributes.statusBarItems` names it. */
export const STATUS_ITEM_ID = 'line'

const REFUSED_EXIT = 2
const INTERVAL_SETTING_KEY = 'dispatchIntervalMinutes'

/** The item's text: `Jig 2 need you`, `Jig 1 ready · 2 need you`, `Jig tick overdue`. */
export function statusText({ ready = null, needs, overdue = false }) {
  const counts = [
    ...(ready ? [`${ready} ready`] : []),
    ...(needs || !overdue ? [`${needs} need you`] : [])
  ]
  return overdue ? ['Jig tick overdue', ...counts].join(' · ') : `Jig ${counts.join(' · ')}`
}

/**
 * What the status bar shows for one read of `jig dispatch line --json`, the answer the
 * dashboard's `GET /state` gives (Jig's plugin/README.md, "The line as JSON"). `read` is the
 * program's result; `intervalMs` the setting's interval, used when the line carries none.
 */
export function lineStatus(read, { intervalMs, now }) {
  if (read.error) {
    const why = read.error.code === 'ENOENT' ? 'the jig command was not found' : read.error.message
    return { text: 'Jig line unreadable', tone: 'danger', icon: 'error', tooltip: `Jig: ${why}` }
  }
  if (read.code === REFUSED_EXIT)
    return {
      text: 'Jig too old for the status bar',
      tone: 'neutral',
      icon: 'info',
      tooltip: 'This jig has no `jig dispatch line`; update the jig plugin to see the line here.'
    }
  let answer = null
  try {
    answer = read.code === 0 ? JSON.parse(read.stdout) : null
  } catch {
    answer = null
  }
  const value = answer?.ok === true ? answer.value : null
  const line = value?.line
  if (!value || line === undefined) {
    const why = firstLine(read.stderr) || (read.code === 0 ? 'it did not print the line' : `exit ${read.code}`)
    return { text: 'Jig line unreadable', tone: 'danger', icon: 'error', tooltip: `Jig: ${why}` }
  }
  if (line === null)
    return {
      text: 'Jig no tick yet',
      tone: 'neutral',
      icon: 'activity',
      tooltip: 'Jig: no dispatch tick has written the line yet.'
    }
  if (line?.version !== 1 || !Array.isArray(line.needs))
    return {
      text: 'Jig line unreadable',
      tone: 'danger',
      icon: 'error',
      tooltip: `Jig: the line is version ${line?.version ?? '?'}, which this plugin does not read; update it.`
    }
  // The line de-duplicates its needs across repositories. Version 1 carries no ready list, so
  // ready-to-merge is not shown rather than guessed from the sessions or the queue.
  const needs = line.needs.length
  const ready = null
  const interval = Number.isFinite(line.intervalMs) && line.intervalMs > 0 ? line.intervalMs : intervalMs
  const clockNow = Date.parse(value.now)
  const at = Date.parse(line.finishedAt)
  if (!Number.isFinite(at))
    return {
      text: 'Jig line unreadable',
      tone: 'danger',
      icon: 'error',
      tooltip: 'Jig: the line carries no readable finish time, so its age is unknown.'
    }
  const age = (Number.isFinite(clockNow) ? clockNow : now) - at
  const overdue = age > 2 * interval
  const minutes = (ms) => `${Math.round(ms / 60_000)} min`
  return {
    text: statusText({ ready, needs, overdue }),
    tone: overdue ? 'danger' : needs ? 'warning' : 'neutral',
    icon: overdue ? 'warning' : needs ? 'bell' : 'check',
    tooltip: [
      `Jig: tick ${line.runId} finished ${line.finishedAt}`,
      overdue ? `, ${minutes(age)} ago, past twice the ${minutes(interval)} interval` : '',
      `. ${needs} need you`,
      ready === null ? '' : `, ${ready} ready to merge`,
      '.'
    ].join('')
  }
}

/** The status bar for the worker's context `ctx`, finding jig through `jigCommand`. */
export function createStatusBar(ctx, { jigCommand }) {
  const { host, log, run, clock, env, platform, call, track } = ctx
  const line = { reading: false, again: false, timer: null, shown: null, disposed: false, abort: null }

  /** The dispatch interval the setting names, for a line that carries none. */
  async function settingIntervalMs() {
    try {
      const result = await call('settings.get', {})
      const minutes = Number(result?.settings?.[INTERVAL_SETTING_KEY])
      if (Number.isFinite(minutes) && minutes > 0) return minutes * 60_000
    } catch (error) {
      log(`could not read the ${INTERVAL_SETTING_KEY} setting: ${error.message}`)
    }
    return DEFAULT_DISPATCH_INTERVAL_MINUTES * 60_000
  }

  /** Resolves the command, runs `jig dispatch line --json` and reads the settings. */
  async function readLineOnce(signal) {
    let command
    try {
      command = await jigCommand(signal)
    } catch (error) {
      if (signal.aborted) throw error
      const why = error instanceof JigCommandError ? error.message : String(error?.message)
      return { text: 'Jig not found', tone: 'danger', icon: 'error', tooltip: `Jig: ${why}` }
    }
    const read = await run([...command, 'dispatch', 'line', '--json'], {
      timeoutMs: LINE_READ_DEADLINE_MS,
      maxBytes: 4 * 1024 * 1024,
      env,
      platform,
      signal
    })
    signal.throwIfAborted()
    const intervalMs = await settingIntervalMs()
    signal.throwIfAborted()
    return lineStatus(read, { intervalMs, now: clock.now() })
  }

  /** The whole read, command resolution and settings included, settling at the deadline. */
  async function readLine() {
    let timer = null
    const control = new AbortController()
    line.abort = control
    const deadline = new Promise((settle) => {
      timer = clock.setTimeout(
        () => {
          // Expiry stops the abandoned read: no further step starts and a running program is killed.
          control.abort()
          settle(
            lineStatus(
              { code: null, stdout: '', stderr: '', error: new Error(`the line read ran past ${LINE_READ_DEADLINE_MS / 1000}s`) },
              { intervalMs: 0, now: clock.now() }
            )
          )
        },
        LINE_READ_DEADLINE_MS
      )
    })
    try {
      const read = readLineOnce(control.signal)
      // The abandoned read ends in an abort rejection nobody awaits.
      read.catch(() => {})
      return await Promise.race([read, deadline])
    } finally {
      clock.clearTimeout(timer)
      if (line.abort === control) line.abort = null
    }
  }

  /** Shows `item` when it differs from what is shown; logs each change once, never each read. */
  async function show(item) {
    const key = JSON.stringify(item)
    if (key === line.shown) return
    line.shown = key
    log(`status bar: ${item.text} (${item.tooltip})`)
    try {
      await call('statusBar.update', { id: STATUS_ITEM_ID, ...item, visible: true })
    } catch (error) {
      line.shown = null
      log(`could not update the status bar: ${error.message}`)
    }
  }

  /**
   * Reads the line and shows it. One read at a time: a request while one runs makes exactly one
   * more read after it, so the item ends on what the newest tick wrote.
   */
  function refreshLine() {
    if (line.disposed || !host.has?.('statusBar.update')) return
    if (line.reading) {
      line.again = true
      return
    }
    line.reading = true
    track(
      readLine()
        .then((item) => (line.disposed ? undefined : show(item)))
        .catch((error) => log(`status bar read failed: ${error?.stack ?? error}`))
        .finally(() => {
          line.reading = false
          if (line.again) {
            line.again = false
            refreshLine()
          }
        })
    )
  }

  /** Reads the line now and every `LINE_REFRESH_MS`. */
  function startStatusBar() {
    if (line.disposed || line.timer || !host.has?.('statusBar.update')) return
    const beat = () => {
      if (line.disposed) return
      refreshLine()
      line.timer = clock.setTimeout(beat, LINE_REFRESH_MS)
    }
    beat()
  }

  /** Stops the timer and cancels a read in progress; nothing is shown after. */
  function dispose() {
    line.disposed = true
    line.again = false
    line.abort?.abort()
    if (line.timer) clock.clearTimeout(line.timer)
    line.timer = null
  }

  return { refreshLine, startStatusBar, dispose }
}
