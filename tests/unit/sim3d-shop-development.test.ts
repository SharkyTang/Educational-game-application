import { describe, expect, it } from "vitest";
import {
  createFirstDayState, getDaySummary, getShopLayoutObstacles, isWalkablePosition, reduceSim, validateSimState,
  type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { createInitialRenovation, getShopAchievements, getShopExpansionOffer,
  SECOND_SHOP_EXPANSION_COST_PENCE, SHOP_EXPANSION_COST_PENCE } from "../../src/sim3d/shopDevelopment";
import { validateShopLayout, type ShopLayout } from "../../src/sim3d/shopLayout";
import { payScannedCheckout } from "../helpers/sim3dPayment";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(result.state.revision).toBe(state.revision + 1);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function rejected(state: SimState, command: SimCommand): string {
  const before = structuredClone(state);
  const result = reduceSim(state, command);
  expect(result.changed, command.type).toBe(false);
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
  return result.message ?? "";
}

function prepared(state = createFirstDayState()): SimState {
  state = act(state, { type: "PURCHASE_STOCK", orderId: `renovation-day-${state.day.number}`, pairs: 3 });
  state = act(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
    for (let slot = 0; slot < 3; slot += 1) state = act(state, { type: "STOCK", productId, slot });
    state = act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position });
  }
  return state;
}

function sold(state: SimState): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  while (state.customer.phase !== "checkout") state = act(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  state = payScannedCheckout(state);
  return act(state, { type: "CUSTOMER_ADVANCE" });
}

/** All funds come from real purchased stock and confirmed card/cash receipts. */
function earned(days = 1): SimState {
  let state = createFirstDayState();
  for (let day = 0; day < days; day += 1) {
    if (day) state = act(state, { type: "START_NEXT_DAY" });
    state = prepared(state);
    for (let order = 0; order < 3; order += 1) state = sold(state);
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "SETTLE_DAY" });
  }
  return state;
}

function movedMilk(state: SimState, rotation: 1 | 3 = 1): ShopLayout {
  const layout = structuredClone(state.renovation.layout);
  Object.assign(layout.placements.find((placement) => placement.id === "milk-fridge")!, { x: 0, z: 1, rotation });
  expect(validateShopLayout(layout).valid).toBe(true);
  return layout;
}

describe("v13 staged shop expansion as a separate audited investment", () => {
  it("starts with the same capital and stock, with no purchased floor or layout achievement", () => {
    const state = createFirstDayState();
    expect(state.schemaVersion).toBe(13);
    expect(state.cashPence).toBe(1200);
    expect(state.items).toEqual([]);
    expect(state.renovation).toMatchObject(createInitialRenovation());
    expect(state.renovation.layout.equipment).toEqual([]);
    expect(getDaySummary(state).expansionSpendPence).toBe(0);
    expect(getShopLayoutObstacles(state)).toEqual([]);
    expect(getShopExpansionOffer(state)).toMatchObject({ allowed: false, costPence: 1500 });
    expect(rejected(state, { type: "BUY_SPACE_EXPANSION" })).toContain("还差");
  });

  it("does not count a zero-order day as the first completed business achievement", () => {
    const empty = act(act(createFirstDayState(), { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
    expect(getShopAchievements(empty).find((entry) => entry.id === "first-day")).toMatchObject({ current: 0, completed: false });
    const before = earned();
    expect(getShopAchievements(before).find((entry) => entry.id === "first-day")).toMatchObject({ current: 1, completed: true });
    expect(before.cashPence).toBe(1710);
  });

  it("buys the first stage after closing and offers the £30 second stage without changing merchandise profit", () => {
    const before = earned();
    expect(before.cashPence).toBe(1710);
    const state = act(before, { type: "BUY_SPACE_EXPANSION" });
    expect(state.cashPence).toBe(210);
    expect(state.renovation).toMatchObject({ layout: { expansion: 1 }, expansionDay: 1, layoutRevision: 0 });
    expect(state.renovation.layout.placements).toEqual(before.renovation.layout.placements);
    expect(state.items).toEqual(before.items);
    expect(state.transactions).toEqual(before.transactions);
    expect(state.purchases).toEqual(before.purchases);
    expect(state.settlements).toHaveLength(1);
    expect(state.settlements[0]).toMatchObject({ targetCustomers: null, grossProfitPence: 510, upgradeSpendPence: 0, expansionSpendPence: 1500, closingCashPence: 210 });
    expect(getDaySummary(state).grossProfitPence).toBe(getDaySummary(before).grossProfitPence);
    expect(getShopExpansionOffer(state)).toMatchObject({ allowed: false, costPence: 3000, targetStage: 2 });
    expect(rejected(state, { type: "BUY_SPACE_EXPANSION" })).toContain("£30.00");
    rejected(state, { type: "SETTLE_DAY" });
    const tomorrow = act(state, { type: "START_NEXT_DAY" });
    expect(tomorrow.day.openingCashPence).toBe(210);
    expect(tomorrow.cashPence).toBe(210);
    expect(getDaySummary(tomorrow).expansionSpendPence).toBe(0);
    expect(tomorrow.renovation).toEqual(state.renovation);
  });

  it("purchases the second real 3 m floor once and audits both stages paid on the same day", () => {
    const before = earned(7);
    expect(before.cashPence).toBe(4770);
    const first = act(before, { type: "BUY_SPACE_EXPANSION" });
    expect(getShopExpansionOffer(first)).toMatchObject({ allowed: true, costPence: SECOND_SHOP_EXPANSION_COST_PENCE, targetStage: 2 });
    const second = act(first, { type: "BUY_SPACE_EXPANSION" });
    expect(second.cashPence).toBe(270);
    expect(second.renovation).toMatchObject({
      layout: { expansion: 2 }, expansionDay: 7, secondExpansionDay: 7, layoutRevision: 0,
    });
    expect(second.settlements[6]).toMatchObject({ expansionSpendPence: 4500, closingCashPence: 270 });
    expect(getShopAchievements(second).find((entry) => entry.id === "second-extension"))
      .toMatchObject({ current: 1, completed: true });
    expect(isWalkablePosition({ x: 0, z: 10.2 }, .26, 2)).toBe(true);
    expect(isWalkablePosition({ x: 0, z: 10.5 }, .26, 2)).toBe(false);
    expect(rejected(second, { type: "BUY_SPACE_EXPANSION" })).toContain("两次实体扩建已完成");
  });

  it("allows construction before opening without levels, English evidence or free stock", () => {
    const before = act(earned(), { type: "START_NEXT_DAY" });
    const expanded = act(before, { type: "BUY_SPACE_EXPANSION" });
    expect(expanded.renovation.expansionDay).toBe(2);
    expect(expanded.day.openingCashPence).toBe(1710);
    expect(getDaySummary(expanded)).toMatchObject({ expansionSpendPence: 1500, grossProfitPence: 0, closingCashPence: 210 });
    expect(expanded.settlements[0]).toEqual(before.settlements[0]);
    expect(expanded.items).toEqual(before.items);
    const closed = act(act(expanded, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
    expect(closed.settlements[1]).toMatchObject({ paidCustomers: 0, expansionSpendPence: 1500, closingCashPence: 210 });
  });

  it("keeps the £8 shelf capacity purchase independent of the £15 space purchase", () => {
    const funds = earned(3);
    const first = act(act(funds, { type: "BUY_UPGRADE" }), { type: "BUY_SPACE_EXPANSION" });
    const second = act(act(funds, { type: "BUY_SPACE_EXPANSION" }), { type: "BUY_UPGRADE" });
    for (const state of [first, second]) {
      expect(state.cashPence).toBe(430);
      expect(state.upgraded).toBe(true);
      expect(state.settlements[2]).toMatchObject({ grossProfitPence: 510, upgradeSpendPence: 800, expansionSpendPence: SHOP_EXPANSION_COST_PENCE, closingCashPence: 430 });
      expect(state.items).toEqual(funds.items);
    }
    expect(getDaySummary(first)).toEqual(getDaySummary(second));
  });

  it("refuses renovation during a visit, closing and while holding goods", () => {
    const ready = prepared(act(earned(), { type: "START_NEXT_DAY" }));
    const layout = movedMilk(ready);
    const held = act(ready, { type: "PICK_CRATE", crateId: "milk-crate" });
    expect(rejected(held, { type: "BUY_SPACE_EXPANSION" })).toContain("放下");
    expect(rejected(held, { type: "APPLY_SHOP_LAYOUT", layout })).toContain("放下");
    const shopping = act(ready, { type: "OPEN_STORE" });
    const closing = act(shopping, { type: "CLOSE_STORE" });
    for (const state of [shopping, closing]) {
      rejected(state, { type: "BUY_SPACE_EXPANSION" });
      rejected(state, { type: "APPLY_SHOP_LAYOUT", layout });
    }
    expect(closing.payment).toEqual(shopping.payment);
  });
});

describe("renovation layout acceptance and save safety", () => {
  it("accepts a real rotation at no charge, copies the plan and changes only the renovation revision", () => {
    const before = prepared(); const layout = movedMilk(before);
    const after = act(before, { type: "APPLY_SHOP_LAYOUT", layout });
    expect(after.renovation.layoutRevision).toBe(1);
    expect(after.cashPence).toBe(before.cashPence);
    expect(after.items).toEqual(before.items); expect(after.purchases).toEqual(before.purchases);
    expect(after.transactions).toEqual(before.transactions); expect(after.settlements).toEqual(before.settlements);
    expect(after.renovation.layout).toEqual(layout);
    layout.placements[0]!.x = 999;
    expect(after.renovation.layout).not.toEqual(layout);
    expect(validateSimState(after)).toBe(true);
    rejected(after, { type: "APPLY_SHOP_LAYOUT", layout: structuredClone(after.renovation.layout) });
    const reordered = structuredClone(after.renovation.layout); reordered.placements.reverse();
    expect(rejected(after, { type: "APPLY_SHOP_LAYOUT", layout: reordered })).toContain("没有变化");
  });

  it("rejects missing equipment, overlaps, blocked service access and attempts to buy area through layout", () => {
    const state = createFirstDayState();
    const missing = structuredClone(state.renovation.layout); missing.placements.pop();
    const overlap = structuredClone(state.renovation.layout); Object.assign(overlap.placements[0]!, overlap.placements[1], { id: overlap.placements[0]!.id });
    const backwards = structuredClone(state.renovation.layout); backwards.placements[0]!.rotation = 2;
    const cheat = structuredClone(state.renovation.layout); cheat.expansion = 1;
    for (const layout of [missing, overlap, backwards, cheat]) rejected(state, { type: "APPLY_SHOP_LAYOUT", layout });
    expect(state.renovation.layoutRevision).toBe(0);
    const expanded = act(earned(), { type: "BUY_SPACE_EXPANSION" });
    rejected(expanded, { type: "APPLY_SHOP_LAYOUT", layout: createInitialRenovation().layout });
  });

  it("counts used empty cartons, checks dynamic paths only at layout acceptance and permits a temporarily blocked save", () => {
    let state = prepared();
    const layout = movedMilk(state, 3);
    state = act(state, { type: "APPLY_SHOP_LAYOUT", layout });
    expect(state.items.some((item) => item.location.kind === "crate")).toBe(false);
    expect(getShopLayoutObstacles(state)).toHaveLength(2);
    state = act(state, { type: "PICK_CRATE", crateId: "milk-crate" });
    expect(getShopLayoutObstacles(state)).toHaveLength(1);
    state = act(state, { type: "DROP_HELD", position: { x: 1.8, z: 1.35 } });
    const milkBox = getShopLayoutObstacles(state).find((bounds) => Math.abs((bounds.minX + bounds.maxX) / 2 - 1.8) < 0.001)!;
    expect(milkBox.maxX - milkBox.minX).toBeCloseTo(0.46);
    expect(milkBox.maxZ - milkBox.minZ).toBeCloseTo(0.36);
    expect(validateShopLayout(layout).valid).toBe(true);
    expect(validateShopLayout(layout, getShopLayoutObstacles(state)).valid).toBe(false);
    expect(validateSimState(JSON.parse(JSON.stringify(state)))).toBe(true);
    const draft = structuredClone(layout); draft.placements.find((placement) => placement.id === "chilled-drinks")!.x += 0.03;
    expect(validateShopLayout(draft).valid).toBe(true);
    expect(rejected(state, { type: "APPLY_SHOP_LAYOUT", layout: draft })).toContain("通道");
  });

  it("opens only the purchased rear floor for movement and rejects forged space or spending", () => {
    const original = earned(); const expanded = act(original, { type: "BUY_SPACE_EXPANSION" });
    const pose = { x: 0, z: 6.6, yaw: 0, pitch: 0 };
    expect(isWalkablePosition(pose)).toBe(false);
    expect(isWalkablePosition(pose, 0.26, 1)).toBe(true);
    expect(isWalkablePosition({ x: 0, z: 7.5 }, 0.26, 1)).toBe(false);
    expect(isWalkablePosition({ x: 4, z: 6 }, 0, 1)).toBe(false);
    rejected(original, { type: "SAVE_POSE", pose });
    const moved = act(expanded, { type: "SAVE_POSE", pose });
    expect(moved.playerPose).toEqual(pose);
    rejected(moved, { type: "SAVE_POSE", pose: { ...pose, z: 7.7 } });
    for (const mutate of [
      (state: SimState) => { state.cashPence += 1500 },
      (state: SimState) => { state.renovation.expansionDay = null },
      (state: SimState) => { state.renovation.expansionDay = 2 },
      (state: SimState) => { state.settlements[0]!.expansionSpendPence = 0 },
      (state: SimState) => { state.renovation.layout.placements[0]!.x = 100 },
      (state: SimState) => { state.renovation.layoutRevision = -1 },
    ]) {
      const corrupt = structuredClone(moved); mutate(corrupt);
      expect(validateSimState(corrupt)).toBe(false);
    }
    const unpaid = structuredClone(original); unpaid.renovation.layout.expansion = 1; unpaid.renovation.expansionDay = 1;
    expect(validateSimState(unpaid)).toBe(false);
    const invalidStage = JSON.parse(JSON.stringify(expanded)); invalidStage.renovation.layout.expansion = 3;
    expect(validateSimState(invalidStage)).toBe(false);
  });
});
