// The spike's worker: serves fixtures through plugin.request. It reads files
// beside the plugin (../../fixtures), which a development folder allows and an
// installed plugin would not; the real worker runs `jig` instead.
import { readFile } from 'node:fs/promises'
import type { OrcaWorkerApi } from 'orca/worker'

const FIXTURES = new URL('../../fixtures/', import.meta.url)

async function fixture(name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8'))
  } catch {
    return null
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('line.get', async () => {
    const scenario = await orca.settings.get('scenario')
    return fixture(`state.${typeof scenario === 'string' ? scenario : 'park-three-decisions'}.json`)
  })
  orca.panels.handle('thread.get', async ({ address }) =>
    fixture(`thread.${address.replace(/[@#]/g, '-')}.json`)
  )
  orca.panels.handle('act', async ({ act, target }) => ({
    done: false,
    would: `spike: "${act}" for ${target} is wired to nothing`
  }))
}
