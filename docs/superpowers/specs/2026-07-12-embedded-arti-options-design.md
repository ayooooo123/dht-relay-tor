# Embedded Arti Options and Hyperswarm Proof Design

## Goal

Make `dht-relay-tor/arti` usable as the privacy transport behind a simple
PearTube Tor switch while preserving a secure mobile storage boundary. Prove
that the embedded Arti client can discover and exchange data with a Hyperswarm
peer through the existing relayed DHT and a real Tor v3 onion service.

This design extends the already-green system-Tor Hyperswarm smoke test. It does
not claim mobile runtime support from cross-compilation alone; Android emulator,
iOS Simulator, and physical-device network audits remain separate release
gates.

## Constraints

- PearTube must be able to provide an absolute app-private data directory.
- A caller that omits `dataDir` may use `BARE_ARTI_DATA` as the portable
  fallback.
- Desktop keeps the existing sidecar backend's OS-default directory behavior.
- Mobile must fail closed when neither an explicit directory nor
  `BARE_ARTI_DATA` is available. The transport must not guess with `cwd`, `/tmp`,
  or shared storage.
- The external API remains runtime-agnostic and uses Holepunch style.
- Tor bootstrap and public-network reachability remain opt-in tests.

## Public API

`dht-relay-tor/arti.connect(options)` continues to accept all existing transport
options and adds these Arti-specific inputs:

- `dataDir`: absolute app-private Arti state/cache directory.
- `artiBackend`: optional `addon` or `sidecar` selector. This name avoids
  confusing a transport backend with a Tor implementation.
- `bootstrapTimeout`: Arti startup timeout.
- `insecureFsPermissions`: existing container escape hatch for Arti's
  `fs-mistrust` checks.

The transport passes a new object to `bare-arti.acquire()`:

```js
{
  backend: options.artiBackend,
  dataDir: options.dataDir,
  timeout: options.bootstrapTimeout,
  insecureFsPermissions: options.insecureFsPermissions
}
```

Undefined fields are omitted. Arti-specific inputs are removed before calling
`Stream.connect()` so they cannot leak into SecretStream or SOCKS options.
Caller-supplied `proxyHost` and `proxyPort` are rejected by the Arti entry: its
SOCKS endpoint is always forced to `127.0.0.1` and the port returned by
`bare-arti`. Either override rejects `ERR_ARTI_CONFIG`.

The preferred PearTube call shape is:

```js
await connect({
  onion,
  dataDir: absoluteAppPrivateDirectory,
  artiBackend: 'addon'
})
```

PearTube's platform adapter owns the directory choice. The user-facing setting
can still be one switch because the adapter supplies this value internally.

## Directory Resolution

`bare-arti`, not `dht-relay-tor`, owns state-directory policy because all Arti
consumers need the same validation.

Resolution order:

1. An explicit `options.dataDir`.
2. A present `BARE_ARTI_DATA` value.
3. On desktop sidecar only, the existing sidecar default.
4. Otherwise reject with `ERR_ARTI_CONFIG`.

Only `undefined` means absent. An explicit empty, non-string, or relative
`dataDir` rejects instead of falling through. A present but empty or relative
`BARE_ARTI_DATA` also rejects instead of falling through. The outer
`bare-arti.start()` or `bare-arti.acquire()` boundary resolves the source once
into an immutable
configuration used for backend selection, conflict matching, and addon
validation; repeated matching never rereads a mutable environment.

The resolved addon directory is still canonicalized and validated by
`validateAddonOptions()`: it must be absolute, a directory, owner-only where the
runtime exposes permission metadata, owned by the current user where UID data
exists, and not a final symlink on Android or iOS. `insecureFsPermissions` is
accepted only as `false` by the addon path; `true` rejects `ERR_ARTI_CONFIG`. It
remains a documented sidecar/container option and must not weaken mobile addon
validation. Backend-specific validation happens inside `bare-arti` after
selection, so an omitted backend is still validated correctly when desktop
selects sidecar or mobile selects addon.

These filesystem checks establish path, ownership, mode, and symlink
invariants. They cannot prove that an arbitrary absolute path is semantically
app-private. PearTube's platform adapter owns that guarantee.

No code mutates `process.env`. Environment fallback is read once per start
validation through an injected environment dependency so tests remain
deterministic.

## Lifecycle and Error Handling

`bare-arti` owns process-wide reference counting because it owns the process-wide
Tor singleton. It adds `acquire(options)`, which returns a distinct lease
`{ port, backend, release }` for every matching acquisition. Each `release()` is
idempotent. Native Arti stops only after the final acquired lease and the legacy
owner described below have both released ownership. Conflicting configurations
still reject `ERR_ARTI_CONFIG_CONFLICT`.

Existing `start()/stop()` behavior remains compatible and represents one
legacy owner regardless of repeated matching `start()` calls. `stop()` or the
legacy service's `stop()` releases only that legacy owner; it cannot stop native
Arti while acquired leases remain. Conversely, releasing the final acquired
lease cannot stop native Arti while the legacy owner remains. Two independently
installed `dht-relay-tor` copies and unrelated direct `bare-arti` consumers are
therefore coordinated at the actual singleton boundary.

`dht-relay-tor/arti.connect()` uses `acquire()`, never the legacy `start()` API.
It may retain a module-local active/start guard as an early diagnostic, but that
guard is not a correctness boundary.

The entry acquires Arti, then opens the onion transport. If the onion connection
fails, it awaits `lease.release()` before rethrowing the original connection error
unless shutdown fails, in which case the shutdown error is surfaced with the
connection error as its cause. A successful transport installs one idempotent
`stopOnce()` for close/error races. The stream exposes `artiStopped`, the exact
cleanup promise. The implementation immediately attaches a no-op rejection
handler to prevent an unhandled rejection, while callers can still await the
original promise and observe `ERR_ARTI_SHUTDOWN`. Ownership clears only after
cleanup settles, so restart cannot overlap shutdown. If acquisition itself
rejects before producing a lease, integration ownership clears immediately and
a later call may retry.

A stream `error` is terminal for this transport. The handler destroys the
stream, then invokes `stopOnce()`; a stream cannot remain apparently usable
after its Tor lease has been released.

All documented `bare-arti` errors retain their codes. In particular, missing
mobile storage rejects `ERR_ARTI_CONFIG`; a missing native module rejects
`ERR_ARTI_ADDON_MISSING`; Tor startup failures reject `ERR_ARTI_BOOTSTRAP`; and
shutdown failures reject `ERR_ARTI_SHUTDOWN`.

## Tests

### Deterministic unit tests

Refactor the Arti entry around an injectable helper without changing the public
entry point. Tests use fake `bare-arti` and transport dependencies to prove:

- explicit `dataDir`, `artiBackend`, and bootstrap timeout are forwarded;
- `insecureFsPermissions` is forwarded only to `bare-arti` and never passed to
  `Stream.connect()`;
- unrelated onion/SecretStream options reach `Stream.connect()`;
- caller-supplied `proxyHost` and `proxyPort` reject instead of overriding the
  embedded SOCKS endpoint;
- all Arti-only keys are absent from the transport options;
- a connection failure stops Arti and preserves the error contract;
- a second active or starting connection rejects without stopping the first;
- close/error races stop Arti exactly once, expose the same `artiStopped`
  promise, and a rejected shutdown never becomes unhandled;
- acquisition failure clears local ownership and a later connection can retry.

`bare-arti` validation tests prove explicit directory precedence,
`BARE_ARTI_DATA` fallback, desktop sidecar default preservation, and mobile
fail-closed behavior when both sources are absent. They also prove invalid
higher-precedence values never fall through, the environment is resolved once,
desktop-default sidecar accepts the boolean permission escape hatch, and addon
selection rejects `insecureFsPermissions: true`.

`bare-arti` ownership tests create leases through two independent integration
helpers plus a direct legacy `start()` consumer. They prove releasing either
lease cannot stop the other, legacy `stop()` cannot stop acquired leases,
releasing all leases cannot stop the legacy owner, final release stops native
Arti exactly once, conflicting configurations reject, and failed acquisition
does not retain a reference.

### Real-network embedded-Arti proof

Extend the manual Tor smoke workflow with an `arti` job using a two-process
harness. A Node orchestrator owns `hyperdht/testnet`, the Hyperswarm echo peer,
the relay TCP server, the system-Tor onion service, and final assertions. A
pinned Bare runtime child loads the exact host addon, calls
`dht-relay-tor/arti`, performs relayed topic discovery/exchange, and prints one
machine-readable result for the orchestrator.

The job:

1. Checks out an exact reviewed `bare-arti` commit rather than a floating
   branch.
2. Pins the Bare runtime, Node, Rust, and native build-tool versions.
3. Builds, packages, and installs `bare-arti` from that literal SHA, or consumes
   an artifact whose manifest identifies the producing workflow run and exact
   source SHA; module resolution must be asserted to point to that checkout.
4. Starts system Tor only as the v3 onion-service host, with its own `0700` data
   directory.
5. Starts the Bare masked client with a separate explicit `0700` Arti
   `dataDir` and the addon backend.
6. Discovers a Hyperswarm server by topic through `@hyperswarm/dht-relay`.
7. Exchanges the exact `tor-proof` payload.
8. Asserts the onion relay socket sees only a loopback source.
9. Tears down both Arti and system Tor within the workflow timeout.

The repository commits its npm lockfile and uses `npm ci`. The job records both
repository SHAs and all pinned tool versions in its summary. A checksum without
source-run/SHA provenance is insufficient.

The system-Tor smoke test stays as a separate control. Neither real-network job
becomes a required normal-CI check because public Tor reachability is inherently
variable.

## Privacy Claims and Remaining Gates

A green embedded-Arti smoke test proves that the Holepunch/Hyperswarm data path
works over an Arti-owned Tor client. The loopback assertion is evidence only
about what the onion relay endpoint observes; it is not a process-wide IP-leak
audit. The test does not prove that a whole application has no clearnet sockets.

Before enabling the PearTube switch by default, each mobile runtime must also:

- load the exact CI-produced addon artifact in BareKit;
- bootstrap Arti from the platform-provided app-private directory;
- repeat onion/Hyperswarm exchange on emulator or Simulator and physical
  devices;
- capture process-scoped socket or packet evidence showing no direct HyperDHT,
  Hyperswarm, DNS, tracker, media, or telemetry traffic escapes the Tor policy;
- fail closed when Tor is unavailable rather than silently selecting a direct
  transport.

## Out of Scope

- Publishing any npm package.
- Automatically choosing a mobile application directory.
- Routing non-Holepunch PearTube HTTP/media traffic.
- Treating cross-compiled mobile modules as runtime-verified.
- Making public Tor reachability a normal CI dependency.
