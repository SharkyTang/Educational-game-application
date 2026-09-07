import { describe, expect, it } from "vitest";
import { EQUIPMENT_ASSETS } from "../../src/sim3d/equipment-library/catalog";
import { PRODUCT_ASSETS, PRODUCT_ASSET_IDS, type ProductAssetId } from "../../src/sim3d/product-library/catalog";
import {
  EQUIPMENT_COMMERCE_CATALOG,
  OPERATIONAL_EQUIPMENT_ASSET_IDS,
  compatibleProductsForEquipment,
  createEquipmentAssetState,
  equipmentInUseInstances,
  equipmentInventoryStats,
  equipmentWarehouseInstances,
  getEquipmentPurchaseOffer,
  isEquipmentProductCompatible,
  purchaseEquipment,
  validateEquipmentAssetState,
  validateEquipmentFloorPlacements,
  type EquipmentFloorPlacement,
  type EquipmentPurchaseRequest,
  type OperationalEquipmentAssetId,
} from "../../src/sim3d/equipmentCommerce";

const expected = {
  "wall-shelf-narrow": { pricePence: 600, capacity: 12 },
  "gondola-low": { pricePence: 1_000, capacity: 32 },
  "chest-chiller-compact": { pricePence: 1_200, capacity: 24 },
  "chest-chiller-wide": { pricePence: 1_800, capacity: 48 },
  "produce-tiered": { pricePence: 1_000, capacity: 12 },
  "bakery-glass": { pricePence: 1_200, capacity: 12 },
} as const;

function request(
  purchaseId = "equipment-order-1",
  assetId: OperationalEquipmentAssetId = "wall-shelf-narrow",
  productId: ProductAssetId = "cereal",
  purchasedDay = 1,
): EquipmentPurchaseRequest {
  return { purchaseId, assetId, productId, purchasedDay };
}

function bought(
  state = createEquipmentAssetState(),
  cashPence = 5_000,
  input = request(),
) {
  const result = purchaseEquipment(state, cashPence, input);
  expect(result.changed, result.reason).toBe(true);
  expect(result.instance).not.toBeNull();
  return result;
}

describe("first operational equipment commerce catalogue", () => {
  it("offers exactly the six approved models at their fixed prices and authored capacities", () => {
    expect(OPERATIONAL_EQUIPMENT_ASSET_IDS).toEqual(Object.keys(expected));
    expect(Object.keys(EQUIPMENT_COMMERCE_CATALOG)).toEqual(OPERATIONAL_EQUIPMENT_ASSET_IDS);
    for (const id of OPERATIONAL_EQUIPMENT_ASSET_IDS) {
      expect(EQUIPMENT_COMMERCE_CATALOG[id]).toMatchObject({
        id,
        nameZh: EQUIPMENT_ASSETS[id].nameZh,
        nameEn: EQUIPMENT_ASSETS[id].nameEn,
        ...expected[id],
      });
      expect(EQUIPMENT_COMMERCE_CATALOG[id].capacity).toBe(EQUIPMENT_ASSETS[id].placementSlots.length);
      expect(EQUIPMENT_COMMERCE_CATALOG[id].compatibleProducts.length).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(EQUIPMENT_COMMERCE_CATALOG)).toBe(true);
    expect(Object.isFrozen(OPERATIONAL_EQUIPMENT_ASSET_IDS)).toBe(true);
    expect(Object.isFrozen(EQUIPMENT_COMMERCE_CATALOG["gondola-low"].compatibleProducts)).toBe(true);
  });

  it("accepts every recommended use while enforcing temperature, category and authored slot size", () => {
    for (const id of OPERATIONAL_EQUIPMENT_ASSET_IDS) {
      for (const productId of EQUIPMENT_ASSETS[id].recommendedProducts) {
        expect(isEquipmentProductCompatible(id, productId), `${id}/${productId}`).toBe(true);
      }
      const compatible = compatibleProductsForEquipment(id);
      expect(compatible).toEqual(EQUIPMENT_COMMERCE_CATALOG[id].compatibleProducts);
      expect(new Set(compatible).size).toBe(compatible.length);
      expect(compatible.every((productId) => PRODUCT_ASSET_IDS.includes(productId))).toBe(true);
    }

    for (const id of ["chest-chiller-compact", "chest-chiller-wide"] as const) {
      expect(isEquipmentProductCompatible(id, "milk")).toBe(true);
      expect(isEquipmentProductCompatible(id, "cheese")).toBe(true);
      expect(isEquipmentProductCompatible(id, "cereal")).toBe(false);
      expect(isEquipmentProductCompatible(id, "apple")).toBe(false);
    }
    expect(isEquipmentProductCompatible("produce-tiered", "lettuce")).toBe(true);
    expect(isEquipmentProductCompatible("produce-tiered", "yoghurt")).toBe(false);
    expect(isEquipmentProductCompatible("bakery-glass", "bread")).toBe(true);
    expect(isEquipmentProductCompatible("bakery-glass", "biscuits")).toBe(true);
    expect(isEquipmentProductCompatible("bakery-glass", "rice")).toBe(false);
    expect(isEquipmentProductCompatible("wall-shelf-narrow", "shampoo")).toBe(true);
    expect(isEquipmentProductCompatible("wall-shelf-narrow", "bread")).toBe(false);
    expect(isEquipmentProductCompatible("not-an-asset", "milk")).toBe(false);
    expect(isEquipmentProductCompatible("wall-shelf-narrow", "not-a-product")).toBe(false);

    for (const id of OPERATIONAL_EQUIPMENT_ASSET_IDS) {
      for (const productId of EQUIPMENT_COMMERCE_CATALOG[id].compatibleProducts) {
        const product = PRODUCT_ASSETS[productId];
        expect(EQUIPMENT_ASSETS[id].placementSlots.some((slot) => product.size.every((size, axis) => size <= slot.maxSize[axis]! + 0.000001)), `${id}/${productId}`).toBe(true);
      }
    }
  });
});

describe("pure equipment purchasing", () => {
  it("starts empty and buys an assigned product without mutating caller-owned input", () => {
    const state = createEquipmentAssetState();
    const snapshot = structuredClone(state);
    const input = request();
    const inputSnapshot = structuredClone(input);
    const offer = getEquipmentPurchaseOffer(state, 1_000, input);
    expect(offer).toEqual({ allowed: true, pricePence: 600, capacity: 12, cashAfterPence: 400 });

    const result = purchaseEquipment(state, 1_000, input);
    expect(result).toMatchObject({ changed: true, cashPence: 400, spentPence: 600 });
    expect(result.instance).toEqual({
      id: "shop-equipment-1",
      assetId: "wall-shelf-narrow",
      productId: "cereal",
      purchasedDay: 1,
    });
    expect(result.state).toEqual({
      instances: [result.instance],
      purchases: [{
        id: "equipment-order-1",
        instanceId: "shop-equipment-1",
        assetId: "wall-shelf-narrow",
        productId: "cereal",
        purchasedDay: 1,
        amountPence: 600,
      }],
      nextSequence: 2,
    });
    expect(validateEquipmentAssetState(result.state)).toBe(true);
    expect(state).toEqual(snapshot);
    expect(input).toEqual(inputSnapshot);
    expect(result.state).not.toBe(state);
    expect(result.state.instances).not.toBe(state.instances);
    expect(result.state.purchases).not.toBe(state.purchases);
  });

  it("issues stable monotonically increasing instance ids and copies existing records", () => {
    const first = bought();
    const firstState = structuredClone(first.state);
    const second = bought(first.state, first.cashPence, request("equipment-order-2", "chest-chiller-wide", "eggs", 3));
    expect(second.instance?.id).toBe("shop-equipment-2");
    expect(second.cashPence).toBe(2_600);
    expect(second.spentPence).toBe(1_800);
    expect(second.state.nextSequence).toBe(3);
    expect(second.state.instances[0]).not.toBe(first.state.instances[0]);
    expect(second.state.purchases[0]).not.toBe(first.state.purchases[0]);
    expect(first.state).toEqual(firstState);
    expect(validateEquipmentAssetState(second.state)).toBe(true);
  });

  it.each([
    ["insufficient funds", createEquipmentAssetState(), 599, request(), "店铺资金不足。", 600, 12],
    ["unknown asset", createEquipmentAssetState(), 5_000, { ...request(), assetId: "island-chiller" }, "没有这种可购买设备。", 0, 0],
    ["unknown product", createEquipmentAssetState(), 5_000, { ...request(), productId: "ice-cream" }, "没有这种经营商品。", 600, 12],
    ["incompatible product", createEquipmentAssetState(), 5_000, request("equipment-order-1", "chest-chiller-compact", "rice"), "不能用于陈列", 1_200, 24],
    ["invalid day", createEquipmentAssetState(), 5_000, { ...request(), purchasedDay: Number.NaN }, "购买日期无效。", 600, 12],
    ["unknown request key", createEquipmentAssetState(), 5_000, { ...request(), injected: true }, "设备购买请求格式无效。", 600, 12],
  ] as const)("rejects %s without debiting or creating merchandise", (_label, state, cashPence, input, reason, pricePence, capacity) => {
    const snapshot = structuredClone(state);
    const offer = getEquipmentPurchaseOffer(state, cashPence, input as unknown as EquipmentPurchaseRequest);
    expect(offer).toMatchObject({ allowed: false, pricePence, capacity, cashAfterPence: cashPence });
    expect(offer.reason).toContain(reason);
    const result = purchaseEquipment(state, cashPence, input as unknown as EquipmentPurchaseRequest);
    expect(result).toMatchObject({ changed: false, state, cashPence, spentPence: 0, instance: null });
    expect(result.reason).toContain(reason);
    expect(result.state).toBe(state);
    expect(state).toEqual(snapshot);
  });

  it("uses the caller purchase id as an idempotency boundary", () => {
    const first = bought();
    const snapshot = structuredClone(first.state);
    const duplicate = purchaseEquipment(first.state, first.cashPence, request("equipment-order-1", "bakery-glass", "bread", 2));
    expect(duplicate).toMatchObject({ changed: false, state: first.state, cashPence: first.cashPence, spentPence: 0, instance: null });
    expect(duplicate.reason).toBe("这笔设备购买已经处理过。");
    expect(first.state).toEqual(snapshot);
  });

  it("does not wrap an exhausted safe instance sequence", () => {
    const state = { instances: [], purchases: [], nextSequence: Number.MAX_SAFE_INTEGER };
    expect(validateEquipmentAssetState(state)).toBe(true);
    const result = purchaseEquipment(state, 5_000, request());
    expect(result).toMatchObject({ changed: false, state, cashPence: 5_000, spentPence: 0, instance: null });
    expect(result.reason).toBe("设备编号已达到上限。");
  });

  it.each(["", " spaces", "order/1", "订单-1", "a".repeat(65)])("rejects unsafe purchase id %j", (purchaseId) => {
    const state = createEquipmentAssetState();
    const result = purchaseEquipment(state, 5_000, request(purchaseId));
    expect(result).toMatchObject({ changed: false, state, cashPence: 5_000, spentPence: 0, instance: null });
    expect(result.reason).toBe("设备购买编号无效。");
  });
});

describe("strict equipment ownership and placement validation", () => {
  it("accepts its empty and purchased JSON shapes", () => {
    const empty = createEquipmentAssetState();
    expect(validateEquipmentAssetState(empty)).toBe(true);
    expect(validateEquipmentAssetState(JSON.parse(JSON.stringify(empty)))).toBe(true);
    const state = bought().state;
    expect(validateEquipmentAssetState(JSON.parse(JSON.stringify(state)))).toBe(true);
  });

  it.each([
    ["top-level extra key", (state: Record<string, unknown>) => { state.extra = true; }],
    ["NaN sequence", (state: Record<string, unknown>) => { state.nextSequence = Number.NaN; }],
    ["reused sequence", (state: Record<string, unknown>) => { state.nextSequence = 1; }],
    ["instance extra key", (state: Record<string, unknown>) => { (state.instances as Record<string, unknown>[])[0]!.extra = true; }],
    ["purchase extra key", (state: Record<string, unknown>) => { (state.purchases as Record<string, unknown>[])[0]!.extra = true; }],
    ["NaN day", (state: Record<string, unknown>) => { (state.instances as Record<string, unknown>[])[0]!.purchasedDay = Number.NaN; }],
    ["NaN amount", (state: Record<string, unknown>) => { (state.purchases as Record<string, unknown>[])[0]!.amountPence = Number.NaN; }],
    ["wrong paid amount", (state: Record<string, unknown>) => { (state.purchases as Record<string, unknown>[])[0]!.amountPence = 601; }],
    ["unknown asset", (state: Record<string, unknown>) => { (state.instances as Record<string, unknown>[])[0]!.assetId = "island-chiller"; }],
    ["unknown product", (state: Record<string, unknown>) => { (state.instances as Record<string, unknown>[])[0]!.productId = "ice-cream"; }],
    ["incompatible product", (state: Record<string, unknown>) => { (state.instances as Record<string, unknown>[])[0]!.productId = "milk"; }],
    ["unsafe instance id", (state: Record<string, unknown>) => { (state.instances as Record<string, unknown>[])[0]!.id = "../../equipment"; }],
    ["missing purchase", (state: Record<string, unknown>) => { (state.purchases as unknown[]).pop(); }],
    ["mismatched purchase", (state: Record<string, unknown>) => { (state.purchases as Record<string, unknown>[])[0]!.productId = "tea"; }],
  ] as const)("rejects %s", (_label, mutate) => {
    const state = structuredClone(bought().state) as unknown as Record<string, unknown>;
    mutate(state);
    expect(validateEquipmentAssetState(state)).toBe(false);
  });

  it("rejects duplicate instance and purchase identities", () => {
    const one = bought().state;
    const duplicateInstance = structuredClone(one);
    duplicateInstance.instances.push(structuredClone(duplicateInstance.instances[0]!));
    duplicateInstance.purchases.push({ ...duplicateInstance.purchases[0]!, id: "equipment-order-2" });
    expect(validateEquipmentAssetState(duplicateInstance)).toBe(false);

    const duplicatePurchase = structuredClone(one);
    duplicatePurchase.instances.push({ ...duplicatePurchase.instances[0]!, id: "shop-equipment-2" });
    duplicatePurchase.purchases.push({ ...duplicatePurchase.purchases[0]!, instanceId: "shop-equipment-2" });
    duplicatePurchase.nextSequence = 3;
    expect(validateEquipmentAssetState(duplicatePurchase)).toBe(false);
  });

  it("strictly validates finite, unique, owned floor placements", () => {
    const first = bought();
    const second = bought(first.state, first.cashPence, request("equipment-order-2", "produce-tiered", "apple", 2));
    const placements: EquipmentFloorPlacement[] = [{ instanceId: "shop-equipment-1", x: 1.2, z: 5.4, rotation: 3 }];
    expect(validateEquipmentFloorPlacements(placements, second.state)).toBe(true);
    for (const invalid of [
      [{ ...placements[0]!, instanceId: "shop-equipment-99" }],
      [placements[0]!, { ...placements[0]!, x: 2 }],
      [{ ...placements[0]!, x: Number.NaN }],
      [{ ...placements[0]!, z: Number.POSITIVE_INFINITY }],
      [{ ...placements[0]!, rotation: 4 }],
      [{ ...placements[0]!, rotation: 1.5 }],
      [{ ...placements[0]!, extra: true }],
    ]) expect(validateEquipmentFloorPlacements(invalid, second.state)).toBe(false);
  });
});

describe("warehouse and in-use equipment helpers", () => {
  it("partitions owned instances and reports equipment and display capacity", () => {
    const first = bought(createEquipmentAssetState(), 10_000, request("equipment-order-1", "wall-shelf-narrow", "tea", 1));
    const second = bought(first.state, first.cashPence, request("equipment-order-2", "chest-chiller-wide", "milk", 2));
    const third = bought(second.state, second.cashPence, request("equipment-order-3", "wall-shelf-narrow", "shampoo", 2));
    const placements: EquipmentFloorPlacement[] = [
      { instanceId: "shop-equipment-2", x: 0, z: 5.5, rotation: 1 },
      // Unknown layout ids cannot turn non-owned objects into owned equipment.
      { instanceId: "shop-equipment-999", x: 0, z: 0, rotation: 0 },
    ];

    expect(equipmentInUseInstances(third.state, placements).map(({ id }) => id)).toEqual(["shop-equipment-2"]);
    expect(equipmentWarehouseInstances(third.state, placements).map(({ id }) => id)).toEqual(["shop-equipment-1", "shop-equipment-3"]);
    const stats = equipmentInventoryStats(third.state, placements);
    expect(stats).toMatchObject({ total: 3, inUse: 1, inWarehouse: 2, totalCapacity: 72, inUseCapacity: 48 });
    expect(stats.byAsset["wall-shelf-narrow"]).toEqual({ total: 2, inUse: 0, inWarehouse: 2, totalCapacity: 24, inUseCapacity: 0 });
    expect(stats.byAsset["chest-chiller-wide"]).toEqual({ total: 1, inUse: 1, inWarehouse: 0, totalCapacity: 48, inUseCapacity: 48 });
    expect(stats.byAsset["bakery-glass"]).toEqual({ total: 0, inUse: 0, inWarehouse: 0, totalCapacity: 0, inUseCapacity: 0 });

    const inUse = equipmentInUseInstances(third.state, placements);
    inUse[0]!.productId = "water";
    expect(third.state.instances[1]!.productId).toBe("milk");
  });
});
