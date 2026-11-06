---
title: How the status bar reads the dispatch line
type: reference
status: active
last_updated: 2026-11-06
description: What the plugin runs to read Jig's dispatch line, which fields of the answer it depends on, and what it shows when the read fails.
---

# How the status bar reads the dispatch line

The status bar item shows what Jig's dispatch line waits on. The line is
Jig's: `jig dispatch line --json` prints the newest tick's line, the same
document the dispatch dashboard serves at `GET /state`.
[Jig's plugin README](https://github.com/jig-harness/jig/blob/main/plugin/README.md),
"The line as JSON", defines the command and its answer. This page says only
what the plugin runs, which parts of the answer it depends on, and what it
does with each outcome. What each item text means to a person is in the
[README](../README.md#the-status-bar).

## What it runs

The Jig command the ticks use (the `jigCommand` setting, else the installed
`jig` plugin; see the [README](../README.md#the-settings)), followed by
`dispatch line --json`, without a shell. One read at a time, stopped after 30
seconds, with at most 4 MB of output read. It reads the line when the worker
starts, after every tick the plugin runs, and every minute. An Orca without
`statusBar.update`, such as orcad, reads nothing.

## What it depends on

| Part of the answer | What the plugin does with it |
|---|---|
| exit status 2 | the command line was refused: this jig has no `dispatch line` |
| exit status 0 and a JSON object with `ok: true` | reads `value`; anything else is unreadable |
| `value.line` is `null` | no tick has written a line yet |
| `value.line.version` | reads version `1` only; another version is unreadable |
| `value.line.needs` | an array; its length is the number of needs (the line counts each once across repositories) |
| `value.line.finishedAt` | the tick's finish time; an unparseable one is unreadable, since the age is unknown |
| `value.line.intervalMs` | the dispatch interval, when positive; else the `dispatchIntervalMinutes` setting |
| `value.now` | the clock the age is measured against, else the worker's own |
| `value.line.runId` | shown in the tooltip |

A tick is overdue when its age is more than twice the interval. Version 1
carries no ready-to-merge list, so the plugin shows no ready count rather
than guess one; once a version carries it, the item adds it.

The line's contract changes in Jig first; this page and the reading code
follow it in one pull request.
