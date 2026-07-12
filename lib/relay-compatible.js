module.exports = function relayCompatible(stream) {
  const setMaxListeners = stream.setMaxListeners

  Object.defineProperty(stream, 'setMaxListeners', {
    configurable: true,
    writable: true,
    value(value) {
      setMaxListeners.call(this, value)
      return this
    }
  })

  return stream
}
