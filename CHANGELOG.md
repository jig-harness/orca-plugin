# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-06

### Added

- A status bar item that shows what Jig's dispatch line waits on, read from
  `jig dispatch line --json`: how many needs wait on you, whether the newest
  tick is overdue, and why the line cannot be read when it cannot
  ([#3](https://github.com/jig-harness/orca-plugin/pull/3),
  [#4](https://github.com/jig-harness/orca-plugin/pull/4)).
- The `dispatchIntervalMinutes` setting: the dispatch interval the status bar
  assumes for a line that does not carry its own.

## [0.2.0] - 2026-11-06

### Added

- A launch guard: the plugin refuses to start an agent in a worktree `jig gc`
  is removing, for every launch Orca makes, through the
  `agent.launch.before` hook and Jig's launch guard record. It fails open
  ([#2](https://github.com/jig-harness/orca-plugin/pull/2)).
- The `guardDirectory` setting, for a machine where Jig keeps the launch guard
  record somewhere else.
- When a workspace is removed, the plugin runs a tick for its repository, so a
  launch whose workspace a person removed ends now.

### Changed

- **Breaking:** the plugin needs Orca 1.4.248 or later.

## [0.1.0] - 2026-11-02

### Added

- The plugin wakes Jig's dispatcher when an agent in a repository that uses
  Jig stops for input or finishes, at most once a minute per repository, and
  shows the tick's receipt as a notification.
- The `jigCommand` setting, for a machine where the installed `jig` plugin
  cannot be found on the `PATH` Orca starts plugins with.

[Unreleased]: https://github.com/jig-harness/orca-plugin/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jig-harness/orca-plugin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jig-harness/orca-plugin/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jig-harness/orca-plugin/releases/tag/v0.1.0
