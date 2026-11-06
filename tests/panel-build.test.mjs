// The built panel: panel/inbox.html is what panel/src/ builds, and it loads no other file.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { BUILT, buildPanel } from '../scripts/build-panel.mjs'

describe('the built panel', () => {
  test('panel/inbox.html is fresh: run `node scripts/build-panel.mjs` after changing panel/src/', () => {
    assert.equal(readFileSync(BUILT, 'utf8'), buildPanel())
  })

  test('it is one document: no stylesheet, script or module it would have to load', () => {
    const html = readFileSync(BUILT, 'utf8')
    assert.doesNotMatch(html, /<link\b/i)
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i)
    assert.doesNotMatch(html, /^\s*import\b/m)
    assert.doesNotMatch(html, /^\s*export\b/m)
  })
})
