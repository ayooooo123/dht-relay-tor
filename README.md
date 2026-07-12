# dht-relay-tor

Run the [Hyperswarm DHT](https://github.com/holepunchto/hyperdht) over a **Tor
circuit**, so a client's source IP is never exposed to the swarm. A Tor
transport for [`@hyperswarm/dht-relay`](https://github.com/holepunchto/hyperswarm-dht-relay),
in the same shape as its built-in `/tcp` and `/ws` wrappers.

> :test_tube: Experimental. Same spirit as iroh's `iroh-tor-transport`, but built
> on the existing dht-relay seam rather than a fork of the DHT.

## How it works

dht-relay lets a client speak the full DHT API (`connect`, `lookup`, `announce`,
`createServer`) over a framed `Duplex` to a **relay node** that holds the real
UDP presence on the swarm. Its TCP transport is just `@hyperswarm/secret-stream`
over a socket. So a Tor transport needs no new protocol — you obtain the socket
by dialing the relay's hidden service through Tor's SOCKS5 proxy, then hand it to
the same secret-stream wrapper. The client never opens a UDP socket to the swarm;
the relay does all holepunching on its behalf.

```
 service peer  <-- DHT holepunch (UDP) -->  relay node  <-- secret-stream over Tor -->  masked client
   (on swarm)                                (on swarm)          (no swarm-facing IP)
```

The SOCKS5 client is buffer-free (`b4a` + byte indexing) and the TCP module is
selected per-runtime (`net` on Node, `bare-tcp` on Bare), so it runs on Bare and
Pear as well as Node.

## Install

```sh
npm install dht-relay-tor @hyperswarm/dht-relay hyperdht
```

## Usage

Relayed (client) side — requires a Tor daemon with a SOCKS proxy on `127.0.0.1:9050`:

```js
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('dht-relay-tor')

const dht = new DHT(await Stream.connect({ onion: '<relay>.onion', port: 8080 }))
await dht.ready()

// From here the API matches hyperdht.
const conn = dht.connect(remotePublicKey)
```

Relay side — an ordinary hyperdht node bridged to a TCP endpoint (published as a
hidden service):

```js
const net = require('net')
const HyperDHT = require('hyperdht')
const { relay } = require('@hyperswarm/dht-relay')
const { wrap } = require('dht-relay-tor')

const dht = new HyperDHT()
net.createServer((socket) => relay(dht, wrap(false, socket))).listen(8080, '127.0.0.1')
```

## API

#### `const stream = await Stream.connect(options)`

Dial the relay's onion over Tor and return a Stream ready for `new DHT(stream)`.

- `onion` (required): the relay's `.onion` hidden-service address.
- `port` (default `8080`): the hidden-service port.
- `proxyHost` / `proxyPort` (default `127.0.0.1:9050`): Tor's SOCKS5 proxy.
- `timeout` (default `30000`): SOCKS5 handshake timeout in ms.
- any other options are forwarded to `@hyperswarm/secret-stream`.

#### `const stream = Stream.wrap(isInitiator, socket[, options])`

Wrap an already-connected socket in the transport Stream. `isInitiator` is
`true` on the relayed client, `false` on the relay. Used by the relay server and
by callers who dial the socket themselves.

#### `const Stream = require('dht-relay-tor')`

The default export is `@hyperswarm/secret-stream` — the same Stream class
dht-relay's `/tcp` transport exports — so `new Stream(isInitiator, socket)` works
identically.

## Bundled Tor (no external daemon)

Install the optional [bare-arti](https://github.com/ayooooo123/bare-arti) module
and use the `arti` entry to boot an embedded Tor client instead of talking to a
system `tor`:

```js
const { connect } = require('dht-relay-tor/arti')
const DHT = require('@hyperswarm/dht-relay')

// PearTube's platform adapter supplies an absolute app-private directory.
const stream = await connect({
  onion: '<relay>.onion',
  dataDir: absoluteAppPrivateDirectory,
  artiBackend: 'addon'
})
const dht = new DHT(stream)
```

`bare-arti` starts Arti (Rust Tor) in the background, exposes a local SOCKS5 port,
and this transport dials through it — nothing to install or run separately. See
bare-arti's README for build/prebuild details.

The preferred PearTube integration keeps the UI to one Tor switch while its
platform adapter supplies `dataDir`. The adapter owns the semantic guarantee
that this absolute path is app-private; this package cannot infer that guarantee
from an arbitrary absolute path. `bare-arti` resolves state storage in this
order: explicit `dataDir`, then `BARE_ARTI_DATA`. An addon fails closed with
`ERR_ARTI_CONFIG` if neither is available, including an explicit desktop addon
and the mobile default. Only the desktop sidecar may retain its existing
OS-default state directory.

`artiBackend: 'addon'` selects the in-process addon. `bootstrapTimeout` is
forwarded to `bare-arti` as its startup timeout. Setting
`insecureFsPermissions: true` is a sidecar-only container escape hatch; the addon
accepts an omitted or `false` value and rejects `true`. All validation and
backend-specific behavior for these options is delegated to `bare-arti`. The
Arti entry rejects `proxyHost` and `proxyPort` because its loopback SOCKS endpoint
is owned by the acquired Arti instance.

Each Arti entry/controller permits one starting or active transport. Within one
JavaScript realm, coordination lives in `bare-arti`: every transport holds a
lease, so one same-realm consumer cannot stop Arti while another still owns it.
Separate worker realms do not share these JavaScript leases. The native addon
rejects conflicting cross-realm ownership with `ERR_ARTI_REALM_CONFLICT` rather
than treating it as a shared lease; desktop sidecars are not lease-coordinated
across realms. Closing the stream, or a terminal stream error, releases its
lease. The returned stream exposes `stream.artiStopped`, which callers may await
to observe completed cleanup. A shutdown failure rejects that promise with
`ERR_ARTI_SHUTDOWN`.

## Run it over real Tor (external daemon)

1. Add a hidden service for the relay's port to your `torrc`:

   ```
   HiddenServiceDir /var/lib/tor/hyperdht-relay/
   HiddenServicePort 8080 127.0.0.1:8080
   ```

   Start Tor, then read the address: `cat /var/lib/tor/hyperdht-relay/hostname`.

2. Start the relay: `node example/relay-server.js 8080`
3. Run a masked client: `node example/masked-client.js <relay-onion> 8080 [targetKeyHex]`

## Test

```sh
npm test
```

Covers the SOCKS5 client against a mock proxy and an end-to-end relayed
connection over the transport on a local testnet (no Tor required — it exercises
the same code path, differing only in how the socket is obtained).

### Real Tor smoke test

The real-network smoke test is opt-in. It starts a fresh Tor daemon and v3 onion
service, then proves that a relayed DHT client can exchange `tor-proof` with a
Hyperswarm echo peer discovered by topic while the relay TCP socket sees only a
loopback address:

```sh
DHT_RELAY_TOR_TEST_TOR=1 npm test
```

Set `TOR_BIN=/path/to/tor` if `tor` is not on `PATH`. Tor bootstrap requires
outbound network access to the public Tor network and may take up to ten
minutes. The test uses fresh temporary data and hidden-service directories and
removes them during teardown.

To reuse an already-published onion service, configure it to forward virtual
port `18080` to a fixed loopback port and run the test in externally managed
mode. For example, with the relay target on `127.0.0.1:40123` and Tor SOCKS on
`127.0.0.1:9050`:

```sh
DHT_RELAY_TOR_TEST_TOR=1 \
DHT_RELAY_TOR_TEST_ONION=<relay-onion> \
DHT_RELAY_TOR_TEST_RELAY_PORT=40123 \
DHT_RELAY_TOR_TEST_SOCKS_PORT=9050 \
npm test
```

This mode does not start or modify Tor; the caller owns the onion service and
its lifecycle. `DHT_RELAY_TOR_TEST_SOCKS_PORT` defaults to `9050`.

The manual **Tor proof** GitHub Actions workflow is the GitHub-native,
exact-source proof. It runs a system-Tor control and, separately, checks out the
exact bare-arti commit pinned in the workflow using a second SHA-pinned checkout.
A prerequisite job builds a fresh Debug addon with test hooks enabled and runs
bare-arti's native addon suite. A read-only package job then starts from a
different, empty build tree, builds a stripped Release addon with test hooks
disabled, adds source and artifact provenance, packs it, and verifies its
target, path, source SHA, and digest in both Node and Bare. A separate read-only
network job downloads that exact artifact, re-verifies and installs it without
changing this repository's lockfile, then runs the real Hyperswarm exchange with
two strictly bounded attempts.

Successful embedded runs upload the packed tarball, addon, provenance, hashes,
runtime verification records, toolchain inventory, and Tor logs. The packed
tarball also receives a GitHub artifact attestation from a minimal downstream
job with no checkout, dependency install, lifecycle script, compiler, or native
test execution. That job independently checks the tarball digest against the
uploaded manifest before requesting the attestation. The job summary records
both repository SHAs, the run ID and attempt, both artifact hashes, and the
effective Node, npm, Bare, Rust, Cargo, CMake, compiler, and Tor versions. GitHub
Action dependencies and language/toolchain versions are immutable or exact;
Ubuntu package versions are recorded because the runner's apt snapshot is not
an immutable project input. Normal CI does not depend on Tor reachability.

The relay's loopback source assertion is evidence that the tested onion relay
did not observe the client's public IP. It is not a whole-process leak audit and
does not prove that every socket opened by an application uses Tor. This Linux
proof does not establish macOS or mobile release readiness. Release testing must
build and attest each target prebuild, load it on that target runtime, and audit
the application's network activity.

To reproduce the package boundary locally, build a fresh Release `bare-arti`
addon for the current host, generate its `prebuilds/provenance.json`, and pack
the exact sibling checkout. Install only that tarball without saving it or
changing this repository's lockfile, then pass the sibling commit as the
expected provenance SHA:

```sh
mkdir -p /tmp/bare-arti-proof
(cd ../bare-arti && npm pack --pack-destination /tmp/bare-arti-proof)
npm install --no-save --package-lock=false /tmp/bare-arti-proof/bare-arti-0.0.1.tgz
BARE_ARTI_SHA=$(git -C ../bare-arti rev-parse HEAD) \
DHT_RELAY_TOR_TEST_TOR=1 \
DHT_RELAY_TOR_TEST_BACKEND=arti \
npm test
```

The verifier fails closed if the provenance source, runtime target, addon path,
or digest differs. The Arti backend still needs public Tor egress. The system
Tor process remains the onion-service host; Arti replaces only the masked
client's SOCKS backend.

## Tradeoffs (read before using)

- **Masking IP means giving up direct connections.** All traffic goes through the
  relay over Tor, so you pay Tor latency and the relay is on the path. You cannot
  have a hidden IP _and_ a direct low-latency holepunch on the same connection —
  masking means routing through an overlay. The productive pattern is a per-peer
  policy (direct for peers you don't mind, masked for the ones you do); that lives
  above this transport, not in it.
- **Trust in the relay.** It proxies your DHT operations and sees your Tor-exit
  connection — not your real IP (Tor handles that) nor your payload (end-to-end
  Noise to the far peer). Run your own, or treat it like a trusted exit.
- **Custodial keys by default.** dht-relay's default lets the relay hold the DHT
  key material. Wire up its non-custodial handshake if the relay should never see
  your keys.

## License

MIT

## Contributing

Clone the repository, then install dependencies and run the formatter and test
suite:

```sh
npm install
npm run format
npm test
```

Before `bare-arti` is published to npm, local cross-package development can use
`npm link ../bare-arti`. Otherwise, npm installs the eventual optional semver
range declared in `package.json`.
