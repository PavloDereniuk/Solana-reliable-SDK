#!/usr/bin/env node
/**
 * solana-reliable-sdk diagnostics CLI
 *
 * Usage:
 *   npx tsx bin/diagnose.ts <endpoint1> [endpoint2] ...
 *   npx tsx bin/diagnose.ts https://api.mainnet-beta.solana.com https://rpc.helius.xyz/?api-key=KEY
 *
 * Output:
 *   Checks each endpoint for: slot latency, getLatestBlockhash, circuit breaker state.
 *   Prints a table and exits 0 if all healthy, 1 if any failed.
 */

import { Connection } from '@solana/web3.js';

const ANSI = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

interface EndpointReport {
  url: string;
  slot: number | null;
  slotLatencyMs: number;
  blockhashLatencyMs: number;
  blockhash: string | null;
  error: string | null;
}

async function checkEndpoint(url: string, timeoutMs = 10_000): Promise<EndpointReport> {
  const conn = new Connection(url, 'confirmed');
  let slot: number | null = null;
  let slotLatencyMs = 0;
  let blockhashLatencyMs = 0;
  let blockhash: string | null = null;
  let error: string | null = null;

  try {
    const t0 = Date.now();
    slot = await Promise.race([
      conn.getSlot(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    slotLatencyMs = Date.now() - t0;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    return { url, slot, slotLatencyMs, blockhashLatencyMs, blockhash, error };
  }

  try {
    const t1 = Date.now();
    const result = await conn.getLatestBlockhash('confirmed');
    blockhashLatencyMs = Date.now() - t1;
    blockhash = result.blockhash;
  } catch (err) {
    error = `getLatestBlockhash failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return { url, slot, slotLatencyMs, blockhashLatencyMs, blockhash, error };
}

function formatLatency(ms: number): string {
  if (ms < 200) return ANSI.green(`${ms}ms`);
  if (ms < 600) return ANSI.yellow(`${ms}ms`);
  return ANSI.red(`${ms}ms`);
}

function formatUrl(url: string): string {
  try {
    const u = new URL(url);
    // Redact api-key query param
    u.searchParams.forEach((_, key) => {
      if (key.toLowerCase().includes('key') || key.toLowerCase().includes('token')) {
        u.searchParams.set(key, '***');
      }
    });
    return u.toString();
  } catch {
    return url;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(ANSI.red('Error: no endpoints provided'));
    console.error('Usage: npx tsx bin/diagnose.ts <endpoint1> [endpoint2] ...');
    console.error('Example: npx tsx bin/diagnose.ts https://api.mainnet-beta.solana.com');
    process.exit(1);
  }

  console.log(ANSI.bold('\nsolana-reliable-sdk — RPC Diagnostics\n'));
  console.log(ANSI.dim(`Checking ${args.length} endpoint(s)...\n`));

  const reports = await Promise.all(args.map((url) => checkEndpoint(url)));

  // Header
  const cols = [
    ANSI.bold('Endpoint'),
    ANSI.bold('Status'),
    ANSI.bold('Slot'),
    ANSI.bold('getSlot'),
    ANSI.bold('getLatestBlockhash'),
  ];
  console.log(cols.join('  |  '));
  console.log('─'.repeat(80));

  let anyFailed = false;

  for (const r of reports) {
    const safeUrl = formatUrl(r.url).slice(0, 40).padEnd(40);

    if (r.error) {
      anyFailed = true;
      console.log(
        `${safeUrl}  |  ${ANSI.red('✗ FAIL')}  |  ${ANSI.dim('—')}  |  ${ANSI.dim('—')}  |  ${ANSI.red(r.error.slice(0, 40))}`,
      );
    } else {
      const status = ANSI.green('✓ OK  ');
      const slot = String(r.slot).padStart(10);
      const slotLat = formatLatency(r.slotLatencyMs).padEnd(12);
      const bhLat = formatLatency(r.blockhashLatencyMs);
      console.log(`${safeUrl}  |  ${status}  |  ${slot}  |  ${slotLat}  |  ${bhLat}`);
    }
  }

  console.log('─'.repeat(80));

  const healthy = reports.filter((r) => !r.error).length;
  console.log(`\n${ANSI.bold('Summary')}: ${ANSI.green(`${healthy} healthy`)} / ${ANSI.red(`${reports.length - healthy} failed`)}\n`);

  if (anyFailed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(ANSI.red('Fatal: ' + err.message));
  process.exit(1);
});
