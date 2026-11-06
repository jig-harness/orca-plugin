// The jig plugin's worker. Orca starts it with the user's permissions and hands it agent and
// workspace events. When an agent stops for input or finishes in a repository that uses Jig, it
// runs one tick of Jig's dispatcher for that repository and shows what the tick did. It also
// guards agent launches: a launch into a worktree `jig gc` is removing is refused, and shows the
// dispatch line's counts in the status bar from `jig dispatch line --json`, and answers the
// panel, which shows what on that line needs the person. Jig's rules
// stay in Jig: the worker only decides when to wake the dispatcher and which repository to name,
// and the guard follows the launch guard record in Jig's plugin/gc/README.md. This file wires
// the concerns together; each lives in its own module under lib/.
import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { createGuard } from './lib/guard.mjs'
import { createCommand, runProgram } from './lib/jig-command.mjs'
import { createPanel } from './lib/panel.mjs'
import { createStatusBar } from './lib/status-bar.mjs'
import { createWake } from './lib/wake.mjs'
import { createWorkspaces } from './lib/workspaces.mjs'

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer)
}

/**
 * The worker's logic, with everything it touches passed in: `host` is `orca.host`, `log` is
 * `orca.log`, `run(argv, options)` runs a program and resolves `{ code, stdout, stderr, error? }`,
 * `fs` is the synchronous part of `node:fs` the launch guard uses, and `post(name, data)` is
 * `orca.panels.post`. Each concern is built from one shared context: the workspaces, the jig
 * command, the status bar, the wake-ups, the launch guard and the panel.
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
  pluginVersion = null,
  post = null
}) {
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

  const ctx = { host, log, run, exists, fs, clock, env, platform, home, writer, pluginVersion, call, track, post }
  const workspaces = createWorkspaces(ctx)
  const command = createCommand(ctx)
  const statusBar = createStatusBar(ctx, command)
  const wake = createWake(ctx, command, workspaces, statusBar)
  const guard = createGuard(ctx, workspaces)
  const panel = createPanel(ctx, workspaces, statusBar)

  const guarded = (name, handler) => (payload) =>
    track(
      handler(payload).catch((error) => log(`${name} handler failed: ${error?.stack ?? error}`))
    )

  return {
    onAgentStatusChanged: guarded('agent.status.changed', wake.handleAgentStatus),
    onWorkspaceCreated: guarded('workspace.created', workspaces.handleWorkspaceCreated),
    onWorkspaceRemoved: guarded('workspace.removed', (payload) =>
      workspaces.handleWorkspaceRemoved(payload, wake.requestTick)
    ),
    onLaunchBefore: guard.guardLaunch,
    startGuard: guard.startGuard,
    startStatusBar: statusBar.startStatusBar,
    refreshLine: statusBar.refreshLine,
    requestTick: wake.requestTick,
    /** The panel's `line.get` and `workspace.open` requests; tracked, so `settled` waits on them. */
    getLine: (input) => track(panel.getLine(input)),
    openWorkspace: (input) => track(panel.openWorkspace(input)),
    /** Resolves once every handler and tick started so far has settled (for tests). */
    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
    dispose() {
      wake.dispose()
      guard.dispose()
      statusBar.dispose()
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
    pluginVersion: manifestVersion(),
    post: (name, data) => {
      // Fire and forget: a post past Orca's budget is dropped, and the panel reads again anyway.
      try {
        orca.panels.post(name, data)
      } catch (error) {
        orca.log(`could not post ${name} to the panel: ${error.message}`)
      }
    }
  })
  // Synchronous: the guard decides before any awaited call, so Orca's 2 s limit is never at stake.
  orca.hooks.on('agent.launch.before', (event) => active.onLaunchBefore(event))
  active.startGuard()
  active.startStatusBar()
  orca.panels.handle('line.get', (input) => active.getLine(input))
  orca.panels.handle('workspace.open', (input) => active.openWorkspace(input))
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

