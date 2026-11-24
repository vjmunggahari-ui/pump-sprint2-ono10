// Pump.fun Paper Sprint — two-tier reserve-flip bot.
//
// Design (measured on the 24h dev window, backtested in Python before this
// file was written; see README for the numbers):
//
//   * A new coin's opening is the whole trade. Coins whose real SOL reserves
//     reach 20+ SOL in their first few slots are the runners: they reach 3x
//     their create price essentially always, and quick flips on them win
//     roughly 2 in 3. Coins under ~8 SOL are dead on arrival.
//   * The dominant loss is a coordinated multi-seller dump that lands inside
//     ONE slot (price -60% before any exit can fill). No stop can react to
//     it, so the defence is to be out before it happens: take profit at +8%,
//     trail 8% below the peak, stop at -10%, and never hold longer than
//     1800 slots. Chasing spikes loses (fills land on spike tops).
//   * Two tiers. Tier A is the profit engine: 20+ SOL real reserves at first
//     sight, 0.5 SOL a trade. Tier B exists only to clear the 20-coin
//     minimum bar: 8-20 SOL reserves, 0.015 SOL a trade (just above the
//     0.01 SOL round-trip floor), capped at 3 of the 5 position slots so it
//     can never block a Tier A trade.
//
// Fully deterministic: every decision comes from the harness state. No
// randomness, no wall-clock, no network, no environment reads. All price
// comparisons are exact bigint cross-multiplications, so two runs produce
// byte-identical action logs.
//
// The bot tracks its own paper impact on each curve (its fills move the
// reserves it is quoted against), mirroring the harness's own offset: a buy
// adds the net quote paid and the tokens taken; a sell removes the gross
// quote received and the tokens sold. Entry decisions use the offset real
// reserves, exits use the offset price.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants

const BPS = 10_000n;
const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n

// Take profit +8%, stop-loss -10%, trailing stop 8% below the peak.
const TP_NUM = 108n;
const SL_NUM = 90n;
const TRAIL_NUM = 92n;
const PCT_DEN = 100n;

// Never hold longer than this many slots after the entry decision.
const MAX_HOLD_SLOTS = 1800;
// Only enter a coin this many slots after its create slot (first sight).
const MAX_ENTRY_AGE_SLOTS = 5;

// Tier A (profit engine): real reserves at first sight, trade size.
const TIER_A_MIN_RQ = 20n * SOL;
const TIER_A_SIZE = 500_000_000n; // 0.5 SOL
// Tier B (minimum-bar filler): real reserves at first sight, trade size.
const TIER_B_MIN_RQ = 8n * SOL;
const TIER_B_SIZE = 15_000_000n; // 0.015 SOL
// Tier B may use at most this many of the 5 position slots.
const TIER_B_MAX_SLOTS = 3;
// Never send a buy smaller than this (the round-trip floor is 0.01 SOL).
const MIN_BUY = 11_000_000n; // 0.011 SOL

const ENTRY_SLIPPAGE_BPS = 1000; // 10% — the fill may land on a fast move
const EXIT_SLIPPAGE_BPS = 2000; // 20% — a dump must not strand the exit

// Curve fees the harness charges on every trade (protocol 95bps + creator 30bps).
const FEE_PROTOCOL_BPS = 95n;
const FEE_CREATOR_BPS = 30n;

// ---------------------------------------------------------------- small math

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Split an exact-in spend into the net quote that enters the curve and the fees. */
function exactInSplit(spendable: bigint): { net: bigint; fee: bigint; creatorFee: bigint } {
  const net0 = (spendable * BPS) / (BPS + FEE_PROTOCOL_BPS + FEE_CREATOR_BPS);
  const fee = ceilDiv(net0 * FEE_PROTOCOL_BPS, BPS);
  const creatorFee = ceilDiv(net0 * FEE_CREATOR_BPS, BPS);
  let over = net0 + fee + creatorFee - spendable;
  if (over < 0n) over = 0n;
  return { net: net0 - over, fee, creatorFee };
}

/** Recover the gross quote a sell took out of the curve from its net proceeds. */
function grossFromProceeds(proceeds: bigint): bigint {
  const approx = (proceeds * BPS) / (BPS - FEE_PROTOCOL_BPS - FEE_CREATOR_BPS);
  return (
    proceeds +
    ceilDiv(approx * FEE_PROTOCOL_BPS, BPS) +
    ceilDiv(approx * FEE_CREATOR_BPS, BPS)
  );
}

// ---------------------------------------------------------------- curve view

interface Reserves {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
}

/** A price as an exact ratio (quote per token). Compared by cross-multiplication. */
interface Price {
  n: bigint;
  d: bigint;
}

function priceAtLeast(cur: Price, ref: Price, num: bigint, den: bigint): boolean {
  // cur >= ref * num / den
  return cur.n * ref.d * den >= ref.n * cur.d * num;
}

function priceAtMost(cur: Price, ref: Price, num: bigint, den: bigint): boolean {
  // cur <= ref * num / den
  return cur.n * ref.d * den <= ref.n * cur.d * num;
}

// ---------------------------------------------------------------- bot state

interface Held {
  entryPrice: Price;
  peak: Price;
  entrySlot: number;
  tier: 'A' | 'B';
}

const seen = new Map<string, number>(); // mint -> create slot (first sight)
const held = new Map<string, Held>();
// Per-mint paper impact: [net quote added, tokens removed] by my own fills.
const offsets = new Map<string, [bigint, bigint]>();
// Mints with a sell I sent that has not resolved yet. While a sell is in
// flight the exit loop skips the mint: sending the same sell twice would only
// earn a rejection, and re-basing the entry price mid-flight would silently
// move the take-profit/stop-loss the trade was opened under.
const pendingSells = new Set<string>();

/** Latest reserves for a mint, shifted by my own fills' persistent impact. */
function viewReserves(state: BotState, mint: string): Reserves | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  const rec: Reserves = {
    vq: c.virtual_quote_reserves,
    vt: c.virtual_token_reserves,
    rq: c.real_quote_reserves,
    rt: c.real_token_reserves,
  };
  const off = offsets.get(mint);
  if (off === undefined) return rec;
  // Scale the offset down if it would push a real reserve below zero.
  let num = 1n;
  let den = 1n;
  if (off[1] > rec.rt) {
    num = rec.rt;
    den = off[1];
  }
  if (off[0] < 0n && rec.rq * den < num * -off[0]) {
    num = rec.rq;
    den = -off[0];
  }
  const scale = (x: bigint): bigint => (num === den ? x : (x * num) / den);
  const q = scale(off[0]);
  const t = scale(off[1]);
  return { vq: rec.vq + q, rq: rec.rq + q, vt: rec.vt - t, rt: rec.rt - t };
}

function viewPrice(state: BotState, mint: string): Price | null {
  const r = viewReserves(state, mint);
  if (r === null || r.vt <= 0n) return null;
  return { n: r.vq, d: r.vt };
}

/** Fold this batch's fills into the per-mint paper-impact offsets. */
function applyFills(batch: Batch): void {
  for (const f of batch.fills) {
    // A resolved sell (filled, rejected or failed) clears the in-flight flag.
    if (f.side === 'sell' && !f.client_id.startsWith('_')) pendingSells.delete(f.mint);
    if (f.status !== 'filled') continue;
    const tokens = BigInt(f.token_amount);
    if (tokens <= 0n) continue;
    const off = offsets.get(f.mint) ?? [0n, 0n];
    if (f.side === 'buy') {
      const net = exactInSplit(BigInt(f.quote_lamports)).net;
      off[0] += net;
      off[1] += tokens;
    } else {
      if (f.client_id.startsWith('_writeoff_')) continue; // tokens abandoned, curve untouched
      const gross = grossFromProceeds(BigInt(f.quote_lamports));
      off[0] -= gross;
      off[1] -= tokens;
    }
    offsets.set(f.mint, off);
  }
}

type OutOrder =
  | { side: 'buy'; mint: string; quote_lamports: bigint; max_slippage_bps: number }
  | { side: 'sell'; mint: string; token_amount: bigint; max_slippage_bps: number };

/**
 * Self-check on the reply before it goes out. The strategy already maintains
 * every invariant below; this is a guard rail, not a decision maker. An order
 * that fails a check is dropped and reported on stderr — a dropped order can
 * only cost one trade, while a protocol violation fails the whole run.
 */
function selfCheck(state: BotState, orders: OutOrder[]): OutOrder[] {
  const kept: OutOrder[] = [];
  const buyMints = new Set<string>();
  let newBuys = 0;
  for (const o of orders) {
    if (kept.length >= 16) {
      console.error(`self-check: dropping order over the 16-per-batch cap (${o.side} ${o.mint})`);
      continue;
    }
    if (o.side === 'buy') {
      if (buyMints.has(o.mint) || state.positions.has(o.mint)) {
        console.error(`self-check: dropping duplicate buy on ${o.mint}`);
        continue;
      }
      if (o.quote_lamports <= 0n || o.quote_lamports > state.maxBuyLamports(o.mint)) {
        console.error(`self-check: dropping buy over the size cap on ${o.mint}`);
        continue;
      }
      if (state.committedPositionCount() + newBuys >= 5) {
        console.error(`self-check: dropping buy over the 5-position cap (${o.mint})`);
        continue;
      }
      buyMints.add(o.mint);
      newBuys += 1;
    } else {
      const pos = state.positions.get(o.mint);
      if (pos === undefined || o.token_amount <= 0n || o.token_amount > pos.token_amount) {
        console.error(`self-check: dropping sell over the held tokens on ${o.mint}`);
        continue;
      }
      if (pendingSells.has(o.mint)) {
        console.error(`self-check: dropping duplicate sell on ${o.mint}`);
        continue;
      }
      // Mark it in flight here, at the last gate before the reply goes out:
      // the exit loop adds the sell to the reply, self-check is what commits it.
      pendingSells.add(o.mint);
    }
    kept.push(o);
  }
  return kept;
}

// ---------------------------------------------------------------- strategy

function onBatch(state: BotState, batch: Batch) {
  applyFills(batch);

  // First sight of a mint: record its create slot (the harness reports the
  // create slot when it saw the CreateEvent, else this batch's slot).
  for (const e of batch.events) {
    if (!seen.has(e.mint)) {
      const c = state.curves.get(e.mint);
      seen.set(e.mint, c?.created_slot ?? state.slot);
    }
  }

  const out: OutOrder[] = [];

  // --- exits first: take profit, stop-loss, trailing stop, max hold ---
  for (const [mint, pos] of state.positions) {
    if (pos.token_amount <= 0n) continue;
    if (pendingSells.has(mint)) continue; // a sell is already in flight
    const px = viewPrice(state, mint);
    if (px === null) continue;
    let h = held.get(mint);
    if (h === undefined) {
      h = { entryPrice: px, peak: px, entrySlot: state.slot, tier: 'A' };
      held.set(mint, h);
    }
    if (priceAtLeast(px, h.peak, 1n, 1n)) h.peak = px;
    const age = state.slot - h.entrySlot;
    const takeProfit = priceAtLeast(px, h.entryPrice, TP_NUM, PCT_DEN);
    const stopLoss = priceAtMost(px, h.entryPrice, SL_NUM, PCT_DEN);
    const trailing = priceAtMost(px, h.peak, TRAIL_NUM, PCT_DEN);
    const stale = age >= MAX_HOLD_SLOTS;
    if (takeProfit || stopLoss || trailing || stale) {
      out.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: EXIT_SLIPPAGE_BPS });
      held.delete(mint);
    }
  }
  if (out.length >= 16) return selfCheck(state, out);

  // --- entries: reserve-gated flips, Tier A first, Tier B fills the bar ---
  if (state.committedPositionCount() < 5) {
    let newBuys = 0;
    for (const e of batch.events) {
      const mint = e.mint;
      if (state.positions.has(mint) || held.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const created = seen.get(mint);
      if (created === undefined) continue;
      if (state.slot - created > MAX_ENTRY_AGE_SLOTS) continue;
      const r = viewReserves(state, mint);
      if (r === null) continue;
      let size = 0n;
      let tier: 'A' | 'B' | null = null;
      if (r.rq >= TIER_A_MIN_RQ) {
        tier = 'A';
        size = TIER_A_SIZE;
      } else if (r.rq >= TIER_B_MIN_RQ && state.committedPositionCount() + newBuys < TIER_B_MAX_SLOTS) {
        tier = 'B';
        size = TIER_B_SIZE;
      }
      if (tier === null) continue;
      const cap = state.maxBuyLamports(mint);
      const free = state.freeCashLamports();
      const halfFree = free / 2n > 0n ? free / 2n : 0n;
      if (size > cap) size = cap;
      if (size > halfFree) size = halfFree;
      if (size < MIN_BUY) continue;
      const px = viewPrice(state, mint);
      if (px === null) continue;
      out.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: ENTRY_SLIPPAGE_BPS });
      held.set(mint, { entryPrice: px, peak: px, entrySlot: state.slot, tier });
      newBuys += 1;
      if (out.length >= 16) break;
      if (state.committedPositionCount() + newBuys >= 5) break;
    }
  }

  return selfCheck(state, out);
}

await runBot({
  onHello(state) {
    // hello: once, before the first batch. Nothing to seed — every decision
    // below comes from the harness state, so the run is fully deterministic.
    console.error(
      `pump-sprint2: hello, capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_open_positions} positions, ` +
        `latency ${state.hello.latency_slots} slots`,
    );
  },
  onBatch,
  onDone(state) {
    console.error(`pump-sprint2: done, final cash ${state.cash} lamports`);
  },
});
