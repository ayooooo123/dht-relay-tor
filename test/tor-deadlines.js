const test = require('brittle')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const runBareClient = require('./lib/bare-client-runner')
const deadlines = require('./lib/tor-deadlines')
const fs = require('fs')
const path = require('path')

test('real Tor harness imports every deadline passed to its Bare child', (t) => {
  const source = fs.readFileSync(path.join(__dirname, 'tor.js'), 'utf8')
  const marker = "} = require('./lib/tor-deadlines')"
  const end = source.indexOf(marker)
  const start = source.lastIndexOf('const {', end)
  const imported = source.slice(start, end)

  for (const name of ['ARTI_BOOTSTRAP_TIMEOUT', 'EXCHANGE_TIMEOUT', 'CLEANUP_TIMEOUT']) {
    t.ok(new RegExp(`\\b${name}\\b`).test(imported), `${name} is explicitly imported`)
  }
})

test('Tor proof deadlines accept a bounded embedded workflow profile', (t) => {
  const configured = deadlines.loadDeadlines({
    DHT_RELAY_TOR_TOR_BOOTSTRAP_TIMEOUT: '120000',
    DHT_RELAY_TOR_ARTI_BOOTSTRAP_TIMEOUT: '450000',
    DHT_RELAY_TOR_EXCHANGE_TIMEOUT: '60000',
    DHT_RELAY_TOR_CLEANUP_TIMEOUT: '20000',
    DHT_RELAY_TOR_PROCESS_KILL_TIMEOUT: '10000',
    DHT_RELAY_TOR_OUTER_CLEANUP_RESERVE: '20000',
    DHT_RELAY_TOR_OUTER_TEST_TIMEOUT: '690000',
    DHT_RELAY_TOR_WORKFLOW_CLEANUP_RESERVE: '120000',
    DHT_RELAY_TOR_WORKFLOW_TIMEOUT: '1800000'
  })

  t.is(configured.ARTI_CHILD_TIMEOUT, 530000)
  t.ok(
    configured.TOR_BOOTSTRAP_TIMEOUT +
      configured.ARTI_CHILD_TIMEOUT +
      configured.PROCESS_KILL_TIMEOUT +
      configured.OUTER_CLEANUP_RESERVE <
      configured.OUTER_TEST_TIMEOUT
  )
})

test('Tor proof deadlines reject an outer timeout without strict cleanup reserve', (t) => {
  t.exception(
    () =>
      deadlines.loadDeadlines({
        DHT_RELAY_TOR_TOR_BOOTSTRAP_TIMEOUT: '120000',
        DHT_RELAY_TOR_ARTI_BOOTSTRAP_TIMEOUT: '450000',
        DHT_RELAY_TOR_EXCHANGE_TIMEOUT: '60000',
        DHT_RELAY_TOR_CLEANUP_TIMEOUT: '20000',
        DHT_RELAY_TOR_PROCESS_KILL_TIMEOUT: '10000',
        DHT_RELAY_TOR_OUTER_CLEANUP_RESERVE: '30000',
        DHT_RELAY_TOR_OUTER_TEST_TIMEOUT: '690000'
      }),
    /strictly below.*outer/i
  )
})

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
