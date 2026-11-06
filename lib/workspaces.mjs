// The workspaces the worker knows: the paths `workspace.created` reported, remembered in the
// plugin's storage; the launch hook's id-to-path map, kept from memory so the hook awaits
// nothing; Orca's `workspace.list`; and which Jig repository a workspace path belongs to.
import { join } from 'node:path'
import { firstLine } from './jig-command.mjs'

const STORAGE_KEY = 'workspaces'
const REMEMBERED_WORKSPACES = 200
const LIST_CACHE_MS = 30_000
const FOLDER_INSTANCE_SUFFIX = /::workspace:[0-9a-f-]{36}$/

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

/** The workspace bookkeeping for the worker's context `ctx`. */
export function createWorkspaces(ctx) {
  const { host, log, run, exists, clock, env, platform, call } = ctx
  const known = new Map()
  /** Workspace id to local path, for the launch hook, which must not await a host call. */
  const guardPaths = new Map()
  /** Workspace path to the Jig repository it belongs to, kept for when its files are gone. */
  const repositoryOf = new Map()
  let loaded = null
  let listed = { at: -Infinity, workspaces: [] }
  /** Ids the last `workspace.list` put in `guardPaths`, so a later list can drop the ones it lost. */
  let listedIds = new Set()
  /** Refresh bookkeeping: a response is stale if a newer one applied, or its workspace was removed meanwhile. */
  let listSeq = 0
  let appliedSeq = 0
  let pendingLists = 0
  /** Path to the `listSeq` at its removal; a list started no later than that must not restore it. */
  const removedAt = new Map()

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
    const seq = ++listSeq
    pendingLists++
    let result
    try {
      result = await call('workspace.list', {})
    } finally {
      pendingLists--
    }
    // A newer response already applied: this snapshot predates it and would overwrite its state.
    if (seq < appliedSeq) return listed
    appliedSeq = seq
    const rows = (result?.workspaces ?? []).filter((w) => !(removedAt.get(w?.path) >= seq))
    if (pendingLists === 0) removedAt.clear()
    listed = { at: clock.now(), workspaces: rows }
    const ids = new Set()
    for (const row of rows)
      if (row?.id && row.path && (!row.hostId || row.hostId === 'local')) {
        guardPaths.set(row.id, row.path)
        ids.add(row.id)
      }
    for (const id of listedIds) if (!ids.has(id) && !known.has(id)) guardPaths.delete(id)
    listedIds = ids
    return listed
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

  /**
   * Forgets a removed workspace and wakes its repository through `requestTick`, since the
   * repository's line may have lost a launch.
   */
  async function handleWorkspaceRemoved(payload, requestTick) {
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
      removedAt.set(path, listSeq)
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

  return {
    remembered,
    listWorkspaces,
    guardPath,
    workspacePath,
    jigRepository,
    handleWorkspaceCreated,
    handleWorkspaceRemoved
  }
}
