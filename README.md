# solana-reliable-sdk

A TypeScript SDK that solves three common pain points in Solana dApp development:

1. **RPC instability** — one endpoint goes down → your app crashes
2. **Dropped transactions** — network congestion causes silent failures
3. **Retry boilerplate** — every project reimplements the same retry logic

---

## Quick Start

```bash
npm install solana-reliable-sdk @solana/web3.js
```

```typescript
import { Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ReliableClient } from 'solana-reliable-sdk';

const client = new ReliableClient({
  endpoints: [
    'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
    'https://api.mainnet-beta.solana.com',
  ],
  commitment: 'confirmed',
  tx: {
    priorityFee: 'auto',   // fetches dynamic fee estimate
    computeUnits: 'auto',  // simulates transaction first
  },
});

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient.publicKey,
    lamports: 0.1 * LAMPORTS_PER_SOL,
  }),
);

const { signature } = await client.sendAndConfirm(tx, [payer]);
console.log('Confirmed:', signature);

client.destroy();
```

---

## How It Works

```
ReliableClient
├── RpcPool          — round-robin / priority failover across multiple endpoints
│   ├── HealthChecker   — pings getSlot every 30 s, marks dead endpoints
│   └── CircuitBreaker  — CLOSED → OPEN (3 fails) → HALF_OPEN → CLOSED
├── BlockhashManager — caches blockhash, tracks lastValidBlockHeight expiry
├── FeeEstimator     — Helius getPriorityFeeEstimate or getRecentPrioritizationFees percentile
├── ComputeUnits     — simulateTransaction → setComputeUnitLimit with 10 % buffer
├── TransactionSender
│   ├── Retry loop every 2 s (configurable)
│   ├── Re-sign when blockhash expires (safe from duplicates)
│   └── Exponential backoff on HTTP 429
├── TransactionConfirmer — polls getSignatureStatuses, distinguishes permanent vs. transient errors
├── JitoSender       — routes transactions through Jito block engine for MEV protection
├── MetricsCollector — records RPC latency, failures, circuit state; exports Prometheus + OTLP
└── WsManager        — auto-reconnect WebSocket subscriptions with exponential backoff
```

---

## API Reference

### `ReliableClient`

```typescript
const client = new ReliableClient(options: ReliableClientOptions);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoints` | `string[]` | required | RPC endpoint URLs. First = highest priority. |
| `commitment` | `Commitment` | `'confirmed'` | Default commitment level. |
| `wsEndpoint` | `string` | `undefined` | WebSocket URL. Required for `client.ws`. |
| `pool` | `Partial<RpcPoolOptions>` | `{}` | RpcPool configuration. |
| `tx` | `Partial<TransactionSenderOptions>` | `{}` | TransactionSender configuration. |
| `confirm` | `Partial<ConfirmOptions>` | `{}` | TransactionConfirmer configuration. |
| `ws` | `Partial<WsManagerOptions>` | `{}` | WsManager configuration. |
| `jito` | `JitoSenderOptions` | `undefined` | Enable Jito/MEV routing. |
| `metrics` | `MetricsCollector` | `undefined` | Attach a metrics collector. |

#### `client.sendAndConfirm(tx, signers)`

Sends a transaction and waits for confirmation. Handles:
- Dynamic priority fees and compute budget
- Automatic retry every `retryIntervalMs`
- Re-signing on blockhash expiry
- Immediate throw on permanent on-chain errors (e.g., `InstructionError`)
- Routes through Jito block engine if `jito` option is set

Returns `{ signature: string }`.

#### `client.destroy()`

Stops the health checker and WebSocket reconnect loop. Always call this on shutdown.

---

### `RpcPool`

```typescript
const pool = new RpcPool(endpoints, {
  strategy: 'round-robin',       // or 'priority'
  healthCheckInterval: 30_000,   // ms between getSlot pings
  circuitBreaker: {
    threshold: 3,                // failures before opening circuit
    timeout: 60_000,             // ms before trying HALF_OPEN
  },
  metrics,                       // optional MetricsCollector
});
```

Exposes `getConnection()`, `reportSuccess(conn)`, `reportFailure(conn)`, `destroy()`.

---

### `TransactionSender`

```typescript
const sender = new TransactionSender(pool, blockhashManager, feeEstimator, computeUnits, {
  retryIntervalMs: 2_000,    // ms between send attempts
  maxDurationMs: 90_000,     // total timeout
  skipPreflight: false,
  priorityFee: 'auto',       // 'auto' | number (microLamports)
  priorityLevel: 'medium',   // 'low' | 'medium' | 'high'
  computeUnits: 'auto',      // 'auto' | number
});
```

---

### `TransactionConfirmer`

```typescript
const confirmer = new TransactionConfirmer(pool, {
  commitment: 'confirmed',   // 'processed' | 'confirmed' | 'finalized'
  pollIntervalMs: 2_000,
  timeoutMs: 90_000,
});

await confirmer.confirm(signature, lastValidBlockHeight);
// Throws PermanentTransactionError on InstructionError
// Throws TransactionExpiredError when blockHeight > lastValidBlockHeight
```

---

### `JitoSender` — MEV Protection

Route transactions through [Jito](https://jito.wtf) block engine to prevent frontrunning and enable atomic bundles.

```typescript
import { ReliableClient } from 'solana-reliable-sdk';

const client = new ReliableClient({
  endpoints: ['https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'],
  jito: {
    region: 'ny',          // 'mainnet' | 'amsterdam' | 'frankfurt' | 'ny' | 'tokyo'
    tipLamports: 10_000,   // tip to Jito validators (default 1_000)
    fallbackOnError: true, // fall back to standard RPC if Jito fails
  },
});

// sendAndConfirm automatically routes through Jito when configured
const { signature } = await client.sendAndConfirm(tx, [payer]);
```

For atomic bundles (multiple transactions in the same slot):

```typescript
import { JitoSender } from 'solana-reliable-sdk';

const jito = new JitoSender(pool, blockhashManager, { region: 'frankfurt' });

// Submit up to 5 transactions atomically
const bundleId = await jito.sendBundle([tx1, tx2], signers);
const status = await jito.getBundleStatus(bundleId);
// { bundleId, status: 'Landed' | 'Pending' | 'Failed' | 'Finalizing', landedSlot? }
```

---

### `MetricsCollector` — Observability

Track RPC latency, failure rates, circuit breaker state, and transaction outcomes.
Exports **Prometheus** text format and **OTLP JSON** (compatible with OpenTelemetry Collector and Datadog Agent).

```typescript
import { ReliableClient, MetricsCollector } from 'solana-reliable-sdk';

const metrics = new MetricsCollector();

const client = new ReliableClient({
  endpoints: ['https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'],
  metrics,
});

// Prometheus format (for Grafana / alertmanager scrape)
const prometheusText = metrics.exportPrometheus();

// OTLP JSON (for OpenTelemetry Collector or Datadog Agent)
const otlpPayload = metrics.exportOtlpJson();

// Raw snapshot
const snap = metrics.getSnapshot();
// snap.rpc['helius-rpc.com'] → { totalRequests, failures, avgLatencyMs, p95LatencyMs, circuitState }
// snap.transactions → { total, succeeded, failed, avgRetries, avgDurationMs }
```

Exposed Prometheus metrics:

| Metric | Type | Description |
|---|---|---|
| `solana_rpc_requests_total` | counter | Total requests per endpoint |
| `solana_rpc_failures_total` | counter | Total failures per endpoint |
| `solana_rpc_latency_avg_ms` | gauge | Average latency (ms) per endpoint |
| `solana_rpc_latency_p95_ms` | gauge | P95 latency (ms) per endpoint |
| `solana_circuit_breaker_state` | gauge | 0=CLOSED, 1=HALF_OPEN, 2=OPEN |
| `solana_tx_total` | counter | Total transactions sent |
| `solana_tx_succeeded_total` | counter | Successful transactions |
| `solana_tx_failed_total` | counter | Failed transactions |
| `solana_tx_avg_retries` | gauge | Average retries per transaction |

---

### `ReliableWalletAdapter` — Wallet Integration

Wrap any wallet-adapter-compatible wallet (Phantom, Solflare, Backpack, etc.) to add RPC failover, priority fee estimation, and retry on top of the standard signing flow.

```typescript
import { ReliableClient, ReliableWalletAdapter } from 'solana-reliable-sdk';

const client = new ReliableClient({ endpoints: ['https://...'] });

// phantomWallet — any object implementing WalletLike (publicKey, connected, signTransaction)
const adapter = new ReliableWalletAdapter(phantomWallet, client);

// Drop-in replacement for wallet.sendTransaction:
const signature = await adapter.sendTransaction(tx);

// Send multiple transactions sequentially with retry on each:
const signatures = await adapter.sendAllTransactions([tx1, tx2, tx3]);
```

Compatible with any wallet implementing `@solana/wallet-adapter-base` `SignerWalletAdapter` interface (v0.15+).

---

### `WsManager`

```typescript
const ws = new WsManager(wsEndpoint, {
  commitment: 'processed',
  healthCheckIntervalMs: 10_000,
  healthFailureThreshold: 3,
  initialReconnectDelayMs: 1_000,
  maxReconnectDelayMs: 30_000,
});

ws.addSubscription(
  'myKey',
  (conn) => conn.onAccountChange(pubkey, callback),
  (conn, id) => conn.removeAccountChangeListener(id),
);

ws.removeSubscription('myKey');
ws.destroy();
```

---

### `ReliableRpcV2` — web3.js v2.0 Support

Use the new functional `@solana/rpc` API with the same failover and circuit-breaker guarantees.

```typescript
import { createReliableRpcV2 } from 'solana-reliable-sdk';

const rpc = createReliableRpcV2({
  endpoints: [
    'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
    'https://api.mainnet-beta.solana.com',
  ],
  strategy: 'round-robin',
  commitment: 'confirmed',
});

const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
const slot = await rpc.getSlot();                    // returns bigint
const balance = await rpc.getBalance(address);       // Address from @solana/addresses
const sig = await rpc.sendTransaction(encodedTx);
```

All methods automatically fail over to the next healthy endpoint and track circuit breaker state — same semantics as `RpcPool` but exposed through the v2.0 functional interface.

---

## Diagnostics CLI

Check health of your RPC endpoints before deployment or during incidents:

```bash
npx tsx bin/diagnose.ts https://api.mainnet-beta.solana.com https://rpc.helius.xyz/?api-key=KEY

# Output:
# solana-reliable-sdk — RPC Diagnostics
#
# Endpoint                                  |  Status  |       Slot  |  getSlot     |  getLatestBlockhash
# ────────────────────────────────────────────────────────────────────────────────
# https://api.mainnet-beta.solana.com       |  ✓ OK    |  312847291  |  183ms       |  201ms
# https://rpc.helius.xyz/?api-key=***       |  ✓ OK    |  312847291  |  48ms        |  51ms
# ────────────────────────────────────────────────────────────────────────────────
# Summary: 2 healthy / 0 failed
```

Exits with code `0` if all endpoints are healthy, `1` if any failed. API keys in query params are automatically redacted in output.

---

## Examples

Run on devnet (no API key needed):

```bash
# SOL transfer
npx tsx examples/transfer-sol.ts

# SPL token transfer (requires @solana/spl-token)
npm install @solana/spl-token
npx tsx examples/spl-token-transfer.ts
```

---

## Why Not Just Use `@solana/web3.js` Directly?

| Scenario | `web3.js` alone | `solana-reliable-sdk` |
|---|---|---|
| RPC endpoint goes down | App crashes | Automatically fails over to next endpoint |
| Transaction dropped by congested network | Silent failure | Retried every 2 s for up to 90 s |
| Blockhash expires during retry | Duplicate transaction risk | Re-signed only after confirmed expiry |
| Priority fees during congestion | Must implement manually | Auto-estimated from network data |
| Compute unit budget | Hardcoded 200 000 or guessed | Simulated before send |
| MEV / frontrunning | No protection | Jito block engine routing with tip |
| Observability | None | Prometheus + OTLP export out of the box |
| Wallet adapter | Standard send only | Adds failover + retry on top |
| WebSocket disconnect | Subscriptions lost silently | Auto-reconnected with backoff |
| web3.js v2.0 (@solana/rpc) | No reliability layer | ReliableRpcV2 with full failover |

---

## Running Tests

```bash
npm test
# 120 tests, 14 test files — including network failure and congestion simulations
```

---

## License

MIT
