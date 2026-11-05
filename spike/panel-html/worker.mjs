// The spike's worker: serves fixtures through plugin.request. It reads files
// beside the plugin (../fixtures), which a development folder allows and an
// installed plugin would not; the real worker runs `jig` instead.
import { readFile } from 'node:fs/promises'

const FIXTURES = new URL('../fixtures/', import.meta.url)

async function fixture(name) {
  try {
    return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8'))
  } catch {
    return null
  }
}

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default function activate(orca) {
  const setting = async (key, fallback) => {
    const value = await orca.settings.get(key)
    return typeof value === 'string' && value !== '' ? value : fallback
  }
  orca.panels.handle('line.get', async () =>
    fixture(`state.${await setting('scenario', 'park-three-decisions')}.json`)
  )
  orca.panels.handle('thread.get', async ({ address }) =>
    fixture(`thread.${String(address).replace(/[@#]/g, '-')}.json`)
  )
  orca.panels.handle('view.get', async () => ({
    view: await setting('view', 'inbox'),
    address: await setting('address', 'drive@jig#456')
  }))
  orca.panels.handle('act', async ({ act, target }) => ({
    done: false,
    would: `spike: "${act}" for ${target} is wired to nothing`
  }))
}
