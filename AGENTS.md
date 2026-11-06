# Working on the Jig plugin for Orca

This repository is an [Orca](https://www.onorca.dev) plugin for
[Jig](https://github.com/jig-harness/jig). Read these first:

- [README.md](README.md): what the plugin does, for the person who installs it.
- [docs/architecture.md](docs/architecture.md): how the worker is built.
- [docs/launch-guard.md](docs/launch-guard.md) and
  [docs/dispatch-line.md](docs/dispatch-line.md): how it keeps its two
  contracts with Jig.
- [docs/development.md](docs/development.md): tests, the validator, the dev loop.

## Rules

- **The plugin guards and shows; Jig decides and acts.** It reads records Jig
  writes and holds none of Jig's rules. A change to what a tick does, for which
  repository or on which account, belongs in Jig.
- **The contracts are Jig's.** The launch guard record is defined in Jig's
  `plugin/gc/README.md`, and `jig dispatch line --json` in Jig's
  `plugin/README.md`. Link them; never restate their formats here. A contract
  changes in Jig first, then here in one pull request.
- **The launch hook never awaits.** It decides from what the worker already
  holds and from synchronous file reads, within Orca's two seconds.
- **Plain JavaScript, no runtime dependencies.** ES modules, Node built-ins only.
- **One concern per pull request.** A pull request that moves code or docs
  changes no behaviour, and the tests pass on every commit.
- **Each fact is written once.** Users' facts go in the README, how it works in
  `docs/`. Link instead of repeating.
- **Plain, literal prose**, as in Jig's own documents.

## Checks

- `node --test`: the tests (also the gates command in `.config/jig.yaml`).
- `orca-ide plugin validate .` (`orca plugin validate .` off Linux): Orca's
  manifest checks.
- `/jig:docs`: the frontmatter, dates and scars of the pages under `docs/`.
  Advance a page's `last_updated` when you change its body.
