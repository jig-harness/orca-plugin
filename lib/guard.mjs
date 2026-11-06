// The launch guard, as the launch guard record in Jig's plugin/gc/README.md describes it: the
// `agent.launch.before` hook writes a launch marker and refuses a launch into a worktree `jig gc`
// has admitted for removal, and the plugin's heartbeat tells gc the guard is running.
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** How often the plugin writes its heartbeat in the guard record and re-lists workspaces. */
export const GUARD_HEARTBEAT_MS = 60_000

/** What a refused launch tells the person. */
export const GUARD_DENY_REASON = 'jig gc is removing this worktree'

const GUARD_SETTING_KEY = 'guardDirectory'

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

/** The launch guard for the worker's context `ctx`, finding paths through `workspaces`. */
export function createGuard(ctx, workspaces) {
  const { host, log, fs, clock, home, writer, pluginVersion, call, track } = ctx
  let guardDirectory = defaultGuardDirectory(home)
  let guardTimer = null
  let disposed = false

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
    await workspaces.remembered()
    if (!host.has?.('workspace.list')) return
    try {
      await workspaces.listWorkspaces()
    } catch (error) {
      log(`could not list workspaces for the launch guard: ${error.message}`)
    }
  }

  /**
   * The `agent.launch.before` hook. Synchronous and awaiting nothing, in the guard record's
   * order: write the launch marker, then look for gc's admission. An admission that exists,
   * readable or not, refuses the launch. An unknown workspace, a folder or any error passes.
   */
  function guardLaunch(event) {
    const workspaceId = event?.workspaceId
    if (!workspaceId || event.workspaceKind !== 'worktree') return undefined
    const path = workspaces.guardPath(workspaceId)
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

  /** Stops the heartbeat; a heartbeat already due writes nothing. */
  function dispose() {
    disposed = true
    if (guardTimer) clock.clearTimeout(guardTimer)
    guardTimer = null
  }

  return { guardLaunch, startGuard, dispose }
}
