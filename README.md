# Jig for Orca

An [Orca](https://www.onorca.dev) plugin that wakes
[Jig](https://github.com/jig-harness/jig)'s dispatcher when an agent in Orca
stops for input or finishes, shows what the dispatcher did, refuses to
start an agent in a worktree `jig gc` is removing, and shows the dispatch
line in Orca's status bar.

Jig's dispatcher is a program that looks at a repository's tracker, its
pull requests and the agent sessions running on this machine, and starts
what should be running and is not (a stopped review loop, a merge's
follow-up, a new piece of work) or tells a person about a stop only a
person can settle. Without this plugin it runs on a timer, every few
minutes. With it, a change in Orca also runs it at once: when an agent
finishes or waits, the next step does not wait for the timer.

## What it does

- When an agent's status in Orca changes to `waiting`, `blocked` or `done`,
  it finds the workspace's folder, the Git repository the folder belongs
  to (the main checkout, for a linked worktree) and, when that repository
  has `.config/jig.yaml`, runs one tick of the dispatcher for it:
  `jig dispatch --apply --repo <repository> --json`.
- It runs at most one tick per repository a minute, and never two at once
  for the same repository; a status change is never lost
  ([how](docs/architecture.md#timers)).
- It shows the tick's receipt as one line in an Orca notification, such as
  `acme/app: 2 wanted, 1 started, 0 notified, 3 running (tick ...)`, and
  writes the rest (each action and launch, and the command that prints the
  full receipt) to the plugin's log, which `orca plugin logs` prints.
- When a workspace is created, it logs it and remembers its folder in the
  plugin's own storage, to find the folder again when that workspace's
  agents change status.
- When a workspace is removed, it forgets it and, when it knows the
  repository the workspace belonged to, runs a tick for that repository, so
  a launch whose workspace a person removed ends now, not at the next timer.
- A `jig` command that is missing or fails is a notification and a log
  line, never a crash.

## The launch guard

`jig gc` removes worktrees nobody uses any more. Between its last look at
Orca and the removal, an agent could start in the worktree it is about to
delete. The plugin closes that gap for every agent Orca starts: from a new
tab, a workspace's creation, `orca agent launch`, an automation or an
orchestration.

Before Orca starts an agent in a worktree, the plugin's `agent.launch.before`
hook checks Jig's launch guard record, which gc writes while it removes a
worktree. When gc holds that worktree, the launch is refused with "jig gc is
removing this worktree". Otherwise it goes on. How the hook and gc see each
other, and what the guard cannot see, is in
[docs/launch-guard.md](docs/launch-guard.md).

The guard fails open. A launch in a folder workspace, in a workspace the
plugin does not know, or one where reading or writing the record fails goes
on, and the plugin logs each refusal and each launch it let through on an
error. Orca also lets a launch through when the hook takes more than two
seconds or the worker has crashed.

## The status bar

One status bar item shows what the dispatch line waits on, from
`jig dispatch line --json`
([Jig's plugin README](https://github.com/jig-harness/jig/blob/main/plugin/README.md),
"The line as JSON"), run with the same Jig command as the ticks:

| The item says | When |
|---|---|
| `Jig 2 need you` | The newest tick's line has two needs (the line counts each once across repositories). |
| `Jig 1 ready · 2 need you` | The same, once the line carries a ready-to-merge list; today's line (version 1) has none, so no ready count is shown. |
| `Jig tick overdue` | The newest tick finished more than twice the dispatch interval ago; its needs follow when there are any. The interval is the line's own, else the `dispatchIntervalMinutes` setting. |
| `Jig no tick yet` | No tick has written a line, or there is no state database. |
| `Jig line unreadable` | The command exited 1 (its standard error line is the tooltip), printed no answer, a line of a version this plugin does not read, or ran past 30 seconds. |
| `Jig too old for the status bar` | The command line was refused (exit 2): the installed jig has no `dispatch line`. |
| `Jig not found` | The Jig command cannot be resolved; the tooltip says why. |

It reads the line when the plugin starts, after every tick the plugin runs,
and every minute ([what it reads](docs/dispatch-line.md)). Pressing the item
opens nothing yet.

## What it does not do

- It holds none of Jig's rules. What a tick starts, for which repository and
  on which account, is decided by Jig and by the machine's dispatch file
  (`~/.jig/dispatch.yaml`); this plugin only says when to run a tick and for
  which repository. It runs the `jig` plugin already installed on the
  machine and bundles nothing of it, so Jig updates through its own release
  channel.
- It does not replace the dispatcher's timer: the timer still catches what
  no status change announces, such as a merge or a new tracker item.
- It has no panel. Jig's dashboard stays `jig dispatch dashboard`; the
  status bar item is a count, not a view.
- It runs ticks only for workspaces on this machine. A workspace on an SSH
  or WSL host is logged and skipped.
- It contributes no skills to Orca, only the one hook above and the one
  status bar item.

## Requirements

- **Orca 1.4.248 or later.** The plugin is a full-access (`trusted-worker`)
  plugin with declared settings and the `agent.launch.before` hook, which
  that release introduced. A plugin with a hook keeps its worker running
  while it is enabled.
- **On a headless Linux server, `orca serve` with
  `ORCA_SERVE_RUNTIME=electron`.** By default `orca serve` runs on orcad,
  which has no plugin service, so no plugin loads, this one included
  ([Orca's remote servers page](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/remote-servers.mdx)).
  A launch from a paired client is decided by the server's plugins, so the
  server must run this one for the guard to see those launches.

  For a server run as a systemd user service, set the variable in a
  drop-in rather than in the unit, which `orca serve service install`
  rewrites on every upgrade:

  ```ini
  # ~/.config/systemd/user/orca-serve.service.d/plugin-runtime.conf
  [Service]
  Environment=ORCA_SERVE_RUNTIME=electron
  ```

  Then `systemctl --user daemon-reload` and restart the service. It took
  effect when `orca plugin list` lists plugins instead of answering "Plugin
  service is not available on this runtime". The desktop app's runtime
  holds more memory than orcad; a packaged macOS app's `orca serve` already
  uses it. The restart keeps terminals, which live in Orca's terminal
  daemon, but stops any session whose processes run in the service itself,
  such as an Orca chat session.
- **The `jig` plugin**, installed for Claude Code or Codex, with **Bun** on
  the `PATH` Orca starts with ([Jig's plugin
  README](https://github.com/jig-harness/jig/blob/main/plugin/README.md)
  says how). `--apply` also needs the machine's dispatch file; without it
  each tick fails with a notification saying so.
- The repositories it should wake the dispatcher for have `.config/jig.yaml`.

## Install

The plugin is not listed in a catalog yet. Load it from a clone:

```sh
git clone https://github.com/jig-harness/orca-plugin.git
orca plugin dev load orca-plugin
```

`dev load` prints what the plugin would be granted and the command to
approve it with (`--approve <fingerprint>`). Orca shows the same review
under Settings → Plugins → Development folders.

What it asks for: `agent:read` and `workspace:read` for the declared events and
the workspace list, `notifications:show` for the receipt, `storage:own` for
the workspaces it remembers, `settings:own` for its settings. The launch
hook needs no capability; Orca lists it in the same review.

## The settings

**Jig command** (`jigCommand`): the command that runs Jig, without
arguments. The plugin adds `dispatch --apply --repo <repository> --json`.
Quotes keep spaces; nothing else is expanded and no shell reads it.

Left empty, the plugin finds the installed `jig` plugin the way Jig's own
timer does: the user-scope `jig@jig` entry of `claude plugin list --json`
(else `codex plugin list --json`), and runs

```sh
bun --no-env-file --config=<plugin>/dispatch/bunfig.toml <plugin>/jig.ts
```

from it. Set it when `claude`, `codex` or `bun` is not on the `PATH` Orca
starts plugins with, or when the tick needs an environment variable: Orca
gives a plugin worker only `PATH`, `HOME`, the locale and the temporary
directory, so, for example,
`env CLAUDE_CONFIG_DIR=/home/me/.claude-work bun --no-env-file --config=...`.

**Dispatch interval** (`dispatchIntervalMinutes`, default 5): how often
Jig's dispatch timer ticks, for a line that does not carry its interval. The
status bar says the tick is overdue past twice this.

**Launch guard directory** (`guardDirectory`): where the launch guard record
lives. Left empty, it is `.local/state/jig/orca-guard` under the home
directory on every platform, which is where Jig looks; Jig reads no
`XDG_STATE_HOME` for it. Set it only to name the directory Jig itself uses.

## Develop

`node --test` runs the tests. How the worker is built, how to load it while
you work and how CI checks it are in [docs/](docs/architecture.md), starting
with [docs/development.md](docs/development.md).

## License

[MIT](LICENSE).
