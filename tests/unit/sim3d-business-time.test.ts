import { describe, expect, it, vi } from "vitest";
import {
  BUSINESS_CLOSE_MINUTE, BUSINESS_DURATION_MS, BUSINESS_OPEN_MINUTE, BUSINESS_PREPARE_MINUTE,
  BUSINESS_WARNING_MINUTE, advanceBusinessElapsedMs, clampBusinessElapsedMs, customerArrivalDelayMs,
  formatBusinessMinute, getBusinessClock, type BusinessPhase,
} from "../../src/sim3d/businessTime";

describe("active-play business clock", () => {
  it("defines preparation and the ten-hour opening interval in seven real minutes", () => {
    expect(BUSINESS_PREPARE_MINUTE).toBe(510);
    expect(BUSINESS_OPEN_MINUTE).toBe(540);
    expect(BUSINESS_CLOSE_MINUTE).toBe(1140);
    expect(BUSINESS_WARNING_MINUTE).toBe(1110);
    expect(BUSINESS_DURATION_MS).toBe(420_000);
  });

  it("keeps preparation at 08:30 and does not consume the opening interval", () => {
    const expected = { minute: 510, timeLabel: "08:30", remainingMinutes: 600, progress: 0, closingSoon: false };
    for (const elapsedOpenMs of [0, 90_000, BUSINESS_DURATION_MS, NaN, Infinity]) {
      expect(getBusinessClock({ phase: "preparing", elapsedOpenMs })).toEqual(expected);
    }
  });

  it.each([
    [0, 540, "09:00", 600, 0],
    [700, 541, "09:01", 599, 1 / 600],
    [210_000, 840, "14:00", 300, .5],
    [420_000, 1140, "19:00", 0, 1],
    [450_000, 1140, "19:00", 0, 1],
  ] as const)("converts %i active milliseconds without using the computer clock", (elapsedOpenMs, minute, timeLabel, remainingMinutes, progress) => {
    expect(getBusinessClock({ phase: "open", elapsedOpenMs })).toEqual({ minute, timeLabel, remainingMinutes, progress, closingSoon: false });
  });

  it("rounds the displayed minute down and remaining time up between minute boundaries", () => {
    expect(getBusinessClock({ phase: "open", elapsedOpenMs: 699.5 })).toMatchObject({ timeLabel: "09:00", remainingMinutes: 600 });
    expect(getBusinessClock({ phase: "open", elapsedOpenMs: 700.5 })).toMatchObject({ timeLabel: "09:01", remainingMinutes: 599 });
    expect(getBusinessClock({ phase: "open", elapsedOpenMs: BUSINESS_DURATION_MS - .5 })).toMatchObject({ timeLabel: "18:59", remainingMinutes: 1 });
  });

  it("warns from exactly 18:30 until the scheduled close, and only while open", () => {
    const warningElapsedMs = 399_000;
    expect(getBusinessClock({ phase: "open", elapsedOpenMs: warningElapsedMs - 1 })).toMatchObject({ timeLabel: "18:29", closingSoon: false });
    expect(getBusinessClock({ phase: "open", elapsedOpenMs: warningElapsedMs })).toMatchObject({ timeLabel: "18:30", remainingMinutes: 30, closingSoon: true });
    expect(getBusinessClock({ phase: "open", elapsedOpenMs: BUSINESS_DURATION_MS - 1 }).closingSoon).toBe(true);
    expect(getBusinessClock({ phase: "open", elapsedOpenMs: BUSINESS_DURATION_MS }).closingSoon).toBe(false);
    for (const phase of ["preparing", "closing", "settled"] as const) {
      expect(getBusinessClock({ phase, elapsedOpenMs: warningElapsedMs }).closingSoon).toBe(false);
    }
  });

  it.each(["closing", "settled"] as const)("preserves the actual early-close time in %s", (phase) => {
    expect(getBusinessClock({ phase, elapsedOpenMs: 210_000 })).toEqual({
      minute: 840, timeLabel: "14:00", remainingMinutes: 300, progress: .5, closingSoon: false,
    });
    expect(getBusinessClock({ phase, elapsedOpenMs: 0 }).timeLabel).toBe("09:00");
    expect(getBusinessClock({ phase, elapsedOpenMs: BUSINESS_DURATION_MS }).timeLabel).toBe("19:00");
  });

  it.each([NaN, Infinity, -Infinity, -1])("normalizes invalid/negative elapsed %s to a safe start", (elapsedOpenMs) => {
    expect(clampBusinessElapsedMs(elapsedOpenMs)).toBe(0);
    expect(getBusinessClock({ phase: "open", elapsedOpenMs })).toMatchObject({ timeLabel: "09:00", remainingMinutes: 600, progress: 0 });
  });

  it("clamps overshoots but preserves fractional elapsed milliseconds", () => {
    expect(clampBusinessElapsedMs(Number.MAX_VALUE)).toBe(BUSINESS_DURATION_MS);
    expect(clampBusinessElapsedMs(1234.125)).toBe(1234.125);
    expect(advanceBusinessElapsedMs(BUSINESS_DURATION_MS - 1, Number.MAX_VALUE)).toBe(BUSINESS_DURATION_MS);
    expect(advanceBusinessElapsedMs(BUSINESS_DURATION_MS, 60_000)).toBe(BUSINESS_DURATION_MS);
  });

  it.each([NaN, Infinity, -Infinity, -20, 0])("ignores delta %s without rewinding valid accumulated time", (deltaMs) => {
    expect(advanceBusinessElapsedMs(123_456, deltaMs)).toBe(123_456);
  });

  it("produces the same result for small steps and one large active step", () => {
    let elapsed = 0;
    for (let step = 0; step < 12_000; step += 1) elapsed = advanceBusinessElapsedMs(elapsed, 17.5);
    expect(elapsed).toBe(advanceBusinessElapsedMs(0, 210_000));
    expect(getBusinessClock({ phase: "open", elapsedOpenMs: elapsed }).timeLabel).toBe("14:00");
    for (let step = 0; step < 24_000; step += 1) elapsed = advanceBusinessElapsedMs(elapsed, 17.5);
    expect(elapsed).toBe(advanceBusinessElapsedMs(210_000, 420_000));
    expect(elapsed).toBe(BUSINESS_DURATION_MS);
  });

  it("leaves pausing to the caller and never advances from wall-clock time or render calls", () => {
    vi.useFakeTimers();
    try {
      let elapsed = advanceBusinessElapsedMs(0, 25_000);
      const before = getBusinessClock({ phase: "open", elapsedOpenMs: elapsed });
      vi.setSystemTime(new Date("2030-08-31T21:00:00Z"));
      // A paused caller keeps its persisted elapsed value and does not call advance.
      expect(getBusinessClock({ phase: "open", elapsedOpenMs: elapsed })).toEqual(before);
      elapsed = advanceBusinessElapsedMs(elapsed, 700);
      expect(elapsed).toBe(25_700);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mutate an input snapshot in any phase", () => {
    for (const phase of ["preparing", "open", "closing", "settled"] satisfies BusinessPhase[]) {
      const state = Object.freeze({ phase, elapsedOpenMs: 12_345 });
      getBusinessClock(state);
      expect(state).toEqual({ phase, elapsedOpenMs: 12_345 });
    }
  });
});

describe("daytime labels", () => {
  it.each([
    [0, "00:00"], [5, "00:05"], [510, "08:30"], [540, "09:00"], [599.9, "09:59"],
    [1140, "19:00"], [1439, "23:59"], [2000, "23:59"], [-1, "00:00"],
    [NaN, "00:00"], [Infinity, "00:00"], [-Infinity, "00:00"],
  ] as const)("formats %s safely as %s", (minute, label) => {
    expect(formatBusinessMinute(minute)).toBe(label);
  });
});

describe("deterministic customer arrival delays", () => {
  it("keeps an 8–12 second integer-millisecond delay for ordinary and very large visit numbers", () => {
    for (const seed of [0, 1, 31, 0xffffffff]) {
      for (const day of [1, 2, 10, Number.MAX_SAFE_INTEGER]) {
        for (const customer of [1, 2, 8, 50, Number.MAX_SAFE_INTEGER]) {
          const delay = customerArrivalDelayMs(seed, day, customer);
          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(8_000);
          expect(delay).toBeLessThanOrEqual(12_000);
        }
      }
    }
  });

  it("reuses the same delay for saved identifiers while all three inputs affect the schedule", () => {
    const schedule = (seed: number, day: number) => Array.from({ length: 20 }, (_, index) => customerArrivalDelayMs(seed, day, index + 1));
    const first = schedule(31, 1);
    expect(schedule(31, 1)).toEqual(first);
    expect(schedule(32, 1)).not.toEqual(first);
    expect(schedule(31, 2)).not.toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(1);
    const restored: { seed: number; day: number; customer: number } = JSON.parse(JSON.stringify({ seed: 31, day: 1, customer: 7 }));
    expect(customerArrivalDelayMs(restored.seed, restored.day, restored.customer)).toBe(first[6]);
  });

  it.each([undefined, NaN, Infinity, -Infinity, -1, .5, 0x1_0000_0000])("uses the legacy seed for invalid or absent seed %s", (seed) => {
    expect(customerArrivalDelayMs(seed, 2, 3)).toBe(customerArrivalDelayMs(31, 2, 3));
  });

  it.each([NaN, Infinity, -Infinity, -1, 0, .5, Number.MAX_SAFE_INTEGER + 1])("uses the first day/visit for invalid identifier %s", (invalid) => {
    expect(customerArrivalDelayMs(31, invalid, 3)).toBe(customerArrivalDelayMs(31, 1, 3));
    expect(customerArrivalDelayMs(31, 2, invalid)).toBe(customerArrivalDelayMs(31, 2, 1));
  });
});
