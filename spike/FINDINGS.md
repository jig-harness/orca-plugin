# The Jig panel on fixtures: findings

Task 10 of [the plan](https://plan.ref.tools/BOw43a3rSQ4XJKay). It is a throwaway spike that will not be merged. Sources read: Orca's plugin docs and renderer at `stablyai/orca` `b7fe7ba45f` (origin/main, 2026-11-05), the installed Orca 1.4.250, and Jig's `dashboard-contract.ts` and `design/dispatch-board.md` at `jig-harness/jig` `d03604bf`.

## Verdicts

1. **Drawing mode: `ui: "html"`.** It is the only mode that can do four things the panel needs: copy the answer line, give the status row its hover hints, stay dense enough for a 350 px sidebar, and share its code with a main-area board, which only an HTML frame can host. The cost is that Orca's components test kit is lost: `check` trees, `shot --scenario` and `shot --act` all work on components panels only. Tasks 7 to 9 need their own browser harness instead (see below).
2. **What fits the right sidebar: the inbox, the address thread and a one-column board.** Six columns side by side do not fit. The sidebar opens at 350 px by default and can be widened, but six columns need 1,000 to 1,300 px. In the sidebar, the board becomes a **strip**: the six column counts in one row, in flow order, with the cards of one column below. A stacked layout (Ready to merge first) is the second choice. The full six-column board fits a **custom editor in the main area**, which is the only main-area surface Orca offers a plugin. It drew all six columns in 1,260 px. Its caveat is that it must be opened on a file.
3. **Thread JSON: one object per address, holding a `thread` list, oldest first.** Each entry has `id` (taken from its record, so it is stable), `at`, `kind` (`request | question | answer | outcome | launch`), `from` and `to` (each `{kind, name}`), `summary` (Jig's own words), `quoted` (record text, kept separate from Jig's words), and `record` (`{kind, id, url}`). Some entries also carry `inReplyTo`, `decision`, `verb`, `launch`, `outcome` and `via`. The object around the list adds `holder`, `waitsOn`, `reads` and `truncated`. Full shape: [below](#3-the-proposed-jig-ask-address---thread---json).

## What blocked shooting in the real app

On this machine Orca runs only as a headless `orca serve`, under the systemd unit `orca-serve.service`. There is no desktop window and no `DISPLAY`. `orca status` reports `desktopWindowStatus: blocked` and `installMode: unsupported-headless-serve`. This runtime has no plugin service at all. So the blocker is not an approval step: loading never got as far as asking for approval.

| Command (run in `spike/panel-components`) | Answer |
| --- | --- |
| `orca plugin dev load . --json` | `runtime_error`: "Plugin service is not available on this runtime" |
| `orca plugin list` | "Plugin service is not available on this runtime" |
| `orca-ide plugin shot . --scenario park-three-decisions --theme dark` | `runtime_error`: "Showing plugin panels is only available in the Orca desktop app" |
| `orca plugin check .` (the `orca` on `PATH`) | `ERR_MODULE_NOT_FOUND …/orcad-artifacts/linux-x64-glibc/resources/plugins/declarative/orca-test-register.mjs` |

I did not start a desktop Orca next to the supervised server, and I did not approve anything. One command did try to change Orca's state: `orca plugin system on` was run once. It failed on the same missing plugin service and changed nothing.

Two Orca packaging problems turned up on the way. They are worth reporting upstream:

- The `orca` on `PATH` is the orcad CLI at `~/.config/orca/orcad-artifacts/…/0.1.0+b086a7d15d60`. It ships without `resources/plugins/declarative/`, so `plugin check`, `plugin test` and the `worker-panel` template of `plugin create` fail on it. The app's own CLI, `/opt/Orca/resources/bin/orca-ide`, runs `check` correctly.
- Neither CLI ships the typings (`orca.d.ts` and the others), so `orca plugin types` fails with both. Both CLIs report 1.4.250.

### How the shots were made (fallback, marked as such)

Every PNG under `shots/` is a **fallback**, drawn in headless Chrome by `harness/shoot.mjs`. None of them comes from `orca plugin shot`. Each mode was drawn as close to Orca's own path as this machine allowed:

- **components** (`shots/components/`): `orca-ide plugin check --json` ran the real panel and the real worker in Orca's own check runtime. The trees it returned were then painted by Orca's own `PluginDeclarativeView`, built from origin/main source with Orca's `main.css`. The wrapper is the same one `shot --scenario` uses (`PluginShotReplaySurface`: a `bg-sidebar` column at the panel's width). What the fallback cannot show:
  - The scroll column is unrolled to show the whole panel, whereas a real replay crops at the window's height (`max-h-screen`).
  - Shots are capped at 8,192 px, which cuts off `long-needs` at 350 px.
- **html** (`shots/html/`): `panel/` was served the way the isolated frame serves it. The `--orca-*` variables and the `light`/`dark` class were baked in the way Orca's frame shell does it, computed from Orca's own CSS (`shots/orca-frame-tokens.json`). `orca.plugin.request` was answered by the plugin's real `worker.mjs`. A real `orca plugin shot` cannot click an HTML panel (`--act` is refused), so the opening view is a plugin setting (`view`), as it would have to be in the app.

The shots cover all 6 scenarios, in light and dark, at 350 px (Orca's default `rightSidebarWidth`) and at 600 px. In total:

- **components (64):** 16 check scenarios: inbox and board for every scenario, plus board-columns ×2 and thread ×2.
- **html (76):** inbox and board (strip) for every scenario, stacked and six-column boards for the two busy scenarios, both threads, and the custom-editor board at 1,280 px.

`shots/manifest.json` lists each shot with its errors (none) and the board's scroll width. To redo them:

```sh
git -C <orca> archive origin/main src resources config package.json tsconfig.json components.json | tar -x -C /tmp/orca-main
ln -s <orca>/node_modules /tmp/orca-main/node_modules
(cd /tmp/orca-main && ORCA_SRC=/tmp/orca-main node_modules/.bin/vite build --config <spike>/harness/vite.config.mjs)
node spike/harness/shoot.mjs            # or: html | components
```

On a machine with the desktop app, the real shots are the commands below. The components plugin needs nothing more than this. The HTML plugin's opening view is set with its `scenario` and `view` settings before each live shot.

```sh
orca plugin dev load spike/panel-components --approve <fingerprint>   # the person's approval
orca plugin shot spike/panel-components --scenario <name> --theme dark --width 350
```

## 1. Drawing mode

The same three views were built twice. Both versions are drawn from the same fixtures and answered by the same worker handlers (`line.get`, `thread.get`, `act`).

| Need | `components` | `html` |
| --- | --- | --- |
| Copy the answer line (Task 7, and the dashboard today) | **Cannot.** The catalog has no clipboard control, the host API has no clipboard method, and the hidden module has no DOM | `document.execCommand('copy')` inside a click works. `navigator.clipboard` is refused in frames |
| Hover hints on the status row (board design, "The status row on every pull request card") | **Cannot.** `tooltip` exists only on `Button` and `IconButton`, so a `Badge` mark carries no hint | `title`, or a popover of the panel's own |
| A decision's question as its heading | `Collapsible` truncates its `title` to one line ("Should \`jig ask\` read session transcr…") | Wraps |
| Quoted record text, set apart and compact | A muted `Box` works. A `Callout` always adds a "Warning" title and an icon (see the backward-moves board) | A `blockquote` |
| A drive's framed decision (Markdown) | `Markdown` renders `## Question` as a full-size heading, with no compact variant | Small caps headings, set by the panel |
| Colour | Five tones. `accent` is the primary colour (black or white), not a hue. No free colour | Free, but frames get only 20 `--orca-*` variables: no success or warning colour, no `--sidebar`, no font |
| Density at 350 px, same content | park-three-decisions inbox: 1,396 px tall. long-needs: over 8,192 px | 1,009 px. 4,976 px |
| Board at the design's bounds (100 cards a column) | About 8.5 nodes a card, so a full board passes the 5,000-node limit, and Orca then refuses the render | No limit |
| A main-area board (custom editor) | Not available: a custom editor's `entry` is always a frame | Same page, `board.html` |
| Six columns side by side | A `Box direction="row" scroll="x"` works. It needs `align="start"`, because a row centres its children by default | Works |
| Looks like Orca, keyboard and focus, light and dark | Comes free | The panel's own CSS. The spike mixes its success and warning colours from Orca's foreground |
| Tests and shots | `orca plugin check` gives text trees per scenario. `shot --scenario`, `--act` and `orca plugin test` with `mount()` all work | None of these. Shots are live only, picked by a setting. Tests need a browser harness (`harness/shoot.mjs` is the pattern: a stand-in `window.orca` and the real worker) |
| Browser clients (`orca serve` in a web browser, which is this machine's setup) | Not drawn: "needs the desktop app" | Drawn only as **one inlined file**. A multi-file page such as this spike's `app.js` and `style.css` does not load there |

The components panel could not express the following. Each was written down rather than worked around:

- It cannot copy text.
- It cannot attach a hint to a status mark.
- It cannot show a wrapping or multi-line collapsible title.
- It cannot draw a compact note without a title.
- It has no colour outside the five tones.
- It cannot set its own Markdown heading sizes.
- It cannot draw a board of 100 cards a column within 5,000 nodes.
- It cannot be a main-area editor.

**Verdict: `html`.** The plan already chose it for Task 7. Two changes follow:

- Build the panel as **one inlined HTML file**, so that browser clients draw it too.
- Budget for a browser harness, because html loses Orca's check, scenario and act tooling.

The components mode is the better fit only for small forms and tables, and the inbox is neither.

## 2. What fits the sidebar

- **Width.** The right sidebar opens at 350 px (`rightSidebarWidth: 350` in `src/shared/constants.ts`). A person can drag it between 220 px and the window's width minus 320 px. `orca plugin shot --width` sizes it for one capture.
- **The inbox and the thread fit at 350 px** in html. A park with three decisions reads in one screen with the first decision open (`html/park-three-decisions.inbox.*.350.png`). A 17-entry thread stays readable (`html/long-thread.thread.*.350.png`).
- **Six columns do not fit.** At 236 px a column, with empty columns narrowed to their heading, the board's measured scroll width is 1,001 px for full-queue and 1,304 px for backward-moves. At 350 px one column shows; at 600 px, two and a half. A sidebar that wide needs a window of at least 1,620 px and leaves 320 px for the work.
- **In the sidebar, the board is the strip** (`html/*.board.*.350.png`). It is the six counts in flow order, and opens on Ready to merge, or on Needs you when nothing is ready, with that column's cards below and the Ready lanes as headings. The stacked layout, which is the dashboard design's phone layout, is the alternative (`html/*.board-stacked.*`). Both keep every column one click away.
- **The six-column board belongs in the main area, as a custom editor.** `customEditors` with `frame: "isolated"` validates, `plugin.request` is offered to editors, and at 1,280 px all six columns fit (`html/editor-board.*.1280.png`, scroll width 1,260 px). The caveats:
  - Orca has no plugin page or tab that is not bound to a file. The board would open on a file such as `.jigboard`, which the worker opens with `editor.open` (`workspace:write`, which Task 7 adds anyway for `workspace.open`), inside some workspace.
  - Nothing of this was seen in the real app.
  - The dashboard already shows the wide board, so the editor is optional.

## 3. The proposed `jig ask <address> --thread --json`

Fixtures: `fixtures/thread.followup-jig-469.json` (17 entries, across three stations) and `fixtures/thread.drive-jig-456.json` (a park with three decisions).

```jsonc
{
  "version": 1,
  "address": "followup@jig#469",
  "station": "followup", "repo": "jig-harness/jig", "key": "469",
  "target": { "kind": "pull-request", "number": 469, "title": "…", "url": "https://github.com/…/pull/469", "state": "merged" },
  "asOf": "2026-11-05T16:47:30Z",
  // What was read. Away from the dispatching host, launch-records is { ok: false, detail }, never guessed.
  "reads": [{ "source": "forge", "ok": true, "detail": null }, { "source": "launch-records", "ok": true, "detail": null }],
  // Who holds the station now; null when nobody does (the last outcome is then the thread's last entry).
  "holder": { "state": "held", "launch": "20261105T161202Z-jig-469", "account": "work-a", "host": "majordomo",
              "since": "…", "workspace": { "path": "/…/pr-469", "runtime": "orca" } },
  // The same closed list as a board card's waitsOn.
  "waitsOn": { "kind": "waiting", "what": "the follow-up pass, running for 35 min" },
  "related": ["drive@jig#469", "pickup@jig#JIG-212"],
  "thread": [
    {
      "id": "review-thread/PRRT_kwDOc2",          // <record.kind>/<record.id>: stable from one read to the next
      "at": "2026-11-03T12:40:00Z",
      "kind": "question",                          // request | question | answer | outcome | launch
      "from": { "kind": "station", "name": "drive@jig#469" },
      "to":   { "kind": "person",  "name": "ophir-docomply" },   // person | station | dispatcher
      "summary": "parked on 1 decision (scope)",   // Jig's own words, from a closed list
      "quoted": { "text": "## Question\n…", "format": "markdown", "truncated": false },  // record text, never Jig's
      "record": { "kind": "review-thread", "id": "PRRT_kwDOc2", "url": "https://github.com/…#discussion_r2011" },
      "decision": { "key": "PRRT_kwDOc2", "class": "scope" },   // questions
      "via": "drive@jig#469"                       // set when the entry belongs to a related address
    },
    { "id": "pr-comment/3122", "kind": "answer", "inReplyTo": "review-thread/PRRT_kwDOc2", "…": "…" },
    { "id": "label-event/jig:hold", "kind": "request", "verb": "hold", "…": "…" },
    { "id": "launch-record/…", "kind": "launch", "launch": { "action": "rearm", "account": "codex-a", "host": "majordomo" } },
    { "id": "ledger/drive-ledger", "kind": "outcome", "outcome": { "class": "converged", "exit": 0 } }
  ],
  "truncated": null                                 // or { "before": 40, "cursor": "…" } for older entries
}
```

Why each part is shaped this way:

- **`summary` and `quoted` are separate fields.** This follows the board design's rule for text the board did not write. The panel shows `quoted` set apart, and an agent that reads the JSON can tell Jig's words from words a collaborator wrote.
- **`id` comes from the record,** so the panel can key its list and link an answer to its question with `inReplyTo` across reads. Answer entries carry `inReplyTo`; question entries carry `decision.key`.
- **`holder.workspace.path`** is what "open the Orca workspace" needs. The worker maps the path to a workspace id with `workspace.list`.
- **Entries from related addresses are included and marked with `via`.** A follow-up's thread then tells the whole story: the pickup that opened the PR, the drive's parks and answers, the merge, then the follow-up launch. A panel or CLI that wants only the address's own entries filters out `via`. Whether `--thread` includes them by default is the one open choice for the addresses design. I recommend including them.
- **`record.url`** is given only for the forge's or tracker's own HTTPS host, as the board design rules for links.

## What else changes the panel Tasks

- **Task 7:**
  - Keep `ui: "html"`, but ship the page as a single inlined file.
  - The opening view should follow the person's needs. The strip and inbox did best opening on Ready to merge or Needs you.
  - `workspace.open` takes a `workspaceId`, so add `workspace.list` (`workspace:read`) to map a need's workspace path to an id.
  - "Copy the answer line" works only through `execCommand` inside the click.
  - Tests need a browser harness. `harness/shoot.mjs` (a stand-in `window.orca` and the real worker in Node) is the pattern.
- **Task 7 and the dispatch board's step 2:** the inbox shows the Ready to merge lanes as a folded group above the needs. The full-queue shots show that this keeps 10 ready pull requests from burying the parks.
- **Task 8:**
  - In the sidebar, the board is the strip, with the stacked layout as an option, not six columns.
  - Add `address` to each board card (proposed in the fixtures' `line.board`), so that a card opens its thread.
  - The six-column view is a custom editor, worth one check in the desktop app first, or it stays on the dashboard.
  - The fixtures' `board` shape is a proposal (`"proposed": true`), not the contract.
- **Task 9:**
  - Nothing yet lists "addresses with recent activity". The spike derives the list from the line's needs and board cards. Either Task 9 does the same, or the addresses design adds `jig ask --recent --json`.
  - The answer box sends with `jig send <address> answer`. Reply drafts live only in the page; the panel stores nothing.
- **Frames get `--orca-background` (#fff / #0a0a0a), but the sidebar around them is `--sidebar` (#fafafa / #171717)**, and Orca's own components replay paints `bg-sidebar`. An HTML panel cannot read `--sidebar`, so in dark mode it may show a seam against the sidebar. This could not be checked without the app.
- **The design round:** no separate round for the panel is needed. The dispatch board's step 5 brief should add the 350 px strip as a target width beside phone and desktop.
- **Fixtures:**
  - The six `state.*.json` files type-check against `StateAnswer` at `d03604bf` once the proposed `line.board` is set aside.
  - `make.mjs` writes them all from hand-written data.
- **Orca issues to report:**
  - The `PATH` CLI lacks the declarative resources.
  - The Linux 1.4.250 package lacks the plugin typings.
  - `shot --scenario` crops at the window's height, so a long inbox cannot be reviewed in one scenario shot.

## Files

- `fixtures/`: `make.mjs`, six `state.<scenario>.json` (`GET /state` answers), and two `thread.<address>.json` (the proposed `ask --thread` answers).
- `panel-components/`: `local.jig-spike-components`: a `ui: "components"` panel (`src/panel.tsx`), its worker, and `src/panel.check.ts` with 16 scenarios.
- `panel-html/`: `local.jig-spike-html`: an HTML panel (`panel/index.html`, `app.js`, `style.css`), the custom editor `panel/board.html` for `.jigboard` files, and `worker.mjs`.
- `harness/`: the fallback renderer (`components/`, `vite.config.mjs`) and `shoot.mjs`.
- `shots/`: 140 PNGs, `manifest.json` and `orca-frame-tokens.json`.
