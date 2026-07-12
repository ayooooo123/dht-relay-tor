const test = require('brittle')
const fs = require('fs')
const path = require('path')

// Keep this at the already-registered workflow path so feature refs can be
// dispatched before the hardened definition reaches the default branch.
const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'tor-smoke.yml')
const readmePath = path.join(__dirname, '..', 'README.md')
const gitignorePath = path.join(__dirname, '..', '.gitignore')

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
  t.ok(/^\s*CMAKE_BARE_VERSION:\s*'1\.8\.0'\s*$/m.test(workflow))
  t.ok(/^\s*CMAKE_CARGO_VERSION:\s*'0\.0\.4'\s*$/m.test(workflow))
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
  t.is((workflow.match(/^\s*runs-on:\s*ubuntu-24\.04\s*$/gm) || []).length, 3)
  t.is((workflow.match(/^\s*timeout-minutes:\s*20\s*$/gm) || []).length, 1)
  t.ok(/embedded_arti:\n(?:.|\n)*?needs:\s*debug_addon/.test(workflow))
  t.ok(/DHT_RELAY_TOR_TEST_BACKEND:\s*tor/.test(workflow))
  t.ok(/DHT_RELAY_TOR_TEST_BACKEND:\s*arti/.test(workflow))
  t.ok(/npm ci/.test(workflow))
})

test('embedded proof rebuilds, packs, and verifies the exact bare-arti checkout', (t) => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')

  t.ok(/repository:\s*ayooooo123\/bare-arti/.test(workflow))
  t.ok(/ref:\s*\$\{\{ env\.BARE_ARTI_SHA \}\}/.test(workflow))
  t.ok(/test "\$\(git -C "\$BARE_ARTI_SOURCE" rev-parse HEAD\)" = "\$BARE_ARTI_SHA"/.test(workflow))
  t.ok(/debug_build="\$\(mktemp -d\)"/.test(workflow))
  t.ok(/release_build="\$\(mktemp -d\)"/.test(workflow))
  t.ok(/BARE_ARTI_TESTING:BOOL=ON/.test(workflow), 'enables debug-only addon hooks')
  t.ok(/CMAKE_BUILD_TYPE:STRING=Debug/.test(workflow))
  t.ok(/bare test\/addon\.js/.test(workflow))
  t.ok(/BARE_ARTI_TESTING:BOOL=OFF/.test(workflow), 'disables deterministic addon hooks')
  t.ok(/CMAKE_BUILD_TYPE:STRING=Release/.test(workflow))
  t.ok(/cmake-bare\/package\.json/.test(workflow))
  t.ok(/cmake-cargo\/package\.json/.test(workflow))
  t.ok(/require\('cmake-runtime'\)\(\)/.test(workflow))
  t.ok(/CMakeCCompiler\.cmake/.test(workflow))
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
  const torTest = fs.readFileSync(path.join(__dirname, 'tor.js'), 'utf8')

  t.ok(/node test\/classify-tor-proof-failure\.js/.test(workflow))
  t.ok(/descriptor-publication-transient/.test(workflow))
  t.absent(/grep -Eiq 'onion service descriptor/.test(workflow))
  t.ok(/TERMINAL_PREFIX/.test(torTest), 'real Tor test emits the structured terminal marker')
})

test('embedded proof publishes complete human and machine-readable evidence', (t) => {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  const gitignore = fs.readFileSync(gitignorePath, 'utf8')

  t.ok(/^\.proof\/$/m.test(gitignore), 'exact-source checkout is excluded from package checks')
  t.ok(/^evidence\/$/m.test(gitignore), 'generated evidence is excluded from package checks')
  t.ok(/^evidence-debug\/$/m.test(gitignore), 'debug evidence is excluded from package checks')
  t.ok(/GITHUB_STEP_SUMMARY/.test(workflow))
  for (const field of [
    'dht-relay-tor-sha',
    'bare-arti-sha',
    'run-id',
    'run-attempt',
    'addon-sha256',
    'tarball-sha256',
    'node',
    'npm',
    'bare',
    'rustc',
    'cargo',
    'cmake',
    'c-compiler',
    'cxx-compiler',
    'tor'
  ]) {
    t.ok(workflow.includes(field), `summary and evidence include ${field}`)
  }
})

test('README documents exact-source GitHub proof and its claim boundary', (t) => {
  const readme = fs.readFileSync(readmePath, 'utf8')

  t.ok(/exact bare-arti commit/i.test(readme))
  t.ok(/GitHub artifact attestation/i.test(readme))
  t.ok(/does not establish macOS or mobile release readiness/i.test(readme))
  t.ok(/npm install --no-save --package-lock=false/i.test(readme))
})
