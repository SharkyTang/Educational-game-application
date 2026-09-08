import { describe, expect, it } from "vitest";
import { createDefaultShopLayout, layoutColliders, layoutEquals, layoutRoute, SHOP_ENTRANCE_POINT,
  shopBounds, shopWallColliders, validateShopLayout, validateShopLayoutStructure } from "../../src/sim3d/shopLayout";
import { createEquipmentAssetState, purchaseEquipment } from "../../src/sim3d/equipmentCommerce";
import { suggestWorkstationPlacement, validateEquipmentLayout, type EquipmentShopLayout } from "../../src/sim3d/equipmentLayout";
import { DEFAULT_WORKSTATION_PLACEMENT, FALLBACK_WORKSTATION_PLACEMENT, workstationBounds,
  workstationInteractionPoint, workstationServicePoint, validateWorkstationPlacement,
  type WorkstationPlacement } from "../../src/sim3d/workstation";

const original = (): EquipmentShopLayout => ({ ...createDefaultShopLayout(), equipment: [] });
const withDesk = (workstation: WorkstationPlacement = { ...DEFAULT_WORKSTATION_PLACEMENT }): EquipmentShopLayout => ({ ...original(), workstation });

describe("free management workstation layout", () => {
  it("preserves the original eleven-fixture save shape and adds the computer independently", () => {
    const legacy = original();
    expect(legacy.placements).toHaveLength(11);
    expect(legacy).not.toHaveProperty("workstation");
    expect(validateShopLayoutStructure(legacy)).toBe(true);
    expect(validateShopLayout(legacy).valid).toBe(true);
    const current = withDesk();
    expect(current.placements).toEqual(legacy.placements);
    expect(validateEquipmentLayout(current, createEquipmentAssetState())).toEqual({ valid: true });
    expect(layoutEquals(current, legacy)).toBe(false);
    expect(layoutEquals(current, structuredClone(current))).toBe(true);
    expect(layoutColliders(current)).toHaveLength(layoutColliders(legacy).length + 1);
  });

  it.each([null, {}, [], { x: 0, z: 0 }, { x: 0, z: 0, rotation: 4 }, { x: 0, z: 0, rotation: 1.5 },
    { x: Infinity, z: 0, rotation: 0 }, { x: 0, z: NaN, rotation: 0 },
    { x: 0, z: 0, rotation: 0, owned: false }])("rejects malformed computer placement %#", (value) => {
    expect(validateWorkstationPlacement(value)).toBe(false);
    expect(validateShopLayoutStructure({ ...original(), workstation: value })).toBe(false);
  });

  it.each([0, 1, 2] as const)("fits the default desk and retains every service route in expansion %s", (expansion) => {
    const layout = { ...withDesk(), expansion };
    expect(validateEquipmentLayout(layout, createEquipmentAssetState())).toEqual({ valid: true });
    const bounds = workstationBounds(layout.workstation!);
    expect(bounds.minX).toBeCloseTo(-2.4); expect(bounds.maxX).toBeCloseTo(-1.2);
    expect(bounds.minZ).toBeCloseTo(-4.425); expect(bounds.maxZ).toBeCloseTo(-3.875);
    expect(layoutRoute(SHOP_ENTRANCE_POINT, workstationServicePoint(layout.workstation!),
      [...layoutColliders(layout), ...shopWallColliders(expansion)], shopBounds(expansion))).not.toBeNull();
  });

  it.each([
    [{ x: 0, z: -4.1, rotation: 0 }, "店门"],
    [{ x: 1.35, z: -2.9, rotation: 0 }, "卸货"],
    [{ x: -2.2, z: -2.2, rotation: 0 }, "重叠"],
    [{ x: -1.8, z: -4.15, rotation: 2 }, "电脑桌前方"],
    [{ x: -1.8, z: -5.25, rotation: 0 }, "店内"],
    [{ x: 0, z: -6.5, rotation: 0 }, "店内"],
  ] as const)("rejects unsafe or inaccessible placement %j", (placement, reason) => {
    const result = validateShopLayout(withDesk({ ...placement }));
    expect(result.valid).toBe(false); expect(result.reason).toContain(reason);
  });

  it("updates validation cache and layout equality when the computer alone changes", () => {
    const layout = withDesk();
    expect(validateShopLayout(layout).valid).toBe(true);
    const previous = structuredClone(layout);
    layout.workstation!.z = -2.2;
    expect(layoutEquals(previous, layout)).toBe(false);
    expect(validateShopLayout(layout).valid).toBe(false);
    layout.workstation!.z = -4.15;
    expect(validateShopLayout(layout).valid).toBe(true);
  });

  it("rejects a desk or an owned device blocking the other's physical space and service side", () => {
    const owned = purchaseEquipment(createEquipmentAssetState(), 100_000, {
      purchaseId: "computer-collision-equipment", assetId: "wall-shelf-narrow", productId: "cereal", purchasedDay: 1,
    }).state;
    const layout = { ...withDesk(), equipment: [{ instanceId: owned.instances[0]!.id, x: -1.8, z: -4.15, rotation: 0 as const }] };
    expect(validateEquipmentLayout(layout, owned).valid).toBe(false);
    const crate = { minX: -2.1, maxX: -1.5, minZ: -3.55, maxZ: -3.15 };
    const blocked = validateEquipmentLayout(withDesk(), createEquipmentAssetState(), [crate]);
    expect(blocked.valid).toBe(false); expect(blocked.reason).toContain("电脑桌前方");
  });

  it("provides the one physical outdoor fallback without opening arbitrary pavement placement", () => {
    const layout = withDesk({ ...FALLBACK_WORKSTATION_PLACEMENT });
    expect(validateEquipmentLayout(layout, createEquipmentAssetState())).toEqual({ valid: true });
    const service = workstationServicePoint(layout.workstation!);
    expect(service.x).toBe(-1.8); expect(service.z).toBeCloseTo(-6.1);
    expect(layoutRoute(SHOP_ENTRANCE_POINT, service,
      [...layoutColliders(layout), ...shopWallColliders(0)], { ...shopBounds(0), minZ: -6.5 })).not.toBeNull();
    layout.workstation!.x -= .1;
    expect(validateShopLayout(layout).valid).toBe(false);
  });

  it("suggests a deterministic alternative while leaving old furniture and equipment unchanged", () => {
    const layout = original();
    const owned = createEquipmentAssetState();
    const before = JSON.stringify([layout, owned]);
    expect(suggestWorkstationPlacement(layout, owned)).toEqual(DEFAULT_WORKSTATION_PLACEMENT);
    const obstacle = { minX: -2.4, maxX: -1.2, minZ: -4.425, maxZ: -3.875 };
    const selected = suggestWorkstationPlacement(layout, owned, [obstacle]);
    expect(selected).not.toEqual(DEFAULT_WORKSTATION_PLACEMENT);
    expect(suggestWorkstationPlacement(layout, owned, [obstacle])).toEqual(selected);
    expect(validateEquipmentLayout({ ...layout, workstation: selected }, owned, [obstacle]).valid).toBe(true);
    expect(JSON.stringify([layout, owned])).toBe(before);
  });

  it("terminates with the physical fallback when the search has no available indoor footprint", () => {
    const occupiedRoom = { ...shopBounds(0) };
    expect(suggestWorkstationPlacement(original(), createEquipmentAssetState(), [occupiedRoom])).toEqual(FALLBACK_WORKSTATION_PLACEMENT);
  });

  it.each([
    [0, 0, .85, -.6, .6, -.275, .275],
    [1, .85, 0, -.275, .275, -.6, .6],
    [2, 0, -.85, -.6, .6, -.275, .275],
    [3, -.85, 0, -.275, .275, -.6, .6],
  ] as const)("rotates service, screen and footprint together for quarter turn %s", (rotation, serviceX, serviceZ, minX, maxX, minZ, maxZ) => {
    const placement = { x: 0, z: 0, rotation };
    expect(workstationServicePoint(placement)).toEqual({ x: serviceX, z: serviceZ });
    expect(workstationBounds(placement)).toEqual({ minX, maxX, minZ, maxZ });
    expect(workstationInteractionPoint(placement).y).toBe(1.15);
  });
});
