// BTC race bot — EMA-gated hold, long only, one trade (btc-race-24h-20261123-0511).
//
// Why this shape: a full-size round trip costs about 26 bps (4 bps fee +
// 2 bps slippage + roughly 20 bps of pool impact), so a bot that trades
// often bleeds to death in chop. The active modes all lost money on the
// earlier dev windows (bounce, trend24, ema-cross, adx, rsi-bollinger),
// while buy-and-hold shapes won. This bot therefore buys once and holds
// to the end — but it does not buy blindly at a fixed bar.
//
// Entry, checked every 24 bars once 25 closes are on file:
//   1. the 24-bar return is above -100% (a sanity floor that is always
//      true in practice), and
//   2. the close sits above the 240-bar slow EMA (the 4-hour trend).
// The EMA gate is the whole point: on a falling open it keeps the bot in
// cash instead of catching the drop, and it makes the bot's orders differ
// from the house momentum bot, which buys at bar 24 no matter what.
// Exit, checked on every bar while a position is open:
//   1. trailing stop, 5% below the highest close since entry;
//   2. hard stop, 4% below the entry close.
// Both are crash-only exits: on the dev window neither fired.
//
// Local grades (kit grade-local, process driver, two executions must match):
//   - this instance's dev window (2026-11-22 05:11 UTC - 2026-11-23 05:11 UTC):
//     net PnL +$30.64, 1 trade, 100% win, max drawdown 1.98%, fees $0.81
//     (at 2x fees still +$29.82) — passes the dev gate (net PnL above $0).
//   - the two previous instances' dev windows, same bot, no re-tuning:
//     20261118: -$13.59 (the ungated hold lost -$23.87 there, so the gate
//     cut the falling-window loss almost in half); 20261117: -$1.22.
//     Mean across the three windows +$5.28, the best of every shape tried,
//     and the best worst-case too. The gate that matters for racing is
//     this instance's dev window; no parameter was picked from the race
//     window, which is unseen by everyone until it runs.
//   - shapes rejected on this instance's dev window: breakout -$7.97,
//     ema-cross -$114.83, rsi-bollinger -$9.32, adx-momentum -$11.20.
//     The ungated hold (+$34.94) was rejected too: it buys at bar 24 on
//     every window, exactly like the house momentum bot, so its action
//     log would be byte-identical to a house entry and take no prize.
//
// Determinism: no network, no clock, no randomness. Every decision is a
// pure function of the bars seen so far, so two runs produce identical
// orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Tunables. The entry check runs every 24 bars; the slow EMA is the
// 4-hour trend (240 one-minute bars).
const PARAMS = {
  emaSlow: 240, // slow EMA length in bars
  trail: 0.05, // trailing stop, fraction below the peak close
  stop: 0.04, // hard stop, fraction below the entry close
  cooldown: 60, // bars to wait after an exit before re-entering
  entryEvery: 24, // bars between entry checks
  entryThresh: -1.0, // entry: buy when the 24-bar return beats this
};

type Params = typeof PARAMS;

class EmaGatedHoldBot {
  private p: Params;
  private closes: number[] = [];
  private slowEma: number | null = null;
  private holding = false;
  private entryClose: number | null = null;
  private peakClose: number | null = null;
  private cooldownUntil = -1;

  constructor(params?: Partial<Params>) {
    this.p = { ...PARAMS, ...params };
  }

  private static ema(prev: number | null, x: number, n: number): number {
    const k = 2 / (n + 1);
    return prev === null ? x : prev + k * (x - prev);
  }

  // Keep the position bookkeeping in sync with the replay's actual
  // holdings: if the replay shows a position we did not record (for
  // example a fill from an earlier order), adopt it as our entry.
  private syncHolding(state: BarsState, close: number): void {
    const h = state.positions.get(SYMBOL);
    if (h !== undefined && !this.holding) {
      const qty = h.qty;
      this.entryClose = qty > 0n ? Number((h.cost * 10_000_000n) / qty) : close;
      this.peakClose = close;
      this.holding = true;
    } else if (h === undefined) {
      this.holding = false;
      this.entryClose = null;
      this.peakClose = null;
    }
  }

  private sellAll(state: BarsState): OrderInput[] {
    const h = state.positions.get(SYMBOL);
    if (h === undefined || h.qty <= 0n) return [];
    this.cooldownUntil = state.seq + this.p.cooldown;
    this.holding = false;
    return [{ side: 'sell', symbol: SYMBOL, qty: h.qty, max_slippage_bps: 200 }];
  }

  private buyAll(state: BarsState): OrderInput[] {
    const room = state.weightRoom(SYMBOL);
    const amount = state.cash < room ? state.cash : room;
    if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: 200 }];
  }

  private record(bar: { c: string }): void {
    const c = Number(bar.c);
    this.closes.push(c);
    this.slowEma = EmaGatedHoldBot.ema(this.slowEma, c, this.p.emaSlow);
  }

  decide(state: BarsState, seq: number): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (state.warmingUp) {
      if (bar !== undefined) this.record(bar);
      return [];
    }
    if (bar === undefined) return [];
    this.record(bar);
    const close = Number(bar.c);
    this.syncHolding(state, close);
    if (this.holding) {
      this.peakClose = Math.max(this.peakClose as number, close);
      if (close <= (this.peakClose as number) * (1 - this.p.trail)) return this.sellAll(state);
      if (close <= (this.entryClose as number) * (1 - this.p.stop)) return this.sellAll(state);
      return []; // hold to the end; only the crash exits apply
    }
    // Flat: test the gated entry once every `entryEvery` bars.
    const lb = this.p.entryEvery;
    if (seq % lb !== 0 || this.closes.length < lb + 1) return [];
    const ret = close / this.closes[this.closes.length - lb - 1] - 1;
    if (ret <= this.p.entryThresh) return [];
    if (this.slowEma === null || close <= this.slowEma) return [];
    return this.buyAll(state);
  }
}

const bot = new EmaGatedHoldBot();

await runBars({
  onBatch(state, batch) {
    return bot.decide(state, batch.seq);
  },
});
