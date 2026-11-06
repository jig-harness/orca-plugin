---
title: How the panel is built
type: architecture
status: active
last_updated: 2026-11-06
description: The Jig panel's inbox, where its source and built file live, the worker requests it makes, what each button does, and how it is tested.
---

# How the panel is built

The panel opens in Orca's right sidebar on the person's inbox: every need
on Jig's dispatch line, in the order and the words of the dashboard's What
needs you. What a person sees and does with it is in the
[README](../README.md#the-panel). The panel draws the line and holds none of
Jig's rules; the line is read as [dispatch-line.md](dispatch-line.md) says.

## Source and built file

The panel is `ui: "html"`: a web page in Orca's isolated frame, 350 px wide
by default. Its source is in `panel/src/`:

| File | What it holds |
|---|---|
| `index.html` | The page: a bar with "Read again", and the inbox below it |
| `inbox.mjs` | Pure functions from the worker's answer to HTML text: the groups, each need, its decisions, the answer line |
| `app.mjs` | The frame's side: the requests to the worker, the buttons, the reply drafts |
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

A need's workspaces are, in order: the line's sessions on the same
repository and target, the need's own `workspaces` (a double claim's), and
the workspace its notification went to (`notified.workspace`). Only those
`workspace.list` lists on this machine, or that a `workspace.created` event
reported, are kept in `open`; a need with none gets no workspace button.

After each read the worker posts `line.changed` to the panel, which then
asks again. The open panel also asks every minute, so its ages move on.

## The buttons

| Button | What it does |
|---|---|
| The pull request (or the tracker) | `orca.shell.openExternal` on the need's `url`, inside the click, and only for an `https:` link. Orca asks before it opens a host this plugin has not opened before. A browser client has no `orca.shell`, so there the link is copied instead. |
| Open the workspace | Asks the worker's `workspace.open` with the path. It needs the `workspace:write` capability. |
| Copy answer line | Copies `answer <key>: <reply>` for each of a park's decisions, with the replies typed under Write reply. A frame refuses `navigator.clipboard`, so the copy is `document.execCommand('copy')` inside the click. |
| Write reply | Opens a box per decision. Drafts live only in the open page; the panel stores nothing. |

Answering from the panel, through `jig send`, is a later step.

## Tests

`tests/panel.test.mjs` runs the requests against the fake Orca and the
fixture lines in `tests/fixtures/` (`GET /state` answers, from the panel
spike). `tests/panel-build.test.mjs` checks the built file is fresh.

An HTML panel gets none of Orca's `plugin check` or `plugin shot
--scenario`, so `tests/panel/harness.mjs` draws `panel/inbox.html` in
Chrome at 350 px, in Orca's light and dark frame colours, with a stand-in
`window.orca` answered by the real worker. It checks a quiet line, a long
Needs you and a park with three decisions, presses the buttons, and writes
a shot of each to `tests/panel/shots/`. How to run it is in
[development.md](development.md#the-panel).
