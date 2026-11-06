// The pure parsers: the command setting, Git's worktree list and the installed plugin lists.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { claudePluginDirectory, codexPluginDirectory, splitCommand } from '../lib/jig-command.mjs'
import { mainCheckout } from '../lib/workspaces.mjs'

describe('parsing', () => {
  test('splitCommand keeps quoted spaces and expands nothing', () => {
    assert.deepEqual(splitCommand(` bun  '--config=/a b/c' "$HOME" `), ['bun', '--config=/a b/c', '$HOME'])
    assert.deepEqual(splitCommand('""'), [''])
    assert.throws(() => splitCommand('bun "x'), /unclosed/)
  })

  test('mainCheckout reads the first worktree and marks a bare one', () => {
    assert.deepEqual(mainCheckout(`worktree /r\nHEAD a\n\nworktree /w\n`), { path: '/r', bare: false })
    assert.deepEqual(mainCheckout(`worktree /r.git\nbare\n\nworktree /w\n`), { path: '/r.git', bare: true })
  })

  test('the plugin directory is found as the launcher finds it', () => {
    assert.equal(
      claudePluginDirectory([
        { id: 'jig@jig', scope: 'project', installPath: '/p' },
        { id: 'jig@jig', scope: 'user', installPath: '/u', readFromFolder: '/f' }
      ]),
      '/f'
    )
    assert.equal(
      codexPluginDirectory({ installed: [{ pluginId: 'jig@jig', version: '1.2.3' }] }, '/h'),
      '/h/.codex/plugins/cache/jig/jig/1.2.3'
    )
  })
})
