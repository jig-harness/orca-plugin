// The panel's browser test. An HTML panel gets none of Orca's `plugin check` or
// `plugin shot --scenario`, so this draws the built panel/inbox.html in Chrome at the sidebar's
// 350 px, in Orca's light and dark frame colours, with a stand-in `window.orca` answered by the
// real worker against a fake Orca (tests/fake-orca.mjs), the fixture lines and the fixture
// answers of `jig ask` and `jig send`. It checks each scenario and writes a shot of each to
// tests/panel/shots/.
//
//   node tests/panel/harness.mjs    (needs `npm ci` and Google Chrome; CHROME_PATH picks another)
//
// The colours are Orca's own frame variables, taken from its CSS (orca-frame-tokens.json), baked
// into the page the way Orca's frame shell bakes them.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { BUILT } from '../../scripts/build-panel.mjs'
import { askFixture, fixtureAnswer, harness, printed, sentOutput } from '../fake-orca.mjs'

const WIDTH = 350
const SHOTS = new URL('./shots/', import.meta.url)
const TOKENS = JSON.parse(readFileSync(new URL('./orca-frame-tokens.json', import.meta.url), 'utf8'))
const PARK = '/home/ophir/orca/workspaces/jig/pr-456'
const PARKED = 'drive@jig-harness/jig#456'

/** `jig ask` as the fixtures answer it: the waiting list, or the long thread of the park. */
const askResult = (argv) => ({
  code: 0,
  stdout: JSON.stringify(askFixture(argv.includes('--waiting') ? 'waiting' : 'thread-long')),
  stderr: ''
})

function parkLine() {
  const answer = fixtureAnswer('park-three-decisions')
  answer.value.line.needs[0].notified = { at: answer.value.now, outcome: 'sent', workspace: PARK }
  return answer
}

const row = (id, path) => ({ id, kind: 'worktree', name: id, path, branch: null, hostId: null })

/** Each scenario: its line, the workspaces Orca lists, and what the drawn panel must show. */
const SCENARIOS = {
  quiet: {
    answer: () => fixtureAnswer('quiet'),
    list: [],
    async check(page) {
      assert.equal(await page.textContent('.band .title'), 'Nothing needs a person.')
      assert.equal(await page.locator('article.need').count(), 0)
    }
  },
  'long-needs': {
    answer: () => fixtureAnswer('long-needs'),
    // One of the double claim's two workspaces is known to Orca; the other gets no button.
    list: [row('wt-web-418', '/home/ophir/orca/workspaces/web/web-418')],
    async check(page, { answer }) {
      const needs = answer.value.line.needs
      assert.equal(await page.locator('article.need').count(), needs.length)
      assert.deepEqual(await page.locator('.groupHead').allTextContents(), [
        `To decide, on the pull request ${needs.filter((n) => ['parked', 'needs-person', 'stopped-unknown'].includes(n.cause)).length}`,
        `To check ${needs.filter((n) => !['parked', 'needs-person', 'stopped-unknown'].includes(n.cause)).length}`
      ])
      assert.equal(await page.textContent('.band .title'), `${needs.length} need a person.`)
      assert.equal(await page.locator('[data-open-workspace]').count(), 1)
    }
  },
  'park-answer': {
    answer: parkLine,
    list: [row('wt-jig-456', PARK)],
    /** Opens the answer box, writes the first answer and reviews it, so the shot shows what is sent and where. */
    async prepare(page) {
      const need = page.locator('article.need').first()
      await need.getByRole('button', { name: 'Answer here' }).click()
      await page.getByRole('textbox', { name: 'Answer PRRT_kwDOa1' }).fill('A, records only')
      await page.getByRole('textbox', { name: 'Answer PRRT_kwDOa1' }).blur()
      await page.locator('[data-answer="review"]').first().click()
      await page.waitForSelector('.box.confirm')
    },
    async check(page, { opened, external, sends, shot }) {
      const need = page.locator('article.need').first()
      assert.equal(await need.locator('details.decision').count(), 3)
      assert.equal(await need.locator('details.decision[open]').count(), 1)
      assert.equal(await page.getByRole('button', { name: /Copy answer/ }).count(), 0, 'the copy button is gone')
      const confirm = page.locator('.box.confirm')
      assert.match(await confirm.textContent(), /Sends to drive@jig-harness\/jig#456, through jig send:/)
      assert.equal(await confirm.locator('pre.line').textContent(), 'answer PRRT_kwDOa1: A, records only')
      assert.deepEqual(sends(), [], 'nothing is sent before the press')
      await confirm.getByRole('button', { name: 'Send' }).click()
      await page.waitForSelector('.sent')
      assert.deepEqual(sends(), [['--', PARKED, 'answer', 'PRRT_kwDOa1', 'A, records only']])
      assert.match(await page.textContent('.sent'), /Sent\. Jig wrote the comment ↗As liqweed, the login the forge client here is signed in as\./)
      assert.equal(await page.locator('[data-answer="review"]').count(), 2, 'the other two questions are still to answer')
      await shot('sent')
      await need.getByRole('button', { name: 'Answer on the pull request ↗' }).click()
      await need.getByRole('button', { name: 'Open the workspace' }).click()
      await waitFor(() => opened.length === 1)
      assert.deepEqual(opened, ['wt-jig-456'])
      await page.locator('.sent').getByRole('button', { name: 'the comment ↗' }).click()
      assert.deepEqual(external, [
        'https://github.com/jig-harness/jig/pull/456',
        'https://github.com/jig-harness/jig/pull/456#issuecomment-6699001'
      ])
    }
  },
  'long-thread': {
    answer: parkLine,
    list: [row('wt-jig-456', PARK)],
    /** From the Addresses tab, opens the parked drive's thread. */
    async prepare(page) {
      await page.locator('.bar').getByRole('button', { name: 'Addresses' }).click()
      await page.waitForSelector('article.addr')
      await page.locator('article.addr', { hasText: PARKED }).getByRole('button', { name: 'Open the thread' }).click()
      await page.waitForSelector('ol.thread')
    },
    async check(page, { external, asks }) {
      const value = askFixture('thread-long')
      assert.deepEqual(asks(), [['--waiting', '--json'], ['--thread', '--json', '--', PARKED]])
      assert.equal(await page.locator('.band .title').textContent(), PARKED)
      assert.equal(await page.locator('li.entry').count(), value.thread.length)
      assert.deepEqual(
        await page.locator('li.entry .quoted').allTextContents(),
        value.thread.map((e) => e.text),
        "each entry quotes its record's words as they are, oldest first"
      )
      assert.equal(await page.locator('[data-answer="review"]').count(), 3, 'the park’s questions, from the line')
      await page.locator('li.entry').nth(2).getByRole('button', { name: 'drive-ledger ↗' }).click()
      assert.deepEqual(external, [value.thread[2].record.url])
      await page.getByRole('button', { name: 'Show all' }).click()
      await page.waitForSelector('ol.thread')
      assert.deepEqual(asks().at(-1), ['--thread', '--all', '--json', '--', PARKED])
      await page.getByRole('button', { name: '← Addresses' }).click()
      await page.waitForSelector('article.addr')
      assert.equal(await page.locator('article.addr').count(), 4)
    }
  }
}

async function waitFor(condition, ms = 5000) {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * A stand-in for the frame API Orca's shell defines before any plugin code runs: requests go to
 * the real worker through `__orcaRequest`, links to `__orcaOpen`.
 */
const FRAME_API = `<script>
window.orca = Object.freeze({
  api: { major: 1, minor: 3 },
  host: { has: () => false, call: async () => { throw new Error('not offered') } },
  plugin: { request: (name, input) => window.__orcaRequest(name, input ?? {}), on: () => ({ dispose() {} }) },
  shell: { openExternal: (url) => window.__orcaOpen(url) },
  on: () => ({ dispose() {} })
})
</script>`

/** The built page as Orca's frame shell serves it: its colours and theme class baked in, the frame API first. */
function framed(html, theme) {
  return html
    .replace('<html>', `<html class="${theme}" style="${TOKENS[theme]}">`)
    .replace('<head>', `<head>\n${FRAME_API}`)
}

const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROME_PATH || undefined
})
const built = readFileSync(BUILT, 'utf8')
mkdirSync(SHOTS, { recursive: true })
const failures = []
const report = []
try {
  for (const [name, scenario] of Object.entries(SCENARIOS))
    for (const theme of ['light', 'dark']) {
      const answer = scenario.answer()
      const h = harness({
        lineResult: printed(answer),
        list: scenario.list,
        canOpen: true,
        askResult,
        sendResult: () => ({ code: 0, stdout: sentOutput(), stderr: '' })
      })
      const external = []
      const errors = []
      const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, colorScheme: theme })
      page.on('pageerror', (error) => errors.push(String(error)))
      page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
      await page.exposeFunction('__orcaRequest', async (method, input) => {
        if (method === 'line.get') return h.dispatcher.getLine(input)
        if (method === 'workspace.open') return h.dispatcher.openWorkspace(input)
        if (method === 'addresses.list') return h.dispatcher.listAddresses(input)
        if (method === 'address.get') return h.dispatcher.getAddress(input)
        if (method === 'address.send') return h.dispatcher.sendToAddress(input)
        throw Object.assign(new Error(`no handler ${method}`), { code: 'unknown_method' })
      })
      await page.exposeFunction('__orcaOpen', async (url) => {
        external.push(url)
        return { opened: true }
      })
      try {
        await page.setContent(framed(built, theme), { waitUntil: 'load' })
        await page.waitForSelector('.band, .empty', { timeout: 5000 })
        // The frame lets a copy through inside a click; the stand-in keeps what was copied.
        await page.evaluate(() => {
          document.execCommand = (command) => {
            if (command !== 'copy') return false
            window.__copied = document.querySelector('textarea[readonly]')?.value ?? null
            return true
          }
        })
        await scenario.prepare?.(page)
        const shot = async (suffix = '') => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth)
          assert.ok(overflow <= WIDTH, `the page is ${overflow} px wide, wider than the sidebar's ${WIDTH}`)
          const file = `${name}${suffix ? `-${suffix}` : ''}.${theme}.png`
          await page.screenshot({ path: new URL(file, SHOTS).pathname, fullPage: true })
        }
        await shot()
        await scenario.check(page, { answer, opened: h.opened, external, asks: h.asks, sends: h.sends, shot })
        assert.deepEqual(errors, [], 'no error in the page')
        const height = await page.evaluate(() => document.documentElement.scrollHeight)
        report.push({ scenario: name, theme, ok: true, height })
        console.log(`ok ${name} ${theme} (${WIDTH}×${height})`)
      } catch (error) {
        if (errors.length > 0) error.message += `\n  page errors: ${errors.join(" | ")}`
        failures.push(`${name} ${theme}: ${error.message}`)
        report.push({ scenario: name, theme, ok: false, error: error.message })
        console.log(`not ok ${name} ${theme}: ${error.message}`)
      } finally {
        await page.close()
        h.dispatcher.dispose()
      }
    }
} finally {
  await browser.close()
}
writeFileSync(new URL('report.json', SHOTS), `${JSON.stringify(report, null, 2)}\n`)
if (failures.length > 0) {
  console.error(`${failures.length} failed:\n${failures.join('\n')}`)
  process.exit(1)
}
