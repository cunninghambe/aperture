/**
 * Noise suppression.
 *
 * Pages mutate constantly for reasons the agent does not care about: clocks,
 * tickers, ad rotations, "posted 3 minutes ago" timestamps. Without this, a
 * page with a running clock emits a diff on every observation and the whole
 * token argument for diffing collapses.
 *
 * Three layers do the work, cheapest first:
 *
 *   1. Free by construction — we serialize semantics, not style. CSS
 *      animations, transforms and carousel translations produce no mutations
 *      we can see, so a spinning graphic costs nothing.
 *   2. Shape heuristics — text matching timer/counter shapes gets promoted to
 *      volatile after a single unprompted change rather than three.
 *   3. Behavioral tracking — this class. Anything that keeps changing on its
 *      own is demoted; anything the agent touches is promoted straight back.
 */

const HALF_LIFE_MS = 10_000;
const STREAK_THRESHOLD = 3;
const EWMA_THRESHOLD = 3;
const FAST_STREAK_THRESHOLD = 1;

interface Entry {
  ewma: number;
  last: number;
  streak: number;
  /** Recognized as a clock/counter by shape, so it skips the statistics. */
  shapeVolatile: boolean;
}

/** Text that is obviously a clock, a countdown, or a relative timestamp. */
const TIMER_SHAPE =
  /^\d{1,2}:\d{2}(:\d{2})?$|^\d+\s*(second|minute|hour|day)s?\s*ago$|^\d+$/i;

export class VolatilityTracker {
  private entries = new Map<string, Entry>();

  /**
   * Record that the rendered line for this key changed.
   *
   * `causedByAgentAction` is the important argument: a change that followed
   * the agent clicking something is signal, by definition, and must never be
   * suppressed. Only unprompted changes count toward volatility.
   */
  noteChange(
    key: string,
    now: number,
    causedByAgentAction: boolean,
    text?: string,
  ): void {
    const prev = this.entries.get(key);
    const e: Entry = prev ?? { ewma: 0, last: now, streak: 0, shapeVolatile: false };

    const decay = Math.pow(0.5, (now - e.last) / HALF_LIFE_MS);
    e.ewma = e.ewma * decay + 1;
    e.streak = causedByAgentAction ? 0 : e.streak + 1;
    e.last = now;

    // A clock does not need to prove itself statistically — it is recognizable
    // on sight, and waiting three ticks just means emitting three junk diffs.
    if (
      !causedByAgentAction &&
      text &&
      TIMER_SHAPE.test(text.trim()) &&
      e.streak >= FAST_STREAK_THRESHOLD
    ) {
      e.shapeVolatile = true;
    }

    this.entries.set(key, e);
  }

  isVolatile(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    if (e.shapeVolatile && e.streak >= FAST_STREAK_THRESHOLD) return true;
    return e.streak >= STREAK_THRESHOLD && e.ewma >= EWMA_THRESHOLD;
  }

  /**
   * The agent read or acted on this node, so it evidently cares. Suppression
   * must never hide something the agent is paying attention to — caring is
   * expressed through the tools, and this is where we listen for it.
   */
  onAgentTouch(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.streak = 0;
    e.shapeVolatile = false;
  }

  /** Keys currently suppressed, for the "(N live regions suppressed)" note. */
  volatileKeys(): string[] {
    return [...this.entries.keys()].filter((k) => this.isVolatile(k));
  }

  reset(): void {
    this.entries.clear();
  }
}
