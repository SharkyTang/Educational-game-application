import { describe, expect, it } from "vitest";
import {
  advanceDeliveryTime, createDeliveryState, deliveryRemainingMs, deliveryTruckX, departDelivery,
  isDeliveryTimeRunning, migrateDeliveryState, queueDelivery, validateDeliveryState, type DeliveryOrder,
} from "../../src/sim3d/delivery";

describe("saved FIFO delivery vehicle", () => {
  const orders = (): DeliveryOrder[] => [{ id: "first", receivedDay: null }, { id: "second", receivedDay: null }];
  it("prepares for six seconds, visibly approaches for six, then waits for the first explicit receipt", () => {
    const paid = orders();
    let state = queueDelivery(createDeliveryState(), paid);
    expect(state).toMatchObject({ phase: "preparing", orderId: "first" });
    expect(deliveryRemainingMs(state)).toBe(12_000);
    state = advanceDeliveryTime(state, paid, 6_000, false);
    expect(state).toMatchObject({ phase: "arriving", elapsedMs: 0 });
    expect(deliveryTruckX(state)).toBe(-25);
    state = advanceDeliveryTime(state, paid, 3_000, false);
    expect(deliveryTruckX(state)).toBe(-11);
    expect(deliveryRemainingMs(state)).toBe(3_000);
    state = advanceDeliveryTime(state, paid, 30_000, false);
    expect(state).toEqual({ phase: "ready", orderId: "first", elapsedMs: 0, blocked: false });
    expect(deliveryTruckX(state)).toBe(3);
    expect(advanceDeliveryTime(state, paid, 10_000, false)).toBe(state);
    expect(departDelivery(state, "second")).toBe(state);
    expect(validateDeliveryState(state, paid)).toBe(true);
  });
  it("finishes a four-second departure before preparing the next paid order", () => {
    const paid = orders();
    let state = migrateDeliveryState(paid);
    paid[0]!.receivedDay = 1;
    state = departDelivery(state, "first");
    expect(validateDeliveryState(state, paid)).toBe(true);
    state = advanceDeliveryTime(state, paid, 3_999, false);
    expect(state).toMatchObject({ phase: "departing", orderId: "first", elapsedMs: 3_999 });
    state = advanceDeliveryTime(state, paid, 1, false);
    expect(state).toEqual({ phase: "preparing", orderId: "second", elapsedMs: 0, blocked: false });
    state = advanceDeliveryTime(state, paid, 12_000, false);
    paid[1]!.receivedDay = 1;
    state = departDelivery(state, "second");
    state = advanceDeliveryTime(state, paid, 4_000, false);
    expect(state).toEqual(createDeliveryState());
    expect(validateDeliveryState(state, paid)).toBe(true);
  });
  it("preserves remainder across phase boundaries and is independent of frame subdivision", () => {
    const paid = orders();
    const original = queueDelivery(createDeliveryState(), paid);
    const single = advanceDeliveryTime(original, paid, 9_137.5, false);
    let divided = original;
    for (let index = 0; index < 365; index++) divided = advanceDeliveryTime(divided, paid, 25, false);
    divided = advanceDeliveryTime(divided, paid, 12.5, false);
    expect(divided).toEqual(single);
    expect(JSON.parse(JSON.stringify(single))).toEqual(single);
  });
  it("blocks driving without losing delivery time and resumes from the same position", () => {
    const paid = orders();
    const driving = advanceDeliveryTime(queueDelivery(createDeliveryState(), paid), paid, 8_000, false);
    const blocked = advanceDeliveryTime(driving, paid, 5_000, true);
    expect(blocked).toEqual({ ...driving, blocked: true });
    expect(deliveryTruckX(blocked)).toBe(deliveryTruckX(driving));
    expect(advanceDeliveryTime(blocked, paid, 5_000, true)).toBe(blocked);
    expect(advanceDeliveryTime(blocked, paid, 1_000, false)).toEqual({ ...driving, blocked: false, elapsedMs: 3_000 });
    const preparing = queueDelivery(createDeliveryState(), paid);
    expect(advanceDeliveryTime(preparing, paid, 2_000, true)).toMatchObject({ phase: "preparing", elapsedMs: 2_000, blocked: false });
  });
  it("does not restart an active order when another is queued", () => {
    const paid = orders();
    const state = advanceDeliveryTime(queueDelivery(createDeliveryState(), paid), paid, 4_000, false);
    paid.push({ id: "third", receivedDay: null });
    expect(queueDelivery(state, paid)).toBe(state);
    expect(migrateDeliveryState(paid)).toMatchObject({ phase: "ready", orderId: "first" });
    expect(migrateDeliveryState([])).toEqual(createDeliveryState());
  });
  it.each([NaN, Infinity, -1, 0])("rejects an invalid elapsed delta %s", (elapsed) => {
    const paid = orders();
    const state = queueDelivery(createDeliveryState(), paid);
    expect(advanceDeliveryTime(state, paid, elapsed, false)).toBe(state);
  });
  it("rejects altered FIFO, times and phase/order combinations", () => {
    const paid = orders();
    const ready = migrateDeliveryState(paid);
    for (const changed of [
      { ...ready, orderId: "second" }, { ...ready, orderId: "unknown" }, { ...ready, elapsedMs: 1 },
      { ...ready, blocked: true }, { ...ready, phase: "idle" }, { ...ready, phase: "arriving", elapsedMs: 6_000 },
      { ...ready, phase: "departing" }, { ...ready, elapsedMs: NaN }, { ...ready, phase: "preparing", blocked: true },
    ]) expect(validateDeliveryState(changed, paid)).toBe(false);
    expect(validateDeliveryState(ready, [{ id: "first", receivedDay: null }, { id: "second", receivedDay: 1 }])).toBe(false);
    expect(validateDeliveryState(createDeliveryState(), paid)).toBe(false);
  });
});

describe("delivery has its own pause gating", () => {
  const active = { phase: "open", mode: "playing", writable: true, foreground: true, hidden: false, learningPlayback: false };
  it.each(["preparing", "open", "closing"])("runs during %s, including normal cash checkout", (phase) => {
    expect(isDeliveryTimeRunning({ ...active, phase })).toBe(true);
    expect(isDeliveryTimeRunning({ ...active, phase, mode: "cashier" })).toBe(true);
  });
  it.each([
    { phase: "settled" }, { mode: "paused" }, { mode: "computer" }, { mode: "inspecting" },
    { writable: false }, { foreground: false }, { hidden: true }, { learningPlayback: true },
  ])("freezes for %j", (patch) => expect(isDeliveryTimeRunning({ ...active, ...patch })).toBe(false));
});
