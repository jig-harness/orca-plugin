---
release: minor
---

### Added

- An Addresses view in the Jig panel: the addresses with recent activity
  (what waits on you, then what the line's sessions hold), and for each its
  holder, state and thread, oldest first, as `jig ask` prints it, every
  entry linked to its record.
- An answer box for a parked question, in the inbox and in the thread. It
  shows the line and the address before it sends, sends it with
  `jig send <address> answer <key> <text>`, and shows what `jig send`
  printed, or why it was not sent. It needs a jig with `jig send`.

### Removed

- The inbox's Copy answer line and Write reply buttons, which the answer
  box replaces.
