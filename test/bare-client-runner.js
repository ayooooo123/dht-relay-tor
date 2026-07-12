const test = require('brittle')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const path = require('path')
const { spawn } = require('child_process')
const runBareClient = require('./lib/bare-client-runner')
const runInvalidBareClient = require('./lib/invalid-bare-client-runner')
const resolveBareRuntime = require('./lib/resolve-bare-runtime')

test('Bare runtime resolver restores the native executable mode', (t) => {
  const calls = []
  const command = resolveBareRuntime({
    runtime: () => '/proof/native-bare',
    chmod: (path, mode) => calls.push([path, mode])
  })

  t.is(command, '/proof/native-bare')
  t.alike(calls, [['/proof/native-bare', 0o755]])
})

test('Bare client runner resolves one result after normal exit', async (t) => {
  const child = fakeChild()
  const result = runBareClient({ spawn: () => child, timeout: 1000 })

  child.stdout.end('noise\nDHT_RELAY_TOR_RESULT {"reply":"echo:tor-proof"}\n')
  child.stderr.end()
  child.close(0, null)

  t.alike(await result, { reply: 'echo:tor-proof' })
})

test('Bare client runner rejects malformed result JSON', async (t) => {
  const child = fakeChild()
  const result = runBareClient({ spawn: () => child, timeout: 1000 })

  child.stdout.end('DHT_RELAY_TOR_RESULT {bad json}\n')
  child.stderr.end('parse diagnostics')
  child.close(0, null)

  const err = await rejection(result)
  t.ok(/malformed/i.test(err.message))
  t.ok(/parse diagnostics/i.test(err.message))
})

test('Bare client runner rejects a normal exit without a result', async (t) => {
  const child = fakeChild()
  const result = runBareClient({ spawn: () => child, timeout: 1000 })

  child.stdout.end('ordinary output\n')
  child.stderr.end('missing diagnostics')
  child.close(0, null)

  const err = await rejection(result)
  t.ok(/without.*result/i.test(err.message))
  t.ok(/missing diagnostics/i.test(err.message))
})

test('Bare client runner rejects a result followed by nonzero exit', async (t) => {
  const child = fakeChild()
  const result = runBareClient({ spawn: () => child, timeout: 1000 })

  child.stdout.end('DHT_RELAY_TOR_RESULT {"reply":"ok"}\n')
  child.stderr.end('native failure')
  child.close(9, null)

  const err = await rejection(result)
  t.ok(/code=9/i.test(err.message))
  t.ok(/native failure/i.test(err.message))
})

test('Bare client runner times out a result followed by a hang and reaps it', async (t) => {
  const child = fakeChild({ closeOnKill: true })
  const result = runBareClient({ spawn: () => child, timeout: 1 })

  child.stdout.write('DHT_RELAY_TOR_RESULT {"reply":"ok"}\n')

  await t.exception(result, /timed out/i)
  t.alike(child.kills, ['SIGTERM'])
  t.is(child.closed, true)
})

test('Bare client runner rejects duplicate result records', async (t) => {
  const child = fakeChild()
  const result = runBareClient({ spawn: () => child, timeout: 1000 })

  child.stdout.end('DHT_RELAY_TOR_RESULT {"reply":"one"}\nDHT_RELAY_TOR_RESULT {"reply":"two"}\n')
  child.stderr.end()
  child.close(0, null)

  await t.exception(result, /duplicate/i)
})

test('Bare client runner rejects stdout overflow after reaping', async (t) => {
  const child = fakeChild({ closeOnKill: true })
  const result = runBareClient({ spawn: () => child, timeout: 1000, maxBuffer: 16 })

  child.stdout.write('x'.repeat(17))

  await t.exception(result, /stdout.*16/i)
  t.is(child.closed, true)
})

test('Bare client runner rejects stderr overflow with bounded diagnostics', async (t) => {
  const child = fakeChild({ closeOnKill: true })
  const result = runBareClient({ spawn: () => child, timeout: 1000, maxBuffer: 32 })

  child.stderr.write('diagnostic'.repeat(8))

  const err = await rejection(result)
  t.ok(/stderr.*32/i.test(err.message))
  t.ok(err.stderr.length <= 32)
})

test('Bare client runner kills on timeout and waits for confirmed close', async (t) => {
  const child = fakeChild()
  const result = runBareClient({ spawn: () => child, timeout: 1 })
  let settled = false
  result.catch(() => {
    settled = true
  })

  await delay(10)
  t.alike(child.kills, ['SIGTERM'])
  t.is(settled, false)
  child.close(null, 'SIGTERM')

  await t.exception(result, /timed out/i)
  t.is(child.closed, true)
})

test('Bare client runner escalates an unreaped timeout to SIGKILL', async (t) => {
  const child = fakeChild()
  const originalKill = child.kill
  child.kill = (signal) => {
    originalKill(signal)
    if (signal === 'SIGKILL') queueMicrotask(() => child.close(null, signal))
    return true
  }
  const result = runBareClient({ spawn: () => child, timeout: 1, killAfter: 1 })

  await t.exception(result, /timed out/i)
  t.alike(child.kills, ['SIGTERM', 'SIGKILL'])
  t.is(child.closed, true)
})

test('Bare client runner rejects a spawn error', async (t) => {
  const child = fakeChild({ pid: undefined })
  const result = runBareClient({ spawn: () => child, timeout: 1000 })
  const failure = new Error('spawn failed')

  child.emit('error', failure)

  t.is(await rejection(result), failure)
})

test('Bare client runner terminates and reaps after a post-spawn error', async (t) => {
  const child = fakeChild()
  const result = runBareClient({ spawn: () => child, timeout: 1000 })
  const failure = new Error('child I/O failed')
  let settled = false
  result.catch(() => {
    settled = true
  })

  child.emit('error', failure)
  await Promise.resolve()
  t.alike(child.kills, ['SIGTERM'])
  t.is(settled, false)
  child.emit('error', new Error('error during SIGTERM'))
  child.close(null, 'SIGTERM')

  t.is(await rejection(result), failure)
  t.is(child.closed, true)
})

test('Bare client runner preserves timeout while reaping an error during SIGTERM', async (t) => {
  const child = fakeChild()
  const result = runBareClient({ spawn: () => child, timeout: 1, killAfter: 1000 })
  let settled = false
  result.catch(() => {
    settled = true
  })

  await delay(10)
  child.emit('error', new Error('termination race'))
  await Promise.resolve()
  t.alike(child.kills, ['SIGTERM'])
  t.is(settled, false)
  child.close(null, 'SIGTERM')

  await t.exception(result, /timed out/i)
})

test('invalid Bare client helper escalates promptly but settles only after close', async (t) => {
  const child = fakeChild()
  const outcome = runInvalidBareClient({
    spawn: () => child,
    timeout: 1,
    killAfter: 1
  })
  let settled = false
  outcome.then(() => {
    settled = true
  })

  await delay(10)
  t.alike(child.kills, ['SIGTERM', 'SIGKILL'])
  t.is(settled, false)
  child.close(null, 'SIGKILL')

  t.alike(await outcome, { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true })
})

test('invalid Bare client helper records a spawn error until close', async (t) => {
  const child = fakeChild({ pid: undefined })
  const outcome = runInvalidBareClient({ spawn: () => child, timeout: 1000 })
  const failure = new Error('spawn failed')
  let settled = false
  outcome.catch(() => {
    settled = true
  })

  child.emit('error', failure)
  await Promise.resolve()
  t.is(settled, false)
  child.close(null, null)

  t.is(await rejection(outcome), failure)
})

test('Bare Tor client validates every input before network access', async (t) => {
  const valid = {
    onion: `${'a'.repeat(56)}.onion`,
    onionPort: 18080,
    bootstrap: [{ host: '127.0.0.1', port: 49152 }],
    topicHex: '07'.repeat(32),
    dataDir: path.resolve('private-arti'),
    reachableAddresses: ['*:80', '*:443'],
    deadlines: {
      artiBootstrapTimeout: 450000,
      exchangeTimeout: 60000,
      cleanupTimeout: 20000
    }
  }
  const cases = [
    ['not-json', /valid JSON/i],
    [{ ...valid, onion: 'invalid.onion' }, /v3 onion/i],
    [{ ...valid, onionPort: 0 }, /onionPort/i],
    [{ ...valid, bootstrap: [] }, /bootstrap/i],
    [{ ...valid, bootstrap: [{ host: '', port: 1 }] }, /bootstrap/i],
    [{ ...valid, bootstrap: [{ host: '   ', port: 1 }] }, /bootstrap/i],
    [{ ...valid, topicHex: 'AA'.repeat(32) }, /topicHex/i],
    [{ ...valid, dataDir: 'relative' }, /dataDir/i],
    [{ ...valid, reachableAddresses: ['*:443'] }, /reachableAddresses/i],
    [{ ...valid, reachableAddresses: ['*:80', '*:443', '*:443'] }, /reachableAddresses/i],
    [{ ...valid, expectedBareArtiSha: 'main' }, /expectedBareArtiSha/i],
    [{ ...valid, deadlines: null }, /deadlines/i],
    [{ ...valid, deadlines: { ...valid.deadlines, cleanupTimeout: 0 } }, /cleanupTimeout/i]
  ]

  for (const [input, expected] of cases) {
    const argument = typeof input === 'string' ? input : JSON.stringify(input)
    const outcome = await runInvalidBareChild(argument)
    t.ok(outcome.code !== 0, `invalid input exits nonzero: ${expected}`)
    t.ok(/^DHT_RELAY_TOR_ERROR /m.test(outcome.stderr), 'error is structured and prefixed')
    t.ok(expected.test(outcome.stderr), `diagnostic identifies invalid input: ${expected}`)
    if (input === 'not-json') {
      t.ok(/at parseInput/.test(outcome.stderr), 'diagnostic preserves a bounded stack location')
    }
  }
})

function fakeChild(options = {}) {
  const { closeOnKill = false } = options
  const pid = Object.prototype.hasOwnProperty.call(options, 'pid') ? options.pid : 123
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.pid = pid
  child.closed = false
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    if (closeOnKill) queueMicrotask(() => child.close(null, signal))
    return true
  }
  child.close = (code, signal) => {
    if (child.closed) return
    child.closed = true
    child.exitCode = code
    child.signalCode = signal
    child.emit('close', code, signal)
  }
  return child
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runInvalidBareChild(argument) {
  return runInvalidBareClient({
    spawn: () =>
      spawn(resolveBareRuntime(), [path.join(__dirname, 'tor-bare-client.js'), argument], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
  })
}

async function rejection(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }

  throw new Error('expected rejection')
}
