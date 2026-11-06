---
title: How the plugin keeps the launch guard record
type: reference
status: active
last_updated: 2026-11-06
description: What the launch guard writes and reads in Jig's launch guard record, in which order, and why that order closes gc's race.
---

# How the plugin keeps the launch guard record

`jig gc` removes worktrees nobody uses any more. Between its last look at
Orca and the removal, an agent could start in the worktree it is about to
delete. The launch guard closes that gap for every agent Orca starts. What a
person sees of it is in the [README](../README.md#the-launch-guard).

The guard and gc share one record on disk, Jig's **launch guard record**.
[Jig's gc README](https://github.com/jig-harness/jig/blob/main/plugin/gc/README.md#the-launch-guard-record)
defines it: its directory on each platform, the key, each file's kind and
fields, and how a file is written. That section is the contract; this page
does not repeat it. It says which files the plugin writes and reads, and when.

## What the plugin writes and reads

| File | The plugin | When |
|---|---|---|
| `launches/<key>.json` | writes | in the `agent.launch.before` hook, before it reads the admission |
| `admissions/<key>.json` | reads | in the same hook, right after writing the marker |
| `heartbeat.json` | writes | when the worker starts, then about every minute |

The plugin writes each file to a temporary file in the same directory and
renames it into place, as the contract requires. It computes the key from
the worktree's path exactly as Orca gives it. The directory is the one the
contract names, under the home directory, unless the `guardDirectory`
setting names another; that setting must name the directory Jig uses.

## The order that closes the race

In the hook, without waiting on anything:

1. find the worktree's folder in the workspace map the plugin already holds
   ([architecture.md](architecture.md#the-workspace-map));
2. write the launch marker;
3. look for gc's admission for the same key. When there is one, readable or
   not, refuse the launch with "jig gc is removing this worktree". Otherwise
   the launch goes on.

gc writes its admission before it reads the markers, and the plugin writes
its marker before it reads the admission. When the two overlap, at least one
of them sees the other. A refused launch's marker only makes gc keep that
worktree for one run.

## The heartbeat

gc trusts the guard only while the heartbeat is fresh. With a stale or
missing heartbeat (Orca closed, the plugin disabled, the worker crashed), gc
collects as it would without the plugin and its receipt says the collection
was unguarded.

## What it never sees

gc's own checks still cover these:

- an agent a person types into a plain shell, in Orca or anywhere else;
- a saved session Orca restores when it starts;
- launches on an Orca running on its Node server, orcad (`orca serve`
  without `ORCA_SERVE_RUNTIME=electron`), which loads no plugins at all.

The record's contract changes in Jig first; this page and the guard's code
follow it in one pull request.
