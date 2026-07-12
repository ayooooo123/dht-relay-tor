function configError(message, code = 'ERR_ARTI_CONFIG') {
  const err = new Error(message)
  err.code = code
  return err
}

function defined(target, key, value) {
  if (value !== undefined) target[key] = value
}

module.exports.createArtiTransport = function createArtiTransport({ arti, Stream }) {
  let owned = false

  return {
    async connect(options = {}) {
      if (
        Object.prototype.hasOwnProperty.call(options, 'proxyHost') ||
        Object.prototype.hasOwnProperty.call(options, 'proxyPort')
      ) {
        throw configError('proxyHost and proxyPort are managed by the embedded Arti transport')
      }

      if (owned) {
        throw configError(
          'an embedded Arti transport is already starting or active',
          'ERR_ARTI_CONFIG_CONFLICT'
        )
      }
      owned = true

      const { dataDir, artiBackend, bootstrapTimeout, insecureFsPermissions, ...streamOptions } =
        options
      const artiOptions = {}
      defined(artiOptions, 'dataDir', dataDir)
      defined(artiOptions, 'backend', artiBackend)
      defined(artiOptions, 'timeout', bootstrapTimeout)
      defined(artiOptions, 'insecureFsPermissions', insecureFsPermissions)

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
        } finally {
          owned = false
        }
        throw err
      }

      stream.once('close', () => {
        let released
        try {
          released = lease.release()
        } catch {
          owned = false
          return
        }
        Promise.resolve(released).then(
          () => {
            owned = false
          },
          () => {
            owned = false
          }
        )
      })

      return stream
    }
  }
}
