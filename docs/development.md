---
title: Developing the plugin
type: guide
status: active
last_updated: 2026-11-06
description: How to load the plugin while you work on it, run its tests and Orca's validator, and what to watch for on Linux.
---

# Developing the plugin

The worker is plain JavaScript ES modules with no dependencies, so there is
nothing to install or build. Node 20 or later runs the tests.

## Tests

```sh
node --test
```

The tests run the worker's logic against a fake Orca, a fake clock, a fake
process runner and a fake file system, and a test against real files. CI
runs them on Node 20 and 24.

`orca plugin test .` runs the same suite through Orca, with Orca's own Node
when the one on `PATH` is older than 20.6. CI does not use it, because it
needs Orca installed.

## Orca's validator

```sh
orca plugin validate .                      # with Orca installed
pnpm validate:plugin /path/to/orca-plugin   # from an Orca checkout
```

CI runs Orca's validator from an Orca checkout pinned to the release
`engines.orca` names (`ORCA_RELEASE` and its commit `ORCA_REF` in
`.github/workflows/validate.yml`). Bump the pin deliberately, and together
with `engines.orca` when the manifest uses a field a newer release
introduced. The validate job fails unless `ORCA_REF` is the commit of Orca's
tag `v$ORCA_RELEASE` and `engines.orca` is exactly `>=$ORCA_RELEASE`.

## Contracts

The `Contracts` workflow (`.github/workflows/contracts.yml`) checks the
plugin against the contracts it shares with Jig, using a Jig checkout
pinned by `JIG_REF`. Bump that pin by hand, as you bump `ORCA_REF`.

- `tests/contracts/guard-record.mjs` checks the launch guard record. The
  plugin's keys match Jig's. Its heartbeat makes Jig's `guardState` report
  the plugin as guarding. Its launch marker reads in Jig's `launchVeto`. An
  admission Jig's `admit` writes makes the hook refuse the launch.
- `tests/contracts/dispatch-line.mjs` runs the pinned Jig's
  `jig dispatch line --json` in a fresh home, and checks that the plugin's
  `lineStatus` reads what it prints. It checks no tick yet, a fresh tick's
  needs, and an overdue tick.

Both run with Bun, which runs Jig's TypeScript, and need no install. They
are not `*.test.mjs` files, so `node --test` skips them. To run them
locally:

```sh
JIG_DIR=/path/to/jig bun --no-env-file tests/contracts/guard-record.mjs
JIG_DIR=/path/to/jig bun --no-env-file tests/contracts/dispatch-line.mjs
```

## Loading it while you work

```sh
orca plugin dev load .
orca plugin dev emit . agent.status.changed --data '{"workspaceId":"...","paneKey":"t:1","state":"done","receivedAt":0}'
orca plugin dev hook . agent.launch.before --data '{...}'
orca plugin logs local.jig
```

`dev load` prints what the plugin would be granted and the command to
approve it with (`--approve <fingerprint>`). Orca reloads a loaded folder
when its files change; a change that asks for new access needs approving
again. A dev-loaded folder overrides an installed plugin with the same key.

## On Linux

- `orca` on `PATH` can be GNOME's screen reader. Orca's own CLI is
  `orca-ide` there.
- `orca plugin types` fails on Orca 1.4.250 for Linux, because the release
  ships no `orca.d.ts`. The worker does not need the typings.

## On a headless server

`orca serve` runs on orcad by default, which has no plugin service, so no
plugin loads. The README's
[requirements](../README.md#requirements) say how to run it on the desktop
app's runtime instead. To check, `orca plugin list` lists plugins instead of
answering "Plugin service is not available on this runtime".
