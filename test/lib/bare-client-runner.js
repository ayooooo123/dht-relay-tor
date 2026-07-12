const { spawn: defaultSpawn } = require('child_process')

const RESULT_PREFIX = 'DHT_RELAY_TOR_RESULT '
const MAX_BUFFER = 64 * 1024

module.exports = function runBareClient(options = {}) {
  const spawn = options.spawn || defaultSpawn
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout
  const timeout = options.timeout === undefined ? 720000 : options.timeout
  const killAfter = options.killAfter === undefined ? 30000 : options.killAfter
  const maxBuffer = options.maxBuffer === undefined ? MAX_BUFFER : options.maxBuffer

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(options.command, options.args || [], options.spawnOptions || {})
    } catch (err) {
      reject(err)
      return
    }

    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let failure = null
    let terminating = false
    let settled = false
    let killTimer = null

    const timer = setTimer(() => {
      fail(new Error(`Bare client timed out after ${timeout}ms`))
    }, timeout)

    child.stdout.on('data', (chunk) => {
      stdout = appendBounded('stdout', stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendBounded('stderr', stderr, chunk)
    })
    const onError = (err) => {
      if (child.pid === undefined) finish(err)
      else fail(err)
    }
    child.on('error', onError)
    child.once('close', (code, signal) => {
      if (settled) return

      let result = null
      if (!failure) {
        try {
          result = parseResult(stdout.toString())
        } catch (err) {
          failure = err
        }
      }

      if (!failure && (code !== 0 || signal !== null)) {
        failure = new Error(`Bare client exited abnormally (code=${code}, signal=${signal})`)
      }

      if (failure) finish(withDiagnostics(failure, stderr))
      else finish(null, result)
    })

    function appendBounded(name, buffer, chunk) {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk)
      const remaining = Math.max(0, maxBuffer - buffer.length)
      const bounded =
        remaining === 0 ? buffer : Buffer.concat([buffer, chunk.subarray(0, remaining)])

      if (chunk.length > remaining) {
        fail(new Error(`Bare client ${name} exceeded the ${maxBuffer}-byte limit`))
      }

      return bounded
    }

    function fail(err) {
      if (!failure) failure = err
      if (terminating || child.exitCode !== null || child.signalCode !== null) return
      terminating = true
      child.kill('SIGTERM')
      killTimer = setTimer(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, killAfter)
    }

    function finish(err, value) {
      if (settled) return
      settled = true
      clearTimer(timer)
      if (killTimer !== null) clearTimer(killTimer)
      child.off('error', onError)
      if (err) reject(err)
      else resolve(value)
    }
  })
}

function parseResult(output) {
  const records = []

  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(RESULT_PREFIX)) continue

    let result
    try {
      result = JSON.parse(line.slice(RESULT_PREFIX.length))
    } catch {
      throw new Error('Bare client emitted a malformed result record')
    }

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Bare client emitted a malformed result record')
    }

    records.push(result)
  }

  if (records.length === 0) throw new Error('Bare client exited without a result record')
  if (records.length !== 1) throw new Error('Bare client emitted duplicate result records')
  return records[0]
}

function withDiagnostics(err, stderr) {
  err.stderr = stderr.toString()
  if (err.stderr) err.message += `\n\nBare client stderr:\n${err.stderr}`
  return err
}

module.exports.RESULT_PREFIX = RESULT_PREFIX
module.exports.MAX_BUFFER = MAX_BUFFER
