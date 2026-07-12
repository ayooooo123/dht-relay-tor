const test = require('brittle')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const runBareClient = require('./lib/bare-client-runner')
const deadlines = require('./lib/tor-deadlines')

test('Tor proof deadline equation leaves cleanup reserves below both outer bounds', async (t) => {
  const timers = fakeTimers()
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 123
  child.exitCode = null
  child.signalCode = null
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    if (signal === 'SIGKILL') {
      queueMicrotask(() => {
        child.signalCode = signal
        child.emit('close', null, signal)
      })
    }
    return true
  }

  const result = runBareClient({
    spawn: () => child,
    timeout: deadlines.ARTI_CHILD_TIMEOUT,
    killAfter: deadlines.PROCESS_KILL_TIMEOUT,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  })
  let settled = false
  result.catch(() => {
    settled = true
  })

  timers.advance(deadlines.ARTI_CHILD_TIMEOUT - 1)
  t.alike(child.kills, [])
  timers.advance(1)
  t.alike(child.kills, ['SIGTERM'])
  t.is(settled, false)
  timers.advance(deadlines.PROCESS_KILL_TIMEOUT)
  await Promise.resolve()
  await t.exception(result, /timed out/i)
  t.alike(child.kills, ['SIGTERM', 'SIGKILL'])

  const localWorstCase =
    deadlines.TOR_BOOTSTRAP_TIMEOUT +
    deadlines.ARTI_CHILD_TIMEOUT +
    deadlines.PROCESS_KILL_TIMEOUT +
    deadlines.OUTER_CLEANUP_RESERVE
  t.ok(localWorstCase < deadlines.OUTER_TEST_TIMEOUT)
  t.ok(
    deadlines.OUTER_TEST_TIMEOUT + deadlines.WORKFLOW_CLEANUP_RESERVE < deadlines.WORKFLOW_TIMEOUT
  )
})

function fakeTimers() {
  let now = 0
  let id = 0
  const pending = new Map()

  return {
    setTimeout(fn, delay) {
      const handle = ++id
      pending.set(handle, { at: now + delay, fn })
      return handle
    },
    clearTimeout(handle) {
      pending.delete(handle)
    },
    advance(ms) {
      const end = now + ms
      while (true) {
        const next = [...pending.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [handle, timer] = next
        pending.delete(handle)
        now = timer.at
        timer.fn()
      }
      now = end
    }
  }
}
