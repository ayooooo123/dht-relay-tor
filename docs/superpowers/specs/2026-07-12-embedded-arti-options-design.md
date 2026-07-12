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

The transport passes a new object to `bare-arti.start()`:

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

1. A non-empty explicit `options.dataDir`.
2. A non-empty `BARE_ARTI_DATA` value.
3. On desktop sidecar only, the existing sidecar default.
4. Otherwise reject with `ERR_ARTI_CONFIG`.

The resolved addon directory is still canonicalized and validated by
`validateAddonOptions()`: it must be absolute, a directory, owner-only where the
runtime exposes permission metadata, owned by the current user where UID data
exists, and not a final symlink on Android or iOS. `insecureFsPermissions` is
not accepted by the addon path; it remains a documented sidecar/container
option and must not weaken mobile addon validation.

No code mutates `process.env`. Environment fallback is read once per start
validation through an injected environment dependency so tests remain
deterministic.

## Lifecycle and Error Handling

`dht-relay-tor/arti.connect()` starts Arti, then opens the onion transport. If
the onion connection fails, it awaits `tor.stop()` before rethrowing the original
connection error unless shutdown fails, in which case the shutdown error is
surfaced with the connection error as its cause. A successful transport stops
Arti once when the stream closes.

All documented `bare-arti` errors retain their codes. In particular, missing
mobile storage rejects `ERR_ARTI_CONFIG`; a missing native module rejects
`ERR_ARTI_ADDON_MISSING`; Tor startup failures reject `ERR_ARTI_BOOTSTRAP`; and
shutdown failures reject `ERR_ARTI_SHUTDOWN`.

## Tests

### Deterministic unit tests

Refactor the Arti entry around an injectable helper without changing the public
entry point. Tests use fake `bare-arti` and transport dependencies to prove:

- explicit `dataDir`, `artiBackend`, and bootstrap timeout are forwarded;
- `insecureFsPermissions` is forwarded only to the sidecar-compatible start
  contract and never passed to `Stream.connect()`;
- unrelated onion/SOCKS/SecretStream options reach `Stream.connect()`;
- all Arti-only keys are absent from the transport options;
- a connection failure stops Arti and preserves the error contract;
- stream close stops Arti exactly once.

`bare-arti` validation tests prove explicit directory precedence,
`BARE_ARTI_DATA` fallback, desktop sidecar default preservation, and mobile
fail-closed behavior when both sources are absent.

### Real-network embedded-Arti proof

Extend the manual Tor smoke workflow with an `arti` job that:

1. Checks out an exact reviewed `bare-arti` commit rather than a floating
   branch.
2. Builds and loads the host addon (or consumes a checksum-verified artifact
   produced by that exact commit).
3. Starts system Tor only as the v3 onion-service host.
4. Starts the masked client with `DHT_RELAY_TOR_TEST_BACKEND=arti`, an explicit
   private `dataDir`, and the addon backend.
5. Discovers a Hyperswarm server by topic through `@hyperswarm/dht-relay`.
6. Exchanges the exact `tor-proof` payload.
7. Asserts the onion relay socket sees only a loopback source.
8. Tears down both Arti and system Tor within the workflow timeout.

The system-Tor smoke test stays as a separate control. Neither real-network job
becomes a required normal-CI check because public Tor reachability is inherently
variable.

## Privacy Claims and Remaining Gates

A green embedded-Arti smoke test proves that the Holepunch/Hyperswarm data path
works over an Arti-owned Tor client and that the onion relay does not observe the
masked client's source IP. It does not prove that a whole application has no
clearnet sockets.

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
