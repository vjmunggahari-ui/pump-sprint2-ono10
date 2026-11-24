# Pump.fun Paper Sprint — Two-Tier Reserve-Flip Bot

A deterministic paper-trading bot for the make.fun "Pump.fun Paper Sprint:
Any Bot Can Win" competition. It replays pump.fun bonding-curve data and
trades fresh coins in their first few slots. Node 22, zero dependencies
besides the provided `vendor/makefun-bot.ts` shim.

## Strategy

**The opening is the whole trade.** A new coin's price jumps inside its
create slot, then decays with time. Measured on the 24h dev window:

- Coins whose real SOL reserves reach **20+ SOL at first sight** are the
  runners: they reach 3x their create price essentially always, and quick
  flips on them win roughly 2 in 3.
- Coins under ~8 SOL real reserves are dead on arrival (median peak barely
  above create price).
- Chasing spikes loses: fills land on spike tops. Buying the dip after a
  spike loses too.
- The dominant loss is a **coordinated multi-seller dump landing inside one
  slot** (price -60% before any exit can fill). No stop can react to it, so
  the defence is to be out before it happens.

**Two tiers:**

- **Tier A — the profit engine.** Buy coins with 20+ SOL real reserves at
  first sight, 0.5 SOL a trade. Exit at take-profit +8%, stop-loss -10%,
  trailing stop 8% below the peak, or max hold 1800 slots, whichever comes
  first.
- **Tier B — the minimum-bar filler.** Buy coins with 8–20 SOL real
  reserves at 0.015 SOL a trade (just above the 0.01 SOL round-trip floor),
  same exits, capped at 3 of the 5 position slots so it can never block a
  Tier A trade. It exists only to clear the 20-distinct-coin bar at minimal
  cost.

The bot tracks its own paper impact on each curve (its fills move the
reserves it is quoted against) and makes every decision from the harness
state with exact bigint arithmetic — no randomness, no wall-clock, no
network — so two runs produce byte-identical action logs.

## Backtest (dev window, 24h, own Python replay of the harness)

| Variant | Net PnL | Coins | Win rate | Max drawdown |
|---|---|---|---|---|
| Tier A only (20+ SOL, TP +8%) | +0.438 SOL | 34 | 73.5% | 2.3% |
| Two-tier (A + B 8–20 SOL) | **+0.421 SOL** | **257** | 41.9% | 2.3% |
| Two-tier, B band 5–20 SOL | +0.319 SOL | 397 | 36.1% | 3.1% |
| Sniper momentum (+8% trigger, TP +60%) | −2.775 SOL | 544 | 18.2% | 28.7% |
| Buy-everything early + flip | −0.851 SOL | — | 19.8% | 8.9% |
| Reserve hold (TP +300%, long hold) | −3.570 SOL | 188 | 17.0% | 36.7% |

The chosen two-tier variant is the best net PnL that also clears the
minimum bar with a wide margin (257 distinct coins vs 20 required) on the
full window, and it stays above 20 counted coins in every 6-hour slice of
the dev window (worst slice: 29 coins).

## Run

The entrypoint is `main.ts` (run by the grader as `node /bot/main.ts`).
Local grading uses the kit's `grade-local` with `--driver process`.

## Badges

[![Bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vjmunggahari-ui/pump-sprint2-ono10/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vjmunggahari-ui/pump-sprint2-ono10/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
