import { receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { describe, expect, it } from "vitest";
import {
  countOnShelf,
  createFirstDayState,
  getDaySummary,
  reduceSim,
  shelfCapacityAt,
  validateSimState,
  type SimCommand,
  type SimState,
} from "../../src/sim3d/domain";
import { suggestEquipmentPlacement } from "../../src/sim3d/equipmentLayout";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(result.state.revision).toBe(state.revision + 1);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function rejected(state: SimState, command: SimCommand): string {
  const snapshot = structuredClone(state);
  const result = reduceSim(state, command);
  expect(result.changed).toBe(false);
  expect(result.state).toBe(state);
  expect(state).toEqual(snapshot);
  return result.message ?? "";
}

function buyCerealShelf(state = createFirstDayState()): SimState {
  return act(state, {
    type: "BUY_EQUIPMENT",
    purchaseId: "equipment-domain-1",
    assetId: "wall-shelf-narrow",
    productId: "cereal",
  });
}

describe("operational equipment in the conserved shop economy", () => {
  it("starts with an empty warehouse and records one idempotent real-capital purchase", () => {
    const initial = createFirstDayState();
    expect(initial.equipment).toEqual({ instances: [], purchases: [], nextSequence: 1 });
    expect(initial.renovation.layout.equipment).toEqual([]);

    const state = buyCerealShelf(initial);
    expect(state.cashPence).toBe(600);
    expect(state.equipment.instances).toEqual([{
      id: "shop-equipment-1", assetId: "wall-shelf-narrow", productId: "cereal", purchasedDay: 1,
    }]);
    expect(state.equipment.purchases).toEqual([{
      id: "equipment-domain-1", instanceId: "shop-equipment-1", assetId: "wall-shelf-narrow",
      productId: "cereal", purchasedDay: 1, amountPence: 600,
    }]);
    expect(getDaySummary(state)).toMatchObject({ equipmentSpendPence: 600, closingCashPence: 600 });
    expect(rejected(state, {
      type: "BUY_EQUIPMENT", purchaseId: "equipment-domain-1", assetId: "wall-shelf-narrow", productId: "cereal",
    })).toContain("已经处理");
  });

  it("rejects incompatible, unaffordable and mid-business purchases without mutating funds", () => {
    const initial = createFirstDayState();
    expect(rejected(initial, {
      type: "BUY_EQUIPMENT", purchaseId: "bad-fit", assetId: "chest-chiller-compact", productId: "cereal",
    })).toContain("不能用于");
    expect(rejected(initial, {
      type: "BUY_EQUIPMENT", purchaseId: "too-expensive", assetId: "chest-chiller-wide", productId: "milk",
    })).toContain("资金不足");

    const withStock = act(initial, { type: "PURCHASE_STOCK", orderId: "open-with-cereal", lines: [{ productId: "cereal", quantity: 1 }] });
    const received = receiveAllDeliveries(withStock);
    const held = act(received, { type: "PICK_CRATE", crateId: "cereal-crate" });
    const stocked = act(held, { type: "STOCK", productId: "cereal", slot: 0 });
    const dropped = act(stocked, { type: "DROP_HELD", position: stocked.crates.find((crate) => crate.productId === "cereal")!.position });
    const open = act(dropped, { type: "OPEN_STORE" });
    expect(rejected(open, {
      type: "BUY_EQUIPMENT", purchaseId: "during-visit", assetId: "wall-shelf-narrow", productId: "cereal",
    })).toContain("营业中");
  });

  it("moves a purchased shelf from warehouse into the plan and exposes only its bound slots", () => {
    let state = buyCerealShelf();
    const placement = suggestEquipmentPlacement(state.renovation.layout, state.equipment, "shop-equipment-1");
    expect(placement).not.toBeNull();
    const layout = { ...state.renovation.layout, equipment: [placement!] };
    state = act(state, {
      type: "APPLY_SHOP_LAYOUT",
      layout,
    });
    expect(shelfCapacityAt(state, "cereal", "shop-equipment-1")).toBe(12);
    expect(shelfCapacityAt(state, "tea", "shop-equipment-1")).toBe(0);

    state = act(state, { type: "PURCHASE_STOCK", orderId: "equipment-cereal", lines: [{ productId: "cereal", quantity: 1 }] });
    state = receiveAllDeliveries(state);
    state = act(state, { type: "PICK_CRATE", crateId: "cereal-crate" });
    expect(rejected(state, { type: "STOCK", productId: "tea", slot: 0, equipmentId: "shop-equipment-1" })).toContain("位置不可用");
    state = act(state, { type: "STOCK", productId: "cereal", slot: 0, equipmentId: "shop-equipment-1" });
    expect(countOnShelf(state, "cereal", "shop-equipment-1")).toBe(1);
    expect(state.items.find((item) => item.productId === "cereal")?.location).toEqual({
      kind: "shelf", productId: "cereal", slot: 0, equipmentId: "shop-equipment-1",
    });

    state = act(state, {
      type: "DROP_HELD",
      position: state.crates.find((crate) => crate.productId === "cereal")!.position,
    });
    const withdrawn = { ...state.renovation.layout, equipment: [] };
    expect(rejected(state, { type: "APPLY_SHOP_LAYOUT", layout: withdrawn })).toContain("还有商品");
    const corrupt = structuredClone(state);
    corrupt.renovation.layout.equipment = [];
    expect(validateSimState(corrupt)).toBe(false);
  });
});
