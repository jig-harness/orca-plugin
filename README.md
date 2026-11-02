# Jig for Orca

An [Orca](https://www.onorca.dev) plugin that wakes
[Jig](https://github.com/jig-harness/jig)'s dispatcher when an agent in Orca
stops for input or finishes, and shows what the dispatcher did.

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
- It runs at most one tick per repository a minute. A status change inside
  that minute schedules one tick at its end, so none is lost and none runs
  twice; a tick never runs while another tick of the same repository does.
  When the dispatcher answers that another tick holds its lock (its own
  timer, say), the plugin tries again a minute later, up to five times.
- It shows the tick's receipt as one line in an Orca notification, such as
  `acme/app: 2 wanted, 1 started, 0 notified, 3 running (tick ...)`, and
  writes the rest (each action and launch, and the command that prints the
  full receipt) to the plugin's log, which `orca plugin logs` prints.
- When a workspace is created, it logs it and remembers its folder in the
  plugin's own storage, to find the folder again when that workspace's
  agents change status.
- A `jig` command that is missing or fails is a notification and a log
  line, never a crash.

## What it does not do

- It holds none of Jig's rules. What a tick starts, for which repository and
  on which account, is decided by Jig and by the machine's dispatch file
  (`~/.jig/dispatch.yaml`); this plugin only says when to run a tick and for
  which repository. It runs the `jig` plugin already installed on the
  machine and bundles nothing of it, so Jig updates through its own release
  channel.
- It does not replace the dispatcher's timer: the timer still catches what
  no status change announces, such as a merge or a new tracker item.
- It has no panel. Jig's dashboard stays `jig dispatch dashboard`.
- It runs ticks only for workspaces on this machine. A workspace on an SSH
  or WSL host is logged and skipped.
- It contributes no skills or hooks to Orca: Orca reserves those
  contribution points until their format is defined.

## Requirements

- **Orca 1.4.246 or later.** The plugin is a full-access (`trusted-worker`)
  plugin with declared settings, which that release introduced.
- **The `jig` plugin**, installed for Claude Code or Codex, with **Bun** on
  the `PATH` Orca starts with ([Jig's plugin
  README](https://github.com/jig-harness/jig/blob/main/plugin/README.md)
  says how). `--apply` also needs the machine's dispatch file; without it
  each tick fails with a notification saying so.
- The repositories it should wake the dispatcher for have `.config/jig.yaml`.

**Finding a workspace's folder.** An agent's status change names its
workspace by id. On Orca 1.4.246 a plugin cannot look a workspace up, so
the plugin knows the folders of workspaces created while it is enabled, and
skips the others with a log line. An Orca whose plugin host API has
`workspace.list` (host API 1.3, after 1.4.246) answers for every workspace,
and the plugin uses it when it is there; it needs no capability beyond
`workspace:read`.

## Install

The plugin is not listed in a catalog yet. Load it from a clone:

```sh
git clone https://github.com/jig-harness/orca-plugin.git
orca plugin dev load orca-plugin
```

`dev load` prints what the plugin would be granted and the command to
approve it with (`--approve <fingerprint>`). Orca shows the same review
under Settings → Plugins → Development folders.

What it asks for: `agent:read` and `workspace:read` for the two events and
the workspace list, `notifications:show` for the receipt, `storage:own` for
the workspaces it remembers, `settings:own` for its one setting.

## The setting

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

## Develop

```sh
node --test                                   # the worker's tests, Node 20 or later
pnpm validate:plugin /path/to/orca-plugin     # from an Orca checkout
orca plugin dev emit . agent.status.changed --data '{"workspaceId":"...","paneKey":"t:1","state":"done","receivedAt":0}'
```

`main.mjs` is plain JavaScript with no dependencies. The tests run the
worker's logic against a fake Orca, a fake clock and a fake process runner.
CI runs them, and validates the manifest with Orca's own validator at the
release `engines.orca` names.

## License

[MIT](LICENSE).
