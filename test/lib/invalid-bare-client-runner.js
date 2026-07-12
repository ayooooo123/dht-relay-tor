const MAX_BUFFER = 64 * 1024

module.exports = function runInvalidBareClient(options) {
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout
  const timeout = options.timeout === undefined ? 2000 : options.timeout
  const killAfter = options.killAfter === undefined ? 1000 : options.killAfter

  return new Promise((resolve, reject) => {
    let child
    try {
      child = options.spawn()
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let failure = null
    let terminating = false
    let settled = false
    let timedOut = false
    let killTimer = null
    const timer = setTimer(() => {
      timedOut = true
      terminate()
    }, timeout)

    child.stdout.on('data', (data) => {
      stdout = (stdout + data).slice(-MAX_BUFFER)
    })
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-MAX_BUFFER)
    })
    const onError = (err) => {
      if (!failure) failure = err
      if (child.pid === undefined) clearTimer(timer)
      else terminate()
    }
    child.on('error', onError)
    child.once('close', (code, signal) => {
      finish(failure, { code, signal, stdout, stderr, timedOut })
    })

    function terminate() {
      if (terminating || child.exitCode !== null || child.signalCode !== null) return
      terminating = true
      child.kill('SIGTERM')
      killTimer = setTimer(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, killAfter)
    }

    function finish(err, outcome) {
      if (settled) return
      settled = true
      clearTimer(timer)
      if (killTimer !== null) clearTimer(killTimer)
      child.off('error', onError)
      if (err) reject(err)
      else resolve(outcome)
    }
  })
}
