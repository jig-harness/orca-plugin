// FALLBACK shots, for when `orca plugin shot` cannot run (see ../FINDINGS.md,
// "What blocked shooting in the real app"). Both modes are drawn in headless
// Chromium, at Orca's default right-sidebar width (350 px) and a wider one:
//
// - html: panel-html/panel/* served as Orca's isolated frame serves it, with
//   the `--orca-*` variables and the light/dark class baked into the
//   document as Orca's frame shell does, and `window.orca.plugin.request`
//   answered by the plugin's real worker.mjs running in this process.
// - components: the trees `orca plugin check --json` drew (panel and worker
//   run by Orca's own check runtime), painted by Orca's own
//   PluginDeclarativeView inside the wrapper `shot --scenario` uses
//   (harness/components, built by vite.config.mjs).
//
// ORCA_SRC=<orca checkout> ORCA_CLI=<orca cli> node spike/harness/shoot.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ORCA = process.env.ORCA_SRC ?? '/tmp/orca-main'
const CLI = process.env.ORCA_CLI ?? '/opt/Orca/resources/bin/orca-ide'
const RENDERER = process.env.HARNESS_OUT ?? '/tmp/jig-spike-components-renderer'
const SPIKE = resolve(new URL('..', import.meta.url).pathname)
const SHOTS = resolve(SPIKE, 'shots')
const WIDTHS = [350, 600]
const THEMES = ['light', 'dark']
const SCENARIOS = ['quiet', 'full-queue', 'backward-moves', 'long-needs', 'park-three-decisions', 'long-thread']

const { chromium } = createRequire(resolve(ORCA, 'package.json'))('playwright')
const only = process.argv[2] // 'html' | 'components' | undefined

/** Module scripts do not load from file:, so the built renderer is served under a local origin. */
async function openRenderer(page) {
  await page.route('https://renderer.local/**', async (route) => {
    const file = resolve(RENDERER, `.${new URL(route.request().url()).pathname}`)
    await route.fulfill({ body: readFileSync(file), contentType: RENDERER_TYPES[extname(file)] ?? 'application/octet-stream' })
  })
  await page.goto('https://renderer.local/index.html')
}
const RENDERER_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' })
const manifest = []

// --- The frame variables Orca would bake into an html panel, read from Orca's own CSS.
async function frameTokens() {
  const allow = readFileSync(resolve(ORCA, 'src/shared/plugins/frames/plugin-panel-design-tokens.ts'), 'utf8')
    .match(/'--[a-z-]+'/g)
    .map((s) => s.slice(1, -1))
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.__SHOT__ = { tree: null, dark: false, width: 350 }
  })
  await openRenderer(page)
  await page.waitForFunction(() => window.__DRAWN__ !== undefined)
  const out = {}
  for (const theme of THEMES) {
    out[theme] = await page.evaluate(
      ([dark, tokens]) => {
        document.documentElement.classList.toggle('dark', dark)
        const styles = getComputedStyle(document.documentElement)
        return tokens
          .map((t) => [t, styles.getPropertyValue(t).trim()])
          .filter(([, v]) => v)
          .map(([t, v]) => `--orca-${t.slice(2)}:${v.replaceAll(/[{}<>;]/g, '')}`)
          .join(';')
      },
      [theme === 'dark', allow]
    )
  }
  await page.close()
  return out
}

// --- html: the plugin's worker, run here with a stand-in `orca`.
async function htmlWorker(settings) {
  const handlers = new Map()
  const mod = await import(pathToFileURL(resolve(SPIKE, 'panel-html/worker.mjs')).href)
  mod.default({
    panels: { handle: (name, fn) => handlers.set(name, fn), post() {} },
    settings: { get: async (key) => settings[key] ?? null },
    log() {}
  })
  return handlers
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

async function shootHtml(tokens, { scenario, view, address, width, theme, surface = 'panel', name }) {
  const handlers = await htmlWorker({ scenario, view, address })
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  const entry = surface === 'editor' ? 'board.html' : 'index.html'
  await page.exposeFunction('__workerRequest', async (name, input) => {
    const fn = handlers.get(name)
    if (!fn) throw Object.assign(new Error(`no handler ${name}`), { code: 'unknown_method' })
    return fn(input ?? {}, {})
  })
  await page.addInitScript(() => {
    const request = (name, input) => window.__workerRequest(name, input)
    window.orca = Object.freeze({
      api: { major: 1, minor: 4 },
      host: { has: () => false, call: () => Promise.reject(Object.assign(new Error('not in the harness'), { code: 'not_permitted' })) },
      plugin: { request, on: () => ({ dispose() {} }) },
      on: () => ({ dispose() {} })
    })
  })
  await page.route('https://jig-spike-html.local/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const file = resolve(SPIKE, 'panel-html/panel', `.${path}`)
    let body = readFileSync(file, 'utf8')
    if (extname(file) === '.html') {
      // As Orca's frame shell does: the scheme class and the tokens, before plugin content.
      body = body.replace(/<html([^>]*)>/, `<html$1 class="${theme}">`).replace('<head>', `<head><style>:root{${tokens[theme]}}</style>`)
    }
    await route.fulfill({ body, contentType: TYPES[extname(file)] ?? 'text/plain' })
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`https://jig-spike-html.local/${entry}`)
  await page.waitForFunction(() => !document.querySelector('#app > p.mut'), null, { timeout: 10_000 })
  const out = resolve(SHOTS, 'html', `${name}.png`)
  await page.screenshot({ path: out, fullPage: true })
  const scrollW = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.cols')].map((c) => c.scrollWidth), 0))
  manifest.push({ mode: 'html', surface, scenario, view, width, theme, file: `html/${name}.png`, errors, boardScrollWidth: scrollW || null })
  await page.close()
}

// --- components: trees from Orca's check runtime, painted by Orca's own renderer.
function checkTrees() {
  const raw = execFileSync(CLI, ['plugin', 'check', resolve(SPIKE, 'panel-components'), '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  const result = JSON.parse(raw)
  return (result.result ?? result).panels
}

async function shootComponents(panel, width, theme) {
  const page = await browser.newPage({ viewport: { width: width + 40, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.addInitScript((shot) => {
    window.__SHOT__ = shot
  }, { tree: panel.tree, dark: theme === 'dark', width })
  await openRenderer(page)
  await page.waitForSelector('[data-plugin-shot-replay]')
  // The panel scrolls inside its own column (and a real replay crops at the window's height);
  // unroll it so the shot shows the whole panel, as the html shots do.
  await page.addStyleTag({
    content:
      'html,body,#root{height:auto!important;overflow:visible!important}[data-plugin-shot-replay]>div{height:auto!important;overflow:visible!important}'
  })
  await page.evaluate(() => document.fonts.ready)
  const name = `${panel.scenario}.${theme}.${width}`
  await page.locator('[data-plugin-shot-replay]').screenshot({ path: resolve(SHOTS, 'components', `${name}.png`) })
  manifest.push({
    mode: 'components',
    scenario: panel.scenario,
    width,
    theme,
    file: `components/${name}.png`,
    errors,
    checkIssues: panel.issues,
    checkWarnings: panel.warnings
  })
  await page.close()
}

mkdirSync(resolve(SHOTS, 'html'), { recursive: true })
mkdirSync(resolve(SHOTS, 'components'), { recursive: true })

if (only !== 'components') {
  const tokens = await frameTokens()
  writeFileSync(resolve(SHOTS, 'orca-frame-tokens.json'), JSON.stringify(tokens, null, 2) + '\n')
  const jobs = []
  for (const scenario of SCENARIOS) {
    for (const view of ['inbox', 'board']) jobs.push({ scenario, view })
  }
  for (const scenario of ['full-queue', 'backward-moves']) {
    jobs.push({ scenario, view: 'board-stacked' }, { scenario, view: 'board-columns' })
  }
  jobs.push({ scenario: 'park-three-decisions', view: 'thread', address: 'drive@jig#456' })
  jobs.push({ scenario: 'long-thread', view: 'thread', address: 'followup@jig#469' })
  for (const job of jobs) {
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        await shootHtml(tokens, { address: 'drive@jig#456', ...job, width, theme, name: `${job.scenario}.${job.view}.${theme}.${width}` })
      }
    }
  }
  // The board as a custom editor in the main area, at a laptop's editor width.
  for (const scenario of ['full-queue', 'backward-moves']) {
    for (const theme of THEMES) {
      await shootHtml(tokens, { scenario, view: 'board', address: '', width: 1280, theme, surface: 'editor', name: `editor-board.${scenario}.${theme}.1280` })
    }
  }
}

if (only !== 'html') {
  for (const panel of checkTrees()) {
    for (const width of WIDTHS) {
      for (const theme of THEMES) await shootComponents(panel, width, theme)
    }
  }
}

await browser.close()
const old = (() => {
  try {
    return JSON.parse(readFileSync(resolve(SHOTS, 'manifest.json'), 'utf8')).filter((m) => only && m.mode !== only)
  } catch {
    return []
  }
})()
writeFileSync(resolve(SHOTS, 'manifest.json'), JSON.stringify([...old, ...manifest], null, 2) + '\n')
const failed = manifest.filter((m) => m.errors.length)
console.log(`${manifest.length} shots, ${failed.length} with errors`)
for (const f of failed) console.log(f.file, f.errors.slice(0, 2))
