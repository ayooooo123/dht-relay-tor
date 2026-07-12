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

  if (provenance.target !== target) {
    throw new Error(`bare-arti provenance target must be ${target}`)
  }
  if (provenance.addon !== addon) {
    throw new Error(`bare-arti provenance addon must be ${addon}`)
  }
  if (!/^[0-9a-f]{40}$/.test(provenance.sourceSha)) {
    throw new Error('bare-arti provenance has an invalid source SHA')
  }
  if (expectedSourceSha && provenance.sourceSha !== expectedSourceSha) {
    throw new Error('bare-arti provenance source SHA does not match the expected checkout')
  }
  if (!/^[0-9a-f]{64}$/.test(provenance.sha256)) {
    throw new Error('bare-arti provenance has an invalid addon SHA-256')
  }

  const filename = path.join(packageRoot, ...addon.split('/'))
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
  if (digest !== provenance.sha256) {
    throw new Error('installed bare-arti addon does not match its provenance SHA-256')
  }

  return { resolvedBareArti, sourceSha: provenance.sourceSha }
}
