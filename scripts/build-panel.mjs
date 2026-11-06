// Builds the panel: inlines panel/src/ (index.html, its stylesheets and its module scripts) into
// one file, panel/inbox.html, the panel's `entry`. Browser clients of `orca serve` load a frame
// as one document, and Orca's catalog installs committed files with no build, so the built file
// is committed and CI checks it is fresh. Node built-ins only.
//
//   node scripts/build-panel.mjs           writes panel/inbox.html
//   node scripts/build-panel.mjs --check   exits 1 when panel/inbox.html is not what src/ builds
//
// Modules are joined, not bundled: each `import { a, b } from './x.mjs'` (one line, relative,
// no renaming) puts x.mjs before its importer, and `export` is dropped from declarations. Any
// other import is refused, so the panel stays plain JavaScript with no dependency.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'panel', 'src')
export const BUILT = join(ROOT, 'panel', 'inbox.html')

const RELATIVE_IMPORT = /^import \{\s*(\w+(?:\s*,\s*\w+)*)\s*,?\s*\} from '\.\/([\w-]+\.mjs)'\s*;?\s*$/
const ANY_IMPORT = /^\s*import\b|\bimport\s*\(/
const EXPORT_DECLARATION = /^export (?=(?:async )?function|const |let |class )/

class BuildError extends Error {}

/** The modules `entry` needs, its dependencies first, each as `{ file, code }`. */
function joinModules(entry) {
  const done = new Set()
  const out = []
  const visit = (file, chain) => {
    if (done.has(file)) return
    if (chain.includes(file)) throw new BuildError(`import cycle: ${[...chain, file].join(' → ')}`)
    const lines = readFileSync(join(SOURCE, file), 'utf8').split('\n')
    const kept = []
    for (const [i, line] of lines.entries()) {
      const found = RELATIVE_IMPORT.exec(line)
      if (found) {
        visit(found[2], [...chain, file])
        continue
      }
      if (ANY_IMPORT.test(line))
        throw new BuildError(`${file}:${i + 1}: only \`import { … } from './x.mjs'\` on one line is joined`)
      if (/^export\b/.test(line) && !EXPORT_DECLARATION.test(line))
        throw new BuildError(`${file}:${i + 1}: only \`export\` before a declaration is joined`)
      kept.push(line.replace(EXPORT_DECLARATION, ''))
    }
    const code = kept.join('\n').trimEnd()
    if (/<\/script/i.test(code)) throw new BuildError(`${file}: holds "</script", which would end the inlined script`)
    done.add(file)
    out.push({ file, code })
  }
  visit(entry, [])
  return out
}

/** The built page, as text. */
export function buildPanel() {
  let html = readFileSync(join(SOURCE, 'index.html'), 'utf8')
  html = html.replace(/^([ \t]*)<link rel="stylesheet" href="(?:\.\/)?([\w-]+\.css)" \/>$/gm, (_, indent, file) => {
    const css = readFileSync(join(SOURCE, file), 'utf8').trimEnd()
    if (/<\/style/i.test(css)) throw new BuildError(`${file}: holds "</style"`)
    return `${indent}<style>\n${css}\n${indent}</style>`
  })
  html = html.replace(
    /^([ \t]*)<script type="module" src="(?:\.\/)?([\w-]+\.mjs)"><\/script>$/gm,
    (_, indent, file) => {
      const code = joinModules(file)
        .map((m) => `// ${relative(ROOT, join(SOURCE, m.file)).split('\\').join('/')}\n${m.code}`)
        .join('\n\n')
      return `${indent}<script type="module">\n${code}\n${indent}</script>`
    }
  )
  if (/<link\b|<script\b[^>]*\bsrc=/i.test(html))
    throw new BuildError('index.html still loads a file the build did not inline')
  return html.replace(
    /^<!doctype html>\n/i,
    '<!doctype html>\n<!-- Built by scripts/build-panel.mjs from panel/src/. Edit the source, then run it. -->\n'
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const built = buildPanel()
    if (process.argv.includes('--check')) {
      let committed = null
      try {
        committed = readFileSync(BUILT, 'utf8')
      } catch {
        committed = null
      }
      if (committed !== built) {
        console.error('panel/inbox.html is not what panel/src/ builds: run node scripts/build-panel.mjs')
        process.exit(1)
      }
      console.log('panel/inbox.html is fresh')
    } else {
      writeFileSync(BUILT, built)
      console.log(`wrote ${relative(ROOT, BUILT)}`)
    }
  } catch (error) {
    if (!(error instanceof BuildError)) throw error
    console.error(`build-panel: ${error.message}`)
    process.exit(1)
  }
}
