import type { BusinessPhase } from "./businessTime";

export interface BusinessTimeActivity {
  phase: BusinessPhase;
  mode: string;
  writable: boolean;
  foreground: boolean;
  hidden: boolean;
  learningPlayback: boolean;
}

/** Releasing the mouse or opening the till is not a pause; learning and menus are. */
export function isBusinessTimeRunning(activity: BusinessTimeActivity): boolean {
  return activity.phase === "open" && (activity.mode === "playing" || activity.mode === "cashier") && activity.writable
    && activity.foreground && !activity.hidden && !activity.learningPlayback;
}

/**
 * Turns a monotonic foreground clock into active milliseconds, independently of
 * render FPS. Nothing is based on wall time, so a loaded save never gains offline
 * business time. Call reset when entering/leaving a pause or replacing a save.
 */
export class BusinessClockDriver {
  private lastActiveAt: number | null = null;

  reset(): void { this.lastActiveAt = null }

  /** Rebase at a user-driven resume/open action, without counting the prior gap. */
  resume(nowMs: number): void {
    this.lastActiveAt = Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : null;
  }

  sample(nowMs: number, running: boolean): number {
    if (!running || !Number.isFinite(nowMs) || nowMs < 0) {
      this.reset();
      return 0;
    }
    const previous = this.lastActiveAt;
    this.lastActiveAt = nowMs;
    if (previous === null || nowMs <= previous) return 0;
    const elapsed = nowMs - previous;
    // A suspended renderer/device can resume without a visibility event. Do not
    // turn that single stalled frame into a day's worth of unattended trading.
    return elapsed > 5_000 ? 0 : elapsed;
  }
}
