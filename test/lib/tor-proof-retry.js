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
  /HSDir.*(?:unavailable|failed)/i
]

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

function matches(patterns, value) {
  return patterns.some((pattern) => pattern.test(value))
}
