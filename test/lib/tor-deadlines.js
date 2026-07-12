const DEFAULTS = {
  TOR_BOOTSTRAP_TIMEOUT: 600000,
  ARTI_BOOTSTRAP_TIMEOUT: 720000,
  EXCHANGE_TIMEOUT: 120000,
  CLEANUP_TIMEOUT: 30000,
  PROCESS_KILL_TIMEOUT: 30000,
  OUTER_CLEANUP_RESERVE: 30000,
  OUTER_TEST_TIMEOUT: 1560000,
  WORKFLOW_CLEANUP_RESERVE: 30000,
  WORKFLOW_TIMEOUT: 1800000
}

function loadDeadlines(environment = {}) {
  const deadlines = {}
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    deadlines[name] = duration(environment, `DHT_RELAY_TOR_${name}`, fallback)
  }
  deadlines.ARTI_CHILD_TIMEOUT =
    deadlines.ARTI_BOOTSTRAP_TIMEOUT + deadlines.EXCHANGE_TIMEOUT + deadlines.CLEANUP_TIMEOUT

  const embeddedWorstCase =
    deadlines.TOR_BOOTSTRAP_TIMEOUT +
    deadlines.ARTI_CHILD_TIMEOUT +
    deadlines.PROCESS_KILL_TIMEOUT +
    deadlines.OUTER_CLEANUP_RESERVE
  if (embeddedWorstCase >= deadlines.OUTER_TEST_TIMEOUT) {
    throw new Error('embedded Tor deadlines must remain strictly below the outer test timeout')
  }

  const systemWorstCase =
    deadlines.TOR_BOOTSTRAP_TIMEOUT + deadlines.EXCHANGE_TIMEOUT + deadlines.OUTER_CLEANUP_RESERVE
  if (systemWorstCase >= deadlines.OUTER_TEST_TIMEOUT) {
    throw new Error('system Tor deadlines must remain strictly below the outer test timeout')
  }
  if (
    deadlines.OUTER_TEST_TIMEOUT + deadlines.WORKFLOW_CLEANUP_RESERVE >=
    deadlines.WORKFLOW_TIMEOUT
  ) {
    throw new Error('outer test timeout and cleanup must remain strictly below workflow timeout')
  }

  return deadlines
}

function duration(environment, name, fallback) {
  const value = environment[name]
  if (value === undefined || value === '') return fallback
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw new Error(`${name} must be a positive integer number of milliseconds`)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${name} exceeds the safe integer range`)
  return number
}

const environment = typeof process !== 'undefined' && process.env ? process.env : {}
module.exports = Object.assign(loadDeadlines(environment), { loadDeadlines })
