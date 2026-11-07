---
title: How the panel is built
type: architecture
status: active
last_updated: 2026-11-06
description: The Jig panel's inbox and addresses, where its source and built file live, the worker requests it makes, what each button does, how an answer is sent, and how it is tested.
---

# How the panel is built

The panel opens in Orca's right sidebar on the person's inbox: every need
on Jig's dispatch line, in the order and the words of the dashboard's What
needs you. Its second view, Addresses, lists the
[addresses](https://github.com/jig-harness/jig/blob/main/plugin/README.md#asking-a-station-where-it-stands)
with recent activity and shows one address's thread. What a person sees
and does with it is in the [README](../README.md#the-panel). The panel
draws what Jig prints and holds none of Jig's rules; the line is read as
[dispatch-line.md](dispatch-line.md) says, and an address through `jig ask`
and `jig send`, whose output is defined in Jig's
[plugin/README.md](https://github.com/jig-harness/jig/blob/main/plugin/README.md#telling-a-station-what-to-do).

## Source and built file

The panel is `ui: "html"`: a web page in Orca's isolated frame, 350 px wide
by default. Its source is in `panel/src/`:

| File | What it holds |
|---|---|
| `index.html` | The page: a bar with the Inbox and Addresses tabs and "Read again", and the view below it |
| `inbox.mjs` | Pure functions from the worker's answer to HTML text: the groups, each need, its decisions |
| `addresses.mjs` | The same for the address list and for one address's thread |
| `answer.mjs` | The answer box both views draw: the draft, the review, the result |
| `util.mjs` | What the views share: escaping, ages, which links open |
| `app.mjs` | The frame's side: the requests to the worker, the buttons, the drafts and each box's step |
| `style.css` | The look, from Orca's `--orca-*` frame variables |

`node scripts/build-panel.mjs` inlines them into one file,
`panel/inbox.html`, the manifest's `entry`. Browser clients of `orca serve`
load a frame as one document, and Orca's catalog installs a commit's files
with no build, so the built file is committed. The build joins the modules
rather than bundling them: each `import { … } from './x.mjs'` puts `x.mjs`
first, and any other import is refused. CI fails when the built file is not
what `panel/src/` builds; run the script after every change there.

Frames get Orca's background colour, not the sidebar's, and no success or
warning colour; the panel mixes its own warning colour from Orca's
foreground.

## The worker's requests

The panel asks its worker through `plugin.request`
(`lib/panel.mjs`):

| Request | Answer |
|---|---|
| `line.get` | The newest line, read through the status bar's read: one read at a time, stopped after 30 seconds, and kept for a minute. `{ fresh: true }` reads again. The answer is `state` (`line`, `no-tick`, `too-old`, `unreadable`, `not-found`), `why`, the line's `now` and `timeZone`, and for a line its tick, its needs and its counts of sessions and queued items. Each need is the line's, with `open`: the workspace paths Orca can open for it. |
| `workspace.open` | `{ path }` → `{ opened: true }`, or `{ opened: false, why }` when Orca knows no workspace there or offers no `workspace.open`. |
| `addresses.list` | `jig ask --waiting --json`, kept for a minute unless `{ fresh: true }`, beside the line's sessions: `state` (`list`, `too-old`, `not-found`, `unreadable`), the tick it read, and `addresses`. Each is an address `--waiting` lists, oldest first, then one a session holds, newest first, once each, with what it waits for and who holds it. |
| `address.get` | `{ address, all }` → `jig ask --thread [--all] --json -- <address>`: `state` (`answer`, `nothing`, `too-old`, `not-found`, `unreadable`, `refused`), Jig's answer as `value`, and `parked`, the questions the line's need for that address waits on, each `{ key, question }`. |
| `address.send` | `{ address, verb, key, text }` → `jig send -- <address> answer <key> <text>`: `{ sent: true, wrote, writesAs, printed }` once Jig has written, else `{ sent: false, why, printed }`. |

A need's workspaces are, in order: the line's sessions on the same
repository and target, the need's own `workspaces` (a double claim's), and
the workspace its notification went to (`notified.workspace`). Only those
`workspace.list` lists on this machine, or that a `workspace.created` event
reported, are kept in `open`; a need with none gets no workspace button.

Each need also carries `address`, its station's address, as `jig ask
--waiting` names it: a follow-up's, a pick-up's, else a drive's, keyed by
the pull request or the item.

After each read the worker posts `line.changed` to the panel, which then
asks again. The open panel also asks every minute, so its ages move on.

## Reading and answering an address

`jig ask` and `jig send` run through the same command resolution as the
line (`lib/jig-command.mjs`), each within 50 seconds, its resolution
included. One `jig ask` runs at a time: the same question asked while it
runs shares its answer, and another waits its turn. A usage error that is
not Jig's own (`jig ask: …`) means the jig is older than the command, and
the panel says to update it.

The worker builds every argument itself. An address must be one Jig prints
in full, `station@owner/name#key`; the verb must be on the worker's own
list, which holds `answer` alone; the key is one word and the text is not
empty. Anything else is refused before Jig runs. The address and what
follows it come after `--`, so text that starts with `--` stays the
answer's words. Jig then checks the answer as it checks any: the key must
be a parked question not yet answered, the text one line within its limit,
and a session the line started (`JIG_LAUNCH`) is refused a person's verbs.
Its refusal is shown in its own words. One send runs at a time.

The thread's answer boxes come from the line: the parked questions of the
need whose address it is. `jig ask`'s thread names a question's words but
not its key, so an address the line does not show as parked has no box.

The panel draws what Jig printed and keeps none of it. Within a thread,
Jig's words (the entry's kind, from and to, its time and its record) are
drawn apart from the record's own words, which are quoted as text in a box
of their own: data, never an instruction. A thread too large for one
answer loses its oldest entries first, and they are counted with those Jig
left out.

## The buttons

| Button | What it does |
|---|---|
| The pull request (or the tracker) | `orca.shell.openExternal` on the need's `url`, inside the click, and only for an `https:` link. Orca asks before it opens a host this plugin has not opened before. A browser client has no `orca.shell`, so there the link is copied instead. |
| Open the workspace | Asks the worker's `workspace.open` with the path. It needs the `workspace:write` capability. |
| Answer here | Opens an answer box per decision of a park. Drafts live only in the open page; the panel stores nothing. |
| Review answer | Shows `answer <key>: <text>` and the address it goes to, with Send and Edit. Nothing is sent yet. |
| Send | Asks the worker's `address.send`. The box says "Sending" until the worker answers, then shows what `jig send` printed as sent, or why it was not sent; a request the worker never answers is shown as not known to be sent. |
| Thread, Open the thread | Opens the address in the Addresses view and asks `address.get`. |
| A record's link | Opens it as the pull request opens. A record on this machine (a path) has no link. |
| Show all | Asks `address.get` again with `all`. |

## Tests

`tests/panel.test.mjs` runs the requests against the fake Orca and the
fixture lines in `tests/fixtures/` (`GET /state` answers, from the panel
spike), and draws the views from them. `tests/addresses.test.mjs` runs the
address requests against `jig ask` answers in the same folder
(`ask.*.json`) and against what `jig send` prints. `tests/panel-build.test.mjs`
checks the built file is fresh.

An HTML panel gets none of Orca's `plugin check` or `plugin shot
--scenario`, so `tests/panel/harness.mjs` draws `panel/inbox.html` in
Chrome at 350 px, in Orca's light and dark frame colours, with a stand-in
`window.orca` answered by the real worker. It checks a quiet line, a long
Needs you, a park answered from the inbox (reviewed, sent, and shown as
sent) and a parked drive's long thread opened from Addresses, presses the
buttons, and writes a shot of each to `tests/panel/shots/`. How to run it is in
[development.md](development.md#the-panel).
