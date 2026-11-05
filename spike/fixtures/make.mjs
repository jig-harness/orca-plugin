// Writes the spike's fixtures: one `GET /state` answer per scenario, shaped by
// jig's plugin/dispatch/lib/dashboard-contract.ts (origin/main, 2026-11-05),
// plus the proposed `jig ask <address> --thread --json` answers.
//
// The data is written by hand below; this script only spells the repeated
// fields once. `line.board` is not in the contract yet: it follows
// design/dispatch-board.md § "The line grows one list" and is marked
// `"proposed": true` so nobody mistakes it for the shipped shape.
//
//   node spike/fixtures/make.mjs
import { writeFileSync } from 'node:fs'

const DAY = Date.UTC(2026, 10, 5)
const NOW = DAY + (16 * 60 + 47.5) * 60_000
/** A time on 2026-11-05 (UTC), as hours and minutes. */
const T = (h, m) => new Date(DAY + (h * 60 + m) * 60_000).toISOString()
/** A time `days` before 2026-11-05. */
const D = (days, h, m) => new Date(DAY - days * 86_400_000 + (h * 60 + m) * 60_000).toISOString()

const JIG = 'jig-harness/jig'
const WEB = 'example-org/web'
const API = 'example-org/api'
const INF = 'example-org/infra'
const short = (repo) => repo.split('/')[1]
const prUrl = (repo, pr) => `https://github.com/${repo}/pull/${pr}`
const sha = (seed) => (seed.toString(16).repeat(40)).slice(0, 40).replace(/[^0-9a-f]/g, 'a')

const REPOS = [JIG, WEB, API, INF].map((slug) => ({
  slug,
  path: `/home/ophir/dev/${short(slug)}`,
  stages: ['rearm', 'pickup', 'followup', 'notify', 'steer'],
  refused: null,
  failedReads: [],
  notes: []
}))

function accounts(sessions) {
  return [
    ['work-a', 'claude'],
    ['work-b', 'claude'],
    ['codex-a', 'codex']
  ].map(([name, vendor]) => ({
    name,
    vendor,
    cap: 2,
    held: sessions.filter((s) => s.account === name).length,
    wall: null,
    wallUnrecorded: false,
    notAdmitted: null
  }))
}

function drive({ repo, pr, title, account = 'work-a', created, round = 2, threads = [6, 3], heartbeat }) {
  return {
    record: `20261105T${created.slice(11, 16).replace(':', '')}02Z-${short(repo)}-${pr}`,
    account,
    vendor: account.startsWith('codex') ? 'codex' : 'claude',
    repo,
    stage: 'rearm',
    target: `PR #${pr}`,
    pr,
    item: null,
    url: prUrl(repo, pr),
    title,
    createdAt: created,
    launch: 'alive',
    launchReason: null,
    agent: null,
    round,
    samples: threads.map((n, i) => ({ round: round - threads.length + 1 + i, threads: n, at: created })),
    heartbeat: heartbeat ?? T(16, 44),
    passTimeoutSec: 2700,
    workspace: `/home/ophir/orca/workspaces/${short(repo)}/pr-${pr}`,
    replaces: null,
    episode: null,
    nudge: null,
    drifting: null,
    waiting: null
  }
}

function pickup({ repo, item, title, account = 'work-b', created }) {
  return {
    ...drive({ repo, pr: 0, title, account, created }),
    record: `20261105T${created.slice(11, 16).replace(':', '')}02Z-${short(repo)}-${item}`,
    stage: 'pickup',
    target: item,
    pr: null,
    item,
    url: `https://linear.app/example/issue/${item}`,
    agent: { state: 'working', since: created },
    round: null,
    samples: [],
    heartbeat: null,
    passTimeoutSec: null,
    workspace: `/home/ophir/orca/workspaces/${short(repo)}/${item.toLowerCase()}`
  }
}

/** A decision as a drive frames it: Markdown under the headings of its record. */
function decision(key, cls, question, options, recommended, already, kind = 'thread') {
  return {
    key,
    kind,
    lines: [
      '## Question',
      question,
      '',
      '## Options',
      ...options,
      '',
      '## Recommended',
      recommended,
      '',
      '## Class',
      cls,
      '',
      '## Steps for a person',
      `Comment \`answer ${key}: <your choice>\` on the pull request.`,
      '',
      '## Already done',
      already
    ],
    question,
    recommendation: recommended,
    decisionClass: cls
  }
}

function need({ cause, stage = 'rearm', repo, pr, item, title, since, reason, decisions = [], notified, workspaces = [] }) {
  return {
    cause,
    stage,
    repo,
    target: pr ? `PR #${pr}` : item,
    pr: pr ?? null,
    item: item ?? null,
    url: pr ? prUrl(repo, pr) : item ? `https://linear.app/example/issue/${item}` : null,
    title,
    since,
    reason,
    decisions,
    notified: notified ? { at: notified, outcome: 'sent', workspace: null } : null,
    workspaces
  }
}

function queued({ source = 're-armable', group = 'starts', repo, pr, item, title, why, stale = false, hold = null }) {
  return {
    source,
    group,
    repo,
    target: pr ? `PR #${pr}` : item,
    pr: pr ?? null,
    item: item ?? null,
    url: pr ? prUrl(repo, pr) : `https://linear.app/example/issue/${item}`,
    title,
    why,
    stale,
    assignedBy: source === 'assigned' ? 'ophir-docomply' : null,
    hold,
    launch: null
  }
}

/** Proposed: one board card (design/dispatch-board.md § "The line grows one list"). */
function card({
  column,
  lane = null,
  repo,
  pr,
  item,
  title,
  station = 'drive',
  entered,
  previous = null,
  waitsOn,
  driver = null,
  status = null,
  verifiedSha = null,
  method = null,
  unblocks = [],
  notRead = null,
  placedFrom = null
}) {
  const key = pr ? String(pr) : item
  return {
    key: `${repo} ${pr ? `PR #${pr}` : item}`,
    address: `${station}@${short(repo)}#${key}`,
    column,
    lane,
    repo,
    target: pr ? `PR #${pr}` : item,
    pr: pr ?? null,
    item: item ?? null,
    url: pr ? prUrl(repo, pr) : `https://linear.app/example/issue/${item}`,
    title,
    enteredAt: entered,
    previous,
    waitsOn,
    driver,
    status,
    verifiedSha,
    mergeCommand:
      lane === 'merge-now' && verifiedSha
        ? `gh pr merge ${pr} --repo ${repo} --match-head-commit ${verifiedSha} --${method ?? 'squash'}`
        : null,
    unblocks,
    notRead,
    placedFrom
  }
}

const S = {
  clean: (threads = 0) => ({ conflicts: 'none', checks: 'green', failing: [], threads, merge: 'merge-now' }),
  approve: () => ({ conflicts: 'none', checks: 'green', failing: [], threads: 0, merge: 'approve-first' }),
  behind: () => ({ conflicts: 'behind', checks: 'green', failing: [], threads: 0, merge: 'update-next' }),
  running: (threads) => ({ conflicts: 'none', checks: 'running', failing: [], threads, merge: 'not-ready' }),
  failing: (name) => ({
    conflicts: 'none',
    checks: 'failing',
    failing: [{ name, app: 'github-actions', required: true }],
    threads: 0,
    merge: 'not-ready'
  }),
  conflicting: () => ({ conflicts: 'conflicting', checks: 'green', failing: [], threads: 0, merge: 'not-ready' })
}
const WAIT = (what) => ({ kind: 'waiting', what })
const PERSON = (act) => ({ kind: 'person', act })

function board(cards, extra = {}) {
  return { proposed: true, cards, overflow: {}, stoodDown: { count: 0, newest: [] }, ...extra }
}

function state(name, { sessions = [], needs = [], queue = [], cards = [], tick = T(16, 45) }) {
  return {
    name,
    now: new Date(NOW).toISOString(),
    timeZone: 'Asia/Jerusalem',
    plugin: '0.131.0',
    schema: 9,
    line: {
      version: 1,
      runId: `20261105T${tick.slice(11, 16).replace(':', '')}00Z`,
      startedAt: tick,
      finishedAt: new Date(Date.parse(tick) + 63_000).toISOString(),
      exitStatus: 0,
      apply: true,
      applyWithheld: null,
      intervalMs: 300_000,
      longestTickMs: 120_000,
      recentTicksMs: [61_000, 58_000, 63_000],
      plugin: '0.131.0',
      timeZone: 'Asia/Jerusalem',
      accounts: accounts(sessions),
      lastAccount: 'work-a',
      sessions,
      needs,
      queue,
      repos: REPOS,
      board: board(cards)
    }
  }
}

// The park with three decisions: drive@jig#456. Used by two scenarios.
const PARK_456 = need({
  cause: 'parked',
  repo: JIG,
  pr: 456,
  title: 'Give every station a constant address',
  since: T(9, 12),
  notified: T(9, 15),
  reason:
    'drive ledger parked: stopped 8 (parked), waiting on thread PRRT_kwDOa1, finding F-3, thread PRRT_kwDOa4: a person answers',
  decisions: [
    decision(
      'PRRT_kwDOa1',
      'scope',
      'Should `jig ask` read session transcripts in this pull request, or records only?',
      [
        '- **A: records only** what the design orders first. Changes: nothing more. Costs: no answer from a session that wrote nothing yet.',
        '- **B: records, then transcripts behind `--transcripts`** Changes: a transcript reader and its tests. Costs: about 400 lines and a second review round.'
      ],
      'A, because the design orders `ask` before transcripts and the flag can come in its own step',
      'The address parser and the record resolver are implemented, with tests.'
    ),
    decision(
      'F-3',
      'destructive',
      'Rename the `launch` table column `stage` to `station`, with a migration?',
      [
        '- **A: rename now** Changes: one migration, every reader. Costs: a host on the old plugin cannot read the state database until it updates.',
        '- **B: keep `stage` and map it in the resolver** Changes: one mapping. Costs: two words for one thing until a later release.'
      ],
      'B, because a rename breaks a host that has not updated',
      'The resolver reads `stage` today.',
      'finding'
    ),
    decision(
      'PRRT_kwDOa4',
      'naming',
      'What should a standing role without a key be called: `arbiter@jig` or `arbiter@jig#-`?',
      [
        '- **A: `arbiter@jig`** Changes: the grammar allows an empty key. Costs: one more parse branch.',
        '- **B: `arbiter@jig#-`** Changes: none. Costs: an odd-looking address people will mistype.'
      ],
      'A, because people type it',
      'Both forms parse in the tests; only one is accepted.'
    )
  ]
})

const quiet = state('quiet', {
  sessions: [
    drive({ repo: JIG, pr: 471, title: 'Print the newest line as JSON', created: T(16, 20), round: 2, threads: [4, 1] })
  ],
  queue: [
    queued({ source: 'assigned', group: 'held', repo: WEB, item: 'WEB-512', title: 'Show the invoice total on the receipt', why: 'assigned to the factory identity; waits for a free slot after PR #471' })
  ],
  cards: [
    card({ column: 'coming', repo: WEB, item: 'WEB-512', station: 'pickup', title: 'Show the invoice total on the receipt', entered: T(15, 2), waitsOn: WAIT('a free slot') }),
    card({ column: 'driven', repo: JIG, pr: 471, title: 'Print the newest line as JSON', entered: T(16, 20), waitsOn: WAIT('the drive, round 2'), driver: 'this machine, account work-a', status: S.running(1) }),
    card({ column: 'ready', lane: 'merge-now', repo: API, pr: 1214, title: 'Log the webhook retry count', entered: T(14, 5), waitsOn: PERSON('merge'), driver: 'this machine, account work-b', status: S.clean(), verifiedSha: sha(0xa1b2c3), method: 'squash' }),
    card({ column: 'merged', repo: JIG, pr: 469, station: 'followup', title: 'Wake the dispatcher on agent status', entered: T(11, 40), waitsOn: WAIT('nothing: merged, its follow-up is done') })
  ]
})

const READY = [
  [API, 1214, 'Log the webhook retry count', 'merge-now', T(8, 5), [1216]],
  [API, 1216, 'Split the invoice table migration', 'merge-now', T(9, 30), []],
  [WEB, 480, 'Lazy-load the settings page', 'merge-now', T(10, 2), []],
  [JIG, 466, 'Name the account in the receipt', 'merge-now', T(11, 47), []],
  [INF, 97, 'Pin the runner image digest', 'merge-now', T(13, 15), []],
  [WEB, 482, 'Retry the login redirect once', 'approve-first', T(7, 50), []],
  [JIG, 468, 'Add the guard record kind', 'approve-first', T(12, 30), []],
  [API, 1219, 'Drop the unused billing flag', 'approve-first', T(15, 5), []],
  [WEB, 477, 'Trim the checkout bundle', 'update-next', T(14, 40), []],
  [INF, 99, 'Raise the disk quota for the cache', 'merge-now', T(15, 55), []]
]
const fullQueue = state('full-queue', {
  sessions: [
    drive({ repo: JIG, pr: 471, title: 'Print the newest line as JSON', created: T(16, 20) }),
    drive({ repo: WEB, pr: 485, title: 'Cache the session lookup', account: 'work-b', created: T(16, 1), round: 3, threads: [9, 4, 2] }),
    drive({ repo: API, pr: 1221, title: 'Paginate the export endpoint', account: 'codex-a', created: T(15, 40) })
  ],
  queue: [
    queued({ repo: WEB, pr: 478, title: 'Move the release notes to the docs site', why: 'converged pull request behind its base, updated after PR #477', group: 'held' })
  ],
  cards: [
    ...READY.map(([repo, pr, title, lane, entered, unblocks]) =>
      card({
        column: 'ready',
        lane,
        repo,
        pr,
        title,
        entered,
        unblocks,
        waitsOn: PERSON(lane === 'merge-now' ? 'merge' : lane === 'approve-first' ? 'approve' : 'update the branch'),
        driver: 'this machine, account work-a',
        status: lane === 'merge-now' ? S.clean() : lane === 'approve-first' ? S.approve() : S.behind(),
        verifiedSha: sha(pr * 7919),
        method: 'squash'
      })
    ),
    card({ column: 'coming', repo: WEB, pr: 478, title: 'Move the release notes to the docs site', entered: T(14, 40), waitsOn: WAIT('PR #477 to be updated first'), status: S.behind() }),
    card({ column: 'driven', repo: JIG, pr: 471, title: 'Print the newest line as JSON', entered: T(16, 20), waitsOn: WAIT('the drive, round 2'), driver: 'this machine, account work-a', status: S.running(1) }),
    card({ column: 'driven', repo: WEB, pr: 485, title: 'Cache the session lookup', entered: T(16, 1), waitsOn: WAIT('the drive, round 3'), driver: 'this machine, account work-b', status: S.running(2) }),
    card({ column: 'driven', repo: API, pr: 1221, title: 'Paginate the export endpoint', entered: T(15, 40), waitsOn: WAIT('the drive, round 2'), driver: 'this machine, account codex-a', status: S.running(3) })
  ]
})

const backward = state('backward-moves', {
  sessions: [drive({ repo: API, pr: 1216, title: 'Split the invoice table migration', created: T(9, 2), round: 5, threads: [2, 1] })],
  needs: [
    need({ cause: 'needs-person', repo: WEB, pr: 480, title: 'Lazy-load the settings page', since: T(8, 40), notified: T(8, 45), reason: 'a check failed after the drive converged: e2e (chromium), required' }),
    need({ cause: 'needs-person', repo: JIG, pr: 466, title: 'Name the account in the receipt', since: T(8, 55), notified: T(9, 0), reason: 'a thread was opened after the drive converged: PRRT_kwDOb9 by ophir-docomply' })
  ],
  queue: [
    queued({ repo: API, pr: 1214, title: 'Log the webhook retry count', why: 'drive ledger stale: stopped 0 (converged), and now conflicting with its base: re-drive on any account', stale: true }),
    queued({ repo: INF, pr: 97, title: 'Pin the runner image digest', why: 'converged pull request behind its base, updated after PR #99', group: 'held' })
  ],
  cards: [
    card({ column: 'coming', repo: API, pr: 1214, title: 'Log the webhook retry count', entered: T(8, 31), previous: { column: 'ready', lane: 'merge-now', at: T(8, 31), cause: 'conflicting', was: '17 h' }, waitsOn: WAIT('a free slot to re-drive'), status: S.conflicting() }),
    card({ column: 'needs-you', repo: WEB, pr: 480, title: 'Lazy-load the settings page', entered: T(8, 40), previous: { column: 'ready', lane: 'merge-now', at: T(8, 40), cause: 'check failed', was: '6 h' }, waitsOn: PERSON('re-run a check'), status: S.failing('e2e (chromium)'), placedFrom: { needs: 0 } }),
    card({ column: 'needs-you', repo: JIG, pr: 466, title: 'Name the account in the receipt', entered: T(8, 55), previous: { column: 'ready', lane: 'approve-first', at: T(8, 55), cause: 'thread opened', was: '2 h' }, waitsOn: PERSON('answer'), status: { ...S.clean(1), merge: 'not-ready' }, placedFrom: { needs: 1 } }),
    card({ column: 'driven', repo: API, pr: 1216, title: 'Split the invoice table migration', entered: T(9, 2), previous: { column: 'ready', lane: 'merge-now', at: T(9, 1), cause: 'head moved', was: '1 d' }, waitsOn: WAIT('the drive, round 5'), driver: 'this machine, account work-a', status: S.running(1) }),
    card({ column: 'coming', repo: INF, pr: 97, title: 'Pin the runner image digest', entered: T(10, 12), previous: { column: 'ready', lane: 'merge-now', at: T(10, 12), cause: 'behind', was: '45 min' }, waitsOn: WAIT('PR #99 to be updated first'), status: S.behind() }),
    card({ column: 'ready', lane: 'update-next', repo: INF, pr: 99, title: 'Raise the disk quota for the cache', entered: T(10, 12), previous: { column: 'ready', lane: 'merge-now', at: T(10, 12), cause: 'behind', was: '3 h' }, waitsOn: PERSON('update the branch'), status: S.behind(), verifiedSha: sha(99 * 7919) }),
    card({ column: 'merged', repo: WEB, pr: 476, title: 'Retry the webhook on a 5xx', entered: T(8, 30), waitsOn: WAIT('its follow-up, running'), station: 'followup' })
  ]
})

const LONG_NEEDS = [
  ['parked', WEB, 456, 'Retry the webhook on a 5xx', T(7, 5)],
  ['parked', API, 1210, 'Split the invoice table migration', T(7, 40)],
  ['parked', WEB, 475, 'Move the release notes to the docs site', T(8, 15)],
  ['parked', INF, 95, 'Raise the runner disk quota', T(9, 30)],
  ['parked', JIG, 462, 'Fold the stood-down group to its count', T(10, 2)],
  ['needs-person', WEB, 479, 'Cache the session lookup', T(10, 50)],
  ['needs-person', API, 1205, 'Rotate the signing key', T(11, 5)],
  ['stopped-unknown', JIG, 459, 'Read the guard record without awaiting', T(11, 30)],
  ['followup-failed', WEB, 461, 'Trim the checkout bundle', T(12, 2)],
  ['nudge-unanswered', API, 1199, 'Retry on 429 with a backoff cap', T(12, 40)],
  ['stalled', API, 'API-77', 'Add the audit export', T(13, 25)],
  ['double-claim', WEB, 'WEB-418', 'Fix the login redirect', T(14, 20)],
  ['assigner-cannot-write', INF, 'INF-31', 'Mirror the base images', T(15, 0)],
  ['parked', API, 1222, 'Name the tenant in the audit row', T(15, 45)]
]
const REASONS = {
  parked: 'drive ledger parked: stopped 8 (parked), waiting on thread PRRT_x1: a person answers',
  'needs-person': 'drive ledger needs-person: stopped 14: only a person settles it (see the drive’s handoff)',
  'stopped-unknown': 'drive ledger stopped 3 with no class the dispatcher knows',
  'followup-failed': 'a follow-up claimed it 17h ago (comment 456) and has not marked it done',
  'nudge-unanswered': 'the session was nudged with `continue` at 12:10 and has not moved since',
  stalled: 'a claimed item with no running session past stalled_after',
  'double-claim': 'WEB-418 joins to 2 running sessions',
  'assigner-cannot-write': 'assigned by @someone-outside, who cannot write to example-org/infra'
}
const longNeeds = state('long-needs', {
  needs: LONG_NEEDS.map(([cause, repo, target, title, since]) =>
    need({
      cause,
      stage: typeof target === 'string' ? 'pickup' : cause === 'followup-failed' ? 'followup' : cause === 'nudge-unanswered' ? 'steer' : 'rearm',
      repo,
      pr: typeof target === 'number' ? target : undefined,
      item: typeof target === 'string' ? target : undefined,
      title,
      since,
      notified: since,
      reason: REASONS[cause],
      workspaces: cause === 'double-claim' ? ['/home/ophir/orca/workspaces/web/web-418', '/home/ophir/orca/workspaces/web/web-418-b'] : [],
      decisions:
        cause === 'parked'
          ? [
              decision(
                'PRRT_x1',
                'scope',
                `Should ${title.toLowerCase()} also cover the admin pages?`,
                ['- **A: no** what the issue asks.', '- **B: yes** one more page and its test.'],
                'A, because the admin pages have their own issue',
                'The main change is implemented and its tests pass.'
              )
            ]
          : []
    })
  ),
  cards: LONG_NEEDS.map(([cause, repo, target, title, since], i) =>
    card({
      column: 'needs-you',
      repo,
      pr: typeof target === 'number' ? target : undefined,
      item: typeof target === 'string' ? target : undefined,
      station: typeof target === 'string' ? 'pickup' : cause === 'followup-failed' ? 'followup' : 'drive',
      title,
      entered: since,
      waitsOn: PERSON(cause === 'parked' ? 'answer' : cause === 'stalled' || cause === 'double-claim' ? 'open the workspace' : 'open the pull request'),
      placedFrom: { needs: i }
    })
  )
})

const park = state('park-three-decisions', {
  sessions: [drive({ repo: WEB, pr: 485, title: 'Cache the session lookup', account: 'work-b', created: T(16, 1) })],
  needs: [PARK_456],
  cards: [
    card({ column: 'needs-you', repo: JIG, pr: 456, title: PARK_456.title, entered: T(9, 12), waitsOn: PERSON('answer'), status: { ...S.clean(3), merge: 'not-ready' }, placedFrom: { needs: 0 } }),
    card({ column: 'driven', repo: WEB, pr: 485, title: 'Cache the session lookup', entered: T(16, 1), waitsOn: WAIT('the drive, round 2'), driver: 'this machine, account work-b', status: S.running(3) })
  ]
})

const longThread = state('long-thread', {
  sessions: [
    {
      ...drive({ repo: JIG, pr: 469, title: 'Wake the dispatcher on agent status', created: T(16, 12), round: null, threads: [] }),
      stage: 'followup'
    }
  ],
  needs: [PARK_456],
  cards: [
    card({ column: 'merged', station: 'followup', repo: JIG, pr: 469, title: 'Wake the dispatcher on agent status', entered: T(15, 58), waitsOn: WAIT('its follow-up, running'), driver: 'this machine, account work-a' }),
    card({ column: 'needs-you', repo: JIG, pr: 456, title: PARK_456.title, entered: T(9, 12), waitsOn: PERSON('answer'), placedFrom: { needs: 0 } })
  ]
})

// ---------------------------------------------------------------------------
// The proposed `jig ask <address> --thread --json` answer.

const ME = { kind: 'person', name: 'ophir-docomply' }
const DISPATCHER = { kind: 'dispatcher', name: 'dispatcher on majordomo' }
const station = (address) => ({ kind: 'station', name: address })
const rec = (kind, id, url = null) => ({ kind, id, url })
const comment = (repo, pr, id) => rec('pr-comment', String(id),`${prUrl(repo, pr)}#issuecomment-${id}`)

function entry(id, at, kind, from, to, summary, quoted, record, extra = {}) {
  return {
    id,
    at,
    kind,
    from,
    to,
    summary,
    quoted: quoted === null ? null : { text: quoted, format: 'markdown', truncated: false },
    record,
    ...extra
  }
}

const A469 = 'followup@jig#469'
const D469 = 'drive@jig#469'
const thread469 = {
  version: 1,
  address: A469,
  station: 'followup',
  repo: JIG,
  key: '469',
  target: { kind: 'pull-request', number: 469, title: 'Wake the dispatcher on agent status', url: prUrl(JIG, 469), state: 'merged' },
  asOf: new Date(NOW).toISOString(),
  reads: [
    { source: 'forge', ok: true, detail: null },
    { source: 'tracker', ok: true, detail: null },
    { source: 'launch-records', ok: true, detail: null },
    { source: 'outcome-log', ok: true, detail: null }
  ],
  holder: {
    state: 'held',
    launch: '20261105T161202Z-jig-469',
    account: 'work-a',
    host: 'majordomo',
    since: T(16, 12),
    workspace: { path: '/home/ophir/orca/workspaces/jig/pr-469', runtime: 'orca' }
  },
  waitsOn: { kind: 'waiting', what: 'the follow-up pass, running for 35 min' },
  related: [D469, 'pickup@jig#JIG-212'],
  thread: [
    entry('e01', D(2, 9, 14), 'request', ME, station('pickup@jig#JIG-212'), 'assigned to the factory identity', 'Wake Jig’s dispatcher when an Orca agent waits or finishes, instead of waiting for the timer.', rec('tracker-assignment', 'JIG-212', 'https://linear.app/jig/issue/JIG-212'), { verb: 'assign', via: 'pickup@jig#JIG-212' }),
    entry('e02', D(2, 9, 20), 'launch', DISPATCHER, station('pickup@jig#JIG-212'), 'launched a pickup on account work-b', null, rec('launch-record', '20261103T092002Z-jig-JIG-212'), { launch: { action: 'pickup', account: 'work-b', host: 'majordomo' }, via: 'pickup@jig#JIG-212' }),
    entry('e03', D(2, 11, 2), 'outcome', station('pickup@jig#JIG-212'), DISPATCHER, 'opened PR #469 and armed its drive', 'Opened #469: wakes the dispatcher on `agent.status.changed`, one tick per repository a minute.', comment(JIG, 469, 3101), { outcome: { class: 'opened', exit: 0 }, via: 'pickup@jig#JIG-212' }),
    entry('e04', D(2, 11, 3), 'launch', DISPATCHER, station(D469), 'launched a drive pass on account work-a', null, rec('launch-record', '20261103T110302Z-jig-469'), { launch: { action: 'rearm', account: 'work-a', host: 'majordomo' }, via: D469 }),
    entry('e05', D(2, 12, 40), 'question', station(D469), ME, 'parked on 1 decision (scope)', '## Question\nShould a status change inside the minute be dropped, or scheduled for the minute’s end?\n\n## Options\n- **A: drop it** simpler. Costs: a wake-up can be lost.\n- **B: schedule one tick at the minute’s end** Costs: a timer per repository.\n\n## Recommended\nB, because no wake-up should be lost', rec('review-thread', 'PRRT_kwDOc2', `${prUrl(JIG, 469)}#discussion_r2011`), { decision: { key: 'PRRT_kwDOc2', class: 'scope' }, via: D469 }),
    entry('e06', D(2, 17, 5), 'answer', ME, station(D469), 'answered PRRT_kwDOc2', 'answer PRRT_kwDOc2: B, and never run two ticks of one repository at once.', comment(JIG, 469, 3122), { inReplyTo: 'e05', via: D469 }),
    entry('e07', D(2, 17, 10), 'launch', DISPATCHER, station(D469), 're-armed the drive on account work-a', null, rec('launch-record', '20261103T171002Z-jig-469'), { launch: { action: 'rearm', account: 'work-a', host: 'majordomo' }, via: D469 }),
    entry('e08', D(1, 8, 2), 'question', station(D469), ME, 'parked on 2 decisions (destructive, naming)', '## Question\nRemove the storage keep-alive now that hooks keep the worker resident?\n\n## Recommended\nNo: hooks are not in this release.', rec('pr-comment', '3140', `${prUrl(JIG, 469)}#issuecomment-3140`), { decision: { key: 'F-2', class: 'destructive' }, via: D469 }),
    entry('e09', D(1, 8, 2), 'question', station(D469), ME, 'parked on 2 decisions (destructive, naming)', '## Question\nName the setting `jigCommand` or `command`?\n\n## Recommended\n`jigCommand`, since Orca shows settings of every plugin together.', rec('review-thread', 'PRRT_kwDOc9', `${prUrl(JIG, 469)}#discussion_r2077`), { decision: { key: 'PRRT_kwDOc9', class: 'naming' }, via: D469 }),
    entry('e10', D(1, 9, 31), 'answer', ME, station(D469), 'answered F-2', 'answer F-2: keep it; we remove it with the launch guard.', comment(JIG, 469, 3151), { inReplyTo: 'e08', via: D469 }),
    entry('e11', D(1, 9, 32), 'answer', ME, station(D469), 'answered PRRT_kwDOc9', 'answer PRRT_kwDOc9: jigCommand', comment(JIG, 469, 3152), { inReplyTo: 'e09', via: D469 }),
    entry('e12', D(1, 9, 35), 'request', ME, station(D469), 'sent hold', null, rec('label-event', 'jig:hold', `${prUrl(JIG, 469)}`), { verb: 'hold', via: D469 }),
    entry('e13', D(1, 14, 0), 'request', ME, station(D469), 'sent drive', null, rec('label-event', 'jig:drive', `${prUrl(JIG, 469)}`), { verb: 'drive', via: D469 }),
    entry('e14', D(1, 14, 5), 'launch', DISPATCHER, station(D469), 're-armed the drive on account codex-a', null, rec('launch-record', '20261104T140502Z-jig-469'), { launch: { action: 'rearm', account: 'codex-a', host: 'majordomo' }, via: D469 }),
    entry('e15', D(1, 15, 48), 'outcome', station(D469), DISPATCHER, 'converged at the verified head', 'drive ledger: stopped 0 (converged) at 9c41e0d, round 4, 0 unresolved threads', rec('ledger', 'drive-ledger', `${prUrl(JIG, 469)}#issuecomment-3190`), { outcome: { class: 'converged', exit: 0 }, via: D469 }),
    entry('e16', T(15, 58), 'outcome', ME, station(A469), 'merged by a person', null, rec('merge', '9c41e0d', prUrl(JIG, 469)), { outcome: { class: 'merged', exit: null } }),
    entry('e17', T(16, 12), 'launch', DISPATCHER, station(A469), 'launched the follow-up on account work-a', null, rec('launch-record', '20261105T161202Z-jig-469'), { launch: { action: 'followup', account: 'work-a', host: 'majordomo' } })
  ],
  truncated: null
}

const A456 = 'drive@jig#456'
const thread456 = {
  version: 1,
  address: A456,
  station: 'drive',
  repo: JIG,
  key: '456',
  target: { kind: 'pull-request', number: 456, title: PARK_456.title, url: prUrl(JIG, 456), state: 'open' },
  asOf: new Date(NOW).toISOString(),
  reads: [
    { source: 'forge', ok: true, detail: null },
    { source: 'tracker', ok: true, detail: null },
    { source: 'launch-records', ok: true, detail: null },
    { source: 'outcome-log', ok: true, detail: null }
  ],
  holder: { state: 'parked', launch: null, account: null, host: null, since: T(9, 12), workspace: { path: '/home/ophir/orca/workspaces/jig/pr-456', runtime: 'orca' } },
  waitsOn: { kind: 'person', act: 'answer', decisions: PARK_456.decisions.map((d) => d.key) },
  related: ['pickup@jig#JIG-219'],
  thread: [
    entry('e01', D(1, 10, 0), 'request', ME, station(A456), 'sent drive', null, rec('label-event', 'jig:drive', prUrl(JIG, 456)), { verb: 'drive' }),
    entry('e02', D(1, 10, 5), 'launch', DISPATCHER, station(A456), 'launched a drive pass on account work-a', null, rec('launch-record', '20261104T100502Z-jig-456'), { launch: { action: 'rearm', account: 'work-a', host: 'majordomo' } }),
    ...PARK_456.decisions.map((d, i) =>
      entry(`e0${3 + i}`, T(9, 12), 'question', station(A456), ME, `parked on 3 decisions (${d.decisionClass})`, d.lines.join('\n'), d.kind === 'finding' ? rec('pr-comment', '3301', `${prUrl(JIG, 456)}#issuecomment-3301`) : rec('review-thread', d.key, `${prUrl(JIG, 456)}#discussion_r${2300 + i}`), { decision: { key: d.key, class: d.decisionClass } })
    )
  ],
  truncated: null
}

const out = new URL('./', import.meta.url)
for (const { name, ...answer } of [quiet, fullQueue, backward, longNeeds, park, longThread]) {
  writeFileSync(new URL(`state.${name}.json`, out), JSON.stringify(answer, null, 2) + '\n')
}
/** `followup@jig#469` → `thread.followup-jig-469.json`. */
const threadFile = (address) => `thread.${address.replace(/[@#]/g, '-')}.json`
/** An entry's id is its record's (`review-thread/PRRT_…`), so it stays the same from one read to the next. */
function stableIds(t) {
  const ids = new Map(t.thread.map((e) => [e.id, `${e.record.kind}/${e.record.id}`]))
  if (new Set(ids.values()).size !== ids.size) throw new Error(`${t.address}: two entries share a record`)
  for (const e of t.thread) {
    e.id = ids.get(e.id)
    if (e.inReplyTo) e.inReplyTo = ids.get(e.inReplyTo)
  }
}
for (const t of [thread469, thread456]) {
  stableIds(t)
  writeFileSync(new URL(threadFile(t.address), out), JSON.stringify(t, null, 2) + '\n')
}
