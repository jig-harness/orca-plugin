// Spike: the Jig panel drawn with Orca's own controls (`ui: "components"`).
// Three views: Inbox (landing), Board, Addresses. Every button is wired to
// nothing: it asks the worker's `act` handler, which only says what it would do.
// Ages are measured against the fixture's `now`, the server clock the
// dashboard also uses, so shots do not drift.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Heading,
  KeyValue,
  Link,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  Row,
  Select,
  set,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  Toolbar,
  type PanelContext
} from 'orca'
import './protocol'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const line = atom<any>(null)
const loadError = atom<string | null>(null)
const thread = atom<any>(null)
const actNote = atom<string | null>(null)
/** The open view; persisted so a check scenario (and the person) can land on any view. */
const view = atom('view', 'inbox', { persist: 'plugin' })
const address = atom('address', 'drive@jig#456', { persist: 'plugin' })
const boardLayout = atom('boardLayout', 'stacked', { persist: 'plugin' })
/** Reply drafts by decision key, for this panel run only: the panel stores nothing. */
const drafts = atom<Record<string, string>>({})

const CAUSE: Record<string, [string, Tone]> = {
  parked: ['Parked', 'accent'],
  'needs-person': ['Needs a person', 'warning'],
  'stopped-unknown': ['Stopped, unknown', 'danger'],
  'followup-failed': ['Follow-up failed', 'danger'],
  'nudge-unanswered': ['Nudge unanswered', 'warning'],
  stalled: ['Stalled pickup', 'warning'],
  'double-claim': ['Double claim', 'danger'],
  'assigner-cannot-write': ['Assigner cannot write', 'neutral']
}

const COLUMNS: Array<[string, string]> = [
  ['ready', 'Ready to merge'],
  ['needs-you', 'Needs you'],
  ['driven', 'Driven'],
  ['picking-up', 'Picking up'],
  ['coming', 'Coming'],
  ['merged', 'Merged']
]
/** The order work passes through, for the side-by-side layout. */
const FLOW = ['coming', 'picking-up', 'driven', 'needs-you', 'ready', 'merged']
const LANES: Array<[string, string]> = [
  ['merge-now', 'Merge now'],
  ['approve-first', 'Approve first'],
  ['update-next', 'Update next']
]

function age(fromIso: string, nowIso: string): string {
  const min = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(fromIso)) / 60_000))
  if (min < 60) return `${min} min`
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim()
  return `${Math.floor(min / 1440)} d`
}

const shortRepo = (repo: string) => repo.split('/')[1] ?? repo
const stationOf = (need: any) =>
  need.stage === 'followup' ? 'followup' : need.stage === 'pickup' ? 'pickup' : 'drive'
const addressOf = (need: any) =>
  `${stationOf(need)}@${shortRepo(need.repo)}#${need.pr ?? need.item}`

async function act(name: string, target: string): Promise<void> {
  const answer = await plugin.request('act', { act: name, target })
  set(actNote, answer.would)
}

async function openThread(next: string): Promise<void> {
  set(address, next)
  set(view, 'addresses')
  set(thread, await plugin.request('thread.get', { address: next }))
}

export async function setup(_ctx: PanelContext): Promise<void> {
  try {
    set(line, await plugin.request('line.get'))
    set(thread, await plugin.request('thread.get', { address: read(address) }))
  } catch (error: any) {
    set(loadError, `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`)
  }
}

function Quoted({ text }: { text: string }) {
  return (
    <Box border radius="sm" background="muted" paddingX="sm" paddingY="xs">
      <Text size="sm" muted>
        {text}
      </Text>
    </Box>
  )
}

function Decision({ decision, open }: { decision: any; open: boolean }) {
  const all = read(drafts)
  return (
    <Collapsible
      title={decision.question ?? `Decision ${decision.key}`}
      description={`${decision.decisionClass ?? 'unclassed'} · ${decision.kind} ${decision.key}`}
      defaultOpen={open}
    >
      <Stack gap="sm">
        {decision.lines.length > 0 ? (
          <Markdown content={decision.lines.join('\n')} />
        ) : (
          <Text muted size="sm">
            The drive framed no question for this decision.
          </Text>
        )}
        <Textarea
          label={`Reply to ${decision.key}`}
          placeholder="Your answer, such as an option and why"
          rows={2}
          value={all[decision.key] ?? ''}
          onChange={(text: string) => set(drafts, { ...read(drafts), [decision.key]: text })}
        />
      </Stack>
    </Collapsible>
  )
}

function NeedCard({ need, now }: { need: any; now: string }) {
  const [label, tone] = CAUSE[need.cause] ?? [need.cause, 'neutral']
  const addr = addressOf(need)
  return (
    <Card title={`${need.target} · ${need.title ?? ''}`} description={`${need.repo} · ${age(need.since, now)}`}>
      <Stack gap="sm">
        <Row gap="xs" wrap>
          <Badge tone={tone}>{label}</Badge>
          <Badge>{need.stage}</Badge>
          {need.decisions.length > 0 ? <Badge tone="accent">{`${need.decisions.length} to answer`}</Badge> : null}
        </Row>
        <Quoted text={need.reason} />
        {need.decisions.map((d: any, i: number) => (
          <Decision key={d.key} decision={d} open={i === 0} />
        ))}
        <Toolbar label={`Acts for ${need.target}`} gap="xs">
          {need.decisions.length > 0 ? (
            <Button size="sm" variant="solid" tone="accent" onPress={() => act('send answer', addr)}>
              Send answer
            </Button>
          ) : null}
          {need.url ? (
            <Button size="sm" icon="open-external" onPress={() => act('open the pull request', need.url)}>
              {need.pr ? 'Pull request' : 'Tracker'}
            </Button>
          ) : null}
          <Button size="sm" icon="folder" onPress={() => act('open the workspace', addr)}>
            Workspace
          </Button>
          <Button size="sm" variant="ghost" onPress={() => openThread(addr)}>
            Thread
          </Button>
        </Toolbar>
      </Stack>
    </Card>
  )
}

/** Parks first, each group oldest first: the dashboard's order. */
function ordered(needs: any[]): any[] {
  const rank = (n: any) => (n.cause === 'parked' ? 0 : 1)
  return [...needs].sort((a, b) => rank(a) - rank(b) || Date.parse(a.since) - Date.parse(b.since))
}

function Inbox({ state }: { state: any }) {
  const l = state.line
  const ready = (l.board?.cards ?? []).filter((c: any) => c.column === 'ready')
  if (l.needs.length === 0 && ready.length === 0) {
    return <EmptyState title="Nothing waits on you" description="The line runs on its own; the next tick may change that." />
  }
  return (
    <Stack gap="md">
      {ready.length > 0 ? (
        <Collapsible title="Ready to merge" description={`${ready.length} pull requests`} defaultOpen={l.needs.length === 0}>
          <Stack gap="xs">
            {ready.map((c: any) => (
              <BoardCard key={c.key} card={c} now={state.now} />
            ))}
          </Stack>
        </Collapsible>
      ) : null}
      {ordered(l.needs).map((n: any) => (
        <NeedCard key={`${n.repo} ${n.target}`} need={n} now={state.now} />
      ))}
    </Stack>
  )
}

const MARK: Record<string, Tone> = {
  none: 'success',
  green: 'success',
  running: 'neutral',
  behind: 'warning',
  conflicting: 'danger',
  failing: 'danger',
  'merge-now': 'success',
  'approve-first': 'accent',
  'update-next': 'warning',
  'not-ready': 'neutral'
}

function StatusRow({ status }: { status: any }) {
  return (
    <Row gap="xs" wrap>
      <Badge tone={MARK[status.conflicts]}>{status.conflicts === 'none' ? 'no conflicts' : status.conflicts}</Badge>
      <Badge tone={MARK[status.checks]}>{`checks ${status.checks}`}</Badge>
      <Badge tone={status.threads ? 'warning' : 'neutral'}>{`${status.threads} threads`}</Badge>
      <Badge tone={MARK[status.merge]}>{status.merge.replace('-', ' ')}</Badge>
    </Row>
  )
}

function BoardCard({ card, now }: { card: any; now: string }) {
  return (
    <Box border radius="md" padding="sm" gap="xs" background="card">
      <Row justify="between">
        <Text weight="semibold" size="sm">
          {`${shortRepo(card.repo)} ${card.target}`}
        </Text>
        <Text muted size="xs">
          {age(card.enteredAt, now)}
        </Text>
      </Row>
      <Text size="sm" truncate>
        {card.title}
      </Text>
      {card.previous ? (
        <Callout tone="warning">{`Was ${card.previous.column}${card.previous.lane ? ` (${card.previous.lane})` : ''} ${card.previous.was}: ${card.previous.cause}`}</Callout>
      ) : null}
      {card.status ? <StatusRow status={card.status} /> : null}
      <Row justify="between" gap="xs">
        <Text size="xs" tone={card.waitsOn.kind === 'person' ? 'warning' : undefined} muted={card.waitsOn.kind !== 'person'}>
          {card.waitsOn.kind === 'person' ? `You: ${card.waitsOn.act}` : `Waits for ${card.waitsOn.what}`}
        </Text>
        {card.lane === 'merge-now' ? (
          <Button size="xs" variant="solid" tone="accent" onPress={() => act('merge', card.key)}>
            Merge
          </Button>
        ) : null}
      </Row>
    </Box>
  )
}

function Board({ state }: { state: any }) {
  const cards: any[] = state.line.board?.cards ?? []
  const layout = read(boardLayout)
  const columnBody = (id: string) => {
    const inColumn = cards.filter((c) => c.column === id)
    if (id !== 'ready') return inColumn.map((c) => <BoardCard key={c.key} card={c} now={state.now} />)
    return LANES.flatMap(([lane, label]) => {
      const inLane = inColumn.filter((c) => c.lane === lane)
      return inLane.length === 0
        ? []
        : [
            <Text key={`h-${lane}`} size="xs" weight="semibold" muted>
              {`${label} · ${inLane.length}`}
            </Text>,
            ...inLane.map((c) => <BoardCard key={c.key} card={c} now={state.now} />)
          ]
    })
  }
  return (
    <Stack gap="sm">
      <Select
        label="Layout"
        value={layout}
        options={[
          { value: 'stacked', label: 'Stacked, Ready to merge first' },
          { value: 'columns', label: 'Six columns side by side' }
        ]}
        onChange={(v: string) => set(boardLayout, v)}
      />
      {layout === 'columns' ? (
        <Box direction="row" gap="sm" scroll="x" align="start">
          {FLOW.map((id) => {
            const label = COLUMNS.find(([c]) => c === id)![1]
            const n = cards.filter((c) => c.column === id).length
            return (
              <Box key={id} minWidth={n === 0 ? 96 : 220} maxWidth={n === 0 ? 96 : 260} gap="xs" shrink={false}>
                <Text weight="semibold" size="sm">{`${label} · ${n}`}</Text>
                {columnBody(id)}
              </Box>
            )
          })}
        </Box>
      ) : (
        COLUMNS.map(([id, label]) => {
          const n = cards.filter((c) => c.column === id).length
          return (
            <Collapsible key={id} title={label} description={`${n}`} defaultOpen={n > 0 && n <= 6} disabled={n === 0}>
              <Stack gap="xs">{columnBody(id)}</Stack>
            </Collapsible>
          )
        })
      )}
    </Stack>
  )
}

const KIND: Record<string, Tone> = {
  request: 'accent',
  question: 'warning',
  answer: 'success',
  outcome: 'neutral',
  launch: 'neutral'
}

function Entry({ entry, now }: { entry: any; now: string }) {
  return (
    <Box gap="xs" paddingY="xs">
      <Row justify="between" gap="xs">
        <Row gap="xs">
          <Badge tone={KIND[entry.kind]}>{entry.kind}</Badge>
          <Text size="xs" muted truncate>{`${entry.from.name} → ${entry.to.name}`}</Text>
        </Row>
        <Text size="xs" muted>
          {age(entry.at, now)}
        </Text>
      </Row>
      <Text size="sm">{entry.summary}</Text>
      {entry.quoted ? (
        entry.kind === 'question' ? (
          <Collapsible title="The decision as recorded" defaultOpen={false}>
            <Markdown content={entry.quoted.text} />
          </Collapsible>
        ) : (
          <Quoted text={entry.quoted.text} />
        )
      ) : null}
      {entry.record.url ? (
        <Row>
          <Link href={entry.record.url}>{`${entry.record.kind} ${entry.record.id}`}</Link>
        </Row>
      ) : (
        <Text size="xs" muted>{`${entry.record.kind} ${entry.record.id}`}</Text>
      )}
    </Box>
  )
}

function Addresses({ state }: { state: any }) {
  const l = state.line
  const current = read(address)
  const known = new Map<string, string>()
  for (const n of l.needs) known.set(addressOf(n), n.title ?? '')
  for (const c of l.board?.cards ?? []) known.set(c.address, c.title ?? '')
  known.set(current, known.get(current) ?? '')
  const t = read(thread)
  return (
    <Stack gap="md">
      <Collapsible title="Addresses" description={`${known.size} with recent activity`} defaultOpen={false}>
        <List label="Addresses">
          {[...known].map(([a, title]) => (
            <ListItem key={a} title={a} description={title} current={a === current} onPress={() => openThread(a)} />
          ))}
        </List>
      </Collapsible>
      {t === null ? (
        <EmptyState title={current} description="No thread for this address in the fixtures." />
      ) : (
        <Stack gap="sm">
          <Heading level={2}>{t.address}</Heading>
          <Text size="sm">{`${t.target.title} (${t.target.state})`}</Text>
          <KeyValue
            items={[
              { label: 'Holder', value: t.holder ? t.holder.state : 'nobody' },
              { label: 'Launch', value: t.holder?.launch ?? '—', code: true },
              { label: 'Account', value: t.holder?.account ? `${t.holder.account} on ${t.holder.host}` : '—' },
              {
                label: 'Waits on',
                value: t.waitsOn.kind === 'person' ? `you: ${t.waitsOn.act}` : t.waitsOn.what,
                tone: t.waitsOn.kind === 'person' ? 'warning' : undefined
              }
            ]}
          />
          <Toolbar label="Acts for this address" gap="xs">
            <Button size="sm" icon="open-external" onPress={() => act('open the pull request', t.target.url)}>
              Pull request
            </Button>
            <Button size="sm" icon="folder" onPress={() => act('open the workspace', t.address)}>
              Workspace
            </Button>
          </Toolbar>
          <Text size="xs" weight="semibold" muted>{`Thread · ${t.thread.length} entries, oldest first`}</Text>
          <Stack gap="none">
            {t.thread.map((e: any) => (
              <Entry key={e.id} entry={e} now={state.now} />
            ))}
          </Stack>
        </Stack>
      )}
    </Stack>
  )
}

export default function Panel() {
  const state = read(line)
  const failed = read(loadError)
  if (failed) return <Callout tone="danger" title="The worker did not answer">{failed}</Callout>
  if (state === null) return <Text muted>Reading the line…</Text>
  const l = state.line
  const asks = l.needs.length
  const ready = (l.board?.cards ?? []).filter((c: any) => c.column === 'ready').length
  const note = read(actNote)
  return (
    <Stack gap="sm">
      <Row justify="between" gap="xs">
        <Row gap="xs">
          <Badge tone={asks ? 'warning' : 'success'}>{`${asks} ask you`}</Badge>
          <Badge tone={ready ? 'accent' : 'neutral'}>{`${ready} ready`}</Badge>
        </Row>
        <Text size="xs" muted>{`tick ${age(l.startedAt, state.now)} ago`}</Text>
      </Row>
      {note ? <Callout tone="neutral">{note}</Callout> : null}
      <Tabs label="View" value={read(view)} onChange={(v: string) => set(view, v)}>
        <Tab value="inbox" label="Inbox">
          <Inbox state={state} />
        </Tab>
        <Tab value="board" label="Board">
          <Board state={state} />
        </Tab>
        <Tab value="addresses" label="Addresses">
          <Addresses state={state} />
        </Tab>
      </Tabs>
    </Stack>
  )
}
