// Finding and running the jig command: the setting's command line, or the jig plugin installed
// for Claude Code or Codex, found as Jig's own timer finds it; and running a program without a
// shell, stopping its whole process group at a deadline.
import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'

/** How long a stopped program has to close after SIGTERM, and again after SIGKILL. */
export const KILL_GRACE_MS = 2_000

const PLUGIN_ID = 'jig@jig'
const SETTING_KEY = 'jigCommand'

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

/** The first non-blank line of a program's output, trimmed; empty when there is none. */
export function firstLine(text) {
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

/** Resolves the jig command for the worker's context `ctx`: the setting's, else the installed one. */
export function createCommand(ctx) {
  const { log, run, exists, env, platform, home, call } = ctx

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

  return { jigCommand }
}
