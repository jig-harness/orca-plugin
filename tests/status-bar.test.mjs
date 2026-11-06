// The status bar: reading the line, showing it, and stopping a read that runs too long.
import assert from 'node:assert/strict'
import process from 'node:process'
import { describe, test } from 'node:test'
import { KILL_GRACE_MS, runProgram } from '../lib/jig-command.mjs'
import {
  LINE_READ_DEADLINE_MS,
  LINE_REFRESH_MS,
  lineStatus,
  statusText
} from '../lib/status-bar.mjs'
import { REPO, harness, lineAnswer, printed } from './fake-orca.mjs'

describe('the status bar', () => {
  test('shows the needs-you count from the line, read with the resolved jig command', async () => {
    const h = harness({ statusBar: true })
    h.dispatcher.startStatusBar()
    await h.settle()
    assert.deepEqual(h.lineReads(), [
      ['/bin/bun', '--no-env-file', '--config=/plugin/dispatch/bunfig.toml', '/plugin/jig.ts', 'dispatch', 'line', '--json']
    ])
    assert.equal(h.items.length, 1)
    assert.equal(h.items[0].id, 'line')
    assert.equal(h.items[0].text, 'Jig 2 need you')
    assert.equal(h.items[0].tone, 'warning')
    assert.match(h.items[0].tooltip, /run-9/)
  })

  test('the text stays short, and ready-to-merge shows only when counted', () => {
    assert.equal(statusText({ needs: 2 }), 'Jig 2 need you')
    assert.equal(statusText({ ready: 1, needs: 2 }), 'Jig 1 ready · 2 need you')
    assert.equal(statusText({ needs: 0, overdue: true }), 'Jig tick overdue')
    assert.equal(statusText({ needs: 2, overdue: true }), 'Jig tick overdue · 2 need you')
  })

  test('a line with nothing needing a person says so, with no ready count guessed', async () => {
    const h = harness({ statusBar: true, lineResult: printed(lineAnswer({ needs: [], queue: [{ group: 'starts' }] })) })
    h.dispatcher.startStatusBar()
    await h.settle()
    assert.equal(h.items[0].text, 'Jig 0 need you')
    assert.equal(h.items[0].tone, 'neutral')
  })

  test('line: null shows that no tick has run yet', async () => {
    const h = harness({ statusBar: true, lineResult: printed(lineAnswer(null)) })
    h.dispatcher.startStatusBar()
    await h.settle()
    assert.equal(h.items[0].text, 'Jig no tick yet')
  })

  test('an unreadable line (exit 1) shows its stderr line in the tooltip', async () => {
    const h = harness({
      statusBar: true,
      lineResult: () => ({ code: 1, stdout: '', stderr: 'line-unreadable: the stored line is not JSON\n' })
    })
    h.dispatcher.startStatusBar()
    await h.settle()
    assert.equal(h.items[0].text, 'Jig line unreadable')
    assert.equal(h.items[0].tone, 'danger')
    assert.equal(h.items[0].tooltip, 'Jig: line-unreadable: the stored line is not JSON')
  })

  test('a line of a newer version is not trusted', async () => {
    const h = harness({ statusBar: true, lineResult: printed(lineAnswer({ version: 2 })) })
    h.dispatcher.startStatusBar()
    await h.settle()
    assert.equal(h.items[0].text, 'Jig line unreadable')
    assert.match(h.items[0].tooltip, /version 2/)
  })

  test('exit 2 says jig is too old, once, however often it is read', async () => {
    const h = harness({ statusBar: true, lineResult: () => ({ code: 2, stdout: '', stderr: 'unknown subcommand line' }) })
    h.dispatcher.startStatusBar()
    await h.settle()
    for (let i = 0; i < 3; i++) {
      h.clock.advance(LINE_REFRESH_MS)
      await h.settle()
    }
    assert.equal(h.lineReads().length, 4)
    assert.equal(h.items.length, 1, 'shown once')
    assert.equal(h.items[0].text, 'Jig too old for the status bar')
    assert.equal(h.items[0].tone, 'neutral')
    assert.equal(h.logs.filter((l) => l.startsWith('status bar:')).length, 1, 'logged once')
    assert.equal(h.notifications.length, 0)
  })

  test('a tick older than twice the line\'s interval is overdue', async () => {
    const h = harness({
      statusBar: true,
      lineResult: printed(lineAnswer({ finishedAt: '2026-11-05T11:49:00.000Z', intervalMs: 300_000 }))
    })
    h.dispatcher.startStatusBar()
    await h.settle()
    assert.equal(h.items[0].text, 'Jig tick overdue · 2 need you')
    assert.equal(h.items[0].tone, 'danger')
    assert.match(h.items[0].tooltip, /11 min ago, past twice the 5 min interval/)
  })

  test('without an interval in the line, the setting decides', async () => {
    const at = '2026-11-05T11:49:00.000Z' // 11 minutes before NOW
    const late = harness({ statusBar: true, lineResult: printed(lineAnswer({ finishedAt: at, intervalMs: undefined })) })
    late.dispatcher.startStatusBar()
    await late.settle()
    assert.match(late.items[0].text, /overdue/, 'default 5 minutes: 11 > 10')

    const fine = harness({
      statusBar: true,
      intervalSetting: 10,
      lineResult: printed(lineAnswer({ finishedAt: at, intervalMs: undefined }))
    })
    fine.dispatcher.startStatusBar()
    await fine.settle()
    assert.equal(fine.items[0].text, 'Jig 2 need you', '10 minutes: 11 < 20')
  })

  test('re-reads every minute, and after every tick the plugin runs', async () => {
    const h = harness({ statusBar: true })
    h.dispatcher.startStatusBar()
    await h.settle()
    h.clock.advance(LINE_REFRESH_MS)
    await h.settle()
    assert.equal(h.lineReads().length, 2)
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.equal(h.ticks().length, 1)
    assert.equal(h.lineReads().length, 3)
    h.dispatcher.dispose()
    h.clock.advance(LINE_REFRESH_MS * 5)
    await h.settle()
    assert.equal(h.lineReads().length, 3, 'no reads after dispose')
  })

  test('never two reads at once: requests during a read make one more after it', async () => {
    const h = harness({ statusBar: true, holdLines: true })
    h.dispatcher.startStatusBar()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.lineReads().length, 1)
    h.dispatcher.refreshLine()
    h.dispatcher.requestTick(REPO)
    h.dispatcher.refreshLine()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.ticks().length, 1)
    assert.equal(h.lineReads().length, 1, 'neither a request nor a tick joins the running read')
    h.releaseLine()
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.lineReads().length, 2, 'exactly one read follows')
    h.releaseLine()
    await h.settle()
    assert.equal(h.lineReads().length, 2)
  })

  test('a read past its deadline is given up, shown, and frees the next read', async () => {
    const h = harness({ statusBar: true, holdLines: true })
    h.dispatcher.startStatusBar()
    await new Promise((resolve) => setImmediate(resolve))
    h.clock.advance(LINE_READ_DEADLINE_MS)
    await h.settle()
    assert.equal(h.items[0].text, 'Jig line unreadable')
    assert.match(h.items[0].tooltip, /ran past 30s/)
    h.clock.advance(LINE_REFRESH_MS - LINE_READ_DEADLINE_MS)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.lineReads().length, 2, 'the next minute reads again')
  })

  test('the program itself is stopped at the 30 s deadline', async () => {
    const h = harness({ statusBar: true })
    h.dispatcher.startStatusBar()
    await h.settle()
    const read = h.runs.findIndex((argv) => argv.includes('line'))
    assert.equal(h.runOptions[read].timeoutMs, 30_000)
  })

  test('a program that ignores SIGTERM is killed and reaped within the termination bound', { skip: process.platform === 'win32' }, async () => {
    const started = Date.now()
    const result = await runProgram(
      [process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 200, env: process.env, platform: process.platform }
    )
    assert.match(result.error.message, /ran past/)
    assert.ok(Date.now() - started < 200 + 2 * KILL_GRACE_MS + 2000, 'settled within the bound')
    assert.notEqual(result.code, 0)
  })

  test('a descendant that ignores SIGTERM is killed even when the direct child closes first', { skip: process.platform === 'win32' }, async () => {
    const script =
      `node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $!; sleep 30`
    const result = await runProgram(['sh', '-c', script], {
      timeoutMs: 300,
      env: process.env,
      platform: process.platform
    })
    assert.match(result.error.message, /ran past/)
    const survivor = Number(result.stdout.trim())
    assert.ok(survivor > 0, 'the descendant reported its pid')
    let alive = true
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(survivor, 0)
        await new Promise((resolve) => setTimeout(resolve, 50))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, 'the descendant did not outlive the timeout')
  })

  test('an aborted program is stopped and an already-aborted one never starts', { skip: process.platform === 'win32' }, async () => {
    const control = new AbortController()
    const pending = runProgram([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 60_000,
      env: process.env,
      platform: process.platform,
      signal: control.signal
    })
    setTimeout(() => control.abort(), 100)
    const result = await pending
    assert.match(result.error.message, /cancelled/)
    const again = await runProgram([process.execPath, '-e', ''], {
      timeoutMs: 1000,
      env: process.env,
      platform: process.platform,
      signal: control.signal
    })
    assert.match(again.error.message, /cancelled/)
  })

  test('a read that expired while settings were pending starts no program afterwards', async () => {
    let releaseSettings = null
    let held = false
    const h = harness({
      statusBar: true,
      hostCall: (method) => {
        if (method === 'settings.get' && !held) {
          held = true
          return new Promise((resolve) => {
            releaseSettings = () => resolve({ settings: { jigCommand: '', dispatchIntervalMinutes: 5 } })
          })
        }
        return undefined
      }
    })
    h.dispatcher.startStatusBar()
    await new Promise((resolve) => setImmediate(resolve))
    h.clock.advance(LINE_READ_DEADLINE_MS)
    await h.settle()
    assert.equal(h.items[0].text, 'Jig line unreadable')
    releaseSettings()
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.runs.filter((argv) => argv.includes('plugin')).length, 0, 'command discovery stopped')
    assert.equal(h.lineReads().length, 0, 'the abandoned read launched nothing')
  })

  test('dispose cancels a read that is still resolving its command', async () => {
    let releaseSettings = null
    let held = false
    const h = harness({
      statusBar: true,
      hostCall: (method) => {
        if (method === 'settings.get' && !held) {
          held = true
          return new Promise((resolve) => {
            releaseSettings = () => resolve({ settings: { jigCommand: '', dispatchIntervalMinutes: 5 } })
          })
        }
        return undefined
      }
    })
    h.dispatcher.startStatusBar()
    await new Promise((resolve) => setImmediate(resolve))
    h.dispatcher.dispose()
    releaseSettings()
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.runs.length, 0, 'no program started after dispose')
  })

  test('a runner error wins over a zero exit and healthy-looking output', () => {
    const read = {
      code: 0,
      stdout: JSON.stringify(lineAnswer()),
      stderr: '',
      error: new Error('printed more than 4194304 bytes')
    }
    const item = lineStatus(read, { intervalMs: 300_000, now: 0 })
    assert.equal(item.text, 'Jig line unreadable')
    assert.match(item.tooltip, /printed more than/)
  })

  test('a line with no readable finish time is unreadable, not healthy', () => {
    for (const finishedAt of ['invalid', undefined]) {
      const read = printed(lineAnswer({ finishedAt }))()
      const item = lineStatus(read, { intervalMs: 300_000, now: Date.now() })
      assert.equal(item.text, 'Jig line unreadable')
      assert.equal(item.tone, 'danger')
    }
  })

  test('after dispose no read is published and none is started', async () => {
    const h = harness({ statusBar: true, holdLines: true })
    h.dispatcher.startStatusBar()
    await new Promise((resolve) => setImmediate(resolve))
    h.dispatcher.refreshLine()
    h.dispatcher.dispose()
    h.releaseLine()
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.lineReads().length, 1, 'the queued refresh does not start another read')
    assert.equal(h.items.length, 0, 'the finished read is not published')
  })

  test('an Orca without statusBar.update reads nothing', async () => {
    const h = harness()
    h.dispatcher.startStatusBar()
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.equal(h.lineReads().length, 0)
    assert.equal(h.items.length, 0)
  })
})
