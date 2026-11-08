---
release: patch
---

### Fixed

- Open the workspace opens the workspace that holds a need's work, as Jig 0.155.0 and later name it, rather than guessing from where the need's notification went. A need for which Jig names no workspace has no button of its own, only those of a double claim's workspaces that Orca knows. With an older Jig, the panel still guesses.
