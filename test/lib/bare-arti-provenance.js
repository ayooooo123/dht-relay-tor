module.exports = function verifyBareArtiProvenance({
  resolvedBareArti,
  expectedSourceSha,
  platform,
  arch,
  fs,
  path,
  crypto
}) {
  const packageRoot = path.dirname(resolvedBareArti)
  const provenancePath = path.join(packageRoot, 'prebuilds', 'provenance.json')

  if (!fs.existsSync(provenancePath)) {
    if (expectedSourceSha) throw new Error('installed bare-arti has no prebuild provenance')
    return { resolvedBareArti, sourceSha: null }
  }

  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
  const target = `${platform}-${arch}`
  const addon = `prebuilds/${target}/bare-arti.bare`
  if (provenance.schemaVersion !== 1) throw new Error('bare-arti provenance schema must be 1')
  if (provenance.addonAbiVersion !== 2) throw new Error('bare-arti provenance addon ABI must be 2')
  if (
    !Array.isArray(provenance.capabilities) ||
    provenance.capabilities.length !== 1 ||
    provenance.capabilities[0] !== 'reachableAddresses'
  ) {
    throw new Error('bare-arti provenance capabilities must be exactly reachableAddresses')
  }
  if (expectedSourceSha && provenance.proofOnly !== true) {
    throw new Error('exact bare-arti proof provenance must set proofOnly true')
  }
  if (
    !expectedSourceSha &&
    Object.prototype.hasOwnProperty.call(provenance, 'proofOnly') &&
    provenance.proofOnly !== true
  ) {
    throw new Error('bare-arti provenance proofOnly marker must be true when present')
  }
  if (!/^[0-9a-f]{40}$/.test(provenance.sourceSha)) {
    throw new Error('bare-arti provenance has an invalid source SHA')
  }
  if (expectedSourceSha && provenance.sourceSha !== expectedSourceSha) {
    throw new Error('bare-arti provenance source SHA does not match the expected checkout')
  }
  if (!Array.isArray(provenance.artifacts)) {
    throw new Error('bare-arti provenance artifacts must be an array')
  }
  const matches = provenance.artifacts.filter(
    (artifact) => artifact && artifact.kind === 'addon' && artifact.target === target
  )
  if (matches.length !== 1) {
    throw new Error(`bare-arti provenance target must contain exactly one addon for ${target}`)
  }
  const artifact = matches[0]
  if (artifact.path !== addon) {
    throw new Error(`bare-arti provenance addon must be ${addon}`)
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new Error('bare-arti provenance has an invalid addon SHA-256')
  }

  const filename = path.join(packageRoot, ...addon.split('/'))
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
  if (digest !== artifact.sha256) {
    throw new Error('installed bare-arti addon does not match its provenance SHA-256')
  }

  return {
    resolvedBareArti,
    sourceSha: provenance.sourceSha,
    target,
    addon,
    sha256: artifact.sha256
  }
}
