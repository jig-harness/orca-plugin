// Waking the dispatcher: the state filter, per-repository coalescing and the receipt.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LOCK_HELD_RETRIES, TICK_WINDOW_MS, receiptLine, wakesDispatcher } from '../lib/wake.mjs'
import { REPO, created, harness, receipt, status } from './fake-orca.mjs'

describe('the state filter', () => {
  test('waiting, blocked and done wake the dispatcher; working does not', () => {
    for (const state of ['waiting', 'blocked', 'done']) assert.equal(wakesDispatcher({ state }), true)
    assert.equal(wakesDispatcher({ state: 'working' }), false)
    assert.equal(wakesDispatcher(null), false)
  })

  test("the main agent's state counts as well", () => {
    assert.equal(wakesDispatcher({ state: 'working', mainAgent: { state: 'done' } }), true)
  })

  test('a working agent starts no tick', async () => {
    const h = harness()
    await created(h)
    await h.dispatcher.onAgentStatusChanged(status('working'))
    await h.settle()
    assert.equal(h.ticks().length, 0)
  })

  test('an event with no workspace is logged and ignored', async () => {
    const h = harness()
    await h.dispatcher.onAgentStatusChanged(status('done', { workspaceId: null }))
    await h.settle()
    assert.equal(h.ticks().length, 0)
    assert.match(h.logs.join('\n'), /no known workspace/)
  })
})

describe('per-repository coalescing', () => {
  test('a second event inside the minute schedules one tick at its end', async () => {
    const h = harness()
    await created(h)
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await h.settle()
    assert.equal(h.ticks().length, 1)

    h.clock.advance(10_000)
    await h.dispatcher.onAgentStatusChanged(status('waiting'))
    await h.dispatcher.onAgentStatusChanged(status('blocked'))
    await h.settle()
    assert.equal(h.ticks().length, 1, 'nothing runs inside the window')

    h.clock.advance(TICK_WINDOW_MS - 10_001)
    await h.settle()
    assert.equal(h.ticks().length, 1)
    h.clock.advance(1)
    await h.settle()
    assert.equal(h.ticks().length, 2, 'exactly one more at the end of the window')

    h.clock.advance(TICK_WINDOW_MS * 3)
    await h.settle()
    assert.equal(h.ticks().length, 2, 'never a second one for the same requests')
  })

  test('a tick never overlaps another for the same repository', async () => {
    const h = harness({ holdTicks: true })
    await created(h)
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.ticks().length, 1)

    h.clock.advance(TICK_WINDOW_MS * 2)
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await h.dispatcher.onAgentStatusChanged(status('done'))
    assert.equal(h.ticks().length, 1, 'the running tick is not joined by another')

    h.release()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.ticks().length, 2, 'one tick follows, the window having passed')
    h.release()
    await h.settle()
    assert.equal(h.ticks().length, 2)
  })

  test('after dispose a running tick finishes and schedules nothing more', async () => {
    const h = harness({ holdTicks: true })
    await created(h)
    await h.dispatcher.onAgentStatusChanged(status('done'))
    await new Promise((resolve) => setImmediate(resolve))
    await h.dispatcher.onAgentStatusChanged(status('done'))
    assert.equal(h.ticks().length, 1)

    h.dispatcher.dispose()
    h.release()
    await h.settle()
    h.clock.advance(TICK_WINDOW_MS * 3)
    await h.settle()
    assert.equal(h.ticks().length, 1, 'the pending request did not start a tick')
    assert.equal(h.notifications.length, 1, 'the running tick still reported')

    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.equal(h.ticks().length, 1, 'no request is honoured after dispose')
  })

  test('repositories are coalesced separately', async () => {
    const other = '/work/other'
    const h = harness({
      files: [`${REPO}/.config/jig.yaml`, `${other}/.config/jig.yaml`, '/bin/bun', '/bin/claude', '/plugin/jig.ts']
    })
    h.dispatcher.requestTick(REPO)
    h.dispatcher.requestTick(other)
    await h.settle()
    assert.deepEqual(
      h.ticks().map((argv) => argv[argv.indexOf('--repo') + 1]),
      [REPO, other]
    )
  })

  test('a held dispatcher lock is tried again a window later, a bounded number of times', async () => {
    const h = harness({ tickResult: () => ({ code: 3, stdout: '', stderr: 'lock held' }) })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    for (let i = 0; i < LOCK_HELD_RETRIES + 2; i++) {
      h.clock.advance(TICK_WINDOW_MS)
      await h.settle()
    }
    assert.equal(h.ticks().length, LOCK_HELD_RETRIES + 1)
    assert.equal(h.notifications.length, 0)
  })
})

describe('the receipt path', () => {
  test("the tick's one-line receipt becomes the notification; the detail goes to the log", async () => {
    const h = harness()
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.notifications, [
      { title: 'Jig dispatch', body: 'acme/app: 1 wanted, 1 started, 0 notified, 0 running (tick run-1)' }
    ])
    const log = h.logs.join('\n')
    assert.match(log, /wants rearm PR #4: stopped on a usage limit/)
    assert.match(log, /jig dispatch receipts run-1/)
  })

  test('a refused repository says why', () => {
    assert.equal(
      receiptLine(receipt(REPO, { refused: 'no forge' }), REPO),
      'acme/app: refused: no forge'
    )
  })

  test('the setting replaces the installed plugin, its quotes kept', async () => {
    const h = harness({ setting: `env "JIG HOME=/x y" jig` })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.ticks()[0], ['env', 'JIG HOME=/x y', 'jig', 'dispatch', '--apply', '--repo', REPO, '--json'])
  })

  test('a missing jig command is a notification, not a crash', async () => {
    const h = harness({
      setting: 'jig',
      tickResult: () => ({
        code: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('spawn jig ENOENT'), { code: 'ENOENT' })
      })
    })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.notifications, [{ title: 'Jig dispatch failed', body: `${REPO}: jig was not found` }])
  })

  test('no installed plugin is a notification naming the setting', async () => {
    const h = harness({ files: [`${REPO}/.config/jig.yaml`, '/bin/bun'] })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.equal(h.ticks().length, 0)
    assert.equal(h.notifications[0].title, 'Jig dispatch did not run')
    assert.match(h.notifications[0].body, /set the Jig command setting/)
  })

  test('a failing tick shows its first error line', async () => {
    const h = harness({
      tickResult: () => ({ code: 2, stdout: '', stderr: 'jig dispatch --apply needs the machine file\n' })
    })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.notifications, [
      { title: 'Jig dispatch failed', body: `${REPO}: jig dispatch --apply needs the machine file` }
    ])
  })

  test('a runner error is a failure even when the output holds a receipt', async () => {
    const h = harness({
      tickResult: () => ({
        code: null,
        stdout: JSON.stringify(receipt()),
        stderr: '',
        error: new Error('timed out after 21600000ms')
      })
    })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.deepEqual(h.notifications, [
      { title: 'Jig dispatch failed', body: `${REPO}: timed out after 21600000ms` }
    ])
  })

  test('a runner error beside the lock-held exit code is a failure, not lock contention', async () => {
    const h = harness({
      tickResult: () => ({
        code: 3,
        stdout: '',
        stderr: 'lock held',
        error: new Error('timed out after 21600000ms')
      })
    })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.equal(h.ticks().length, 1)
    assert.deepEqual(h.notifications, [
      { title: 'Jig dispatch failed', body: `${REPO}: timed out after 21600000ms` }
    ])
  })

  test('a failing notification is logged, never thrown', async () => {
    const h = harness({
      hostCall: (method) => {
        if (method === 'notifications.show') throw new Error('capability_denied')
      }
    })
    h.dispatcher.requestTick(REPO)
    await h.settle()
    assert.match(h.logs.join('\n'), /could not show a notification: capability_denied/)
  })
})
