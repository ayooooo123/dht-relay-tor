const { createArtiTransport } = require('./arti-transport')

function isMissingArti(err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') return false
  const firstLine = String(err.message).split('\n', 1)[0]
  return /(?:Cannot find module|Cannot find package) ['"]bare-arti['"]/.test(firstLine)
}

function missingArtiError(cause) {
  const err = new Error(
    'bundled Tor requires the optional dependency `bare-arti` (embedded Arti) to be installed',
    { cause }
  )
  err.code = 'ERR_ARTI_NOT_INSTALLED'
  return err
}

module.exports.createArtiEntry = function createArtiEntry({ loadArti, Stream }) {
  let controller = null
  let loading = null

  async function getController() {
    if (controller) return controller
    if (!loading) {
      loading = Promise.resolve()
        .then(loadArti)
        .catch((err) => {
          if (isMissingArti(err)) throw missingArtiError(err)
          throw err
        })
        .then((arti) => createArtiTransport({ arti, Stream }))
        .then(
          (loaded) => {
            controller = loaded
            loading = null
            return loaded
          },
          (err) => {
            loading = null
            throw err
          }
        )
    }
    return loading
  }

  return {
    async connect(options = {}) {
      const transport = await getController()
      return transport.connect(options)
    }
  }
}
