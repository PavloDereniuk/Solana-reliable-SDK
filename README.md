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

#### `client.sendAndConfirm(tx, signers)`

Sends a transaction and waits for confirmation. Handles:
- Dynamic priority fees and compute budget
- Automatic retry every `retryIntervalMs`
- Re-signing on blockhash expiry
- Immediate throw on permanent on-chain errors (e.g., `InstructionError`)

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
| WebSocket disconnect | Subscriptions lost silently | Auto-reconnected with backoff |

---

## Running Tests

```bash
npm test
# 70 tests, 9 test files
```

---

## License

MIT
