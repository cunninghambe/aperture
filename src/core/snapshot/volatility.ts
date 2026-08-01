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

interface Entry {
  ewma: number;
  last: number;
  streak: number;
  /** Recognized as a clock/counter by shape, so it skips the statistics. */
  shapeVolatile: boolean;
}

/**
 * Text that is obviously a clock, a countdown, or a relative timestamp.
 *
 * Deliberately does NOT match a bare integer. `^\d+$` swept up cart badges,
 * result counts, unread counts, quantities and un-symboled prices — exactly
 * the numbers an agent is most likely to be watching — and the shape fast-path
 * suppressed them after a single unprompted tick.
 */
const TIMER_SHAPE =
  /^\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$|^\d+\s*(second|minute|hour|day)s?\s*ago$|^(just now|yesterday)$/i;

export class VolatilityTracker {
  private entries = new Map<string, Entry>();

  /**
   * Record that the rendered line for this key changed.
   *
   * `causedByAgentAction` is the important argument: a change that followed
   * the agent clicking something is signal, by definition, and must never be
   * suppressed. Only unprompted changes count toward the *statistical* path.
   *
   * The shape path is different. In a pure act-observe loop EVERY observation
   * follows an action, so `causedByAgentAction` is always true and the
   * statistical path can never demote anything — which meant a ticking clock
   * rode along in every action diff forever, in exactly the loop this class
   * exists to protect. A clock is recognizable on sight regardless of what
   * the agent was doing, so the shape check now runs even after an action —
   * for every key EXCEPT the element the action actually targeted
   * (`actedKey`). Typing "10:30" into a time field must never mark that
   * field volatile.
   */
  noteChange(
    key: string,
    now: number,
    causedByAgentAction: boolean,
    text?: string,
    actedKey?: string,
  ): void {
    const prev = this.entries.get(key);
    const e: Entry = prev ?? { ewma: 0, last: now, streak: 0, shapeVolatile: false };

    const decay = Math.pow(0.5, (now - e.last) / HALF_LIFE_MS);
    e.ewma = e.ewma * decay + 1;
    e.streak = causedByAgentAction ? 0 : e.streak + 1;
    e.last = now;

    // A clock does not need to prove itself statistically — it is recognizable
    // on sight, and waiting three ticks just means emitting three junk diffs.
    if (text && TIMER_SHAPE.test(text.trim()) && key !== actedKey) {
      e.shapeVolatile = true;
    }

    this.entries.set(key, e);
  }

  isVolatile(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    if (e.shapeVolatile) return true;
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
