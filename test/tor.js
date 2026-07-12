const test = require('brittle')
const b4a = require('b4a')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const RelayedDHT = require('@hyperswarm/dht-relay')
const { relay } = require('@hyperswarm/dht-relay')
const Stream = require('..')
const runBareClient = require('./lib/bare-client-runner')
const resolveBareRuntime = require('./lib/resolve-bare-runtime')
const { TERMINAL_PREFIX } = require('./lib/tor-proof-retry')
const {
  TOR_BOOTSTRAP_TIMEOUT,
  ARTI_BOOTSTRAP_TIMEOUT,
  EXCHANGE_TIMEOUT,
  CLEANUP_TIMEOUT,
  PROCESS_KILL_TIMEOUT,
  ARTI_CHILD_TIMEOUT,
  OUTER_TEST_TIMEOUT
} = require('./lib/tor-deadlines')
const ONION_PORT = 18080

test(
  'relayed DHT reaches a swarm peer through a real Tor v3 service',
  { timeout: OUTER_TEST_TIMEOUT },
  async (t) => {
    const backend = process.env.DHT_RELAY_TOR_TEST_BACKEND || 'tor'
    const externalOnion = process.env.DHT_RELAY_TOR_TEST_ONION || null
    const externalRelayPort = numberFromEnvironment('DHT_RELAY_TOR_TEST_RELAY_PORT', externalOnion)

    if (backend !== 'tor' && backend !== 'arti') {
      throw new Error(`unknown DHT_RELAY_TOR_TEST_BACKEND=${backend}; expected tor or arti`)
    }

    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dht-relay-tor-'))
    const dataDirectory = path.join(root, 'data')
    const artiDataDirectory = path.join(root, 'arti-data')
    const hiddenServiceDirectory = path.join(root, 'hidden-service')
    const socksPort = externalOnion
      ? numberFromEnvironment('DHT_RELAY_TOR_TEST_SOCKS_PORT', false, 9050)
      : await freePort()

    await fs.promises.mkdir(dataDirectory, { mode: 0o700 })

    let tor = null
    let torLogs = ''
    let tcp = null
    let relayDHT = null
    let serverDHT = null
    let serverSwarm = null
    let clientDHT = null
    let clientSwarm = null
    let clientStream = null
    let bareClient = null
    let cleaned = false
    let relayRemoteAddress = null

    const cleanup = async () => {
      if (cleaned) return
      cleaned = true

      if (bareClient) await stopProcess(bareClient)
      if (clientSwarm) await clientSwarm.destroy().catch(() => {})
      else if (clientDHT) await clientDHT.destroy().catch(() => {})
      if (clientStream) clientStream.destroy()
      if (tcp) await closeServer(tcp)
      if (relayDHT) await relayDHT.destroy().catch(() => {})
      if (serverSwarm) await serverSwarm.destroy().catch(() => {})
      else if (serverDHT) await serverDHT.destroy().catch(() => {})
      if (tor) await stopProcess(tor)
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {})
    }

    t.teardown(cleanup)

    try {
      const testnet = await createTestnet(4, t.teardown)
      const { bootstrap } = testnet
      const topic = b4a.alloc(32, 7)

      serverDHT = new HyperDHT({ bootstrap })
      serverSwarm = new Hyperswarm({ dht: serverDHT })
      serverSwarm.on('connection', (socket) => {
        socket.on('error', () => {})
        socket.on('data', (data) => {
          socket.write(b4a.concat([b4a.from('echo:'), data]))
        })
      })
      await serverSwarm.join(topic, { server: true, client: false }).flushed()

      relayDHT = new HyperDHT({ bootstrap })
      tcp = net.createServer((socket) => {
        relayRemoteAddress = socket.remoteAddress
        const stream = Stream.wrap(false, socket)
        stream.on('error', () => {})
        relay(relayDHT, stream)
      })
      await listen(tcp, externalRelayPort || 0)

      let onion = externalOnion

      if (!onion) {
        tor = spawn(
          process.env.TOR_BIN || 'tor',
          [
            '--DataDirectory',
            dataDirectory,
            '--SocksPort',
            `127.0.0.1:${socksPort}`,
            '--HiddenServiceDir',
            hiddenServiceDirectory,
            '--HiddenServiceVersion',
            '3',
            '--HiddenServicePort',
            `${ONION_PORT} 127.0.0.1:${tcp.address().port}`,
            '--FascistFirewall',
            '1',
            '--Log',
            'notice stdout'
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )

        const recordLogs = (data) => {
          torLogs = (torLogs + data.toString()).slice(-65536)
        }
        tor.stdout.on('data', recordLogs)
        tor.stderr.on('data', recordLogs)

        onion = await waitForTor(tor, path.join(hiddenServiceDirectory, 'hostname'), () => torLogs)
      }

      if (backend === 'arti') {
        await fs.promises.mkdir(artiDataDirectory, { mode: 0o700 })
        const expectedBareArtiSha = process.env.BARE_ARTI_SHA || undefined
        const result = await runBareClient({
          command: resolveBareRuntime(),
          args: [
            path.join(__dirname, 'tor-bare-client.js'),
            JSON.stringify({
              onion,
              onionPort: ONION_PORT,
              bootstrap: bootstrap.map(({ host, port }) => ({ host, port })),
              topicHex: topic.toString('hex'),
              dataDir: artiDataDirectory,
              expectedBareArtiSha,
              reachableAddresses: ['*:80', '*:443'],
              deadlines: {
                artiBootstrapTimeout: ARTI_BOOTSTRAP_TIMEOUT,
                exchangeTimeout: EXCHANGE_TIMEOUT,
                cleanupTimeout: CLEANUP_TIMEOUT
              }
            })
          ],
          timeout: ARTI_CHILD_TIMEOUT,
          killAfter: PROCESS_KILL_TIMEOUT,
          spawn: (command, args, options) => {
            bareClient = spawn(command, args, options)
            return bareClient
          },
          spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] }
        })

        t.is(result.reply, 'echo:tor-proof', 'Hyperswarm payload crossed the relayed DHT over Arti')
        t.is(
          result.resolvedBareArti,
          require.resolve('bare-arti'),
          'Bare child loaded the installed bare-arti package'
        )
        if (expectedBareArtiSha) {
          t.is(
            result.sourceSha,
            expectedBareArtiSha,
            'Bare child verified the bare-arti source SHA'
          )
        }
        t.alike(
          result.reachableAddresses,
          ['*:80', '*:443'],
          'Bare child used the restricted Arti relay reachability policy'
        )
      } else {
        clientStream = await Stream.connect({
          onion,
          port: ONION_PORT,
          proxyHost: '127.0.0.1',
          proxyPort: socksPort,
          timeout: TOR_BOOTSTRAP_TIMEOUT
        })

        clientDHT = new RelayedDHT(clientStream)
        await clientDHT.ready()

        clientSwarm = new Hyperswarm({ dht: clientDHT })
        const reply = exchange(clientSwarm, b4a.from('tor-proof'))
        clientSwarm.join(topic, { client: true, server: false })

        t.is(await reply, 'echo:tor-proof', 'Hyperswarm payload crossed the relayed DHT over Tor')
      }
      t.ok(
        isLoopback(relayRemoteAddress),
        `hidden-service relay saw only Tor on loopback (${relayRemoteAddress})`
      )
    } catch (err) {
      console.error(
        TERMINAL_PREFIX +
          JSON.stringify({
            diagnostic: terminalDiagnostic(err, torLogs)
          })
      )
      if (torLogs) err.message += `\n\nTor diagnostics:\n${torLogs}`
      throw err
    } finally {
      await cleanup()
    }
  }
)

function terminalDiagnostic(err, torLogs) {
  const errorText =
    err && typeof err.stack === 'string'
      ? err.stack
      : err && typeof err.message === 'string'
        ? err.message
        : String(err)
  const boundedError = errorText.slice(0, 16384)
  const boundedTorLogs = torLogs ? torLogs.slice(-49152) : ''
  return boundedTorLogs ? `${boundedError}\n\nTor diagnostics:\n${boundedTorLogs}` : boundedError
}

function freePort() {
  const server = net.createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function numberFromEnvironment(name, required, fallback = null) {
  const value = process.env[name]

  if (!value && !required) return fallback
  if (!value) throw new Error(`${name} is required when using an external onion`)

  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`)
  }

  return number
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

function waitForTor(child, hostnameFile, getLogs) {
  return new Promise((resolve, reject) => {
    let bootstrapped = false
    let settled = false

    const finish = (err, onion) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('error', onError)
      if (err) reject(err)
      else resolve(onion)
    }

    const check = async () => {
      if (/Bootstrapped 100%/.test(getLogs())) bootstrapped = true

      let onion = ''
      try {
        onion = (await fs.promises.readFile(hostnameFile, 'utf8')).trim()
      } catch (err) {
        if (err.code !== 'ENOENT') return finish(err)
      }

      if (bootstrapped && /^[a-z2-7]{56}\.onion$/.test(onion)) {
        finish(null, onion)
      }
    }

    const onExit = (code, signal) => {
      finish(
        new Error(`Tor exited before bootstrap (code=${code}, signal=${signal})\n${getLogs()}`)
      )
    }
    const onError = (err) => finish(err)

    child.once('exit', onExit)
    child.once('error', onError)
    const poll = setInterval(check, 200)
    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Tor did not bootstrap and publish its v3 hostname within ${TOR_BOOTSTRAP_TIMEOUT}ms\n${getLogs()}`
        )
      )
    }, TOR_BOOTSTRAP_TIMEOUT)
    check()
  })
}

function exchange(swarm, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('timed out waiting for the echo peer through Tor'))
    }, EXCHANGE_TIMEOUT)

    const done = (err, value) => {
      clearTimeout(timeout)
      swarm.off('connection', onConnection)
      if (err) reject(err)
      else resolve(value)
    }
    const onError = (err) => done(err)
    const onConnection = (socket) => {
      socket.once('error', onError)
      socket.once('data', (data) => done(null, data.toString()))
      socket.write(message)
    }

    swarm.once('connection', onConnection)
  })
}

function isLoopback(address) {
  return (
    address === '::1' ||
    address === '127.0.0.1' ||
    (typeof address === 'string' && address.startsWith('::ffff:127.'))
  )
}

function stopProcess(child) {
  if (!child.pid) return Promise.resolve()
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise((resolve) => {
    let killTimer = null
    const done = () => {
      clearTimeout(killTimer)
      resolve()
    }

    child.once('exit', done)
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
  })
}
