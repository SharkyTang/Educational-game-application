import { describe, expect, it } from "vitest";
import { BusinessClockDriver, isBusinessTimeRunning, type BusinessTimeActivity } from "../../src/sim3d/businessClockDriver";

const playing: BusinessTimeActivity = {
  phase: "open", mode: "playing", writable: true, foreground: true, hidden: false, learningPlayback: false,
};

describe("business time activity policy", () => {
  it("runs while serving, carrying, scanning or using a free mouse in active play", () => {
    expect(isBusinessTimeRunning(playing)).toBe(true);
    expect(isBusinessTimeRunning({ ...playing, mode: "cashier" })).toBe(true);
  });

  it.each(["preparing", "closing", "settled"] as const)("does not run in %s", (phase) => {
    expect(isBusinessTimeRunning({ ...playing, phase })).toBe(false);
  });

  it.each(["loading", "start", "paused", "inspecting", "street-dialogue", "readonly", "error"])("does not run on the %s screen", (mode) => {
    expect(isBusinessTimeRunning({ ...playing, mode })).toBe(false);
  });

  it.each<Partial<BusinessTimeActivity>>([
    { writable: false }, { foreground: false }, { hidden: true }, { learningPlayback: true },
  ])("pauses safely for %j", (change) => {
    expect(isBusinessTimeRunning({ ...playing, ...change })).toBe(false);
  });
});

describe("active monotonic clock driver", () => {
  it("does not charge loading or time before the first active frame", () => {
    const clock = new BusinessClockDriver();
    expect(clock.sample(60_000, true)).toBe(0);
    expect(clock.sample(60_125, true)).toBe(125);
  });

  it("counts equal elapsed time at different frame rates without per-frame rounding", () => {
    const sample = (frames: number[]): number => {
      const clock = new BusinessClockDriver();
      clock.resume(0);
      return frames.reduce((sum, at) => sum + clock.sample(at, true), 0);
    };
    expect(sample([10.5, 100.25, 230.75, 999.5, 1_000])).toBe(1_000);
    expect(sample([1_000])).toBe(1_000);
    expect(sample([250, 500, 750, 1_000])).toBe(1_000);
  });

  it("ignores a pause gap even when paused frames were never rendered", () => {
    const clock = new BusinessClockDriver();
    clock.resume(0);
    expect(clock.sample(100, true)).toBe(100);
    clock.reset();
    expect(clock.sample(600_000, true)).toBe(0);
    expect(clock.sample(600_100, true)).toBe(100);
  });

  it("can resume exactly at the user action before the next frame", () => {
    const clock = new BusinessClockDriver();
    clock.resume(0);
    expect(clock.sample(100, true)).toBe(100);
    expect(clock.sample(200, false)).toBe(0);
    clock.resume(25_000);
    expect(clock.sample(25_125, true)).toBe(125);
  });

  it("neither counts paused frames nor retroactively charges them on resumption", () => {
    const clock = new BusinessClockDriver();
    clock.resume(0);
    expect(clock.sample(50, true)).toBe(50);
    expect(clock.sample(100, false)).toBe(0);
    expect(clock.sample(10_000, false)).toBe(0);
    expect(clock.sample(10_100, true)).toBe(0);
    expect(clock.sample(10_200, true)).toBe(100);
  });

  it("does not finish a day because the device suspended without a visibility event", () => {
    const clock = new BusinessClockDriver();
    clock.resume(0);
    expect(clock.sample(420_000, true)).toBe(0);
    expect(clock.sample(420_100, true)).toBe(100);
  });

  it.each([NaN, Infinity, -Infinity, -1])("handles malformed timestamp %s and rebases safely", (at) => {
    const clock = new BusinessClockDriver();
    clock.resume(0);
    expect(clock.sample(at, true)).toBe(0);
    expect(clock.sample(100, true)).toBe(0);
    expect(clock.sample(200, true)).toBe(100);
  });

  it("ignores duplicate or reversed monotonic timestamps", () => {
    const clock = new BusinessClockDriver();
    clock.resume(500);
    expect(clock.sample(500, true)).toBe(0);
    expect(clock.sample(400, true)).toBe(0);
    expect(clock.sample(500, true)).toBe(100);
  });
});
