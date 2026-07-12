const test = require('brittle')
const classifyTorProofFailure = require('./lib/tor-proof-retry')
const { classifyTorProofLog, TERMINAL_PREFIX } = classifyTorProofFailure

test('Tor proof retry accepts a descriptor-only publication transient', (t) => {
  t.alike(classifyTorProofFailure('Onion service descriptor not found at the selected HSDir'), {
    retry: true,
    class: 'descriptor-publication-transient'
  })
})

test('Tor proof retry accepts Tor waiting for a rendezvous descriptor', (t) => {
  t.alike(
    classifyTorProofFailure(
      'SOCKS5 CONNECT failed: TTL expired\nTried for 120 seconds to get a connection. Giving up. (waiting for rendezvous desc)'
    ),
    { retry: true, class: 'descriptor-publication-transient' }
  )
})

test('rendezvous descriptor retry stays fail-closed for payload and integrity failures', (t) => {
  const descriptor = 'Giving up. (waiting for rendezvous desc)'

  t.alike(classifyTorProofFailure(`${descriptor}\nHyperswarm exchange timed out`), {
    retry: false,
    class: 'terminal-payload'
  })
  t.alike(classifyTorProofFailure(`${descriptor}\nbare-arti provenance SHA-256 does not match`), {
    retry: false,
    class: 'terminal-integrity-or-load'
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

test('Tor proof retry ignores passing TAP titles and accepts the structured descriptor failure', (t) => {
  const log = fullTap('Onion service descriptor not found at the selected HSDir')

  t.alike(classifyTorProofLog(log), {
    retry: true,
    class: 'descriptor-publication-transient'
  })
})

test('Tor proof retry rejects a structured payload failure mixed with descriptor text', (t) => {
  const log = fullTap(
    'HSDir unavailable while publishing\nHyperswarm exchange timed out waiting for payload'
  )

  t.alike(classifyTorProofLog(log), { retry: false, class: 'terminal-payload' })
})

test('Tor proof retry rejects a structured addon load failure mixed with descriptor text', (t) => {
  const log = fullTap('onion service descriptor unavailable\nERR_DLOPEN_FAILED loading addon')

  t.alike(classifyTorProofLog(log), {
    retry: false,
    class: 'terminal-integrity-or-load'
  })
})

test('Tor proof retry rejects a structured provenance failure mixed with descriptor text', (t) => {
  const log = fullTap('HSDir failed temporarily\nbare-arti provenance SHA-256 does not match')

  t.alike(classifyTorProofLog(log), {
    retry: false,
    class: 'terminal-integrity-or-load'
  })
})

test('Tor proof retry fails closed without exactly one valid terminal record', (t) => {
  t.alike(classifyTorProofLog('TAP version 13\nnot ok 1'), {
    retry: false,
    class: 'terminal-record-missing'
  })
  t.alike(classifyTorProofLog(`${TERMINAL_PREFIX}{bad json}`), {
    retry: false,
    class: 'terminal-record-malformed'
  })

  const record = `${TERMINAL_PREFIX}${JSON.stringify({ diagnostic: 'HSDir unavailable' })}`
  t.alike(classifyTorProofLog(`${record}\n${record}`), {
    retry: false,
    class: 'terminal-record-duplicate'
  })
})

function fullTap(diagnostic) {
  return [
    'TAP version 13',
    '# passing provenance SHA-256 integrity failure test',
    'ok 1 - passing provenance SHA-256 integrity failure test',
    '# passing Hyperswarm payload timeout test',
    'ok 2 - passing Hyperswarm payload timeout test',
    `    ${TERMINAL_PREFIX}${JSON.stringify({ diagnostic })}`,
    'not ok 3 - relayed DHT reaches a swarm peer through a real Tor v3 service'
  ].join('\n')
}
