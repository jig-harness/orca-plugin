# Change notes

A pull request records what it changes for a reader in a **change note**: a
small Markdown file in this folder, one per pull request, named after the
branch or the change (`changes/panel-inbox.md`). It never edits
[CHANGELOG.md](../CHANGELOG.md) or the version in `orca-plugin.json`. After
the merge, the release step (`.github/workflows/changelog.yml`, from Jig's
[changelog skill](https://github.com/jig-harness/jig/blob/main/plugin/skills/changelog/README.md))
writes every note into the changelog, moves the version when a note asks for
it and deletes the notes; the release commit is tagged once its checks pass.

## When a pull request needs one

CHANGELOG.md is read by the people who install the plugin in Orca.

- **A note with `release`:** any change to `main.mjs`, `lib/` or
  `orca-plugin.json`, since Orca receives the plugin only as a new version.
  The branch check fails without one.
- **A note without `release`:** a change to the README that changes what a
  person installing the plugin does.
- **No note:** `docs/`, `AGENTS.md`, the tests, CI, and wording fixes that
  change nothing a reader does.

## Writing one

```markdown
---
release: minor
---

### Added

- What was added, written for someone who uses the plugin: what it does and
  where they see it. Mark a change that breaks something they rely on as
  **Breaking**, and say what they change.
```

`release` is `patch`, `minor` or `major`, as
[semantic versioning](https://semver.org) names them. Before 1.0.0 a
breaking change, such as a higher minimum Orca, asks for `minor`. The change
types are Keep a Changelog's: Added, Changed, Deprecated, Removed, Fixed,
Security.
