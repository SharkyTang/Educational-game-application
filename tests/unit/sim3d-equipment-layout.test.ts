import { describe, expect, it } from "vitest";
import { EQUIPMENT_ASSETS } from "../../src/sim3d/equipment-library/catalog";
import {
  createEquipmentAssetState,
  purchaseEquipment,
  type EquipmentAssetState,
  type EquipmentFloorPlacement,
  type OperationalEquipmentAssetId,
  type ProductId,
} from "../../src/sim3d/equipmentCommerce";
import {
  equipmentLayoutColliders,
  equipmentPlacementBounds,
  equipmentServicePositions,
  equipmentSlotPosition,
  suggestEquipmentPlacement,
  transformEquipmentPoint,
  validateEquipmentLayout,
  validateEquipmentPlacementsStructure,
  type EquipmentShopLayout,
} from "../../src/sim3d/equipmentLayout";
import { createDefaultShopLayout, shopBounds } from "../../src/sim3d/shopLayout";

function layout(expansion: 0 | 1 = 1): EquipmentShopLayout {
  return { ...createDefaultShopLayout(), expansion, equipment: [] };
}

function buy(
  state: EquipmentAssetState,
  sequence: number,
  assetId: OperationalEquipmentAssetId,
  productId: ProductId,
): EquipmentAssetState {
  const result = purchaseEquipment(state, 100_000, {
    purchaseId: `layout-order-${sequence}`,
    assetId,
    productId,
    purchasedDay: sequence,
  });
  expect(result.changed, result.reason).toBe(true);
  return result.state;
}

function ownsWallShelf(): EquipmentAssetState {
  return buy(createEquipmentAssetState(), 1, "wall-shelf-narrow", "cereal");
}

function withPlacement(base: EquipmentShopLayout, placement: EquipmentFloorPlacement): EquipmentShopLayout {
  return { ...base, equipment: [...base.equipment, placement] };
}

describe("equipment placement structure", () => {
  it("accepts an empty list and up to forty unique finite quarter-turn placements", () => {
    expect(validateEquipmentPlacementsStructure([])).toBe(true);
    const placements = Array.from({ length: 40 }, (_, index): EquipmentFloorPlacement => ({
      instanceId: `shop-equipment-${index + 1}`,
      x: index / 10,
      z: -index / 10,
      rotation: (index % 4) as 0 | 1 | 2 | 3,
    }));
    expect(validateEquipmentPlacementsStructure(placements)).toBe(true);
    expect(validateEquipmentPlacementsStructure([...placements, { ...placements[0]!, instanceId: "shop-equipment-41" }])).toBe(false);
  });

  it.each([
    null,
    {},
    [{ instanceId: "shop-equipment-1", x: 0, z: 0 }],
    [{ instanceId: "shop-equipment-1", x: 0, z: 0, rotation: 0, injected: true }],
    [{ instanceId: "shop-equipment-0", x: 0, z: 0, rotation: 0 }],
    [{ instanceId: "shop-equipment-01", x: 0, z: 0, rotation: 0 }],
    [{ instanceId: `shop-equipment-${Number.MAX_SAFE_INTEGER}0`, x: 0, z: 0, rotation: 0 }],
    [{ instanceId: "shop-equipment-1", x: Number.NaN, z: 0, rotation: 0 }],
    [{ instanceId: "shop-equipment-1", x: 0, z: Number.POSITIVE_INFINITY, rotation: 0 }],
    [{ instanceId: "shop-equipment-1", x: 0, z: 0, rotation: -1 }],
    [{ instanceId: "shop-equipment-1", x: 0, z: 0, rotation: 1.5 }],
    [{ instanceId: "shop-equipment-1", x: 0, z: 0, rotation: 4 }],
    [
      { instanceId: "shop-equipment-1", x: 0, z: 0, rotation: 0 },
      { instanceId: "shop-equipment-1", x: 1, z: 1, rotation: 1 },
    ],
  ])("rejects malformed, duplicate or unsafe placement data %#", (value) => {
    expect(validateEquipmentPlacementsStructure(value)).toBe(false);
  });

  it("also rejects a malformed base shop, ownership ledger and obstacle list without throwing", () => {
    const state = ownsWallShelf();
    const malformedLayout = { ...layout(), placements: [] } as EquipmentShopLayout;
    expect(validateEquipmentLayout(malformedLayout, state)).toMatchObject({ valid: false, reason: "设备布局格式无效。" });
    const malformedState = { ...state, nextSequence: Number.NaN };
    expect(validateEquipmentLayout(layout(), malformedState)).toMatchObject({ valid: false, reason: "设备资产记录无效。" });
    expect(validateEquipmentLayout(layout(), state, [{ minX: 1, maxX: 0, minZ: 0, maxZ: 1 }])).toMatchObject({ valid: false, reason: expect.stringContaining("货箱占位数据无效") });
    expect(validateEquipmentLayout(layout(), state, [{ minX: 0, maxX: Number.NaN, minZ: 0, maxZ: 1 }])).toMatchObject({ valid: false, reason: expect.stringContaining("货箱占位数据无效") });
    const tooMany = Array.from({ length: 161 }, (_, index) => ({ minX: index, maxX: index + .5, minZ: 0, maxZ: .5 }));
    expect(validateEquipmentLayout(layout(), state, tooMany)).toMatchObject({ valid: false, reason: expect.stringContaining("货箱占位数据无效") });
  });
});

describe("equipment bounds, ownership and collision rules", () => {
  it("rotates nominal footprints and returns colliders only for owned placed instances", () => {
    const state = ownsWallShelf();
    const instance = state.instances[0]!;
    const original: EquipmentFloorPlacement = { instanceId: instance.id, x: 2, z: 6, rotation: 0 };
    const rotated: EquipmentFloorPlacement = { ...original, rotation: 1 };
    expect(equipmentPlacementBounds(instance, original)).toEqual({ minX: 1.51, maxX: 2.49, minZ: 5.74, maxZ: 6.26 });
    expect(equipmentPlacementBounds(instance, rotated)).toEqual({ minX: 1.74, maxX: 2.26, minZ: 5.51, maxZ: 6.49 });
    const colliders = equipmentLayoutColliders({ ...layout(), equipment: [original, { ...original, instanceId: "shop-equipment-99" }] }, state);
    expect(colliders).toEqual([equipmentPlacementBounds(instance, original)]);
  });

  it("accepts an owned reachable rear-room placement and rejects unpurchased equipment", () => {
    const state = ownsWallShelf();
    const suggested = suggestEquipmentPlacement(layout(), state, "shop-equipment-1");
    expect(suggested).not.toBeNull();
    expect(validateEquipmentLayout(withPlacement(layout(), suggested!), state)).toEqual({ valid: true });
    expect(validateEquipmentLayout(withPlacement(layout(), { ...suggested!, instanceId: "shop-equipment-2" }), state)).toMatchObject({
      valid: false,
      reason: "布局中含有未购买的设备。",
    });
  });

  it.each([
    ["outside", { instanceId: "shop-equipment-1", x: 0, z: 7.5, rotation: 0 }, "超出了店铺空间"],
    ["entrance", { instanceId: "shop-equipment-1", x: 0, z: -4, rotation: 0 }, "挡住了店门"],
    ["plant", { instanceId: "shop-equipment-1", x: -0.9, z: 4, rotation: 0 }, "固定盆栽重叠"],
    ["unloading bay", { instanceId: "shop-equipment-1", x: -1.1, z: 2.6, rotation: 0 }, "卸货"],
    ["existing fixture", { instanceId: "shop-equipment-1", x: -2.2, z: -2.2, rotation: 0 }, "现有家具重叠"],
  ] as const)("rejects an equipment footprint at the %s", (_label, placement, reason) => {
    const result = validateEquipmentLayout(withPlacement(layout(), placement), ownsWallShelf());
    expect(result).toMatchObject({ valid: false, instanceId: "shop-equipment-1" });
    expect(result.reason).toContain(reason);
  });

  it("rejects collisions with cartons and another purchased machine", () => {
    let state = ownsWallShelf();
    state = buy(state, 2, "wall-shelf-narrow", "tea");
    const first = suggestEquipmentPlacement(layout(), state, "shop-equipment-1")!;
    expect(first).not.toBeNull();
    const firstBounds = equipmentPlacementBounds(state.instances[0]!, first);
    expect(validateEquipmentLayout(withPlacement(layout(), first), state, [firstBounds])).toMatchObject({
      valid: false,
      instanceId: "shop-equipment-1",
      reason: expect.stringContaining("货箱重叠"),
    });
    const overlapping = {
      ...layout(),
      equipment: [first, { ...first, instanceId: "shop-equipment-2" }],
    } satisfies EquipmentShopLayout;
    expect(validateEquipmentLayout(overlapping, state)).toMatchObject({
      valid: false,
      instanceId: "shop-equipment-1",
      reason: expect.stringContaining("另一台已购设备重叠"),
    });
  });
});

describe("service aisles and placement suggestions", () => {
  it("requires the front service point to remain inside the room", () => {
    const state = ownsWallShelf();
    const placed = withPlacement(layout(), { instanceId: "shop-equipment-1", x: 2.5, z: -4, rotation: 0 });
    expect(validateEquipmentLayout(placed, state)).toMatchObject({
      valid: false,
      instanceId: "shop-equipment-1",
      reason: expect.stringContaining("正面取货位置被挡住"),
    });
  });

  it("requires both service sides of a double-sided gondola", () => {
    const state = buy(createEquipmentAssetState(), 1, "gondola-low", "biscuits");
    const placed = withPlacement(layout(), { instanceId: "shop-equipment-1", x: 0, z: 7, rotation: 0 });
    expect(validateEquipmentLayout(placed, state)).toMatchObject({
      valid: false,
      instanceId: "shop-equipment-1",
      reason: expect.stringContaining("背面取货位置被挡住"),
    });
  });

  it("rejects equipment that leaves its own aisle clear but blocks an original shelf service point", () => {
    const state = ownsWallShelf();
    const placed = withPlacement(layout(), {
      instanceId: "shop-equipment-1", x: -2.4, z: -0.8, rotation: 3,
    });
    expect(validateEquipmentLayout(placed, state)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("前方无法到达"),
    });
  });

  it.each([
    ["customer", { minX: -1.04, maxX: -.84, minZ: -2.25, maxZ: -2.05 }, "顾客侧"],
    ["clerk", { minX: -3.22, maxX: -3.02, minZ: -2.3, maxZ: -2.1 }, "店员侧"],
  ] as const)("revalidates the checkout %s side with the same carton obstacles", (_side, obstacle, reason) => {
    expect(validateEquipmentLayout(layout(), createEquipmentAssetState(), [obstacle])).toMatchObject({
      valid: false,
      reason: expect.stringContaining(reason),
    });
  });

  it("rejects a clear service point when a full divider cuts off every door route", () => {
    const state = ownsWallShelf();
    const placed = withPlacement(layout(), { instanceId: "shop-equipment-1", x: 0, z: 6.5, rotation: 0 });
    const divider = { ...shopBounds(1), minZ: 4.8, maxZ: 5 };
    expect(validateEquipmentLayout(placed, state, [divider])).toMatchObject({
      valid: false,
      instanceId: "shop-equipment-1",
      reason: expect.stringContaining("无法从店门到达"),
    });
  });

  it("suggests a deterministic valid placement without mutating the layout and refuses duplicate, unknown or fully blocked requests", () => {
    const state = ownsWallShelf();
    const base = layout();
    const snapshot = structuredClone(base);
    const suggestion = suggestEquipmentPlacement(base, state, "shop-equipment-1");
    expect(suggestion).not.toBeNull();
    expect(validateEquipmentPlacementsStructure([suggestion!])).toBe(true);
    expect(validateEquipmentLayout(withPlacement(base, suggestion!), state)).toEqual({ valid: true });
    expect(base).toEqual(snapshot);
    expect(suggestEquipmentPlacement(withPlacement(base, suggestion!), state, "shop-equipment-1")).toBeNull();
    expect(suggestEquipmentPlacement(base, state, "shop-equipment-99")).toBeNull();
    expect(suggestEquipmentPlacement(base, state, "shop-equipment-1", [shopBounds(1)])).toBeNull();
  });
});

describe("service and display-slot world transforms", () => {
  it.each([
    [0, { x: 3, y: 2, z: 8 }],
    [1, { x: 5, y: 2, z: 4 }],
    [2, { x: 1, y: 2, z: 2 }],
    [3, { x: -1, y: 2, z: 6 }],
  ] as const)("applies Babylon positive yaw for %i quarter turns", (rotation, expectedPoint) => {
    expect(transformEquipmentPoint({ instanceId: "shop-equipment-1", x: 2, z: 5, rotation }, [1, 2, 3])).toEqual(expectedPoint);
  });

  it("transforms authored slots, composes yaw and returns null for invalid indices", () => {
    const state = ownsWallShelf();
    const instance = state.instances[0]!;
    const placement: EquipmentFloorPlacement = { instanceId: instance.id, x: 2, z: 5, rotation: 1 };
    const authored = EQUIPMENT_ASSETS[instance.assetId].placementSlots[0]!;
    expect(equipmentSlotPosition(instance, placement, 0)).toEqual({
      x: placement.x + authored.position[2],
      y: authored.position[1],
      z: placement.z - authored.position[0],
      yaw: authored.rotationY + Math.PI / 2,
      maxSize: authored.maxSize,
    });
    expect(equipmentSlotPosition(instance, placement, -1)).toBeNull();
    expect(equipmentSlotPosition(instance, placement, EQUIPMENT_ASSETS[instance.assetId].capacity)).toBeNull();
    expect(equipmentSlotPosition(instance, placement, Number.NaN)).toBeNull();
  });

  it("preserves the authored back-side yaw and rotates both gondola service points", () => {
    const state = buy(createEquipmentAssetState(), 1, "gondola-low", "soap");
    const instance = state.instances[0]!;
    const placement: EquipmentFloorPlacement = { instanceId: instance.id, x: -1, z: 6, rotation: 3 };
    const backSlotIndex = EQUIPMENT_ASSETS[instance.assetId].capacity / 2;
    const authoredBack = EQUIPMENT_ASSETS[instance.assetId].placementSlots[backSlotIndex]!;
    const transformed = equipmentSlotPosition(instance, placement, backSlotIndex)!;
    expect(authoredBack.rotationY).toBe(Math.PI);
    expect(transformed.yaw).toBe(Math.PI + 3 * Math.PI / 2);
    expect(transformed).toMatchObject(transformEquipmentPoint(placement, authoredBack.position));

    const services = equipmentServicePositions(instance, placement);
    expect(services.map(({ id }) => id)).toEqual(["front", "back"]);
    for (const [index, service] of EQUIPMENT_ASSETS[instance.assetId].servicePoints.entries()) {
      expect(services[index]).toEqual({ id: service.id, ...transformEquipmentPoint(placement, service.position) });
    }
  });
});
