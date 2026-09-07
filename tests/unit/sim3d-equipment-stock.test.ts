import { describe, expect, it } from "vitest";
import {
  createEquipmentAssetState,
  purchaseEquipment,
  type EquipmentAssetState,
  type EquipmentFloorPlacement,
  type OperationalEquipmentAssetId,
  type ProductId,
} from "../../src/sim3d/equipmentCommerce";
import {
  BASE_SHELF_CAPACITY,
  UPGRADED_BASE_SHELF_CAPACITY,
  baseShelfCapacity,
  equipmentHasStock,
  equipmentIsInUse,
  equipmentShelfCapacity,
  findFirstEmptyShelfSlot,
  isValidShelfStockLocation,
  productInStoreCapacity,
  shelfCapacityFor,
  shelfSlotKey,
  type ShelfStockLocation,
  type StockItemView,
} from "../../src/sim3d/equipmentStock";

function buy(
  state: EquipmentAssetState,
  sequence: number,
  assetId: OperationalEquipmentAssetId,
  productId: ProductId,
): EquipmentAssetState {
  const result = purchaseEquipment(state, 100_000, {
    purchaseId: `stock-order-${sequence}`,
    assetId,
    productId,
    purchasedDay: sequence,
  });
  expect(result.changed, result.reason).toBe(true);
  return result.state;
}

function ownedState(): EquipmentAssetState {
  let state = buy(createEquipmentAssetState(), 1, "wall-shelf-narrow", "cereal");
  state = buy(state, 2, "wall-shelf-narrow", "cereal");
  state = buy(state, 3, "chest-chiller-wide", "milk");
  return buy(state, 4, "bakery-glass", "bread");
}

function placement(instanceId: string, index = 0): EquipmentFloorPlacement {
  return { instanceId, x: index, z: 6, rotation: (index % 4) as 0 | 1 | 2 | 3 };
}

function item(location: ShelfStockLocation | { kind: string }): StockItemView {
  return { location };
}

function fill(productId: ProductId, capacity: number, equipmentId?: string): StockItemView[] {
  return Array.from({ length: capacity }, (_, slot) => item({
    kind: "shelf",
    productId,
    slot,
    ...(equipmentId === undefined ? {} : { equipmentId }),
  }));
}

describe("base and purchased equipment capacity", () => {
  it("keeps the original capacity independent from purchased equipment", () => {
    expect(BASE_SHELF_CAPACITY).toBe(4);
    expect(UPGRADED_BASE_SHELF_CAPACITY).toBe(8);
    expect(baseShelfCapacity(false)).toBe(4);
    expect(baseShelfCapacity(true)).toBe(8);
    expect(Number.isSafeInteger(baseShelfCapacity(false))).toBe(true);
    expect(Number.isSafeInteger(baseShelfCapacity(true))).toBe(true);
  });

  it("counts an equipment capacity only when it is owned, placed and bound to the requested product", () => {
    const state = ownedState();
    const placements = [placement("shop-equipment-1")];
    expect(equipmentIsInUse(state, placements, "shop-equipment-1")).toBe(true);
    expect(equipmentShelfCapacity(state, placements, "shop-equipment-1", "cereal")).toBe(12);
    expect(equipmentShelfCapacity(state, placements, "shop-equipment-1", "tea")).toBe(0);
    expect(equipmentShelfCapacity(state, [], "shop-equipment-1", "cereal")).toBe(0);
    expect(equipmentShelfCapacity(state, [placement("shop-equipment-99")], "shop-equipment-99", "cereal")).toBe(0);
    expect(equipmentShelfCapacity(state, placements, "not-equipment", "cereal")).toBe(0);
    expect(equipmentShelfCapacity(state, placements, "shop-equipment-1", "not-a-product" as ProductId)).toBe(0);
  });

  it("sums only active instances assigned to each product", () => {
    const state = ownedState();
    const placements = [placement("shop-equipment-3"), placement("shop-equipment-2", 1), placement("shop-equipment-1", 2)];
    expect(productInStoreCapacity(false, state, placements, "cereal")).toBe(4 + 12 + 12);
    expect(productInStoreCapacity(true, state, placements, "cereal")).toBe(8 + 12 + 12);
    expect(productInStoreCapacity(false, state, placements, "milk")).toBe(4 + 48);
    expect(productInStoreCapacity(false, state, placements, "bread")).toBe(4);
    expect(productInStoreCapacity(false, state, placements, "tea")).toBe(4);
    expect(productInStoreCapacity(false, state, placements, "unknown" as ProductId)).toBe(0);
  });

  it("selects base or instance capacity from the location identity", () => {
    const state = ownedState();
    const placements = [placement("shop-equipment-3")];
    expect(shelfCapacityFor({ productId: "milk" }, false, state, placements)).toBe(4);
    expect(shelfCapacityFor({ productId: "milk" }, true, state, placements)).toBe(8);
    expect(shelfCapacityFor({ productId: "milk", equipmentId: "shop-equipment-3" }, false, state, placements)).toBe(48);
    expect(shelfCapacityFor({ productId: "cereal", equipmentId: "shop-equipment-3" }, false, state, placements)).toBe(0);
  });
});

describe("stable shelf slot identities", () => {
  it("makes base, product and instance slots unambiguous", () => {
    const base = { kind: "shelf", productId: "cereal", slot: 0 } satisfies ShelfStockLocation;
    const one = { ...base, equipmentId: "shop-equipment-1" } satisfies ShelfStockLocation;
    const two = { ...base, equipmentId: "shop-equipment-2" } satisfies ShelfStockLocation;
    expect(shelfSlotKey(base)).toBe("base:cereal:0");
    expect(shelfSlotKey(one)).toBe("equipment:shop-equipment-1:cereal:0");
    expect(new Set([shelfSlotKey(base), shelfSlotKey(one), shelfSlotKey(two), shelfSlotKey({ ...base, productId: "tea" })]).size).toBe(4);
  });

  it.each([
    { kind: "shelf", productId: "cereal", slot: -1 },
    { kind: "shelf", productId: "cereal", slot: .5 },
    { kind: "shelf", productId: "cereal", slot: Number.NaN },
    { kind: "shelf", productId: "cereal", slot: Number.POSITIVE_INFINITY },
    { kind: "shelf", productId: "unknown", slot: 0 },
    { kind: "crate", productId: "cereal", slot: 0 },
    { kind: "shelf", productId: "cereal", slot: 0, equipmentId: "shop-equipment-0" },
    { kind: "shelf", productId: "cereal", slot: 0, equipmentId: `shop-equipment-${Number.MAX_SAFE_INTEGER}0` },
    { kind: "shelf", productId: "cereal", slot: 0, injected: true },
  ])("rejects a malformed slot key %#", (location) => {
    expect(() => shelfSlotKey(location as ShelfStockLocation)).toThrow("货位编号无效");
  });
});

describe("shelf location validity", () => {
  it("validates original shelf indices against the normal or upgraded base capacity", () => {
    const empty = createEquipmentAssetState();
    expect(isValidShelfStockLocation({ kind: "shelf", productId: "cereal", slot: 3 }, false, empty, [])).toBe(true);
    expect(isValidShelfStockLocation({ kind: "shelf", productId: "cereal", slot: 4 }, false, empty, [])).toBe(false);
    expect(isValidShelfStockLocation({ kind: "shelf", productId: "cereal", slot: 7 }, true, empty, [])).toBe(true);
    expect(isValidShelfStockLocation({ kind: "shelf", productId: "cereal", slot: 8 }, true, empty, [])).toBe(false);
    expect(isValidShelfStockLocation({ kind: "shelf", productId: "tea", slot: 0 }, false, empty, [], "cereal")).toBe(false);
  });

  it("requires equipment ownership, active placement, matching assignment and a bounded integer slot", () => {
    const state = ownedState();
    const placements = [placement("shop-equipment-1")];
    const valid = { kind: "shelf", productId: "cereal", slot: 11, equipmentId: "shop-equipment-1" };
    expect(isValidShelfStockLocation(valid, false, state, placements, "cereal")).toBe(true);
    expect(isValidShelfStockLocation({ ...valid, slot: 12 }, false, state, placements)).toBe(false);
    expect(isValidShelfStockLocation({ ...valid, slot: Number.NaN }, false, state, placements)).toBe(false);
    expect(isValidShelfStockLocation({ ...valid, slot: 1.5 }, false, state, placements)).toBe(false);
    expect(isValidShelfStockLocation({ ...valid, productId: "tea" }, false, state, placements)).toBe(false);
    expect(isValidShelfStockLocation({ ...valid, equipmentId: "shop-equipment-2" }, false, state, placements)).toBe(false);
    expect(isValidShelfStockLocation(valid, false, state, [])).toBe(false);
    expect(isValidShelfStockLocation({ ...valid, injected: true }, false, state, placements)).toBe(false);
  });
});

describe("deterministic first-empty-slot selection", () => {
  it("fills gaps in the original fixture before considering equipment", () => {
    const state = ownedState();
    const placements = [placement("shop-equipment-1")];
    const items = [
      item({ kind: "shelf", productId: "cereal", slot: 0 }),
      item({ kind: "shelf", productId: "cereal", slot: 2 }),
      item({ kind: "shelf", productId: "cereal", slot: 0, equipmentId: "shop-equipment-1" }),
      item({ kind: "crate" }),
    ];
    expect(findFirstEmptyShelfSlot(items, "cereal", false, state, placements)).toEqual({ kind: "shelf", productId: "cereal", slot: 1 });
  });

  it("uses placed equipment in saved layout order after all base slots", () => {
    const state = ownedState();
    const placements = [placement("shop-equipment-2"), placement("shop-equipment-1", 1)];
    const items = [
      ...fill("cereal", 4),
      item({ kind: "shelf", productId: "cereal", slot: 0, equipmentId: "shop-equipment-2" }),
    ];
    expect(findFirstEmptyShelfSlot(items, "cereal", false, state, placements)).toEqual({
      kind: "shelf",
      productId: "cereal",
      slot: 1,
      equipmentId: "shop-equipment-2",
    });
    const firstFull = [...items, ...fill("cereal", 12, "shop-equipment-2").slice(1)];
    expect(findFirstEmptyShelfSlot(firstFull, "cereal", false, state, placements)).toEqual({
      kind: "shelf",
      productId: "cereal",
      slot: 0,
      equipmentId: "shop-equipment-1",
    });
  });

  it("ignores warehouse and differently assigned equipment and returns null when every valid slot is occupied", () => {
    const state = ownedState();
    const placements = [placement("shop-equipment-1"), placement("shop-equipment-3", 1)];
    const allCereal = [...fill("cereal", 4), ...fill("cereal", 12, "shop-equipment-1")];
    expect(findFirstEmptyShelfSlot(allCereal, "cereal", false, state, placements)).toBeNull();
    expect(findFirstEmptyShelfSlot(fill("milk", 4), "milk", false, state, [placement("shop-equipment-3")])).toEqual({
      kind: "shelf", productId: "milk", slot: 0, equipmentId: "shop-equipment-3",
    });
    expect(findFirstEmptyShelfSlot([], "unknown" as ProductId, false, state, placements)).toBeNull();
    expect(findFirstEmptyShelfSlot([], "cereal", false, state, [placement("shop-equipment-99")])).toBeNull();
  });

  it("does not mutate items, ownership or placement order", () => {
    const state = ownedState();
    const placements = [placement("shop-equipment-2"), placement("shop-equipment-1", 1)];
    const items = fill("cereal", 4);
    const before = structuredClone({ state, placements, items });
    findFirstEmptyShelfSlot(items, "cereal", false, state, placements);
    expect({ state, placements, items }).toEqual(before);
  });
});

describe("equipment use and stock removal guards", () => {
  it("recognises only an owned instance in a valid active placement list", () => {
    const state = ownedState();
    expect(equipmentIsInUse(state, [placement("shop-equipment-1")], "shop-equipment-1")).toBe(true);
    expect(equipmentIsInUse(state, [], "shop-equipment-1")).toBe(false);
    expect(equipmentIsInUse(state, [placement("shop-equipment-99")], "shop-equipment-99")).toBe(false);
    expect(equipmentIsInUse(state, [placement("shop-equipment-1"), placement("shop-equipment-1", 2)], "shop-equipment-1")).toBe(false);
    expect(equipmentIsInUse(state, [placement("shop-equipment-1")], "unsafe/id")).toBe(false);
  });

  it("treats any shelf reference as stock while ignoring base shelves and non-shelf locations", () => {
    const items: StockItemView[] = [
      item({ kind: "shelf", productId: "cereal", slot: 0 }),
      item({ kind: "crate" }),
      item({ kind: "shelf", productId: "cereal", slot: 999, equipmentId: "shop-equipment-1" }),
    ];
    expect(equipmentHasStock(items, "shop-equipment-1")).toBe(true);
    expect(equipmentHasStock(items, "shop-equipment-2")).toBe(false);
    expect(equipmentHasStock(items.slice(0, 2), "shop-equipment-1")).toBe(false);
    expect(equipmentHasStock(items, "unsafe/id")).toBe(false);
  });
});
