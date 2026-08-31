import { describe, expect, it } from "vitest";
import {
  createFirstDayState, isWalkablePosition, reduceSim, validateSimState,
  type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { STREET_VENUES, getStreetProgress, getVenueProgress } from "../../src/sim3d/progression";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, result.message).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function serveDay(state: SimState): SimState {
  state = act(state, { type: "PURCHASE_STOCK", orderId: `street-day-${state.day.number}`, pairs: 3 });
  state = act(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    const goods = state.items.filter((item) => item.productId === productId && item.location.kind === "crate");
    for (let slot = 0; slot < 3; slot += 1) {
      state = act(state, { type: "TAKE_ITEM", itemId: goods[slot]!.id });
      state = act(state, { type: "STOCK", productId, slot });
    }
  }
  for (let customer = 0; customer < 3; customer += 1) {
    state = act(state, { type: customer === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" });
    for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout")) {
      state = act(state, { type: "SCAN", itemId: item.id });
    }
    state = act(state, { type: "PAY", success: true });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
  }
  return state;
}

describe("business milestones for future high street venues", () => {
  it("shows every future shop and its concrete requirements while a new store remains Lv 1", () => {
    const state = createFirstDayState();
    expect(getStreetProgress(state)).toMatchObject({ level: 1, experience: 0, nextLevelExperience: 30, levelExperience: 0, paidOrders: 0, settledDays: 0 });
    expect(STREET_VENUES.map((venue) => venue.id)).toEqual(["cafe", "restaurant", "supermarket"]);
    for (const venue of STREET_VENUES) {
      const progress = getVenueProgress(state, venue.id);
      expect(progress.statusText).toBe("暂未开放");
      expect(progress.eligible).toBe(false);
      expect(progress.requirements[0]).toMatchObject({ id: "level", current: 1, target: venue.requiredLevel, completed: false });
    }
    expect(getVenueProgress(state, "supermarket").requirements).toContainEqual({ id: "upgrade", label: "完成小店货架扩容", current: 0, target: 1, completed: false });
  });

  it("does not turn purchasing, delivery, inspection or a failed payment into business or English mastery", () => {
    let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "no-experience-for-orders", pairs: 1 });
    expect(getStreetProgress(state).experience).toBe(0);
    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = act(state, { type: "INSPECT", productId: "milk" });
    expect(getStreetProgress(state).experience).toBe(0);
    for (const productId of ["milk", "bread"] as const) {
      const item = state.items.find((candidate) => candidate.productId === productId)!;
      state = act(state, { type: "TAKE_ITEM", itemId: item.id });
      state = act(state, { type: "STOCK", productId, slot: 0 });
    }
    state = act(state, { type: "OPEN_STORE" });
    for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items) state = act(state, { type: "SCAN", itemId: item.id });
    expect(reduceSim(state, { type: "PAY", success: false }).state).toBe(state);
    expect(getStreetProgress(state).experience).toBe(0);
    state = act(state, { type: "PAY", success: true });
    const before = structuredClone(state);
    expect(getStreetProgress(state)).toMatchObject({ level: 1, experience: 10, levelExperience: 10, paidOrders: 1 });
    expect(reduceSim(state, { type: "PAY", success: true }).state).toBe(state);
    expect(getStreetProgress(state).experience).toBe(10);
    getVenueProgress(state, "cafe");
    expect(state).toEqual(before);
    expect(state.inspectedProducts).toEqual(["milk"]);
  });

  it("requires the first actual day-end as well as Lv 2 for the café", () => {
    let state = serveDay(createFirstDayState());
    expect(getStreetProgress(state)).toMatchObject({ level: 2, experience: 30, levelExperience: 0, nextLevelExperience: 60 });
    expect(getVenueProgress(state, "cafe").eligible).toBe(false);
    expect(getVenueProgress(state, "cafe").requirements[1]).toMatchObject({ current: 0, target: 1, completed: false });
    state = act(state, { type: "SETTLE_DAY" });
    expect(getVenueProgress(state, "cafe")).toMatchObject({ eligible: true, statusText: "条件已达成·筹备中" });
    const progress = getStreetProgress(state);
    expect(reduceSim(state, { type: "SETTLE_DAY" }).state).toBe(state);
    expect(getStreetProgress(state)).toEqual(progress);
  });

  it("derives paid-order and expansion milestones from conserved multi-day business history", () => {
    let state = createFirstDayState();
    for (let day = 1; day <= 10; day += 1) {
      state = serveDay(state);
      state = act(state, { type: "SETTLE_DAY" });
      if (day === 3) expect(getVenueProgress(state, "restaurant").requirements[1]).toMatchObject({ current: 9, target: 12, completed: false });
      if (day === 4) expect(getVenueProgress(state, "restaurant")).toMatchObject({ eligible: true, statusText: "条件已达成·筹备中" });
      if (day < 10) state = act(state, { type: "START_NEXT_DAY" });
    }
    expect(getStreetProgress(state)).toMatchObject({ paidOrders: 30, settledDays: 10, experience: 300, level: 11 });
    expect(getVenueProgress(state, "supermarket").eligible).toBe(false);
    expect(getVenueProgress(state, "supermarket").requirements.find((entry) => entry.id === "upgrade")?.completed).toBe(false);
    state = act(state, { type: "BUY_UPGRADE" });
    expect(getVenueProgress(state, "supermarket")).toMatchObject({ eligible: true, statusText: "条件已达成·筹备中" });
    expect(state.inspectedProducts).toEqual([]);
    expect(getStreetProgress(JSON.parse(JSON.stringify(state)) as SimState)).toEqual(getStreetProgress(state));
  });
});

describe("indoor and street save boundaries", () => {
  it("allows the street and the shop to meet without breaking the doorway for a player radius", () => {
    expect(isWalkablePosition({ x: 0, z: -4.6 }, 0.24)).toBe(true);
    expect(isWalkablePosition({ x: 0, z: -4.5 }, 0.24)).toBe(true);
    expect(isWalkablePosition({ x: 0, z: -4.7 }, 0.24)).toBe(true);
    expect(isWalkablePosition({ x: 15, z: -8 }, 0.24)).toBe(true);
    expect(isWalkablePosition({ x: -15, z: -8 }, 0.24)).toBe(true);
    expect(isWalkablePosition({ x: 3.3, z: -4.7 }, 0.24)).toBe(false);
  });

  it.each([
    { x: 8, z: 0 }, { x: -8, z: 0 }, { x: 21, z: -10 }, { x: 0, z: -21 }, { x: 0, z: 5 },
    { x: Number.NaN, z: 0 }, { x: 0, z: Number.POSITIVE_INFINITY },
  ])("rejects inaccessible saved location $x,$z", (position) => {
    expect(isWalkablePosition(position)).toBe(false);
    const state = createFirstDayState();
    expect(reduceSim(state, { type: "SAVE_POSE", pose: { ...position, yaw: 0, pitch: 0 } }).state).toBe(state);
    const broken = { ...state, playerPose: { ...position, yaw: 0, pitch: 0 } };
    expect(validateSimState(broken)).toBe(false);
  });

  it("round-trips a street position and rejects a player radius crossing the outer edge", () => {
    const state = act(createFirstDayState(), { type: "SAVE_POSE", pose: { x: -13, z: -8, yaw: 0.4, pitch: 0.2 } });
    expect(validateSimState(JSON.parse(JSON.stringify(state)))).toBe(true);
    expect(isWalkablePosition({ x: 19.9, z: -8 }, 0.24)).toBe(false);
    expect(isWalkablePosition({ x: 0, z: -19.9 }, 0.24)).toBe(false);
    expect(isWalkablePosition({ x: 0, z: 0 }, -1)).toBe(false);
  });
});
