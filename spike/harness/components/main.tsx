// Fallback renderer for components panels: draws a tree `orca plugin check
// --json` produced with Orca's own PluginDeclarativeView, inside the same
// wrapper `orca plugin shot --scenario` uses (PluginShotReplaySurface: a
// `bg-sidebar` column of the panel's width). Built against an Orca source
// checkout; see "How the shots were made" in ../../FINDINGS.md.
import './harness.css'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PluginDeclarativeView } from '@/components/plugins/declarative/PluginDeclarativeView'
import { parsePluginDeclarativeTree } from '@shared/plugins/declarative/plugin-declarative-tree'

declare global {
  interface Window {
    __SHOT__: { tree: unknown; dark: boolean; width: number }
    __DRAWN__?: { ok: boolean; error?: string; warnings?: unknown }
  }
}

const { tree, dark, width } = window.__SHOT__
document.documentElement.classList.toggle('dark', dark)
document.body.style.margin = '0'
const parsed = parsePluginDeclarativeTree(tree)
if (!parsed.ok) {
  window.__DRAWN__ = { ok: false, error: parsed.error }
} else {
  createRoot(document.getElementById('root')!).render(
    <TooltipProvider>
      <div data-plugin-shot-replay="" className="flex flex-col bg-sidebar text-foreground" style={{ width }}>
        <PluginDeclarativeView tree={parsed.tree} onEvent={() => {}} />
      </div>
    </TooltipProvider>
  )
  window.__DRAWN__ = { ok: true, warnings: parsed.warnings }
}
