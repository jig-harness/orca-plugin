// One check scenario per fixture and view. `orca plugin check` renders each, and
// `orca plugin shot . --scenario <name>` shoots it. The worker answers for real:
// the scenario only seeds the setting that picks its fixture and the persisted
// atoms that pick the view.
import { defineCheck } from 'orca/testing'

const SCENARIOS = ['quiet', 'full-queue', 'backward-moves', 'long-needs', 'park-three-decisions', 'long-thread']

const at = (scenario: string, plugin: Record<string, string> = {}) => ({
  settings: { scenario },
  persisted: { plugin: { view: 'inbox', address: 'drive@jig#456', boardLayout: 'stacked', ...plugin } }
})

const checks: Record<string, ReturnType<typeof at>> = {}
for (const s of SCENARIOS) {
  checks[s] = at(s)
  checks[`${s}.board`] = at(s, { view: 'board' })
}
checks['full-queue.board-columns'] = at('full-queue', { view: 'board', boardLayout: 'columns' })
checks['backward-moves.board-columns'] = at('backward-moves', { view: 'board', boardLayout: 'columns' })
checks['park-three-decisions.thread'] = at('park-three-decisions', { view: 'addresses', address: 'drive@jig#456' })
checks['long-thread.thread'] = at('long-thread', { view: 'addresses', address: 'followup@jig#469' })

export default defineCheck(checks)
