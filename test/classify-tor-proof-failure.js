const fs = require('fs')
const { classifyTorProofLog } = require('./lib/tor-proof-retry')

const filename = process.argv[2]
if (!filename) {
  console.error('usage: node test/classify-tor-proof-failure.js <log>')
  process.exit(2)
}

const classification = classifyTorProofLog(fs.readFileSync(filename, 'utf8'))
console.log(JSON.stringify(classification))
process.exit(classification.retry ? 0 : 1)
