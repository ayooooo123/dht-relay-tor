const { isBare, runtime, platform, arch } = require('which-runtime')
const fs = isBare ? require('bare-fs') : require('fs')
const path = isBare ? require('bare-path') : require('path')
const crypto = isBare ? require('bare-crypto') : require('crypto')
const verifyBareArtiProvenance = require('./lib/bare-arti-provenance')

const expectedSourceSha = isBare ? Bare.argv[2] : process.argv[2]
const resolvedBareArti = require.resolve('bare-arti')
const verified = verifyBareArtiProvenance({
  resolvedBareArti,
  expectedSourceSha,
  platform,
  arch,
  fs,
  path,
  crypto
})
const packageRoot = path.dirname(resolvedBareArti)
const provenancePath = path.join(packageRoot, 'prebuilds', 'provenance.json')
const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
let addonLoaded = false

if (isBare) {
  require('bare-arti/binding')
  addonLoaded = true
}

console.log(
  JSON.stringify({
    runtime,
    platform,
    arch,
    resolvedBareArti: verified.resolvedBareArti,
    sourceSha: verified.sourceSha,
    target: provenance.target,
    addon: provenance.addon,
    sha256: provenance.sha256,
    addonLoaded
  })
)
