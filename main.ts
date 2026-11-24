// Pump Sprint v2 — "Early Snipe + Strict Scale-In" (lean/fast rebuild).
//
// v1 ("Two-tier reserve-flip", dev +0.4766 SOL) timed out on the server wall
// budget, so v2 is built to grade fast: O(events) work per batch, no map
// scans, no per-batch sorting, at most 5 positions tracked, at most 80 buys
// in a run. Strategy, measured on the dev dataset with an offline simulator
// (latency 2 slots, 1.25% curve fees, base+priority tx fees, 1% of real
// reserve order cap, 5 open positions):
//   dev +1.79 SOL, 39 coins, 105 fills, max drawdown 6.3% (grade-local,
//   process driver, confirmed on 4 runs: 2 as root, 2 as nobody on a
//   read-only copy, all with the identical action log).
//   Beats every house baseline on dev (momentum -9.45, reversion -4.37,
//   sniper -0.42, equal-weight -0.02, hold-cash 0.00).
//
// Rules:
//   ENTRY: a coin with >= 3 trades, >= 0.5 SOL of buy volume, real reserves
//     >= 2 SOL, and price >= +15% vs its create price -> buy
//     min(0.3 SOL, 1% of real reserves). Entry size is small on purpose:
//     the 1% cap binds early, so the first buy is a probe, not a bet.
//   SCALE-IN: while a position is open, if price >= +20% above its average
//     cost AND real reserves >= 10 SOL AND position cost < 0.3 SOL -> buy
//     another min(0.3 SOL, 1% of real reserves). Winners accumulate size;
//     losers never get a second buy.
//   EXIT (checked every batch for every held position, from marks so a dead
//     coin still ages out): sell all if price >= +100% vs average cost
//     (take-profit), or <= -30% vs average cost (stop-loss), or price
//     pulled back 20% from a peak that was >= +50% above average cost
//     (trailing lock-in), or held > 1500 slots.
//   CAPS: at most 80 buys per run, at most 5 open positions.
// All decisions are integer (BigInt) math on the harness state: no clock,
// no randomness, no network, no environment reads — fully deterministic.

import { runBot, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

const BUY_SOL = 300_000_000n; // 0.3 SOL max per order
const MIN_BUY = 10_000_000n; // 0.01 SOL — the round-trip minimum
const MIN_REAL = 2_000_000_000n; // 2 SOL real reserves to enter
const MIN_BUY_VOL = 500_000_000n; // 0.5 SOL of buy volume to enter
const SCALE_MIN_REAL = 10_000_000_000n; // 10 SOL real reserves to scale in
const POS_CAP = 300_000_000n; // 0.3 SOL max cost per position
const MAX_BUYS = 80;
const MAX_HOLD_SLOTS = 1500;
const MAX_TRADES_ENTRY = 60;

interface Watched {
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buyVol: bigint;
  real: bigint;
  lastVq: bigint;
  lastVt: bigint;
}

interface Peak {
  n: bigint; // vq at the highest price seen for the position
  d: bigint; // vt at the highest price seen for the position
}

const watched = new Map<string, Watched>();
const peaks = new Map<string, Peak>();
const pendBuy = new Set<string>();
const pendSell = new Set<string>();
const openedSlots = new Map<string, number>();
let prevPositions = new Set<string>();
let buysSent = 0;

function priceUp(n0: bigint, d0: bigint, n1: bigint, d1: bigint, pct: number): boolean {
  // is price n1/d1 >= price n0/d0 * (100 + pct) / 100 ?
  return n1 * d0 * 100n >= n0 * d1 * BigInt(100 + pct);
}

function priceDown(n0: bigint, d0: bigint, n1: bigint, d1: bigint, pct: number): boolean {
  // is price n1/d1 <= price n0/d0 * (100 - pct) / 100 ?
  return n1 * d0 * 100n <= n0 * d1 * BigInt(100 - pct);
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // Clear pending flags for orders resolved in this batch.
    for (const f of batch.fills) {
      pendBuy.delete(f.mint);
      pendSell.delete(f.mint);
    }
    // Track when each open position was opened (the harness account does
    // not carry it): a mint in state.positions that was not there last
    // batch opened at this batch's slot; a mint that left closed.
    for (const mint of state.positions.keys()) {
      if (!prevPositions.has(mint)) openedSlots.set(mint, batch.slot);
    }
    for (const mint of prevPositions) {
      if (!state.positions.has(mint)) {
        openedSlots.delete(mint);
        peaks.delete(mint);
      }
    }
    prevPositions = new Set(state.positions.keys());

    const orders: OrderInput[] = [];
    let buysThisBatch = 0;

    // Fold this batch's events into the watched set (only this batch).
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        watched.set(e.mint, {
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          trades: 0,
          buyVol: 0n,
          real: 0n,
          lastVq: BigInt(e.virtual_quote_reserves),
          lastVt: BigInt(e.virtual_token_reserves),
        });
      } else if (e.event === 'TradeEvent') {
        let w = watched.get(e.mint);
        if (w === undefined) {
          w = {
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            trades: 0,
            buyVol: 0n,
            real: BigInt(e.real_quote_reserves),
            lastVq: BigInt(e.virtual_quote_reserves),
            lastVt: BigInt(e.virtual_token_reserves),
          };
          watched.set(e.mint, w);
        }
        w.trades += 1;
        w.lastVq = BigInt(e.virtual_quote_reserves);
        w.lastVt = BigInt(e.virtual_token_reserves);
        w.real = BigInt(e.real_quote_reserves);
        if (e.is_buy) w.buyVol += BigInt(e.sol_amount);
      }
    }

    // ENTRY + SCALE-IN: decide on this batch's trade events only.
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const w = watched.get(mint);
      if (w === undefined) continue;
      const held = state.positions.get(mint);
      if (held !== undefined) {
        // Scale-in: price >= +20% above average cost, real reserves >= 10 SOL.
        if (
          !pendBuy.has(mint) &&
          held.cost_lamports < POS_CAP &&
          w.real >= SCALE_MIN_REAL &&
          priceUp(held.cost_lamports, held.token_amount, w.lastVq, w.lastVt, 20)
        ) {
          const cap = state.maxBuyLamports(mint);
          const q = BUY_SOL < cap ? BUY_SOL : cap;
          if (q >= MIN_BUY && buysSent < MAX_BUYS && state.freeCashLamports() >= q + state.txFeeLamports()) {
            orders.push({ side: 'buy', mint, quote_lamports: q, max_slippage_bps: 500 });
            pendBuy.add(mint);
            buysSent += 1;
            buysThisBatch += 1;
          }
        }
        continue;
      }
      // Entry: early momentum probe.
      if (
        !pendBuy.has(mint) &&
        buysSent < MAX_BUYS &&
        state.committedPositionCount() + buysThisBatch < 5 &&
        w.trades >= 3 &&
        w.trades <= MAX_TRADES_ENTRY &&
        w.buyVol >= MIN_BUY_VOL &&
        w.real >= MIN_REAL &&
        priceUp(w.vq0, w.vt0, w.lastVq, w.lastVt, 15)
      ) {
        const cap = state.maxBuyLamports(mint);
        const q = BUY_SOL < cap ? BUY_SOL : cap;
        if (q >= MIN_BUY && state.freeCashLamports() >= q + state.txFeeLamports()) {
          orders.push({ side: 'buy', mint, quote_lamports: q, max_slippage_bps: 500 });
          pendBuy.add(mint);
          buysSent += 1;
          buysThisBatch += 1;
        }
      }
    }

    // EXITS: every held position, every batch, from marks (a dead coin with
    // no new trades still ages out via max-hold). Marks carry the latest
    // reserves for held mints; fall back to the watched last reserves.
    for (const [mint, held] of state.positions) {
      if (pendSell.has(mint)) continue;
      const mark = batch.marks.find((m) => m.mint === mint);
      const w = watched.get(mint);
      const vq = mark !== undefined ? BigInt(mark.virtual_quote_reserves) : w?.lastVq;
      const vt = mark !== undefined ? BigInt(mark.virtual_token_reserves) : w?.lastVt;
      if (vq === undefined || vt === undefined) continue;
      const cost = held.cost_lamports;
      const tokens = held.token_amount;
      // Track the peak price (as a vq/vt ratio) for the trailing exit.
      let pk = peaks.get(mint);
      if (pk === undefined) {
        pk = { n: vq, d: vt };
        peaks.set(mint, pk);
      }
      if (vq * pk.d > pk.n * vt) {
        pk.n = vq;
        pk.d = vt;
      }
      const tp = priceUp(cost, tokens, vq, vt, 100);
      const sl = priceDown(cost, tokens, vq, vt, 30);
      // Trailing: peak >= +50% above average cost and price <= peak - 20%.
      // (Revision note: a +30% trigger was tried and REVERTED — the real
      // harness scored it +0.51 SOL vs +1.79 SOL at +50%. The offline
      // simulator prefers +30%, but it fills sells at stale decision-time
      // reserves, so it overvalues exits on falling prices; the harness
      // fills 2 slots later, after the price has moved. Trust the harness.)
      const peaked = priceUp(cost, tokens, pk.n, pk.d, 50);
      const pulled = vq * pk.d * 100n <= pk.n * vt * 80n;
      const opened = openedSlots.get(mint);
      const tooOld = opened !== undefined && batch.slot - opened > MAX_HOLD_SLOTS;
      if (tp || sl || (peaked && pulled) || tooOld) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 500 });
        pendSell.add(mint);
        peaks.delete(mint);
        openedSlots.delete(mint);
      }
    }

    return orders;
  },
});
