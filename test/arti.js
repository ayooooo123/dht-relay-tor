const test = require('brittle')
const { createArtiTransport } = require('../lib/arti-transport')
const { createArtiEntry } = require('../lib/arti-entry')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeStream() {
  const listeners = new Map()
  return {
    destroyed: false,
    destroys: 0,
    once(name, listener) {
      listeners.set(name, listener)
    },
    off(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name)
    },
    listenerCount(name) {
      return listeners.has(name) ? 1 : 0
    },
    emit(name, value) {
      const listener = listeners.get(name)
      listeners.delete(name)
      if (listener) listener(value)
    },
    destroy() {
      this.destroyed = true
      this.destroys++
    }
  }
}

function error(code, message = code) {
  const err = new Error(message)
  err.code = code
  return err
}

async function rejection(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected promise to reject')
}

async function closeAndFlush(stream) {
  stream.emit('close')
  await Promise.resolve()
  await Promise.resolve()
}

test('Arti transport keeps acquisition and stream options separated', async (t) => {
  const acquired = []
  const connected = []
  let releases = 0
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire(options) {
        acquired.push(options)
        return { port: 19411, release: async () => releases++ }
      }
    },
    Stream: {
      connect(options) {
        connected.push(options)
        return stream
      }
    }
  })

  const result = await transport.connect({
    onion: 'relay.onion',
    port: 443,
    timeout: 1200,
    dataDir: '/private/app/arti',
    artiBackend: 'addon',
    bootstrapTimeout: 90000,
    insecureFsPermissions: false,
    keyPair: 'secret-stream-option'
  })

  t.is(result, stream)
  t.alike(acquired, [
    {
      dataDir: '/private/app/arti',
      backend: 'addon',
      timeout: 90000,
      insecureFsPermissions: false,
      reachableAddresses: ['*:80', '*:443']
    }
  ])
  t.alike(connected, [
    {
      onion: 'relay.onion',
      port: 443,
      timeout: 1200,
      keyPair: 'secret-stream-option',
      proxyHost: '127.0.0.1',
      proxyPort: 19411
    }
  ])
  await closeAndFlush(stream)
  t.is(releases, 1)
})

test('Arti relay reachability policy is fixed and never leaks to external stream options', async (t) => {
  const acquired = []
  const connected = []
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire(options) {
        acquired.push(options)
        return { port: 19411, release: async () => {} }
      }
    },
    Stream: {
      connect(options) {
        connected.push(options)
        return stream
      }
    }
  })

  await transport.connect({ onion: 'relay.onion', port: 443 })
  t.alike(acquired, [{ reachableAddresses: ['*:80', '*:443'] }])
  t.absent(connected[0].reachableAddresses)
  await closeAndFlush(stream)
})

test('Arti transport omits undefined acquisition fields', async (t) => {
  let acquired
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire(options) {
        acquired = options
        return { port: 1, release: async () => {} }
      }
    },
    Stream: { connect: () => stream }
  })

  await transport.connect({ dataDir: undefined, onion: 'relay.onion' })
  t.alike(acquired, { reachableAddresses: ['*:80', '*:443'] })
  await closeAndFlush(stream)
})

test('Arti transport snapshots security options once', async (t) => {
  const reads = {
    dataDir: 0,
    artiBackend: 0,
    bootstrapTimeout: 0,
    insecureFsPermissions: 0
  }
  const values = {
    dataDir: '/private/app/arti',
    artiBackend: 'addon',
    bootstrapTimeout: 5000,
    insecureFsPermissions: false
  }
  const options = { onion: 'relay.onion' }
  for (const key of Object.keys(reads)) {
    Object.defineProperty(options, key, {
      enumerable: true,
      get() {
        reads[key]++
        return values[key]
      }
    })
  }
  let acquired
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire(options) {
        acquired = options
        return { port: 8, release: async () => {} }
      }
    },
    Stream: { connect: () => stream }
  })

  await transport.connect(options)
  t.alike(reads, {
    dataDir: 1,
    artiBackend: 1,
    bootstrapTimeout: 1,
    insecureFsPermissions: 1
  })
  t.alike(acquired, {
    dataDir: '/private/app/arti',
    backend: 'addon',
    timeout: 5000,
    insecureFsPermissions: false,
    reachableAddresses: ['*:80', '*:443']
  })
  await closeAndFlush(stream)
})

test('Arti transport rolls back failed option snapshots', async (t) => {
  const failures = [
    {
      error: error('ERR_GETTER', 'dataDir getter failed'),
      options(failure) {
        return Object.defineProperty({}, 'dataDir', {
          enumerable: true,
          get() {
            throw failure
          }
        })
      }
    },
    {
      error: error('ERR_OWN_KEYS', 'ownKeys failed'),
      options(failure) {
        return new Proxy(
          {},
          {
            ownKeys() {
              throw failure
            }
          }
        )
      }
    },
    {
      error: error('ERR_PROPERTY', 'property lookup failed'),
      options(failure) {
        return new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw failure
            }
          }
        )
      }
    }
  ]

  for (const fixture of failures) {
    let acquisitions = 0
    const stream = fakeStream()
    const transport = createArtiTransport({
      arti: {
        acquire: () => {
          acquisitions++
          return { port: 9, release: async () => {} }
        }
      },
      Stream: { connect: () => stream }
    })

    t.is(await rejection(transport.connect(fixture.options(fixture.error))), fixture.error)
    t.is(acquisitions, 0)
    t.is(await transport.connect({ onion: 'relay.onion' }), stream)
    await closeAndFlush(stream)
  }
})

test('Arti transport rejects owned proxy overrides before acquisition', async (t) => {
  let acquisitions = 0
  const transport = createArtiTransport({
    arti: { acquire: () => acquisitions++ },
    Stream: { connect: () => {} }
  })

  for (const options of [
    { proxyHost: 'localhost' },
    { proxyHost: undefined },
    { proxyPort: 9050 },
    { proxyPort: undefined }
  ]) {
    const err = await rejection(transport.connect(options))
    t.is(err.code, 'ERR_ARTI_CONFIG')
  }
  t.is(acquisitions, 0)
})

test('Arti transport retries after acquisition rejection', async (t) => {
  let acquisitions = 0
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire() {
        if (acquisitions++ === 0) throw error('ERR_ARTI_BOOTSTRAP')
        return { port: 2, release: async () => {} }
      }
    },
    Stream: { connect: () => stream }
  })

  const err = await rejection(transport.connect())
  t.is(err.code, 'ERR_ARTI_BOOTSTRAP')
  t.is(await transport.connect(), stream)
  await closeAndFlush(stream)
})

test('Arti transport rejects a second starting or active connection', async (t) => {
  const acquisition = deferred()
  const firstStream = fakeStream()
  const transport = createArtiTransport({
    arti: { acquire: () => acquisition.promise },
    Stream: { connect: () => firstStream }
  })

  const first = transport.connect()
  let err = await rejection(transport.connect())
  t.is(err.code, 'ERR_ARTI_CONFIG_CONFLICT')
  acquisition.resolve({ port: 3, release: async () => {} })
  await first
  err = await rejection(transport.connect())
  t.is(err.code, 'ERR_ARTI_CONFIG_CONFLICT')
  await closeAndFlush(firstStream)
})

test('Arti transport releases after connection failure', async (t) => {
  const failure = error('ERR_CONNECT', 'connect failed')
  let releases = 0
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({ port: 4, release: async () => releases++ })
    },
    Stream: { connect: () => Promise.reject(failure) }
  })

  t.is(await rejection(transport.connect()), failure)
  t.is(releases, 1)
})

test('Arti transport awaits cleanup after connection failure', async (t) => {
  const failure = error('ERR_CONNECT', 'connect failed')
  const release = deferred()
  let settled = false
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({ port: 11, release: () => release.promise })
    },
    Stream: { connect: () => Promise.reject(failure) }
  })

  const connecting = transport.connect()
  connecting.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  t.is(settled, false)
  release.resolve()
  t.is(await rejection(connecting), failure)
})

test('Arti transport reports failed rollback without hiding connection failure', async (t) => {
  const connectionFailure = error('ERR_CONNECT', 'connect failed')
  const shutdownFailure = error('ERR_NATIVE_STOP', 'native stop failed')
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({
        port: 12,
        release: () => Promise.reject(shutdownFailure)
      })
    },
    Stream: { connect: () => Promise.reject(connectionFailure) }
  })

  const failure = await rejection(transport.connect())
  t.is(failure.code, 'ERR_ARTI_SHUTDOWN')
  t.is(failure.cause, connectionFailure)
  t.is(failure.shutdownError, shutdownFailure)
  t.ok(failure.message.includes('native stop failed'))
})

test('Arti transport exposes one cleanup promise on a successful stream', async (t) => {
  const release = deferred()
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({ port: 13, release: () => release.promise })
    },
    Stream: { connect: () => stream }
  })

  const connected = await transport.connect()
  const stopped = connected.artiStopped
  t.ok(stopped instanceof Promise)
  t.is(connected.artiStopped, stopped)
  stream.emit('close')
  t.is(connected.artiStopped, stopped)
  release.resolve()
  await stopped
})

test('Arti transport releases once across repeated terminal signals', async (t) => {
  for (const signals of [
    ['close', 'close'],
    ['close', 'error'],
    ['error', 'close'],
    ['error', 'error']
  ]) {
    let releases = 0
    const stream = fakeStream()
    const transport = createArtiTransport({
      arti: {
        acquire: () => ({
          port: 14,
          release: async () => {
            releases++
          }
        })
      },
      Stream: { connect: () => stream }
    })

    const connected = await transport.connect()
    for (const signal of signals) stream.emit(signal, error('ERR_STREAM'))
    await connected.artiStopped
    t.is(releases, 1)
    if (signals[0] === 'error') {
      t.is(stream.destroys, 1)
      t.is(stream.destroyed, true)
    }
  }
})

test('Arti transport detaches terminal listeners after close', async (t) => {
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({ port: 17, release: async () => {} })
    },
    Stream: { connect: () => stream }
  })

  await transport.connect()
  t.is(stream.listenerCount('close'), 1)
  t.is(stream.listenerCount('error'), 1)
  stream.emit('close')
  await stream.artiStopped
  t.is(stream.listenerCount('close'), 0)
  t.is(stream.listenerCount('error'), 0)
})

test('Arti transport detaches terminal listeners after error', async (t) => {
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({ port: 18, release: async () => {} })
    },
    Stream: { connect: () => stream }
  })

  await transport.connect()
  stream.emit('error', error('ERR_STREAM'))
  await stream.artiStopped
  t.is(stream.listenerCount('close'), 0)
  t.is(stream.listenerCount('error'), 0)
})

test('Arti transport still releases when terminal stream teardown throws', async (t) => {
  for (const operation of ['off', 'destroy']) {
    const failure = error(`ERR_${operation.toUpperCase()}`)
    const stream = fakeStream()
    let releases = 0
    if (operation === 'off')
      stream.off = () => {
        throw failure
      }
    else
      stream.destroy = () => {
        throw failure
      }
    const transport = createArtiTransport({
      arti: {
        acquire: () => ({
          port: 19,
          release: async () => {
            releases++
          }
        })
      },
      Stream: { connect: () => stream }
    })

    await transport.connect()
    let surfaced
    try {
      stream.emit(operation === 'off' ? 'close' : 'error', error('ERR_STREAM'))
    } catch (err) {
      surfaced = err
    }
    t.is(surfaced, failure)
    await stream.artiStopped
    t.is(releases, 1)
  }
})

test('Arti transport detaches a partial listener setup before rollback', async (t) => {
  const setupFailure = error('ERR_ERROR_LISTENER')
  const release = deferred()
  const partial = fakeStream()
  const once = partial.once
  partial.once = function (name, listener) {
    if (name === 'error') throw setupFailure
    return once.call(this, name, listener)
  }
  const retry = fakeStream()
  let connects = 0
  let releases = 0
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({
        port: 20,
        release() {
          releases++
          return release.promise
        }
      })
    },
    Stream: { connect: () => (connects++ === 0 ? partial : retry) }
  })

  const connecting = transport.connect()
  await Promise.resolve()
  await Promise.resolve()
  t.is(partial.listenerCount('close'), 0)
  t.is(releases, 1)
  release.resolve()
  t.is(await rejection(connecting), setupFailure)
  t.is(await transport.connect(), retry)
  retry.emit('close')
  await retry.artiStopped
})

test('Arti transport keeps ownership until cleanup settles', async (t) => {
  const release = deferred()
  const streams = [fakeStream(), fakeStream()]
  let connects = 0
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({ port: 15, release: () => release.promise })
    },
    Stream: { connect: () => streams[connects++] }
  })

  const first = await transport.connect()
  first.emit('close')
  let failure = await rejection(transport.connect())
  t.is(failure.code, 'ERR_ARTI_CONFIG_CONFLICT')
  release.resolve()
  await first.artiStopped
  t.is(await transport.connect(), streams[1])
  streams[1].emit('close')
  await streams[1].artiStopped
})

test('Arti transport observes automatic cleanup rejection', async (t) => {
  const shutdownFailure = error('ERR_NATIVE_STOP', 'native stop failed')
  const stream = fakeStream()
  const transport = createArtiTransport({
    arti: {
      acquire: () => ({
        port: 16,
        release: () => Promise.reject(shutdownFailure)
      })
    },
    Stream: { connect: () => stream }
  })
  const observesUnhandled =
    typeof process !== 'undefined' &&
    typeof process.on === 'function' &&
    typeof process.off === 'function'
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  if (observesUnhandled) process.on('unhandledRejection', onUnhandled)

  try {
    const connected = await transport.connect()
    const stopped = connected.artiStopped
    stream.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (observesUnhandled) t.alike(unhandled, [])
    const failure = await rejection(stopped)
    t.is(failure.code, 'ERR_ARTI_SHUTDOWN')
    t.is(failure.shutdownError, shutdownFailure)
  } finally {
    if (observesUnhandled) process.off('unhandledRejection', onUnhandled)
  }
})

test('Arti transport rolls back failed stream listener setup', async (t) => {
  const listenerFailure = error('ERR_LISTENER_SETUP')
  const setupFailures = [
    {
      stream: {},
      expected: TypeError
    },
    {
      stream: new Proxy(
        {},
        {
          get(target, key) {
            if (key === 'once') throw listenerFailure
            return target[key]
          }
        }
      ),
      expected: listenerFailure
    }
  ]

  for (const fixture of setupFailures) {
    const release = deferred()
    let releases = 0
    let connects = 0
    let settled = false
    const retryStream = fakeStream()
    const transport = createArtiTransport({
      arti: {
        acquire: () => ({
          port: 10,
          async release() {
            releases++
            await release.promise
          }
        })
      },
      Stream: {
        connect() {
          return connects++ === 0 ? fixture.stream : retryStream
        }
      }
    })

    const connecting = transport.connect()
    connecting.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    await Promise.resolve()
    t.is(releases, 1)
    t.is(settled, false)
    release.resolve()
    const failure = await rejection(connecting)
    if (fixture.expected === TypeError) t.ok(failure instanceof TypeError)
    else t.is(failure, fixture.expected)
    t.is(await transport.connect(), retryStream)
    await closeAndFlush(retryStream)
  }
})

test('Arti entry is lazy and caches one successful controller', async (t) => {
  let loads = 0
  let acquisitions = 0
  const streams = [fakeStream(), fakeStream()]
  const entry = createArtiEntry({
    loadArti() {
      loads++
      return {
        acquire: () => ({
          port: 5,
          release: async () => {}
        })
      }
    },
    Stream: { connect: () => streams[acquisitions++] }
  })

  t.is(loads, 0)
  t.is(await entry.connect(), streams[0])
  await closeAndFlush(streams[0])
  t.is(await entry.connect(), streams[1])
  await closeAndFlush(streams[1])
  t.is(loads, 1)
})

test('Arti entry maps only a missing bare-arti package', async (t) => {
  const missing = error('MODULE_NOT_FOUND', "Cannot find module 'bare-arti'\nRequire stack: entry")
  const entry = createArtiEntry({
    loadArti: () => {
      throw missing
    },
    Stream: {}
  })

  const err = await rejection(entry.connect())
  t.is(err.code, 'ERR_ARTI_NOT_INSTALLED')
  t.ok(err.message.includes('optional dependency `bare-arti`'))
})

test('Arti entry retries a failed package load', async (t) => {
  let loads = 0
  const stream = fakeStream()
  const entry = createArtiEntry({
    loadArti() {
      if (loads++ === 0) throw error('ERR_TEMPORARY')
      return {
        acquire: () => ({ port: 6, release: async () => {} })
      }
    },
    Stream: { connect: () => stream }
  })

  const err = await rejection(entry.connect())
  t.is(err.code, 'ERR_TEMPORARY')
  t.is(await entry.connect(), stream)
  await closeAndFlush(stream)
  t.is(loads, 2)
})

test('Arti entry preserves installed-package initialization errors', async (t) => {
  for (const failure of [
    error('ERR_ARTI_ADDON_MISSING'),
    error('MODULE_NOT_FOUND', "Cannot find module 'nested-arti-dependency'")
  ]) {
    const entry = createArtiEntry({
      loadArti: () => {
        throw failure
      },
      Stream: {}
    })
    t.is(await rejection(entry.connect()), failure)
  }
})

test('concurrent Arti entry connects share one controller guard', async (t) => {
  const load = deferred()
  const acquisition = deferred()
  let loads = 0
  const stream = fakeStream()
  const entry = createArtiEntry({
    loadArti() {
      loads++
      return load.promise
    },
    Stream: { connect: () => stream }
  })

  const first = entry.connect()
  const second = entry.connect()
  load.resolve({ acquire: () => acquisition.promise })
  await Promise.resolve()
  const conflict = await rejection(second)
  t.is(conflict.code, 'ERR_ARTI_CONFIG_CONFLICT')
  acquisition.resolve({ port: 7, release: async () => {} })
  t.is(await first, stream)
  t.is(loads, 1)
  await closeAndFlush(stream)
})

test('public Arti entry require stays lazy', (t) => {
  const entry = require('../arti')
  t.is(typeof entry.connect, 'function')
})
