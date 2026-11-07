---
title: How the worker is built
type: architecture
status: active
last_updated: 2026-11-07
description: The plugin's concerns, the workspace map they share, its timers, and why the launch hook never waits.
---

# How the worker is built

The plugin is one Orca worker (`execution: trusted-worker`) and one panel,
with no runtime dependencies. Orca starts the worker once and calls its
default export, `activate(orca)`, which builds the worker's logic with
`createDispatcher` and connects it to the events it listens for, the launch
hook, the status bar item and the panel's requests. The panel is built
apart ([panel.md](panel.md)). Because the plugin has a hook and a status bar item, Orca keeps the
worker running while the plugin is enabled.

The plugin decides nothing Jig decides. It says when to run a tick and for
which repository, keeps a launch out of a worktree gc is removing, and shows
the dispatch line. Jig holds the rules, through the `jig` plugin installed for
Claude Code or Codex.

## The concerns

| Concern | What starts it | What it does |
|---|---|---|
| Workspaces | `workspace.created`, `workspace.removed`, `workspace.list` | Keeps a map from Orca's workspace id to its folder, and from a folder to the Jig repository it belongs to |
| Wake | `agent.status.changed`, `workspace.removed` | Runs `jig dispatch --apply --repo <repository> --json`, coalesced per repository, and shows its receipt |
| Launch guard | `agent.launch.before` | Writes a launch marker, then refuses the launch if gc holds an admission for that worktree ([launch-guard.md](launch-guard.md)) |
| Heartbeat | a timer | Writes the guard record's heartbeat and re-lists workspaces |
| Status bar | the plugin's start, each tick, a timer | Reads `jig dispatch line --json` and updates the item ([dispatch-line.md](dispatch-line.md)) |
| Panel | the panel's requests | Hands the panel the status bar's newest read, opens a workspace by its path, reads an address with `jig ask`, and sends an answer with `jig send` ([panel.md](panel.md)) |

`createDispatcher` takes everything the worker touches as arguments: the
host API, the log, a program runner, the file system, a clock, the
environment, the platform, the home directory, the host name and the process
id. The tests pass fakes for each.

## The workspace map

An agent's status change and a launch name their workspace by id, not by
folder. The plugin finds the folder in three places, in this order:

1. what `workspace.created` reported, which the plugin also keeps in its own
   storage (at most 200 workspaces), so it survives a restart of the worker;
2. `workspace.list`, which answers for every workspace on this machine and
   which the plugin re-reads at most every 30 seconds for a status change;
3. for the launch hook only, a map the plugin holds, because the hook may not wait for a call. It
   reads `workspace.list` into the map when the worker starts, every minute
   and after a workspace is created, and when a status change names an
   unknown workspace and the last listing is more than 30 seconds old. A
   removal only prunes the map and a launch never lists, so between those
   moments the hook can meet a workspace the map does not know.

It needs no capability beyond `workspace:read`. A workspace on an SSH or WSL
host has no local folder; the plugin logs it and skips it.

From a folder, the plugin finds the Git repository's main checkout
(`git worktree list --porcelain`) and wakes the dispatcher only when that
checkout, or the workspace's own checkout, has `.config/jig.yaml` (the main
checkout may lag a branch that adds Jig). It remembers which repository each folder
belonged to, so that when a workspace is removed and its files are gone it
can still run a tick for that repository.

## Why the hook never waits

Orca gives a hook two seconds to answer, and an awaited host call before a
`{ deny }` can let the action through
([Orca's hook contract](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-host-api.md#hooks)).
So the hook is synchronous: it reads the workspace map it already holds and
the guard record's files with synchronous file calls, and decides. Nothing
it does awaits Orca or a program.

The guard fails open. When it cannot decide (an unknown workspace, a folder
workspace, a file it cannot read or write), it lets the launch go on and logs
why. Orca also lets a launch through when the hook takes longer than two
seconds or the worker has crashed.

## Timers

| What | How often or how long |
|---|---|
| Ticks per repository | at most one a minute; a status change inside the minute schedules one tick at its end |
| A tick that finds Jig's lock held | tried again a minute later, up to five times |
| A tick's deadline | six hours, as long as Jig's own timer allows |
| Heartbeat and workspace re-list | every minute |
| Status bar read | at start, after each tick, and every minute; never two at once |
| A status bar read's deadline | 30 seconds, finding the command and reading the settings included |
| A panel's `jig ask` or `jig send` | 50 seconds, finding the command included; one `jig ask` at a time |
| A panel's address request in all | 100 seconds: the wait for its turn, `jig ask` and the line read together |
| A stopped program | SIGTERM, then SIGKILL after two seconds, then given up after two more |

Every program the plugin runs is started without a shell, with its arguments
as a list.

## Logs and notifications

A tick's receipt is one line in an Orca notification; its detail (each
action, launch and notification, and the command that prints the full
receipt) goes to the plugin's log, which `orca plugin logs` prints. A change of the status bar item is logged once, not on every read.
