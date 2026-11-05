// The panel <-> worker contract of the spike. The real panel would carry the
// same three requests, answered from `jig dispatch line --json`,
// `jig ask <address> --thread --json` and `jig send`.
export {}

declare module 'orca' {
  interface PluginRequests {
    /** The `GET /state` answer of the selected fixture. */
    'line.get': { output: unknown }
    /** The proposed `jig ask <address> --thread --json` answer; null for an address with no fixture. */
    'thread.get': { input: { address: string }; output: unknown }
    /** Wired to nothing in the spike: says what the real handler would do. */
    act: { input: { act: string; target: string }; output: { done: false; would: string } }
  }
}
