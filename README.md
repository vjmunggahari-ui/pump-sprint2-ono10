# Pump Sprint v2 — Early Snipe + Strict Scale-In

[![bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vjmunggahari-ui/pump-sprint2-ono10/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/vjmunggahari-ui/pump-sprint2-ono10/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A lean, fast paper-trading bot for the pump.fun replay sprint. v1 timed out
on the server wall budget, so v2 is built to grade fast: O(events) work per
batch, no map scans, at most 5 positions, at most 80 buys per run.

## Strategy

- **Entry (probe):** a new coin with ≥ 3 trades, ≥ 0.5 SOL of buy volume,
  real reserves ≥ 2 SOL, and price ≥ +15% vs its create price gets a small
  buy of min(0.3 SOL, 1% of real reserves).
- **Scale-in (winners only):** while a position is open, if its price is
  ≥ +20% above its average cost and real reserves are ≥ 10 SOL, buy more
  (up to 0.3 SOL total position cost). Losers never get a second buy.
- **Exit:** sell everything if price ≥ +100% vs average cost, or
  ≤ −30% vs average cost, or it pulls back 20% from a peak that was
  ≥ +50% above average cost, or it has been held > 1500 slots.

## Measured on the dev dataset (grade-local, process driver)

- Net PnL **+1.79 SOL** after all fees.
- **39 distinct coins** (minimum bar: 20), 105 fills, 41 round trips,
  max drawdown 6.3%.
- Top 3 coins made +1.65 SOL of gains (52% share); without the top 3 the
  bot still nets +0.14 SOL — the win is not a single coin.
- Beats every house baseline on dev: momentum −9.45 SOL, reversion −4.37,
  sniper −0.42, equal-weight −0.02, hold-cash 0.00. Beats v1's +0.48 SOL
  by 3.7×, with a leaner/faster run (105 fills vs v1's heavier profile).
