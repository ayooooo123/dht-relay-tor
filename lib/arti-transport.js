function configError(message, code = 'ERR_ARTI_CONFIG') {
  const err = new Error(message)
  err.code = code
  return err
}

function defined(target, key, value) {
  if (value !== undefined) target[key] = value
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function shutdownError(detail, cause = detail) {
  const message = detail && detail.message ? `: ${detail.message}` : ''
  const err = configError(`embedded Arti shutdown failed${message}`, 'ERR_ARTI_SHUTDOWN')
  err.cause = cause
  err.shutdownError = detail
  return err
}

module.exports.createArtiTransport = function createArtiTransport({ arti, Stream }) {
  let owned = false

  return {
    async connect(options = {}) {
      if (owned) {
        throw configError(
          'an embedded Arti transport is already starting or active',
          'ERR_ARTI_CONFIG_CONFLICT'
        )
      }
      owned = true

      let artiOptions
      let streamOptions
      try {
        if (
          Object.prototype.hasOwnProperty.call(options, 'proxyHost') ||
          Object.prototype.hasOwnProperty.call(options, 'proxyPort')
        ) {
          throw configError('proxyHost and proxyPort are managed by the embedded Arti transport')
        }

        const snapshot = { ...options }
        const {
          dataDir,
          artiBackend,
          bootstrapTimeout,
          insecureFsPermissions,
          ...transportOptions
        } = snapshot
        artiOptions = {}
        defined(artiOptions, 'dataDir', dataDir)
        defined(artiOptions, 'backend', artiBackend)
        defined(artiOptions, 'timeout', bootstrapTimeout)
        defined(artiOptions, 'insecureFsPermissions', insecureFsPermissions)
        streamOptions = transportOptions
      } catch (err) {
        owned = false
        throw err
      }

      let lease
      try {
        lease = await arti.acquire(artiOptions)
      } catch (err) {
        owned = false
        throw err
      }

      let stream
      try {
        stream = await Stream.connect({
          ...streamOptions,
          proxyHost: '127.0.0.1',
          proxyPort: lease.port
        })
      } catch (err) {
        try {
          await lease.release()
        } catch (shutdown) {
          owned = false
          throw shutdownError(shutdown, err)
        }
        owned = false
        throw err
      }

      const cleanup = deferred()
      let stopping = null
      cleanup.promise.catch(() => {})

      const stopOnce = () => {
        if (stopping !== null) return stopping
        const release = deferred()
        stopping = release.promise
          .catch((err) => {
            throw shutdownError(err)
          })
          .finally(() => {
            owned = false
          })
        stopping.then(cleanup.resolve, cleanup.reject)
        try {
          release.resolve(lease.release())
        } catch (err) {
          release.reject(err)
        }
        return stopping
      }

      try {
        Object.defineProperty(stream, 'artiStopped', {
          value: cleanup.promise,
          enumerable: true,
          configurable: true
        })
        stream.once('close', stopOnce)
        stream.once('error', () => {
          try {
            stream.destroy()
          } finally {
            stopOnce()
          }
        })
      } catch (err) {
        try {
          await stopOnce()
        } catch (shutdown) {
          throw shutdownError(shutdown.shutdownError || shutdown, err)
        }
        throw err
      }

      return stream
    }
  }
}
