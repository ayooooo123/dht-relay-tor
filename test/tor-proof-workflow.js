const test = require('brittle')
const fs = require('fs')
const path = require('path')

// Keep this at the already-registered workflow path so feature refs can be
// dispatched before the hardened definition reaches the default branch.
const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'tor-smoke.yml')

test('Tor proof workflow locks its supply-chain inputs', (t) => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const actionReferences = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s]+)/gm)].map(
    (match) => match[1]
  )

  t.ok(/^\s*workflow_dispatch:\s*$/m.test(workflow), 'is manually dispatched')
  t.ok(/^\s*BARE_ARTI_SHA:\s*d628e48498eec43f665a21dcf0015005683150ab\s*$/m.test(workflow))
  t.ok(/^\s*NODE_VERSION:\s*'22\.19\.0'\s*$/m.test(workflow))
  t.ok(/^\s*RUST_VERSION:\s*'1\.96\.1'\s*$/m.test(workflow))
  t.ok(/^\s*BARE_VERSION:\s*'1\.30\.3'\s*$/m.test(workflow))
  t.ok(/^\s*BARE_MAKE_VERSION:\s*'1\.6\.3'\s*$/m.test(workflow))
  t.ok(/^\s*CMAKE_RUNTIME_VERSION:\s*'4\.3\.1'\s*$/m.test(workflow))
  t.ok(actionReferences.length >= 6, 'uses GitHub actions for both jobs and evidence')
  for (const reference of actionReferences) {
    t.ok(/@[0-9a-f]{40}$/.test(reference), `${reference} is pinned to an immutable commit`)
  }
})

test('Tor proof workflow separates the control and embedded proof', (t) => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')

  t.ok(
    /permissions:\n  contents: read\n\nenv:/.test(workflow),
    'workflow defaults to read-only contents'
  )
  t.ok(
    /  embedded_arti:\n(?:.|\n)*?    permissions:\n      contents: read\n      id-token: write\n      attestations: write\n/.test(
      workflow
    ),
    'only the attesting job receives OIDC and attestation writes'
  )
  t.is((workflow.match(/^  (system_tor|embedded_arti):\s*$/gm) || []).length, 2)
  t.is((workflow.match(/^\s*timeout-minutes:\s*30\s*$/gm) || []).length, 2)
  t.is((workflow.match(/^\s*runs-on:\s*ubuntu-24\.04\s*$/gm) || []).length, 2)
  t.ok(/DHT_RELAY_TOR_TEST_BACKEND:\s*tor/.test(workflow))
  t.ok(/DHT_RELAY_TOR_TEST_BACKEND:\s*arti/.test(workflow))
  t.ok(/npm ci/.test(workflow))
})

test('embedded proof rebuilds, packs, and verifies the exact bare-arti checkout', (t) => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')

  t.ok(/git -C "\$bare_arti_source" checkout --detach "\$BARE_ARTI_SHA"/.test(workflow))
  t.ok(/test "\$\(git -C "\$bare_arti_source" rev-parse HEAD\)" = "\$BARE_ARTI_SHA"/.test(workflow))
  t.ok(/mktemp -d/.test(workflow), 'uses a fresh build directory')
  t.ok(/BARE_ARTI_TESTING:BOOL=OFF/.test(workflow), 'disables deterministic addon hooks')
  t.ok(/npm pack --json/.test(workflow))
  t.ok(/npm install --no-save --package-lock=false/.test(workflow))
  t.ok(/sourceSha/.test(workflow))
  t.ok(/runId/.test(workflow))
  t.ok(/runAttempt/.test(workflow))
  t.ok(/sha256sum/.test(workflow))
  t.ok(/node test\/verify-installed-bare-arti\.js/.test(workflow))
  t.ok(/node_modules\/\.bin\/bare test\/verify-installed-bare-arti\.js/.test(workflow))
  t.ok(/actions\/attest-build-provenance@/.test(workflow))
  t.ok(/actions\/upload-artifact@/.test(workflow))
})

test('Tor retries are descriptor-specific and never classify integrity failures as transient', (t) => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')

  t.ok(/onion service descriptor.*(?:not found|unavailable)/i.test(workflow))
  t.ok(/HSDir.*(?:unavailable|failed)/i.test(workflow))
  t.ok(/provenance\|source SHA\|SHA-256\|addon.*(?:mismatch|does not match)/.test(workflow))
  t.ok(/not retrying an integrity or addon load failure/.test(workflow))
})
