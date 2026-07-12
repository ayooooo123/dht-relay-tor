const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const crypto = require('bare-crypto')
const Hyperswarm = require('hyperswarm')
const RelayedDHT = require('@hyperswarm/dht-relay')

const EXCHANGE_TIMEOUT = 120000
const CLEANUP_TIMEOUT = 30000
const ERROR_PREFIX = 'DHT_RELAY_TOR_ERROR '
const RESULT_PREFIX = 'DHT_RELAY_TOR_RESULT '

let clientStream = null
let clientDHT = null
let clientSwarm = null

main().then(onSuccess, onFailure)

async function main() {
  const input = parseInput(Bare.argv[2])
  const provenance = verifyBareArti(input.expectedBareArtiSha)

  clientStream = await require('../arti').connect({
    onion: input.onion,
    port: input.onionPort,
    dataDir: input.dataDir,
    artiBackend: 'addon',
    bootstrapTimeout: 720000,
    timeout: 720000
  })
  clientDHT = new RelayedDHT(clientStream)
  await clientDHT.ready()

  clientSwarm = new Hyperswarm({ dht: clientDHT })
  const reply = exchange(clientSwarm, b4a.from('tor-proof'))
  clientSwarm.join(b4a.from(input.topicHex, 'hex'), { client: true, server: false })

  const value = await reply
  const stopped = clientStream.artiStopped
  await teardown()
  await withDeadline(stopped, CLEANUP_TIMEOUT, 'Arti cleanup')

  return {
    reply: value,
    resolvedBareArti: provenance.resolvedBareArti,
    sourceSha: provenance.sourceSha
  }
}

async function onSuccess(result) {
  console.log(RESULT_PREFIX + JSON.stringify(result))
}

async function onFailure(err) {
  const stopped = clientStream && clientStream.artiStopped
  await withDeadline(
    (async () => {
      await teardown()
      if (stopped) await stopped
    })(),
    CLEANUP_TIMEOUT,
    'client teardown'
  ).catch(() => {})
  console.error(
    ERROR_PREFIX +
      JSON.stringify({
        code: typeof err.code === 'string' ? err.code : 'ERR_TOR_BARE_CLIENT',
        message: boundedMessage(err)
      })
  )
  Bare.exit(1)
}

function parseInput(argument) {
  let input
  try {
    input = JSON.parse(argument)
  } catch {
    throw new Error('input must be valid JSON')
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('input must be a JSON object')
  }
  if (!/^[a-z2-7]{56}\.onion$/.test(input.onion)) {
    throw new Error('onion must be a valid v3 onion hostname')
  }
  assertPort(input.onionPort, 'onionPort')
  if (!Array.isArray(input.bootstrap) || input.bootstrap.length === 0) {
    throw new Error('bootstrap must contain at least one node')
  }
  for (const node of input.bootstrap) {
    if (!node || typeof node !== 'object' || typeof node.host !== 'string' || !node.host.trim()) {
      throw new Error('every bootstrap node must have a nonempty host')
    }
    assertPort(node.port, 'bootstrap port')
  }
  if (!/^[0-9a-f]{64}$/.test(input.topicHex)) {
    throw new Error('topicHex must be exactly 32 bytes of lowercase hexadecimal')
  }
  if (typeof input.dataDir !== 'string' || !path.isAbsolute(input.dataDir)) {
    throw new Error('dataDir must be an absolute path')
  }
  if (
    input.expectedBareArtiSha !== undefined &&
    !/^[0-9a-f]{40}$/.test(input.expectedBareArtiSha)
  ) {
    throw new Error('expectedBareArtiSha must be a lowercase 40-character Git SHA')
  }

  return input
}

function verifyBareArti(expectedSourceSha) {
  const resolvedBareArti = require.resolve('bare-arti')
  const packageRoot = path.dirname(resolvedBareArti)
  const provenancePath = path.join(packageRoot, 'prebuilds', 'provenance.json')

  if (!fs.existsSync(provenancePath)) {
    if (expectedSourceSha) throw new Error('installed bare-arti has no prebuild provenance')
    return { resolvedBareArti, sourceSha: null }
  }

  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
  if (!/^[0-9a-f]{40}$/.test(provenance.sourceSha)) {
    throw new Error('bare-arti provenance has an invalid source SHA')
  }
  if (expectedSourceSha && provenance.sourceSha !== expectedSourceSha) {
    throw new Error('bare-arti provenance source SHA does not match the expected checkout')
  }
  if (typeof provenance.addon !== 'string' || !provenance.addon) {
    throw new Error('bare-arti provenance has no addon path')
  }
  if (!/^[0-9a-f]{64}$/.test(provenance.sha256)) {
    throw new Error('bare-arti provenance has an invalid addon SHA-256')
  }

  const addon = path.resolve(packageRoot, provenance.addon)
  if (addon !== packageRoot && !addon.startsWith(packageRoot + path.sep)) {
    throw new Error('bare-arti provenance addon path escapes the package')
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(addon)).digest('hex')
  if (digest !== provenance.sha256) {
    throw new Error('installed bare-arti addon does not match its provenance SHA-256')
  }

  return { resolvedBareArti, sourceSha: provenance.sourceSha }
}

async function teardown() {
  const swarm = clientSwarm
  const dht = clientDHT
  const stream = clientStream
  clientSwarm = null
  clientDHT = null
  clientStream = null

  if (swarm) await swarm.destroy().catch(() => {})
  else if (dht) await dht.destroy().catch(() => {})
  if (stream) stream.destroy()
}

function exchange(swarm, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => done(new Error('Hyperswarm exchange timed out')),
      EXCHANGE_TIMEOUT
    )

    const done = (err, value) => {
      clearTimeout(timeout)
      swarm.off('connection', onConnection)
      if (err) reject(err)
      else resolve(value)
    }
    const onConnection = (socket) => {
      socket.once('error', done)
      socket.once('data', (data) => done(null, data.toString()))
      socket.write(message)
    }

    swarm.once('connection', onConnection)
  })
}

function withDeadline(promise, timeout, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeout}ms`)),
      timeout
    )
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function assertPort(port, name) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`)
  }
}

function boundedMessage(err) {
  const message = err && typeof err.message === 'string' ? err.message : String(err)
  return message.slice(0, 4096)
}
