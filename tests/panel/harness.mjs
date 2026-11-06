// The panel's browser test. An HTML panel gets none of Orca's `plugin check` or
// `plugin shot --scenario`, so this draws the built panel/inbox.html in Chrome at the sidebar's
// 350 px, in Orca's light and dark frame colours, with a stand-in `window.orca` answered by the
// real worker against a fake Orca (tests/fake-orca.mjs) and the fixture lines. It checks each
// scenario and writes a shot of each to tests/panel/shots/.
//
//   node tests/panel/harness.mjs    (needs `npm ci` and Google Chrome; CHROME_PATH picks another)
//
// The colours are Orca's own frame variables, taken from its CSS (orca-frame-tokens.json), baked
// into the page the way Orca's frame shell bakes them.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { BUILT } from '../../scripts/build-panel.mjs'
import { fixtureAnswer, harness, printed } from '../fake-orca.mjs'

const WIDTH = 350
const SHOTS = new URL('./shots/', import.meta.url)
const TOKENS = JSON.parse(readFileSync(new URL('./orca-frame-tokens.json', import.meta.url), 'utf8'))
const PARK = '/home/ophir/orca/workspaces/jig/pr-456'

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
  'park-three-decisions': {
    answer: () => {
      const answer = fixtureAnswer('park-three-decisions')
      answer.value.line.needs[0].notified = { at: answer.value.now, outcome: 'sent', workspace: PARK }
      return answer
    },
    list: [row('wt-jig-456', PARK)],
    async check(page, { opened, external }) {
      const need = page.locator('article.need').first()
      assert.equal(await need.locator('details.decision').count(), 3)
      assert.equal(await need.locator('details.decision[open]').count(), 1)
      await need.getByRole('button', { name: 'Answer on the pull request ↗' }).click()
      assert.deepEqual(external, ['https://github.com/jig-harness/jig/pull/456'])
      await need.getByRole('button', { name: 'Open the workspace' }).click()
      await waitFor(() => opened.length === 1)
      assert.deepEqual(opened, ['wt-jig-456'])
      await need.getByRole('button', { name: 'Write reply' }).click()
      await page.locator('textarea').first().fill('A, records only')
      await page.locator('textarea').first().blur()
      await need.getByRole('button', { name: /^Copy answer/ }).click()
      assert.match(await page.textContent('.note'), /Copied the answer line for PR #456|refused the copy/)
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
      const h = harness({ lineResult: printed(answer), list: scenario.list, canOpen: true })
      const external = []
      const errors = []
      const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, colorScheme: theme })
      page.on('pageerror', (error) => errors.push(String(error)))
      page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
      await page.exposeFunction('__orcaRequest', async (method, input) => {
        if (method === 'line.get') return h.dispatcher.getLine(input)
        if (method === 'workspace.open') return h.dispatcher.openWorkspace(input)
        throw Object.assign(new Error(`no handler ${method}`), { code: 'unknown_method' })
      })
      await page.exposeFunction('__orcaOpen', async (url) => {
        external.push(url)
        return { opened: true }
      })
      try {
        await page.setContent(framed(built, theme), { waitUntil: 'load' })
        await page.waitForSelector('.band, .empty', { timeout: 5000 })
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth)
        assert.ok(overflow <= WIDTH, `the page is ${overflow} px wide, wider than the sidebar's ${WIDTH}`)
        await page.screenshot({ path: new URL(`${name}.${theme}.png`, SHOTS).pathname, fullPage: true })
        await scenario.check(page, { answer, opened: h.opened, external })
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
