/**
 * Transfer SOL on devnet using ReliableClient.
 *
 * Usage:
 *   npx tsx examples/transfer-sol.ts
 *
 * The script:
 *   1. Generates a throwaway keypair and airdrops 1 SOL from the devnet faucet
 *   2. Sends 0.1 SOL back to a recipient (same keypair for simplicity)
 *   3. Prints the Explorer link
 */

import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  Connection,
} from '@solana/web3.js';
import { ReliableClient } from '../src/index.js';

const DEVNET = clusterApiUrl('devnet');

async function main() {
  // ── 1. Generate sender keypair ────────────────────────────────────────────
  const sender = Keypair.generate();
  console.log('Sender:', sender.publicKey.toBase58());

  // ── 2. Airdrop 1 SOL (devnet only) ───────────────────────────────────────
  console.log('Requesting airdrop…');
  const conn = new Connection(DEVNET, 'confirmed');
  const sig = await conn.requestAirdrop(sender.publicKey, LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('Airdrop confirmed');

  // ── 3. Build client with two devnet endpoints ─────────────────────────────
  const client = new ReliableClient({
    endpoints: [
      DEVNET,
      'https://rpc.ankr.com/solana_devnet',
    ],
    commitment: 'confirmed',
    tx: {
      priorityFee: 1_000,   // 1000 microLamports — fixed, no auto-estimate on devnet
      retryIntervalMs: 2_000,
      maxDurationMs: 60_000,
    },
  });

  // ── 4. Build a simple SOL transfer transaction ────────────────────────────
  const recipient = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    }),
  );

  // ── 5. Send and confirm ───────────────────────────────────────────────────
  console.log('Sending transaction…');
  const { signature } = await client.sendAndConfirm(tx, [sender]);
  console.log('Confirmed!');
  console.log('Signature:', signature);
  console.log('Explorer: https://explorer.solana.com/tx/' + signature + '?cluster=devnet');

  client.destroy();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
