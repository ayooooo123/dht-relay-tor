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
    once(name, listener) {
      listeners.set(name, listener)
    },
    emit(name, value) {
      const listener = listeners.get(name)
      listeners.delete(name)
      if (listener) listener(value)
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
      insecureFsPermissions: false
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
  t.alike(acquired, {})
  await closeAndFlush(stream)
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
