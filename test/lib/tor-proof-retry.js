const INTEGRITY_OR_LOAD = [
  /provenance/i,
  /source SHA/i,
  /SHA-256/i,
  /integrity/i,
  /hash.*(?:mismatch|does not match|failed)/i,
  /Cannot find module/i,
  /ERR_DLOPEN_FAILED/i,
  /dlopen/i,
  /module did not self-register/i,
  /require\.addon/i,
  /(?:addon|bare-arti).*(?:load|mismatch|does not match|failed)/i,
  /(?:load|failed).*(?:addon|bare-arti)/i
]
const PAYLOAD = [
  /Hyperswarm payload/i,
  /payload.*(?:mismatch|failed|timed out)/i,
  /exchange timed out/i,
  /timed out waiting for (?:the )?echo peer/i
]
const DESCRIPTOR = [
  /onion service descriptor.*(?:not found|unavailable)/i,
  /HSDir.*(?:unavailable|failed)/i,
  /Giving up\. \(waiting for rendezvous desc\)/i
]
const TERMINAL_PREFIX = 'DHT_RELAY_TOR_TERMINAL '

module.exports = function classifyTorProofFailure(log) {
  if (matches(INTEGRITY_OR_LOAD, log)) {
    return { retry: false, class: 'terminal-integrity-or-load' }
  }
  if (matches(PAYLOAD, log)) return { retry: false, class: 'terminal-payload' }
  if (matches(DESCRIPTOR, log)) {
    return { retry: true, class: 'descriptor-publication-transient' }
  }
  return { retry: false, class: 'other-terminal' }
}

function classifyTorProofLog(log) {
  const records = log
    .split(/\r?\n/)
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith(TERMINAL_PREFIX))

  if (records.length === 0) return { retry: false, class: 'terminal-record-missing' }
  if (records.length !== 1) return { retry: false, class: 'terminal-record-duplicate' }

  let record
  try {
    record = JSON.parse(records[0].slice(TERMINAL_PREFIX.length))
  } catch {
    return { retry: false, class: 'terminal-record-malformed' }
  }
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    typeof record.diagnostic !== 'string' ||
    record.diagnostic.length === 0
  ) {
    return { retry: false, class: 'terminal-record-malformed' }
  }

  return module.exports(record.diagnostic)
}

function matches(patterns, value) {
  return patterns.some((pattern) => pattern.test(value))
}

module.exports.classifyTorProofLog = classifyTorProofLog
module.exports.TERMINAL_PREFIX = TERMINAL_PREFIX
