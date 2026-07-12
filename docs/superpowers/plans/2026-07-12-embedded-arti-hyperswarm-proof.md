# Embedded Arti Hyperswarm Proof Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure, process-wide Arti leases and prove a Bare client can discover and exchange data with a Hyperswarm peer through embedded Arti and a real Tor v3 onion service.

**Architecture:** `bare-arti` snapshots storage fallback once, wraps its existing singleton controller with reference-counted leases, and publishes that ownership boundary through a versioned same-realm global registry so duplicate physical installs cannot stop each other. The existing native realm-conflict guard prevents simultaneous cross-realm addon ownership; JS lease reference counting is intentionally same-realm. `dht-relay-tor/arti` acquires one lease, keeps Arti-only options out of the SOCKS/SecretStream call, and exposes observable idempotent cleanup. A Node orchestrator owns the local HyperDHT testnet, relay, echo peer, and onion service while a pinned Bare child loads the real addon and performs the masked Hyperswarm exchange.

**Tech Stack:** Bare JS Runtime 1.30.3, Node.js 22/LTS, Brittle, HyperDHT, Hyperswarm, `@hyperswarm/dht-relay`, Rust 1.96.1, Arti 0.44, cmake-bare, cmake-cargo, bare-make 1.6.3, Tor v3 onion services, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-12-embedded-arti-options-design.md`

**Repositories/worktrees:**

- `bare-arti`: `/Users/jd/.config/superpowers/worktrees/bare-arti/mobile-tor-addon`
- `dht-relay-tor`: `/Users/jd/.config/superpowers/worktrees/dht-relay-tor/embedded-arti-proof`

---

## File Map

### `bare-arti`

- Create `lib/options.js`: resolve explicit/environment directory precedence and backend-specific permission policy once.
- Create `lib/ownership.js`: coordinate acquired leases with one legacy `start()/stop()` owner.
- Create `lib/registry.js`: share one versioned ownership boundary across duplicate same-realm package installs.
- Create `test/options.js`: deterministic data-directory and backend validation tests.
- Create `test/ownership.js`: process-wide lease/legacy owner race and shutdown tests.
- Create `test/public-api.js`: verify duplicate composition, wrapped legacy handles, and public exports.
- Modify `index.js`: build the normalized backend and export `acquire`, `start`, and `stop`.
- Modify `lib/addon-controller.js`: consume already-resolved addon options without rereading environment.
- Modify `lib/backend.js`: expose the selected backend through the ownership layer while retaining singleton/config matching.
- Modify `test/addon-controller.js`: cover `insecureFsPermissions: true` rejection for addon selection.
- Modify `test/backend-selection.js`: update the public export contract and preserve backend selection regressions.
- Modify `test/all.js`: include the new deterministic suites.
- Modify `README.md`: document explicit `dataDir`, `BARE_ARTI_DATA`, leases, and mobile fail-closed behavior.

### `dht-relay-tor`

- Create `lib/arti-transport.js`: injectable Arti lease/transport controller with single active transport and observable cleanup.
- Create `lib/arti-entry.js`: lazy optional-package loader with stable absence errors and initialization-error preservation.
- Create `test/arti.js`: deterministic option separation, ownership, retry, and cleanup tests.
- Create `test/lib/bare-client-runner.js`: excluded Node-only child process/result/exit protocol for the test orchestrator.
- Create `test/bare-client-runner.js`: unconditional fake-child protocol tests.
- Create `test/tor-bare-client.js`: Bare-only masked client that prints one structured result.
- Modify `arti.js`: load optional `bare-arti` and delegate to the focused controller.
- Modify `test/all.js`: include deterministic Arti entry and child-runner tests.
- Modify `test/tor.js`: retain the system-Tor control and orchestrate the Bare/Arti child when selected.
- Modify `.gitignore`: stop ignoring `package-lock.json`.
- Add `package-lock.json`: reproducible JavaScript dependencies and pinned Bare runtime.
- Modify `package.json`: add exact `bare-runtime` 1.30.3 for the proof harness.
- Modify `.github/workflows/tor-smoke.yml`: separate system-Tor control and exact-SHA embedded-Arti jobs.
- Modify `README.md`: document secure options, evidence, and remaining mobile gates.

---

## Chunk 1: Secure `bare-arti` Options and Ownership

All Chunk 1 commands run from the existing reviewed feature worktree:

```sh
cd /Users/jd/.config/superpowers/worktrees/bare-arti/mobile-tor-addon
test "$(git branch --show-current)" = "feature/mobile-tor-addon"
```

### Task 1: Resolve the data directory and backend policy once

**Files:**

- Create: `bare-arti/lib/options.js`
- Create: `bare-arti/test/options.js`
- Modify: `bare-arti/test/all.js`

- [ ] **Step 1: Write failing option-resolution tests**

Create `test/options.js` around an injected signature:

```js
const { createOptionResolver } = require('../lib/options')

const options = createOptionResolver({
  platform: 'android',
  path,
  environment: { BARE_ARTI_DATA: '/private/env-arti' }
})
const resolve = options.beginGeneration()

t.is(resolve({ dataDir: '/private/explicit' }).dataDir, '/private/explicit')
t.is(resolve({}).dataDir, '/private/env-arti')
```

Cover these independent cases:

- explicit absolute `dataDir` wins over `BARE_ARTI_DATA`;
- absent explicit value uses a valid absolute `BARE_ARTI_DATA`;
- `dataDir: ''`, non-string, or relative rejects `ERR_ARTI_CONFIG` without fallback;
- present empty or relative `BARE_ARTI_DATA` rejects without desktop fallback;
- desktop sidecar may keep `dataDir` undefined when both sources are absent;
- Android/iOS or explicit addon rejects missing directory;
- addon rejects `insecureFsPermissions: true` and accepts omitted/false;
- sidecar accepts a boolean `insecureFsPermissions` value;
- `BARE_ARTI_DATA` is snapshotted by `beginGeneration()`, after module composition but before the first start/acquire validation;
- mutating the injected environment while startup is pending or running does not change later omitted-directory resolutions for that module generation;
- after complete shutdown, a new `beginGeneration()` reads the current environment value;
- invalid option objects and backend names retain `ERR_ARTI_CONFIG`, including `''`, `null`, `false`, and arbitrary strings.

Add `require('./options')` to `test/all.js`.

- [ ] **Step 2: Run RED**

Run:

```sh
node test/options.js
```

Expected: FAIL with `Cannot find module '../lib/options'`.

- [ ] **Step 3: Implement the minimal resolver**

Create `lib/options.js` with:

```js
const { artiError } = require('./errors')

function config(message) {
  return artiError('ERR_ARTI_CONFIG', message)
}

function createOptionResolver({ platform, path, environment }) {
  function beginGeneration() {
    const environmentDataDir = environment.BARE_ARTI_DATA

    return function resolveOptions(options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw config('Options must be an object')
      }

      const mobile = platform === 'android' || platform === 'ios'
      const backend =
        options.backend === undefined ? (mobile ? 'addon' : 'sidecar') : options.backend
      if (backend !== 'addon' && backend !== 'sidecar')
        throw config('backend must be addon or sidecar')

      const source = options.dataDir !== undefined ? options.dataDir : environmentDataDir
      if (
        source !== undefined &&
        (typeof source !== 'string' || source.length === 0 || !path.isAbsolute(source))
      ) {
        throw config('dataDir must be a non-empty absolute path')
      }
      if (backend === 'addon' && source === undefined)
        throw config('dataDir is required for the addon backend')
      if (backend === 'addon' && options.insecureFsPermissions === true) {
        throw config('insecureFsPermissions is not supported by the addon backend')
      }
      if (
        options.insecureFsPermissions !== undefined &&
        typeof options.insecureFsPermissions !== 'boolean'
      ) {
        throw config('insecureFsPermissions must be a boolean')
      }

      return Object.freeze({ ...options, backend, dataDir: source })
    }
  }

  return { beginGeneration }
}

module.exports = { createOptionResolver }
```

Keep timeout range/canonical filesystem validation in `validateAddonOptions()`; this resolver owns only precedence, absence, type/path shape, and backend-specific permission policy.

- [ ] **Step 4: Run GREEN and regressions**

Run:

```sh
node test/options.js
npm test
```

Expected: new tests pass; full JS suite remains green.

- [ ] **Step 5: Commit**

```sh
git add lib/options.js test/options.js test/all.js
git commit -m "feat: resolve secure Arti backend options"
```

### Task 2: Add process-wide acquired leases

**Files:**

- Create: `bare-arti/lib/ownership.js`
- Create: `bare-arti/test/ownership.js`
- Modify: `bare-arti/test/all.js`

- [ ] **Step 1: Write failing ownership tests**

Define the desired constructor:

```js
const ownership = createOwnership({
  startBackend,
  stopBackend,
  beginOptionsGeneration
})
```

Test with controllable backend promises that:

- two matching `acquire()` calls return distinct leases but start once;
- releasing one lease keeps the backend running;
- final release stops once and matching releases share the stop operation;
- each lease release is idempotent;
- a legacy `start()` owner survives release of every acquired lease;
- acquired leases survive legacy `stop()`;
- final owner across both ownership types performs the only native stop;
- repeated matching legacy `start()` calls share the exact stored promise and count as one owner;
- matching pending/running and canonical-equivalent legacy requests share the exact public promise, while conflicting pending/running requests reject without changing ownership;
- the frozen public legacy service exposes exactly `backend`, `port`, and an ownership-wrapped `stop`, never the backend-native `stop`;
- exported `stop()` and `legacyHandle.stop()` release only the legacy owner, and repeated handle stops are idempotent;
- conflicting acquired or legacy configuration rejects `ERR_ARTI_CONFIG_CONFLICT` through the backend;
- pending acquisitions reserve ownership so an existing final release cannot stop underneath them;
- failed acquisition removes its reservation and permits retry;
- exported `stop()` during a pending legacy start releases that owner, initiates exactly one backend stop when no acquired reservation exists, and preserves the pending start's `ERR_ARTI_CANCELLED` rejection;
- an acquired lease/reservation prevents pending legacy stop from shutting down the backend; retry rejects during final stopping and succeeds after it settles with no stale legacy/reservation state;
- start during final stopping rejects `ERR_ARTI_CANCELLED` until stop settles;
- backend stop rejection is retained as terminal `ERR_ARTI_SHUTDOWN`.
- every lease is frozen with exact keys `backend`, `port`, and `release`; backend-native `stop` never escapes;
- repeated calls to one lease's `release()` return its same stored promise, while only the transition to zero total owners invokes the shared backend-stop promise.

- [ ] **Step 2: Run RED**

Run:

```sh
node test/ownership.js
```

Expected: FAIL with `Cannot find module '../lib/ownership'`.

- [ ] **Step 3: Implement ownership with reservations**

`createOwnership()` maintains:

```js
{
  legacy: false,
  legacyStarting: null,
  backendStarting: null,
  legacyService: null,
  resolveGeneration: null,
  leases: Set,
  pendingAcquisitions: 0,
  stopping: null,
  terminalError: null
}
```

Rules:

- call `beginOptionsGeneration()` only when the first owner/reservation for a new generation arrives, store its resolver, and clear it only after final shutdown or failed empty generation;
- normalize every request through the stored generation resolver before calling the backend;
- set `pendingAcquisitions++` before awaiting backend start;
- convert one successful reservation into one unique frozen lease;
- `release()` deletes only its own token and calls `maybeStop()`;
- legacy `start()` normalizes every request and calls `startBackend()` so the backend remains authoritative for canonical matching/conflicts;
- when `startBackend()` returns the stored backend operation, return the exact stored public wrapper promise; propagate a distinct conflicting rejection without changing the legacy owner;
- resolve the first legacy start to one frozen public service whose `stop()` delegates to ownership `stop()`, retaining the backend handle only internally;
- legacy `start()` sets one boolean owner before starting and clears it on rejection;
- legacy `stop()` releases only the legacy boolean;
- `maybeStop()` calls the backend only when legacy is false, no leases exist, and no acquisition is pending;
- store/share the final stop promise and do not allow restart until it settles;
- map unexpected stop failures to `ERR_ARTI_SHUTDOWN` and retain the terminal state.

Return `{ acquire, start, stop }`.

- [ ] **Step 4: Run GREEN and stress repetition**

Run:

```sh
node test/ownership.js
for i in 1 2 3 4 5; do node test/ownership.js || exit 1; done
npm test
```

Expected: all ownership tests pass five consecutive runs and full JS tests remain green.

- [ ] **Step 5: Commit**

```sh
git add lib/ownership.js test/ownership.js test/all.js
git commit -m "feat: coordinate process-wide Arti leases"
```

### Task 3: Wire normalization and leases into the public module

**Files:**

- Create: `bare-arti/lib/registry.js`
- Create: `bare-arti/test/public-api.js`
- Modify: `bare-arti/index.js`
- Modify: `bare-arti/lib/addon-controller.js`
- Modify: `bare-arti/lib/backend.js`
- Modify: `bare-arti/test/addon-controller.js`
- Modify: `bare-arti/test/backend-selection.js`
- Modify: `bare-arti/test/all.js`
- Modify: `bare-arti/README.md`

- [ ] **Step 1: Write failing public-contract tests**

Update/add tests proving:

```js
t.alike(Object.keys(require('..')).sort(), ['acquire', 'start', 'stop'])
```

Also prove the real public composition:

- resolves `BARE_ARTI_DATA` once before addon matching;
- addon receives canonical explicit/fallback `dataDir`;
- addon rejects `insecureFsPermissions: true` before native start;
- desktop sidecar retains no-directory default;
- public `acquire()` returns distinct leases around one backend service;
- public legacy `start()/stop()` remains backward compatible;
- two independently composed public modules with separate backend factories and one injected global object resolve the exact same ownership instance, and only the first backend factory is used;
- an incompatible registry record rejects `ERR_ARTI_CONFIG_CONFLICT`;
- setting the environment after module composition but before first ownership starts is observed, mutation during that generation is ignored, and mutation after complete shutdown is observed by the next generation;
- addon cross-realm attempts remain governed by the existing native `ERR_ARTI_REALM_CONFLICT` path rather than JS lease counting.

- [ ] **Step 2: Run RED**

Run:

```sh
node test/public-api.js
node test/backend-selection.js
```

Expected: FAIL because `acquire`/the registry are not composed and the new public contract is absent.

- [ ] **Step 3: Compose the public API**

In `index.js`:

```js
const { createOptionResolver } = require('./lib/options')
const { createOwnership } = require('./lib/ownership')
const { getRegisteredOwnership } = require('./lib/registry')

const options = createOptionResolver({
  platform: process.platform,
  path,
  environment: process.env
})
const ownership = getRegisteredOwnership({
  global: globalThis,
  version: 1,
  create: () =>
    createOwnership({
      startBackend: backend.start,
      stopBackend: backend.stop,
      beginOptionsGeneration: options.beginGeneration
    })
})

module.exports = {
  acquire: ownership.acquire,
  start: ownership.start,
  stop: ownership.stop
}
```

Add `require('./public-api')` to `test/all.js`.

`lib/registry.js` uses the stable same-realm key
`Symbol.for('bare-arti.ownership')` and stores a frozen `{ version, ownership }`
record as a non-configurable global property. An existing record with another
version rejects `ERR_ARTI_CONFIG_CONFLICT`. A duplicate physical package copy in
the same realm reuses the existing ownership/backend boundary rather than its
newly constructed backend. Do not describe this JS registry as worker-realm
reference counting; the native addon continues to reject incompatible realm
ownership.

Pass the frozen normalized addon object into existing canonical filesystem validation. Do not read environment inside `validateAddonOptions()`. Preserve existing addon-controller promise identity, generation, timeout, and realm behavior.

- [ ] **Step 4: Document the contract**

Document:

- explicit absolute `dataDir` and `BARE_ARTI_DATA` precedence;
- mobile missing-directory failure;
- sidecar-only `insecureFsPermissions: true`;
- `acquire()` lease semantics and legacy compatibility;
- app-private semantics remain the mobile host's responsibility.

- [ ] **Step 5: Run the full `bare-arti` gate**

Run:

```sh
npm test
cargo test --locked --all-targets
cargo test --manifest-path addon/Cargo.toml --locked
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --manifest-path addon/Cargo.toml --locked -- -D warnings
node_modules/.bin/bare test/addon.js
git diff --check
```

Expected: JS, Rust core, Rust addon ABI, clippy, and real host Bare addon lifecycle suites all pass.

- [ ] **Step 6: Commit**

```sh
git add index.js lib/registry.js lib/addon-controller.js lib/backend.js test/public-api.js test/addon-controller.js test/backend-selection.js test/all.js README.md
git commit -m "feat: expose secure Arti acquisition leases"
```

- [ ] **Step 7: Push and record the literal source SHA**

```sh
git push origin feature/mobile-tor-addon
git rev-parse HEAD
```

Expected: `feature/mobile-tor-addon` is pushed. Record the full 40-character SHA as `BARE_ARTI_SHA`; Task 7 must insert this literal value into the cross-repository workflow.

---

## Chunk 2: `dht-relay-tor` Integration Contract

All Chunk 2 commands run from the isolated transport worktree with the known
Node 22 toolchain:

```sh
cd /Users/jd/.config/superpowers/worktrees/dht-relay-tor/embedded-arti-proof
test "$(git branch --show-current)" = "feature/embedded-arti-proof"
export PATH="/Users/jd/.nvm/versions/node/v22.19.0/bin:$PATH"
node --version
npm --version
```

### Task 4: Forward secure Arti options without polluting transport options

**Files:**

- Create: `dht-relay-tor/lib/arti-transport.js`
- Create: `dht-relay-tor/lib/arti-entry.js`
- Create: `dht-relay-tor/test/arti.js`
- Modify: `dht-relay-tor/arti.js`
- Modify: `dht-relay-tor/test/all.js`

- [ ] **Step 1: Write failing option-boundary tests**

Create an injected controller:

```js
const controller = createArtiTransport({ arti, Stream })
const stream = await controller.connect({
  onion: 'example.onion',
  port: 18080,
  dataDir: '/private/peartube/arti',
  artiBackend: 'addon',
  bootstrapTimeout: 600000,
  timeout: 30000
})
```

Assert `arti.acquire()` receives exactly:

```js
{
  backend: 'addon',
  dataDir: '/private/peartube/arti',
  timeout: 600000
}
```

Assert `Stream.connect()` receives onion/port/transport timeout plus forced `proxyHost: '127.0.0.1'` and the lease port, but never `dataDir`, `artiBackend`, `bootstrapTimeout`, or `insecureFsPermissions`.

Add separate failing tests for:

- `insecureFsPermissions` forwarded only to `arti.acquire()`;
- `proxyHost` or `proxyPort` rejects `ERR_ARTI_CONFIG` before acquisition;
- second starting/active connection rejects `ERR_ARTI_CONFIG_CONFLICT`;
- acquisition rejection clears ownership and allows retry.

Test proxy override presence with `Object.hasOwn()`: both defined values and
explicit `{ proxyHost: undefined }` / `{ proxyPort: undefined }` reject because
the caller supplied an override.

Create separate lazy-entry tests around:

```js
const entry = createArtiEntry({ loadArti, Stream })
```

Prove:

- creating/requiring the entry does not load the optional package;
- a top-level module-not-found error attributable specifically to the
  `bare-arti` request maps to `ERR_ARTI_NOT_INSTALLED`;
- failed loading is not cached and a later call retries;
- one successful lazy load constructs and caches exactly one
  `createArtiTransport({ arti, Stream })` controller for the entry lifetime;
- two concurrent public `entry.connect()` calls delegate to that one controller
  and the second rejects `ERR_ARTI_CONFIG_CONFLICT`;
- the public guard remains active after the first connection succeeds, cleanup
  permits a later connection, and successful loading/controller composition
  still occurs exactly once;
- errors thrown while initializing an installed `bare-arti`, including
  documented Arti errors, propagate unchanged rather than being mislabeled as
  absence.

Add `require('./arti')` to `test/all.js`.

- [ ] **Step 2: Run RED**

Run:

```sh
node test/arti.js
```

Expected: FAIL with missing `lib/arti-transport` / `lib/arti-entry` modules.

- [ ] **Step 3: Implement minimal option separation**

`lib/arti-transport.js` exports `createArtiTransport({ arti, Stream })`. Destructure Arti-only keys, reject proxy overrides by own-property presence, omit undefined Arti keys, call `arti.acquire()`, and force the returned loopback SOCKS endpoint into `Stream.connect()`.

`lib/arti-entry.js` exports `createArtiEntry({ loadArti, Stream })`. On the first
successful `connect()`, it lazily loads Arti and constructs exactly one cached
`createArtiTransport({ arti, Stream })`; every later call delegates to that same
controller. Failed loads are not cached and may retry. It maps only a
module-not-found error whose missing request is the top-level `bare-arti`
package to `ERR_ARTI_NOT_INSTALLED` and preserves
initialization/nested-dependency errors. `arti.js` composes this entry and
contains no lifecycle logic.

- [ ] **Step 4: Run GREEN**

Run:

```sh
node test/arti.js
npm test
```

Expected: new unit tests and all existing transport tests pass.

- [ ] **Step 5: Commit**

```sh
git add lib/arti-transport.js lib/arti-entry.js test/arti.js arti.js test/all.js
git commit -m "feat: forward secure embedded Arti options"
```

### Task 5: Make lease cleanup idempotent and observable

**Files:**

- Modify: `dht-relay-tor/lib/arti-transport.js`
- Modify: `dht-relay-tor/test/arti.js`

- [ ] **Step 1: Write failing lifecycle tests**

Use a fake EventEmitter-compatible stream and controllable `lease.release()` promise. Prove:

- connection failure awaits release before rejecting;
- connection failure preserves its error when release succeeds;
- release failure surfaces `ERR_ARTI_SHUTDOWN` with the connection error as cause;
- successful stream exposes one `artiStopped` promise;
- `close` twice calls release once;
- `error` destroys the stream and calls release once even when `close` follows;
- rejected automatic cleanup emits no `unhandledRejection` event while the original `artiStopped` promise remains awaitable and rejects `ERR_ARTI_SHUTDOWN`;
- ownership clears only after release settles;
- a later connect succeeds after cleanup but not during cleanup.

- [ ] **Step 2: Run RED**

Run:

```sh
node test/arti.js
```

Expected: FAIL on missing `artiStopped` and duplicate/early release behavior.

- [ ] **Step 3: Implement one cleanup deferred**

Create one deferred per successful stream. `stopOnce()` memoizes `Promise.resolve(lease.release())`, connects it to the deferred, and clears module ownership only in `finally`. Attach `artiStopped.catch(() => {})` immediately, then expose the original promise on the stream. Treat `error` as terminal by destroying the stream before invoking `stopOnce()`. In the rejection test, install a temporary `process.on('unhandledRejection')` observer, reject release, advance at least one event-loop turn, assert the observer was not called, remove it in teardown, and separately await the original rejection.

- [ ] **Step 4: Run GREEN and stress**

Run:

```sh
node test/arti.js
for i in 1 2 3 4 5; do node test/arti.js || exit 1; done
npm test
git diff --check
```

Expected: lifecycle tests pass five consecutive times with no unhandled rejection output.

- [ ] **Step 5: Commit**

```sh
git add lib/arti-transport.js test/arti.js
git commit -m "fix: make embedded Arti cleanup observable"
```

### Task 6: Commit reproducible JavaScript dependencies and documentation

**Files:**

- Modify: `dht-relay-tor/.gitignore`
- Modify: `dht-relay-tor/package.json`
- Add: `dht-relay-tor/package-lock.json`
- Modify: `dht-relay-tor/README.md`

- [ ] **Step 1: Stop ignoring the lockfile and pin the harness runtime**

Remove `package-lock.json` from `.gitignore`. Add exact dev dependency:

```json
"bare-runtime": "1.30.3"
```

Do not change runtime dependencies.

- [ ] **Step 2: Generate and verify the lockfile**

Run:

```sh
npm install
npm ci
npm ls bare-runtime hyperdht hyperswarm @hyperswarm/dht-relay
```

Expected: clean install succeeds and Bare resolves exactly `1.30.3`.

- [ ] **Step 3: Document the PearTube call shape and claims**

Add the approved example with explicit app-private `dataDir` and `artiBackend: 'addon'`. Document `BARE_ARTI_DATA` fallback, mobile fail-closed behavior, rejected proxy overrides, `stream.artiStopped`, and that a green relay loopback assertion is not a whole-process leak audit.

- [ ] **Step 4: Run package verification**

Run:

```sh
npm test
npm pack --dry-run --json > /private/tmp/dht-relay-tor-pack.json
node -e "const f=require('/private/tmp/dht-relay-tor-pack.json')[0].files.map(x=>x.path);if(!f.includes('arti.js')||!f.includes('lib/arti-transport.js')||!f.includes('lib/arti-entry.js')||f.some(x=>x.startsWith('test/')||x.startsWith('build')||x.includes('node_modules')))process.exit(1)"
git diff --check
```

Expected: tests pass; package includes `arti.js` and `lib/arti-transport.js`, excludes tests, `node_modules`, and local build output.

- [ ] **Step 5: Commit**

```sh
git add .gitignore package.json package-lock.json README.md
git commit -m "build: lock embedded Arti proof dependencies"
```

---

## Chunk 3: Real Bare Addon + Tor + Hyperswarm Proof

### Task 7: Split the real-network proof into Node orchestration and a Bare client

**Files:**

- Create: `dht-relay-tor/test/lib/bare-client-runner.js`
- Create: `dht-relay-tor/test/bare-client-runner.js`
- Create: `dht-relay-tor/test/tor-bare-client.js`
- Modify: `dht-relay-tor/test/tor.js`
- Modify: `dht-relay-tor/test/all.js`

- [ ] **Step 1: Write the Bare child contract first**

`test/tor-bare-client.js` accepts one JSON argument containing:

```js
{
  onion: '56-character-address.onion',
  onionPort: 18080,
  bootstrap: [{ host: '127.0.0.1', port: 49152 }],
  topicHex: '64-lowercase-hex-characters',
  dataDir: '/absolute/private/arti'
}
```

Validate the onion format, TCP port, nonempty bootstrap host/port entries,
32-byte topic hex, and absolute `dataDir` before network work. The child calls
`require('../arti').connect()` with `artiBackend: 'addon'`, constructs
`RelayedDHT` and `Hyperswarm`, joins the topic client-only, and exchanges
`tor-proof`.

Success teardown order is exact: retain the reply; destroy `clientSwarm` (or
`clientDHT` if swarm creation failed); destroy the transport stream so cleanup
starts; await the original `stream.artiStopped`; then print exactly one prefixed
result and exit normally:

```js
console.log('DHT_RELAY_TOR_RESULT ' + JSON.stringify({ reply }))
```

The result also includes the Bare child's own resolved `bare-arti` path and
verified provenance source SHA. On error it completes the same bounded teardown,
writes one prefixed structured error to stderr, and sets a nonzero exit code.

- [ ] **Step 2: Add an orchestrator contract test without Tor**

Create `test/lib/bare-client-runner.js` around injected `spawn`, timers, and a maximum
64 KiB per stdout/stderr buffer. It resolves only after exactly one valid result
record and confirmed normal exit code 0. It kills on timeout and awaits confirmed
child exit before rejecting.

`test/bare-client-runner.js` uses temporary fake children to cover valid result +
zero exit, malformed output, no result, result then nonzero exit, result then
hang, duplicate results, buffer overflow, timeout termination/reaping, and spawn
error. Add `require('./bare-client-runner')` unconditionally to `test/all.js`.

- [ ] **Step 3: Run RED**

Run:

```sh
node test/bare-client-runner.js
```

Expected: FAIL with `Cannot find module './lib/bare-client-runner'`.

- [ ] **Step 4: Implement the two-process harness**

Keep the current Node-owned testnet, echo swarm, relay DHT, TCP relay, and system-Tor v3 onion host. For `DHT_RELAY_TOR_TEST_BACKEND=arti`:

- create a separate `0700` Arti directory;
- spawn `node_modules/.bin/bare test/tor-bare-client.js <json>` through the
  bounded runner;
- pass the testnet bootstrap array and exact topic;
- require the structured reply to equal `echo:tor-proof`;
- require exactly one result, cleanup-before-result, exit code 0, and the expected
  installed source SHA/path;
- preserve the existing loopback relay assertion;
- kill and reap a timed-out child before closing system Tor/testnet resources.

Use separate deadlines: system-Tor bootstrap 600 seconds, Arti child bootstrap
720 seconds, exchange 120 seconds, child cleanup 30 seconds, and an outer Brittle
timeout of 1,500 seconds. The workflow timeout is 30 minutes, leaving a cleanup
reserve above the 25-minute test bound.

The existing system-Tor path remains unchanged as the control.

- [ ] **Step 5: Run deterministic regressions**

Run:

```sh
npm test
```

Expected: deterministic suite passes without requiring Tor.

- [ ] **Step 6: Commit**

```sh
git add test/lib/bare-client-runner.js test/bare-client-runner.js test/tor-bare-client.js test/tor.js test/all.js
git commit -m "test: orchestrate embedded Arti from Bare"
```

### Task 8: Prove the host addon against a real onion locally

**Files:** none expected; this is a verification task.

- [ ] **Step 1: Build a production host addon from the recorded `BARE_ARTI_SHA`**

Use the literal `BARE_ARTI_SHA` recorded in Task 3 and assert the exact clean
source before building. Build from a fresh Release directory that cannot inherit
debug hooks:

```sh
cd /Users/jd/.config/superpowers/worktrees/bare-arti/mobile-tor-addon
export BARE_ARTI_SHA=<literal SHA recorded in Task 3>
test "$(git rev-parse HEAD)" = "$BARE_ARTI_SHA"
test -z "$(git status --short)"
unset BARE_ARTI_TESTING
export BARE_ARTI_REAL_CARGO="$(command -v cargo)"
export PATH="$PWD/scripts/locked-bin:$PATH"
export CMAKE_PROGRAM_PATH="$PWD/scripts/locked-bin"
export PROOF_BUILD="/private/tmp/bare-arti-release-$BARE_ARTI_SHA"
test ! -e "$PROOF_BUILD"
npx --no-install bare-make generate --build "$PROOF_BUILD" --define CMAKE_PROGRAM_PATH:PATH="$PWD/scripts/locked-bin"
grep -Fx 'BARE_ARTI_TESTING:BOOL=OFF' "$PROOF_BUILD/CMakeCache.txt"
grep -Fx 'CMAKE_BUILD_TYPE:STRING=Release' "$PROOF_BUILD/CMakeCache.txt"
npx --no-install bare-make build --build "$PROOF_BUILD"
npx --no-install bare-make install --build "$PROOF_BUILD" --prefix prebuilds --strip
```

Expected: host `prebuilds/<platform>-<arch>/bare-arti.bare` exists and no test hooks are enabled.

- [ ] **Step 2: Install/link the exact local package into `dht-relay-tor`**

Generate shipped provenance before packing. It contains source SHA, local run
identity, target, and SHA-256 of the production addon. Pack the asserted source,
record the tarball SHA-256, return explicitly to the transport worktree, install
without changing its lockfile, and verify the installed path/provenance/addon
hash:

```sh
export PROOF_ADDON="prebuilds/darwin-arm64/bare-arti.bare"
export PROOF_ADDON_SHA="$(shasum -a 256 "$PROOF_ADDON" | awk '{print $1}')"
node -e "const f=require('fs');f.writeFileSync('prebuilds/provenance.json',JSON.stringify({sourceSha:process.env.BARE_ARTI_SHA,runId:'local',runAttempt:'1',target:'darwin-arm64',addon:'prebuilds/darwin-arm64/bare-arti.bare',sha256:process.env.PROOF_ADDON_SHA})+'\n')"
npm pack --json --pack-destination /private/tmp > /private/tmp/bare-arti-pack.json
export BARE_ARTI_TARBALL="/private/tmp/$(node -e "process.stdout.write(require('/private/tmp/bare-arti-pack.json')[0].filename)")"
shasum -a 256 "$BARE_ARTI_TARBALL" > /private/tmp/bare-arti-tarball.sha256
cd /Users/jd/.config/superpowers/worktrees/dht-relay-tor/embedded-arti-proof
npm ci
npm install --no-save --package-lock=false "$BARE_ARTI_TARBALL"
node -e "const f=require('fs'),c=require('crypto'),p=require('./node_modules/bare-arti/prebuilds/provenance.json'),a='./node_modules/bare-arti/'+p.addon,h=c.createHash('sha256').update(f.readFileSync(a)).digest('hex');if(p.sourceSha!==process.env.BARE_ARTI_SHA||h!==p.sha256)process.exit(1);console.log(require.resolve('bare-arti'),p.sourceSha,h)"
```

Expected: resolution points inside the isolated proof worktree's installed
package; provenance source/hash and installed addon hash match the asserted
checkout. The Bare child must later report the same resolved package and source
SHA.

- [ ] **Step 3: Run the real embedded-Arti smoke**

```sh
DHT_RELAY_TOR_TEST_TOR=1 \
DHT_RELAY_TOR_TEST_BACKEND=arti \
TOR_BIN=/opt/homebrew/bin/tor \
npm test
```

Expected within 25 minutes:

- Arti addon bootstraps through public Tor egress;
- Bare client discovers the Hyperswarm echo server by topic;
- reply equals `echo:tor-proof`;
- relay socket source is loopback;
- teardown exits cleanly.

- [ ] **Step 4: Re-run the system-Tor control**

```sh
DHT_RELAY_TOR_TEST_TOR=1 TOR_BIN=/opt/homebrew/bin/tor npm test
```

Expected: existing system-Tor Hyperswarm proof remains green.

### Task 9: Make the exact-source proof GitHub-native

**Files:**

- Modify: `dht-relay-tor/.github/workflows/tor-smoke.yml`
- Modify: `dht-relay-tor/README.md`

- [ ] **Step 1: Extend the manual workflow with two jobs**

Retain `workflow_dispatch` and `contents: read`. Define:

- `system-tor`: current control using `npm ci`;
- `embedded-arti`: `ubuntu-24.04`, Node 22.19.0, Bare 1.30.3 from the lockfile, Rust 1.96.1, Tor package, bare-make 1.6.3, cmake-runtime 4.3.1, and a 30-minute timeout.

Every `uses:` entry—including checkout, setup, download, and
`actions/upload-artifact` for provenance—must use an immutable full 40-character
commit SHA with the human-readable release version in a comment. Reject any
floating action reference during review. Assert lockfile
versions `bare-runtime@1.30.3`, `bare-make@1.6.3`, `cmake-bare@1.8.0`,
`cmake-cargo@0.0.4`, and `cmake-runtime@4.3.1`; run the locked CMake binary's
`--version`. Record Tor/compiler versions because the Ubuntu package versions
are not controlled by npm/Cargo locks.

- [ ] **Step 2: Pin the exact `bare-arti` source**

Insert the literal full `BARE_ARTI_SHA` recorded in Task 3 into an environment key:

```yaml
env:
  BARE_ARTI_SHA: <literal 40-character SHA recorded in Task 3>
```

The workflow must fetch that SHA directly, detach checkout at it, assert `git rev-parse HEAD` equals the literal, and never use a floating branch or tag.

- [ ] **Step 3: Build/package/install the exact host addon**

In the embedded job:

1. check out `dht-relay-tor` at the workflow SHA;
2. use a second immutable `actions/checkout` step for `ayooooo123/bare-arti` at
   literal `BARE_ARTI_SHA`, then assert detached `HEAD` equals it;
3. run `npm ci` in both repositories;
4. configure a distinct Debug tree with `--debug` and
   `BARE_ARTI_TESTING:BOOL=ON`, assert both cache values, build/install it, and
   run `test/addon.js` only against this debug artifact;
5. configure a fresh distinct Release tree without test hooks, assert
   `CMAKE_BUILD_TYPE:STRING=Release` and `BARE_ARTI_TESTING:BOOL=OFF`, then build
   and install the production Linux x64 addon with `scripts/locked-bin/cargo`
   enforcing `--locked`;
6. generate `bare-arti/prebuilds/provenance.json` containing `BARE_ARTI_SHA`,
   `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `linux-x64`, the addon relative path,
   and its SHA-256;
7. `npm pack --json` that asserted checkout, record the tarball SHA-256, and
   install it into `dht-relay-tor` with `--no-save --package-lock=false`;
8. verify the installed provenance source SHA and installed addon SHA-256, and
   assert Node resolution points inside the installed tarball;
9. run the Arti smoke with separate `0700` Tor and Arti directories; require the
   Bare child's reported `require.resolve('bare-arti')` and provenance SHA to
   match the installed package;
10. upload the provenance JSON and tarball SHA-256 as an audit artifact.

Write both repository SHAs, workflow run/attempt, addon/tarball hashes, and Node,
npm, Bare, Rust, Cargo, CMake, compiler, and Tor versions to
`$GITHUB_STEP_SUMMARY`.

- [ ] **Step 4: Validate workflow syntax and regressions**

Run:

```sh
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/tor-smoke.yml')"
npm ci
npm test
npm pack --dry-run --json > /private/tmp/dht-relay-tor-final-pack.json
node -e "const f=require('/private/tmp/dht-relay-tor-final-pack.json')[0].files.map(x=>x.path);if(f.some(x=>x.startsWith('test/')||x.includes('bare-client-runner')))process.exit(1)"
test -z "$(rg '^\s*uses:\s+[^#\n]*@(?![0-9a-f]{40})(\S+)' .github/workflows/tor-smoke.yml --pcre2 || true)"
git diff --check
```

Expected: YAML parses; clean install and deterministic suite pass.

- [ ] **Step 5: Commit**

```sh
git add .github/workflows/tor-smoke.yml README.md
git commit -m "ci: prove Hyperswarm through embedded Arti"
```

### Task 10: Exact-head CI and evidence audit

**Files:** none expected unless CI exposes a defect.

- [ ] **Step 1: Run final local verification in both repositories**

`bare-arti`:

```sh
npm ci
npm test
cargo test --locked --all-targets
cargo test --manifest-path addon/Cargo.toml --locked
git diff --check
git status --short
```

Do not run `test/addon.js` against the installed production prebuild; it requires
the distinct Debug `BARE_ARTI_TESTING=ON` artifact already verified in Task 3 and
again in the GitHub embedded job. The production-safe runtime gate is Task 8's
real onion bootstrap/exchange/cleanup proof.

`dht-relay-tor`:

```sh
npm ci
npm test
git diff --check
git status --short
```

Expected: all suites pass and both worktrees contain only intentional commits.

- [ ] **Step 2: Request two-stage review**

Use @requesting-code-review for:

1. spec compliance across both repositories;
2. code quality/security review, especially lease races, cleanup rejection handling, exact-SHA resolution, and privacy-claim wording.

Fix Critical/Important findings with tests first and repeat review until approved.

- [ ] **Step 3: Push the `dht-relay-tor` feature branch**

```sh
git push -u origin feature/embedded-arti-proof
git rev-parse HEAD
```

Record the exact head SHA.

- [ ] **Step 4: Dispatch and watch the manual Tor smoke workflow**

```sh
gh workflow run tor-smoke.yml --repo ayooooo123/dht-relay-tor --ref feature/embedded-arti-proof
gh run list --repo ayooooo123/dht-relay-tor --workflow tor-smoke.yml --branch feature/embedded-arti-proof --json databaseId,headSha,status,conclusion,url
gh run watch <exact-run-id> --repo ayooooo123/dht-relay-tor --exit-status
```

Accept only a run whose `headSha` exactly equals the pushed feature head.

- [ ] **Step 5: Audit the successful logs**

Confirm the embedded job log records:

- exact `dht-relay-tor` and `bare-arti` SHAs;
- pinned tool versions;
- production addon build/load;
- Bare child structured `echo:tor-proof` result;
- loopback relay assertion;
- successful cleanup.

Do not claim process-wide or mobile IP-leak protection from this host proof.

- [ ] **Step 6: Update the project plan**

Mark the embedded-Arti host Hyperswarm proof complete. Create a separate implementation plan for Android emulator/iOS Simulator/physical-device BareKit loading and process-scoped socket audits; those remain required before the PearTube Tor switch can claim mobile privacy.
