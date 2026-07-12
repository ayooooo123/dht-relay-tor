const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const verifyBareArtiProvenance = require('./lib/bare-arti-provenance')

test('Bare Arti provenance rejects a non-runtime target', (t) => {
  const fixture = provenanceFixture('darwin-arm64')
  t.teardown(fixture.cleanup)
  fixture.writeManifest({ target: 'linux-x64' })

  t.exception(() => fixture.verify(), /target.*darwin-arm64/i)
})

test('Bare Arti provenance rejects a valid hash at a non-runtime artifact path', (t) => {
  const fixture = provenanceFixture('darwin-arm64')
  t.teardown(fixture.cleanup)
  const other = fixture.writeAddon('prebuilds/linux-x64/bare-arti.bare', 'other addon')
  fixture.writeManifest({
    addon: 'prebuilds/linux-x64/bare-arti.bare',
    sha256: sha256(other)
  })

  t.exception(() => fixture.verify(), /addon.*prebuilds\/darwin-arm64\/bare-arti\.bare/i)
})

test('Bare Arti provenance verifies the exact runtime artifact', (t) => {
  const fixture = provenanceFixture('darwin-arm64')
  t.teardown(fixture.cleanup)
  fixture.writeManifest()

  t.alike(fixture.verify(), {
    resolvedBareArti: fixture.resolvedBareArti,
    sourceSha: 'a'.repeat(40)
  })
})

function provenanceFixture(target) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dht-relay-tor-provenance-'))
  const resolvedBareArti = path.join(root, 'index.js')
  fs.writeFileSync(resolvedBareArti, '')
  const runtimeAddon = `prebuilds/${target}/bare-arti.bare`
  const runtimeFile = writeAddon(runtimeAddon, 'runtime addon')

  return {
    resolvedBareArti,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
    writeAddon,
    writeManifest(overrides = {}) {
      const provenance = {
        sourceSha: 'a'.repeat(40),
        target,
        addon: runtimeAddon,
        sha256: sha256(runtimeFile),
        ...overrides
      }
      fs.mkdirSync(path.join(root, 'prebuilds'), { recursive: true })
      fs.writeFileSync(path.join(root, 'prebuilds', 'provenance.json'), JSON.stringify(provenance))
    },
    verify() {
      return verifyBareArtiProvenance({
        resolvedBareArti,
        expectedSourceSha: 'a'.repeat(40),
        platform: target.split('-')[0],
        arch: target.split('-').slice(1).join('-'),
        fs,
        path,
        crypto
      })
    }
  }

  function writeAddon(relative, contents) {
    const filename = path.join(root, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, contents)
    return filename
  }
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}
