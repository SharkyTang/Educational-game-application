/** Minutes since midnight on the game clock, independent of the real-world clock. */
export const BUSINESS_PREPARE_MINUTE = 8 * 60 + 30;
export const BUSINESS_OPEN_MINUTE = 9 * 60;
export const BUSINESS_CLOSE_MINUTE = 19 * 60;
export const BUSINESS_WARNING_MINUTE = 18 * 60 + 30;

/** Old v9–v14 snapshots use this fixed duration during strict legacy validation. */
export const LEGACY_BUSINESS_DURATION_MS = 420_000;
/** Twelve minutes of active play correspond to the ten-hour business day. */
export const BUSINESS_DURATION_MS = 720_000;
const BUSINESS_MINUTES = BUSINESS_CLOSE_MINUTE - BUSINESS_OPEN_MINUTE;
const MS_PER_BUSINESS_MINUTE = BUSINESS_DURATION_MS / BUSINESS_MINUTES;
export const MIN_ARRIVAL_DELAY_MS = 2_000;
export const MAX_ARRIVAL_DELAY_MS = 4_000;
const DEFAULT_CUSTOMER_SEED = 31;

export type BusinessPhase = "preparing" | "open" | "closing" | "settled";

export interface BusinessClockInput {
  phase: BusinessPhase;
  /** Active real milliseconds spent open; excludes preparation, pauses and cleanup. */
  elapsedOpenMs: number;
}

export interface BusinessClock {
  /** Whole in-game minutes since midnight, rounded down for the displayed time. */
  minute: number;
  timeLabel: string;
  /** In-game minutes until the scheduled 19:00 close, rounded up, even after an early close. */
  remainingMinutes: number;
  /** Fraction of the scheduled open interval, bounded to [0, 1]. */
  progress: number;
  /** True only while open during 18:30–18:59. */
  closingSoon: boolean;
}

/** Non-finite elapsed values are invalid and fall back to the start of business. */
export function clampBusinessElapsedMs(elapsedOpenMs: number): number {
  if (!Number.isFinite(elapsedOpenMs)) return 0;
  return Math.min(BUSINESS_DURATION_MS, Math.max(0, elapsedOpenMs));
}

/**
 * Advance only when the caller is actively playing in the open phase.
 * Ignore negative/non-finite deltas; retain sub-millisecond fractions so frame
 * subdivision does not discard time. This helper never reads Date.now().
 */
export function advanceBusinessElapsedMs(elapsedOpenMs: number, deltaMs: number): number {
  const current = clampBusinessElapsedMs(elapsedOpenMs);
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return current;
  return current + Math.min(deltaMs, BUSINESS_DURATION_MS - current);
}

/** Format a daytime minute as HH:MM; invalid values use 00:00, outside values clamp to this day. */
export function formatBusinessMinute(minute: number): string {
  const normalized = Number.isFinite(minute) ? Math.min(24 * 60 - 1, Math.max(0, Math.floor(minute))) : 0;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export function getBusinessClock(input: BusinessClockInput): BusinessClock {
  const elapsed = input.phase === "preparing" ? 0 : clampBusinessElapsedMs(input.elapsedOpenMs);
  const minute = input.phase === "preparing" ? BUSINESS_PREPARE_MINUTE
    : BUSINESS_OPEN_MINUTE + Math.floor(elapsed / MS_PER_BUSINESS_MINUTE);
  return {
    minute,
    timeLabel: formatBusinessMinute(minute),
    remainingMinutes: Math.ceil((BUSINESS_DURATION_MS - elapsed) / MS_PER_BUSINESS_MINUTE),
    progress: elapsed / BUSINESS_DURATION_MS,
    closingSoon: input.phase === "open" && minute >= BUSINESS_WARNING_MINUTE && minute < BUSINESS_CLOSE_MINUTE,
  };
}

/** Saved identifiers make the next arrival delay stable across reloads and retries. */
export function customerArrivalDelayMs(seed: number | undefined, dayNumber: number, customerNumber: number): number {
  const safeSeed = typeof seed === "number" && Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff
    ? seed : DEFAULT_CUSTOMER_SEED;
  const safeDay = Number.isSafeInteger(dayNumber) && dayNumber >= 1 ? dayNumber : 1;
  const safeCustomer = Number.isSafeInteger(customerNumber) && customerNumber >= 1 ? customerNumber : 1;
  const key = `business-arrival:${safeSeed}:${safeDay}:${safeCustomer}`;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619) >>> 0;
  }
  return MIN_ARRIVAL_DELAY_MS + hash % (MAX_ARRIVAL_DELAY_MS - MIN_ARRIVAL_DELAY_MS + 1);
}
