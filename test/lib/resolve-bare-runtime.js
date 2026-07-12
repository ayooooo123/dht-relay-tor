const fs = require('fs')
const defaultRuntime = require('bare-runtime')

module.exports = function resolveBareRuntime(options = {}) {
  const runtime = options.runtime || defaultRuntime
  const chmod = options.chmod || fs.chmodSync
  const command = runtime('bare')

  chmod(command, 0o755)
  return command
}
