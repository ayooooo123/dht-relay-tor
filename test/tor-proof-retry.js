const test = require('brittle')
const classifyTorProofFailure = require('./lib/tor-proof-retry')

test('Tor proof retry accepts a descriptor-only publication transient', (t) => {
  t.alike(classifyTorProofFailure('Onion service descriptor not found at the selected HSDir'), {
    retry: true,
    class: 'descriptor-publication-transient'
  })
})

test('Tor proof retry rejects HSDir text mixed with a payload timeout', (t) => {
  t.alike(
    classifyTorProofFailure(
      'HSDir unavailable while publishing\nHyperswarm exchange timed out waiting for payload'
    ),
    { retry: false, class: 'terminal-payload' }
  )
})

test('Tor proof retry rejects descriptor text mixed with a payload mismatch', (t) => {
  t.alike(
    classifyTorProofFailure(
      'onion service descriptor unavailable\nHyperswarm payload mismatch: expected echo:tor-proof'
    ),
    { retry: false, class: 'terminal-payload' }
  )
})

test('Tor proof retry rejects HSDir text mixed with an addon load failure', (t) => {
  t.alike(classifyTorProofFailure('HSDir failed temporarily\nfailed to load bare-arti addon'), {
    retry: false,
    class: 'terminal-integrity-or-load'
  })
})

test('Tor proof retry rejects HSDir text mixed with a native loader failure', (t) => {
  t.alike(
    classifyTorProofFailure(
      'HSDir unavailable while publishing\nERR_DLOPEN_FAILED: module did not self-register'
    ),
    { retry: false, class: 'terminal-integrity-or-load' }
  )
})

test('Tor proof retry rejects descriptor text mixed with provenance failure', (t) => {
  t.alike(
    classifyTorProofFailure(
      'onion service descriptor not found\nbare-arti provenance SHA-256 does not match'
    ),
    { retry: false, class: 'terminal-integrity-or-load' }
  )
})

test('Tor proof retry rejects unrelated failures', (t) => {
  t.alike(classifyTorProofFailure('Tor bootstrap failed'), {
    retry: false,
    class: 'other-terminal'
  })
})
