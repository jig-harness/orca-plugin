// The jig plugin's worker. Orca starts it with the user's permissions and hands it agent and
// workspace events. When an agent stops for input or finishes in a repository that uses Jig, it
// runs one tick of Jig's dispatcher for that repository and shows what the tick did. It also
// guards agent launches: a launch into a worktree `jig gc` is removing is refused, and shows the
// dispatch line's counts in the status bar from `jig dispatch line --json`. Jig's rules
// stay in Jig: this file only decides when to wake the dispatcher and which repository to name,
// and the guard follows the launch guard record in Jig's plugin/gc/README.md.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { delimiter, join } from 'node:path'

/** Agent states that mean a session may want the dispatcher: it needs a person, or it ended. */
export const WAKE_STATES = new Set(['waiting', 'blocked', 'done'])

/** At most one tick per repository in this window. */
export const TICK_WINDOW_MS = 60_000

/** How long a tick may run before it is stopped; the dispatcher's own timer allows as much. */
export const TICK_DEADLINE_MS = 6 * 3600_000

/** How often the plugin writes its heartbeat in the guard record and re-lists workspaces. */
export const GUARD_HEARTBEAT_MS = 60_000

/** What a refused launch tells the person. */
export const GUARD_DENY_REASON = 'jig gc is removing this worktree'

/** A tick that finds the dispatcher's lock held is tried again this many times, a window apart. */
export const LOCK_HELD_RETRIES = 5

/** How often the status bar re-reads the line when no tick asked it to. */
export const LINE_REFRESH_MS = 60_000

/** How long one read of the line may run. */
export const LINE_READ_DEADLINE_MS = 30_000
/** How long a stopped program has to close after SIGTERM, and again after SIGKILL. */
export const KILL_GRACE_MS = 2_000

/** The dispatch interval the overdue check assumes when the line carries none, in minutes. */
export const DEFAULT_DISPATCH_INTERVAL_MINUTES = 5

/** The status bar item, as `contributes.statusBarItems` names it. */
export const STATUS_ITEM_ID = 'line'

const LOCK_HELD_EXIT = 3
const REFUSED_EXIT = 2
const PLUGIN_ID = 'jig@jig'
const SETTING_KEY = 'jigCommand'
const GUARD_SETTING_KEY = 'guardDirectory'
const INTERVAL_SETTING_KEY = 'dispatchIntervalMinutes'
const STORAGE_KEY = 'workspaces'
const REMEMBERED_WORKSPACES = 200
const LIST_CACHE_MS = 30_000
const FOLDER_INSTANCE_SUFFIX = /::workspace:[0-9a-f-]{36}$/

/** Why the dispatcher cannot be run at all; shown to the person, never thrown past a handler. */
export class JigCommandError extends Error {}

/**
 * The setting's command line as arguments: whitespace separates them, single or double quotes
 * keep spaces, and nothing is expanded, so no shell ever reads it.
 */
export function splitCommand(text) {
  const args = []
  let current = ''
  let quote = null
  let started = false
  for (const ch of String(text ?? '')) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (quote) throw new JigCommandError(`the jig command has an unclosed ${quote} quote`)
  if (started) args.push(current)
  return args
}

/** Whether a status change should wake the dispatcher: its own state or its main agent's. */
export function wakesDispatcher(payload) {
  return WAKE_STATES.has(payload?.state) || WAKE_STATES.has(payload?.mainAgent?.state)
}

/** The plugin directory of the user-scope install in `claude plugin list --json`. */
export function claudePluginDirectory(list) {
  if (!Array.isArray(list)) return null
  const entry = list.find((plugin) => plugin?.id === PLUGIN_ID && plugin?.scope === 'user')
  // A plugin loaded in place from a local marketplace has no cache copy.
  const directory = entry?.readFromFolder ?? entry?.installPath
  return typeof directory === 'string' && directory ? directory : null
}

/** The cache directory of the install in `codex plugin list --json`. */
export function codexPluginDirectory(list, home) {
  const installed = list?.installed
  if (!Array.isArray(installed)) return null
  const version = installed.find((plugin) => plugin?.pluginId === PLUGIN_ID)?.version
  return typeof version === 'string' && version
    ? join(home, '.codex', 'plugins', 'cache', 'jig', 'jig', version)
    : null
}

/** The first `name` on `PATH`, with Windows' executable extensions; null when none is there. */
export function findOnPath(name, env, platform, exists) {
  const extensions =
    platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : ['']
  for (const directory of (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * The repository a workspace belongs to, from `git worktree list --porcelain`: Git lists the
 * main checkout first, and the dispatcher's machine file names a repository by that path. A bare
 * repository has no main checkout, so its worktree's own top level stands in.
 */
export function mainCheckout(porcelain) {
  const first = porcelain.split('\n\n')[0] ?? ''
  const lines = first.split('\n')
  const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
  if (!path) return null
  return { path, bare: lines.includes('bare') }
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

/**
 * The guard record's directory: Jig's state root under the home directory on every platform.
 * `home` is `os.homedir()`, which on Windows is the profile directory, never `HOME`.
 */
export function defaultGuardDirectory(home) {
  return join(home, '.local', 'state', 'jig', 'orca-guard')
}

/** A guard record key: the lowercase hex SHA-256 of the worktree path exactly as Orca gives it. */
export function guardKey(path) {
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

/** A launch marker, as the guard record's `orca-guard-launch` kind. */
export function launchMarker({ path, workspaceId, agent, writer, at }) {
  return { kind: 'orca-guard-launch', v: 1, key: guardKey(path), writer, at, path, workspaceId, agent }
}

/** The plugin's heartbeat, as the guard record's `orca-guard-heartbeat` kind. */
export function heartbeatRecord({ writer, at, pluginVersion }) {
  return { kind: 'orca-guard-heartbeat', v: 1, key: 'heartbeat', writer, at, pid: writer.pid, pluginVersion }
}

/**
 * Writes `record` as compact JSON and a newline to `directory/name`: to a temporary file first,
 * named to start with `.` and end in `.tmp` so no reader takes it for a record, then renamed into
 * place. Synchronous, so the launch hook awaits nothing.
 */
export function writeRecord(fs, directory, name, record) {
  fs.mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`)
    fs.renameSync(temporary, join(directory, name))
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {}
    throw error
  }
}

function firstLine(text) {
  return (
    String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}

/** Runs a program to its end without a shell; never rejects. */
export function runProgram(argv, { timeoutMs, maxBytes = 16 * 1024 * 1024, env, platform, signal: abort }) {
  return new Promise((settle) => {
    if (abort?.aborted) {
      settle({ code: null, stdout: '', stderr: '', error: new Error('cancelled') })
      return
    }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        // Its own process group, so a deadline stops everything the tick started.
        detached: platform !== 'win32',
        windowsHide: true
      })
    } catch (error) {
      settle({ code: null, stdout: '', stderr: '', error })
      return
    }
    const out = { stdout: [], stderr: [] }
    let size = 0
    let done = false
    let stopped = null
    let killer = null
    const signal = (name) => {
      try {
        if (platform === 'win32') child.kill()
        else process.kill(-child.pid, name)
      } catch {
        try {
          child.kill(name)
        } catch {}
      }
    }
    const stop = (why) => {
      if (stopped) return
      stopped = why
      signal('SIGTERM')
      // A program that ignores SIGTERM is killed, and given up on if it still does not close.
      killer = setTimeout(() => {
        signal('SIGKILL')
        killer = setTimeout(() => finish(null), KILL_GRACE_MS)
      }, KILL_GRACE_MS)
    }
    const deadline = setTimeout(() => stop(`ran past ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
    const onAbort = () => stop('cancelled')
    abort?.addEventListener('abort', onAbort, { once: true })
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) stop(`printed more than ${maxBytes} bytes`)
        else out[stream].push(chunk)
      })
    }
    const finish = (code, error) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      clearTimeout(killer)
      abort?.removeEventListener('abort', onAbort)
      // The direct child closing says nothing about its group: a descendant that ignored SIGTERM
      // is killed now rather than left behind once the escalation timer is cleared.
      if (stopped && platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
      settle({
        code,
        stdout: Buffer.concat(out.stdout).toString('utf8'),
        stderr: Buffer.concat(out.stderr).toString('utf8'),
        ...(error ? { error } : {}),
        ...(stopped ? { error: new Error(stopped) } : {})
      })
    }
    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code))
  })
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer)
}

/**
 * The worker's logic, with everything it touches passed in: `host` is `orca.host`, `log` is
 * `orca.log`, `run(argv, options)` runs a program and resolves `{ code, stdout, stderr, error? }`,
 * and `fs` is the synchronous part of `node:fs` the launch guard uses.
 */
export function createDispatcher({
  host,
  log,
  run = runProgram,
  exists = existsSync,
  fs = nodeFs,
  clock = realClock,
  env = process.env,
  platform = process.platform,
  home = homedir(),
  hostName = hostname(),
  pid = process.pid,
  pluginVersion = null
}) {
  const repos = new Map()
  const known = new Map()
  /** Workspace id to local path, for the launch hook, which must not await a host call. */
  const guardPaths = new Map()
  /** Workspace path to the Jig repository it belongs to, kept for when its files are gone. */
  const repositoryOf = new Map()
  let guardDirectory = defaultGuardDirectory(home)
  let loaded = null
  let listed = { at: -Infinity, workspaces: [] }
  let guardTimer = null
  const line = { reading: false, again: false, timer: null, shown: null, disposed: false, abort: null }
  let disposed = false
  /** Ids the last `workspace.list` put in `guardPaths`, so a later list can drop the ones it lost. */
  let listedIds = new Set()
  const inFlight = new Set()
  const writer = { host: hostName, pid }

  const track = (promise) => {
    inFlight.add(promise)
    promise.finally(() => inFlight.delete(promise))
    return promise
  }

  async function call(method, params) {
    return host.call(method, params)
  }

  async function remembered() {
    loaded ??= call('storage.get', { key: STORAGE_KEY })
      .then((result) => {
        const value = result?.value
        if (value && typeof value === 'object')
          for (const [id, path] of Object.entries(value))
            if (typeof path === 'string' && !known.has(id)) {
              known.set(id, path)
              if (!guardPaths.has(id)) guardPaths.set(id, path)
            }
      })
      .catch((error) => log(`could not read remembered workspaces: ${error.message}`))
    await loaded
  }

  async function remember(id, path) {
    await remembered()
    known.delete(id)
    known.set(id, path)
    while (known.size > REMEMBERED_WORKSPACES) known.delete(known.keys().next().value)
    await store(`could not remember workspace ${id}`)
  }

  async function forget(id) {
    await remembered()
    if (known.delete(id)) await store(`could not forget workspace ${id}`)
  }

  async function store(failure) {
    try {
      await call('storage.set', { key: STORAGE_KEY, value: Object.fromEntries(known) })
    } catch (error) {
      log(`${failure}: ${error.message}`)
    }
  }

  /** Lists Orca's workspaces and adds this machine's to the launch hook's map. */
  async function listWorkspaces() {
    const result = await call('workspace.list', {})
    listed = { at: clock.now(), workspaces: result?.workspaces ?? [] }
    const ids = new Set()
    for (const row of listed.workspaces)
      if (row?.id && row.path && (!row.hostId || row.hostId === 'local')) {
        guardPaths.set(row.id, row.path)
        ids.add(row.id)
      }
    for (const id of listedIds) if (!ids.has(id) && !known.has(id)) guardPaths.delete(id)
    listedIds = ids
    return listed
  }

  /** Refreshes the launch hook's map and the guard directory setting; never rejects. */
  async function refreshGuard() {
    try {
      const result = await call('settings.get', {})
      const value = result?.settings?.[GUARD_SETTING_KEY]
      const configured = typeof value === 'string' ? value.trim() : ''
      guardDirectory = configured || defaultGuardDirectory(home)
    } catch (error) {
      log(`could not read the ${GUARD_SETTING_KEY} setting: ${error.message}`)
    }
    await remembered()
    if (!host.has?.('workspace.list')) return
    try {
      await listWorkspaces()
    } catch (error) {
      log(`could not list workspaces for the launch guard: ${error.message}`)
    }
  }

  /** The local path of the workspace a launch names, from memory only; null when unknown. */
  function guardPath(workspaceId) {
    const path = guardPaths.get(workspaceId)
    if (path) return path
    const locator = workspaceId.replace(FOLDER_INSTANCE_SUFFIX, '')
    for (const candidate of guardPaths.values())
      if (locator.endsWith(`::${candidate}`)) return candidate
    return null
  }

  /**
   * The `agent.launch.before` hook. Synchronous and awaiting nothing, in the guard record's
   * order: write the launch marker, then look for gc's admission. An admission that exists,
   * readable or not, refuses the launch. An unknown workspace, a folder or any error passes.
   */
  function guardLaunch(event) {
    const workspaceId = event?.workspaceId
    if (!workspaceId || event.workspaceKind !== 'worktree') return undefined
    const path = guardPath(workspaceId)
    if (!path) return undefined
    const agent = event.agent ?? null
    try {
      const key = guardKey(path)
      const at = new Date(clock.now()).toISOString()
      writeRecord(
        fs,
        join(guardDirectory, 'launches'),
        `${key}.json`,
        launchMarker({ path, workspaceId, agent, writer, at })
      )
      const admission = fs.statSync(join(guardDirectory, 'admissions', `${key}.json`), {
        throwIfNoEntry: false
      })
      if (!admission) return undefined
      log(`launch guard: refused ${agent ?? 'an agent'} in ${path}: ${GUARD_DENY_REASON}`)
      return { deny: GUARD_DENY_REASON }
    } catch (error) {
      log(`launch guard: let ${agent ?? 'an agent'} in ${path} through on an error: ${error?.message ?? error}`)
      return undefined
    }
  }

  function writeHeartbeat() {
    if (disposed) return
    try {
      const at = new Date(clock.now()).toISOString()
      writeRecord(fs, guardDirectory, 'heartbeat.json', heartbeatRecord({ writer, at, pluginVersion }))
    } catch (error) {
      log(`launch guard: could not write the heartbeat: ${error?.message ?? error}`)
    }
  }

  /** Writes the heartbeat and refreshes the hook's map now and every `GUARD_HEARTBEAT_MS`. */
  function startGuard() {
    if (guardTimer) return
    const beat = () => {
      if (disposed) return
      writeHeartbeat()
      track(refreshGuard())
      guardTimer = clock.setTimeout(beat, GUARD_HEARTBEAT_MS)
    }
    track(refreshGuard().then(writeHeartbeat))
    guardTimer = clock.setTimeout(beat, GUARD_HEARTBEAT_MS)
  }

  /**
   * A workspace's local path. Orca 1.4.246 offers no way to look a workspace up, so the plugin
   * remembers the paths `workspace.created` reports; an Orca with `workspace.list` answers for
   * every workspace. Agent events name a workspace by Orca's worktree id, which `workspace.list`
   * replaces with a host identity when it has one; the listed path is what both spell alike.
   */
  async function workspacePath(workspaceId) {
    await remembered()
    if (known.has(workspaceId)) return known.get(workspaceId)
    if (!host.has?.('workspace.list')) return null
    if (clock.now() - listed.at > LIST_CACHE_MS) await listWorkspaces()
    const locator = workspaceId.replace(FOLDER_INSTANCE_SUFFIX, '')
    const row =
      listed.workspaces.find((w) => w.id === workspaceId) ??
      listed.workspaces.find((w) => w.path && locator.endsWith(`::${w.path}`))
    if (!row) return null
    if (row.hostId && row.hostId !== 'local') {
      log(`workspace ${workspaceId} is on ${row.hostId}; ticks run only for this machine's`)
      return null
    }
    return row.path
  }

  /** The repository a workspace path belongs to, when it uses Jig; null otherwise. */
  async function jigRepository(path) {
    const listing = await run(['git', '-C', path, 'worktree', 'list', '--porcelain'], {
      timeoutMs: 30_000,
      env,
      platform
    })
    if (listing.code !== 0) {
      log(`${path} is not a Git checkout: ${firstLine(listing.stderr) || listing.error?.message}`)
      return null
    }
    let repo = mainCheckout(listing.stdout)
    let top = null
    if (!repo || repo.bare) {
      const shown = await run(['git', '-C', path, 'rev-parse', '--show-toplevel'], {
        timeoutMs: 30_000,
        env,
        platform
      })
      top = shown.code === 0 ? firstLine(shown.stdout) : null
      if (!top) return null
      repo = { path: top }
    }
    // The main checkout may lag a branch that adds Jig, so the workspace's own counts too.
    const configured = [repo.path, top ?? path].some((root) =>
      exists(join(root, '.config', 'jig.yaml'))
    )
    if (!configured) return null
    repositoryOf.set(path, repo.path)
    return repo.path
  }

  async function jigCommand(signal) {
    let configured = ''
    try {
      const result = await call('settings.get', {})
      const value = result?.settings?.[SETTING_KEY]
      configured = typeof value === 'string' ? value.trim() : ''
    } catch (error) {
      log(`could not read the ${SETTING_KEY} setting, using the installed plugin: ${error.message}`)
    }
    signal?.throwIfAborted()
    if (configured) {
      const args = splitCommand(configured)
      if (args.length > 0) return args
    }
    return installedCommand(signal)
  }

  /** The installed jig plugin's command, found as Jig's own timer finds it. */
  async function installedCommand(signal) {
    const failures = []
    const tools = [
      ['claude', claudePluginDirectory],
      ['codex', (list) => codexPluginDirectory(list, home)]
    ]
    for (const [name, directoryOf] of tools) {
      const program = findOnPath(name, env, platform, exists)
      if (!program) continue
      signal?.throwIfAborted()
      const answer = await run([program, 'plugin', 'list', '--json'], {
        timeoutMs: 30_000,
        maxBytes: 4 * 1024 * 1024,
        env,
        platform,
        signal
      })
      signal?.throwIfAborted()
      if (answer.code !== 0) {
        failures.push(`${name}: ${firstLine(answer.stderr) || answer.error?.message || 'failed'}`)
        continue
      }
      let directory = null
      try {
        directory = directoryOf(JSON.parse(answer.stdout))
      } catch {
        failures.push(`${name}: plugin list did not print JSON`)
        continue
      }
      if (!directory) {
        failures.push(`${name}: ${PLUGIN_ID} is not installed`)
        continue
      }
      const entry = join(directory, 'jig.ts')
      if (!exists(entry)) {
        failures.push(`${name}: ${entry} does not exist`)
        continue
      }
      const bun = findOnPath('bun', env, platform, exists) ?? join(home, '.bun', 'bin', 'bun')
      if (!exists(bun)) throw new JigCommandError('Bun is not on the PATH Orca gives its plugins')
      return [bun, '--no-env-file', `--config=${join(directory, 'dispatch', 'bunfig.toml')}`, entry]
    }
    throw new JigCommandError(
      `cannot find the installed jig plugin (${failures.join('; ') || 'neither claude nor codex is on the PATH Orca gives its plugins'}); set the Jig command setting`
    )
  }

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
    if (result.code === LOCK_HELD_EXIT) {
      log(`tick for ${repo}: another tick holds the lock: ${firstLine(result.stderr)}`)
      return true
    }
    let receipt = null
    try {
      receipt = JSON.parse(result.stdout)
    } catch {
      receipt = null
    }
    if (!receipt || !Array.isArray(receipt.repos)) {
      const why =
        result.error?.code === 'ENOENT'
          ? `${argv[0]} was not found`
          : firstLine(result.stderr) ||
            result.error?.message ||
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
    const path = await workspacePath(workspaceId)
    if (!path) {
      log(`agent ${payload.state} in workspace ${workspaceId}: its path is unknown; ignored`)
      return
    }
    const repo = await jigRepository(path)
    if (!repo) return
    requestTick(repo)
  }

  async function handleWorkspaceCreated(payload) {
    log(`workspace created: ${payload?.kind} ${payload?.path} (${payload?.branch ?? 'no branch'})`)
    if (payload?.workspaceId && payload?.path) {
      guardPaths.set(payload.workspaceId, payload.path)
      await remember(payload.workspaceId, payload.path)
    }
    // The event's id can differ from the id `workspace.list` gives the same path; list again.
    if (host.has?.('workspace.list')) {
      try {
        await listWorkspaces()
      } catch (error) {
        log(`could not list workspaces after a creation: ${error.message}`)
      }
    }
  }

  /** Forgets a removed workspace and wakes its repository, whose line may have lost a launch. */
  async function handleWorkspaceRemoved(payload) {
    const workspaceId = payload?.workspaceId
    const path = payload?.path ?? (workspaceId ? guardPaths.get(workspaceId) ?? known.get(workspaceId) : null)
    log(`workspace removed: ${payload?.kind} ${path ?? workspaceId}`)
    // Let the startup load settle first: it would otherwise re-add what is deleted here.
    await remembered()
    if (workspaceId) {
      guardPaths.delete(workspaceId)
      await forget(workspaceId)
    }
    if (path) {
      // Every id this path went by: an identity id from `workspace.list` as well as the event's.
      for (const [id, p] of [...guardPaths]) if (p === path) guardPaths.delete(id)
      let changed = false
      for (const [id, p] of [...known]) if (p === path) changed = known.delete(id) || changed
      if (changed) await store(`could not forget workspace ${workspaceId ?? path}`)
      listed = { at: listed.at, workspaces: listed.workspaces.filter((w) => w.path !== path) }
    }
    const repo = path ? repositoryOf.get(path) : null
    if (path) repositoryOf.delete(path)
    if (repo) requestTick(repo)
  }

  const guarded = (name, handler) => (payload) =>
    track(
      handler(payload).catch((error) => log(`${name} handler failed: ${error?.stack ?? error}`))
    )

  return {
    onAgentStatusChanged: guarded('agent.status.changed', handleAgentStatus),
    onWorkspaceCreated: guarded('workspace.created', handleWorkspaceCreated),
    onWorkspaceRemoved: guarded('workspace.removed', handleWorkspaceRemoved),
    onLaunchBefore: guardLaunch,
    startGuard,
    startStatusBar,
    refreshLine,
    requestTick,
    /** Resolves once every handler and tick started so far has settled (for tests). */
    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
    dispose() {
      for (const s of repos.values()) if (s.timer) clock.clearTimeout(s.timer)
      disposed = true
      if (guardTimer) clock.clearTimeout(guardTimer)
      guardTimer = null
      line.disposed = true
      line.again = false
      line.abort?.abort()
      if (line.timer) clock.clearTimeout(line.timer)
      line.timer = null
    }
  }
}

let active = null

/** The plugin's version from its manifest, for the heartbeat; null when it cannot be read. */
function manifestVersion() {
  try {
    return JSON.parse(nodeFs.readFileSync(new URL('./orca-plugin.json', import.meta.url), 'utf8')).version ?? null
  } catch {
    return null
  }
}

export default function activate(orca) {
  active = createDispatcher({
    host: orca.host,
    log: (message) => orca.log(message),
    pluginVersion: manifestVersion()
  })
  // Synchronous: the guard decides before any awaited call, so Orca's 2 s limit is never at stake.
  orca.hooks.on('agent.launch.before', (event) => active.onLaunchBefore(event))
  active.startGuard()
  active.startStatusBar()
  // Handlers return at once: Orca waits on them, and a tick can take minutes.
  orca.events.on('agent.status.changed', (payload) => {
    active.onAgentStatusChanged(payload)
  })
  orca.events.on('workspace.created', (payload) => {
    active.onWorkspaceCreated(payload)
  })
  orca.events.on('workspace.removed', (payload) => {
    active.onWorkspaceRemoved(payload)
  })
}

export function deactivate() {
  active?.dispose()
  active = null
}

