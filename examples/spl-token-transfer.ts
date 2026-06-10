/**
 * Transfer SPL tokens on devnet using ReliableClient.
 *
 * Usage:
 *   npm install @solana/spl-token   # one-time setup
 *   npx tsx examples/spl-token-transfer.ts
 *
 * The script:
 *   1. Generates a payer keypair and airdrops 2 SOL
 *   2. Creates a new SPL token mint (6 decimals)
 *   3. Creates Associated Token Accounts for sender and recipient
 *   4. Mints 1 000 tokens to the sender's ATA
 *   5. Transfers 100 tokens to the recipient via ReliableClient
 *   6. Prints the Explorer link
 */

import {
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
  clusterApiUrl,
  Connection,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  createMintToInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
} from '@solana/spl-token';
import { ReliableClient } from '../src/index.js';

const DEVNET = clusterApiUrl('devnet');
const DECIMALS = 6;
const MINT_AMOUNT = 1_000 * 10 ** DECIMALS;
const TRANSFER_AMOUNT = 100 * 10 ** DECIMALS;

async function main() {
  const conn = new Connection(DEVNET, 'confirmed');

  // ── 1. Generate payer & airdrop ───────────────────────────────────────────
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  console.log('Payer:', payer.publicKey.toBase58());
  console.log('Recipient:', recipient.publicKey.toBase58());

  console.log('Requesting airdrop…');
  const airdropSig = await conn.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(airdropSig, 'confirmed');
  console.log('Airdrop confirmed (2 SOL)');

  // ── 2. Create SPL token mint ──────────────────────────────────────────────
  console.log('Creating mint…');
  const mint = await createMint(conn, payer, payer.publicKey, null, DECIMALS);
  console.log('Mint:', mint.toBase58());

  // ── 3. Create Associated Token Accounts ───────────────────────────────────
  const senderAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  const recipientAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, recipient.publicKey);
  console.log('Sender ATA:', senderAta.address.toBase58());
  console.log('Recipient ATA:', recipientAta.address.toBase58());

  // ── 4. Mint tokens to sender ──────────────────────────────────────────────
  const mintTx = new Transaction().add(
    createMintToInstruction(mint, senderAta.address, payer.publicKey, MINT_AMOUNT),
  );

  const basicConn = new Connection(DEVNET, 'confirmed');
  const mintInfo = await basicConn.sendTransaction(mintTx, [payer]);
  await basicConn.confirmTransaction(mintInfo, 'confirmed');
  console.log(`Minted ${MINT_AMOUNT / 10 ** DECIMALS} tokens`);

  // ── 5. Transfer via ReliableClient ───────────────────────────────────────
  const client = new ReliableClient({
    endpoints: [
      DEVNET,
      'https://rpc.ankr.com/solana_devnet',
    ],
    commitment: 'confirmed',
    tx: {
      priorityFee: 1_000,   // fixed microLamports — safe for devnet
      retryIntervalMs: 2_000,
      maxDurationMs: 60_000,
    },
  });

  const transferTx = new Transaction().add(
    createTransferInstruction(
      senderAta.address,
      recipientAta.address,
      payer.publicKey,
      TRANSFER_AMOUNT,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  console.log('Sending SPL token transfer…');
  const { signature } = await client.sendAndConfirm(transferTx, [payer]);
  console.log('Confirmed!');
  console.log('Signature:', signature);
  console.log('Explorer: https://explorer.solana.com/tx/' + signature + '?cluster=devnet');

  client.destroy();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
