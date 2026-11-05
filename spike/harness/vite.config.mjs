// Builds the components fallback renderer against an Orca source checkout.
// Run from the checkout (Tailwind scans the working directory, as Orca's own
// build does): ORCA_SRC=<checkout> node_modules/.bin/vite build --config <this file>
import { cpSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ORCA = process.env.ORCA_SRC
if (!ORCA) throw new Error('Set ORCA_SRC to an Orca source checkout with node_modules')
const fromOrca = createRequire(resolve(ORCA, 'package.json'))
const load = async (name) => (await import(pathToFileURL(fromOrca.resolve(name)).href)).default

const here = new URL('.', import.meta.url).pathname
// Bare imports (react, react-dom) resolve from the checkout, so the entry is copied into it.
const root = resolve(ORCA, '.jig-spike-harness')
cpSync(resolve(here, 'components'), root, { recursive: true })

export default {
  root,
  base: './',
  logLevel: 'warn',
  plugins: [(await load('@vitejs/plugin-react'))(), (await load('@tailwindcss/vite'))()],
  define: { ORCA_FEATURE_WALL_ENABLED: 'true', ORCA_BUILD_COMMIT: '"spike"' },
  resolve: {
    alias: {
      '@renderer': resolve(ORCA, 'src/renderer/src'),
      '@shared': resolve(ORCA, 'src/shared'),
      '@': resolve(ORCA, 'src/renderer/src')
    }
  },
  build: { outDir: resolve(process.env.HARNESS_OUT ?? '/tmp/jig-spike-components-renderer'), emptyOutDir: true }
}
