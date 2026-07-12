const test = require('brittle')
const relayCompatible = require('../lib/relay-compatible')

test('relay-compatible streams make setMaxListeners chainable on Bare', (t) => {
  const calls = []
  const stream = {
    setMaxListeners(value) {
      calls.push(value)
    }
  }

  const compatible = relayCompatible(stream)

  t.is(compatible, stream)
  t.is(stream.setMaxListeners(0), stream)
  t.alike(calls, [0])
})
