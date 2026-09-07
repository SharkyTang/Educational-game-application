import { describe, expect, it } from "vitest";
import { PRODUCT_ASSET_IDS } from "../../src/sim3d/product-library/catalog";
import { CATALOG_RACKS, PRODUCT_DISPLAYS, segmentClear, type FloorPoint, type LayoutCollider } from "../../src/sim3d/productLayout";
import {
  CHECKOUT_CLERK_POINT, CHECKOUT_CUSTOMER_POINT, FURNITURE_DEFINITIONS, FURNITURE_IDS,
  FIXED_LAYOUT_OBSTACLES, LAYOUT_WALK_RADIUS, RESERVED_LAYOUT_AREAS, SHOP_ENTRANCE_POINT,
  createDefaultShopLayout, definitionForFurniture, furnitureBounds, furnitureForProduct,
  layoutColliders, layoutEquals, layoutRoute, shopBounds, shopWallColliders, transformLayoutPoint,
  validateShopLayout, validateShopLayoutStructure,
  type FurnitureId, type FurniturePlacement, type FurnitureRotation, type ShopLayout,
} from "../../src/sim3d/shopLayout";

function move(layout: ShopLayout, id: FurnitureId, update: Partial<Omit<FurniturePlacement, "id">>): ShopLayout {
  return { ...layout, placements: layout.placements.map((placement) => placement.id === id ? { ...placement, ...update } : { ...placement }) };
}

function expectClearRoute(from: FloorPoint, to: FloorPoint, obstacles: readonly LayoutCollider[], bounds: LayoutCollider): void {
  const route = layoutRoute(from, to, obstacles, bounds);
  expect(route, `route (${from.x},${from.z}) → (${to.x},${to.z})`).not.toBeNull();
  let current = from;
  for (const point of route!) {
    expect(segmentClear(current, point, obstacles, LAYOUT_WALK_RADIUS)).toBe(true);
    expect(point.x).toBeGreaterThanOrEqual(bounds.minX + LAYOUT_WALK_RADIUS - 1e-8);
    expect(point.x).toBeLessThanOrEqual(bounds.maxX - LAYOUT_WALK_RADIUS + 1e-8);
    expect(point.z).toBeGreaterThanOrEqual(bounds.minZ + LAYOUT_WALK_RADIUS - 1e-8);
    expect(point.z).toBeLessThanOrEqual(bounds.maxZ - LAYOUT_WALK_RADIUS + 1e-8);
    current = point;
  }
  expect(current.x).toBeCloseTo(to.x, 7);
  expect(current.z).toBeCloseTo(to.z, 7);
}

describe("shop renovation identities and physical transforms", () => {
  it("starts with the existing eleven fixtures and independently owned placement objects", () => {
    const layout = createDefaultShopLayout();
    expect(layout.expansion).toBe(0);
    expect(layout.placements).toHaveLength(11);
    expect(new Set(layout.placements.map((placement) => placement.id)).size).toBe(11);
    expect(layout.placements.every((placement) => placement.rotation === 0)).toBe(true);
    expect(layout.placements.find((placement) => placement.id === "checkout-counter")).toEqual({ id: "checkout-counter", x: -2.2, z: -2.2, rotation: 0 });
    expect(layout.placements.find((placement) => placement.id === "milk-fridge")).toEqual({ id: "milk-fridge", x: 0, z: 4.065, rotation: 0 });
    const another = createDefaultShopLayout();
    layout.placements[0]!.x = 0;
    expect(another.placements[0]!.x).toBe(-3.025);
    expect(definitionForFurniture("pantry-grains").origin.x).toBe(-3.025);
  });

  it("assigns every existing SKU to its entire fixture rather than moving individual compartments", () => {
    expect(furnitureForProduct("milk")).toBe("milk-fridge");
    expect(furnitureForProduct("bread")).toBe("bread-rack");
    for (const rack of CATALOG_RACKS) for (const id of rack.products) expect(furnitureForProduct(id)).toBe(rack.id);
    expect(new Set(PRODUCT_ASSET_IDS.map(furnitureForProduct)).size).toBe(10);
    expect(FURNITURE_DEFINITIONS.find((definition) => definition.id === "checkout-counter")!.front).toEqual({ x: 1, z: 0 });
  });

  it("preserves original slot coordinates exactly before the first renovation", () => {
    const layout = createDefaultShopLayout();
    for (const id of PRODUCT_ASSET_IDS) {
      for (const point of PRODUCT_DISPLAYS[id].slots) expect(transformLayoutPoint(layout, furnitureForProduct(id), point)).toEqual(point);
      expect(transformLayoutPoint(layout, furnitureForProduct(id), PRODUCT_DISPLAYS[id].approach)).toEqual(PRODUCT_DISPLAYS[id].approach);
    }
  });

  it("moves every compartment, approach point and facing of a rack with the same rigid rotation", () => {
    const original = createDefaultShopLayout();
    const layout = move(original, "pantry-grains", { x: 0.5, z: 5.8, rotation: 1 });
    const origin = definitionForFurniture("pantry-grains").origin;
    for (const id of ["cereal", "pasta", "rice", "flour"] as const) {
      for (const point of PRODUCT_DISPLAYS[id].slots) {
        const transformed = transformLayoutPoint(layout, furnitureForProduct(id), point);
        expect(transformed.x).toBeCloseTo(0.5 + point.z - origin.z, 8);
        expect(transformed.z).toBeCloseTo(5.8 - (point.x - origin.x), 8);
        expect(transformed.y).toBe(point.y);
      }
    }
    const marker = { x: -2.8, z: -0.3, label: "test point" };
    expect(transformLayoutPoint(layout, "pantry-grains", marker)).toMatchObject({ label: "test point" });
    expect("y" in transformLayoutPoint(layout, "pantry-grains", marker)).toBe(false);
    expect(marker).toEqual({ x: -2.8, z: -0.3, label: "test point" });
    expect(original.placements[0]!.rotation).toBe(0);
  });

  it("swaps the complete world footprint on a quarter turn, including an already sideways shelf", () => {
    const plain: FurniturePlacement = { id: "bread-rack", x: 0, z: 0, rotation: 0 };
    const straight = furnitureBounds(plain); const turned = furnitureBounds({ ...plain, rotation: 1 });
    expect(straight.maxX - straight.minX).toBeCloseTo(0.70);
    expect(straight.maxZ - straight.minZ).toBeCloseTo(1.84);
    expect(turned.maxX - turned.minX).toBeCloseTo(1.84);
    expect(turned.maxZ - turned.minZ).toBeCloseTo(0.70);
    expect(furnitureBounds({ ...plain, rotation: 2 })).toEqual(straight);
    expect(furnitureBounds({ ...plain, rotation: 3 })).toEqual(turned);
  });

  it("extends only the back of the current shop by three metres", () => {
    expect(shopBounds(0)).toEqual({ minX: -3.4, maxX: 3.4, minZ: -4.6, maxZ: 4.6 });
    expect(shopBounds(1)).toEqual({ minX: -3.4, maxX: 3.4, minZ: -4.6, maxZ: 7.6 });
    const moved = move(createDefaultShopLayout(), "milk-fridge", { x: 0, z: 5.7 });
    expect(validateShopLayout(moved)).toMatchObject({ valid: false, furnitureId: "milk-fridge" });
    expect(validateShopLayout({ ...moved, expansion: 1 })).toEqual({ valid: true });
  });

  it("compares layouts by fixture identity rather than array order without mutating either", () => {
    const layout = createDefaultShopLayout();
    const reordered = { ...layout, placements: [...layout.placements].reverse() };
    expect(layoutEquals(layout, reordered)).toBe(true);
    expect(layoutEquals(layout, { ...layout, expansion: 1 })).toBe(false);
    expect(layoutEquals(layout, move(layout, "bread-rack", { x: 0 }))).toBe(false);
    expect(layoutEquals(layout, move(layout, "bread-rack", { rotation: 2 }))).toBe(false);
    expect(layoutEquals(layout, { ...layout, placements: layout.placements.slice(1) })).toBe(false);
    expect(layout.placements[0]!.id).toBe("pantry-grains");
  });
});

describe("safe and usable furniture layouts", () => {
  it("accepts the real initial layout and reaches all thirty service positions and both sides of the counter", () => {
    const layout = createDefaultShopLayout();
    expect(validateShopLayout(layout)).toEqual({ valid: true });
    const obstacles = [...layoutColliders(layout), ...shopWallColliders(layout.expansion)];
    const bounds = shopBounds(0);
    for (const id of PRODUCT_ASSET_IDS) expectClearRoute(SHOP_ENTRANCE_POINT, PRODUCT_DISPLAYS[id].approach, obstacles, bounds);
    expectClearRoute(SHOP_ENTRANCE_POINT, CHECKOUT_CUSTOMER_POINT, obstacles, bounds);
    expectClearRoute(SHOP_ENTRANCE_POINT, CHECKOUT_CLERK_POINT, obstacles, bounds);
  });

  it("opens the actual narrow clerk aisle without reducing the walking radius", () => {
    const obstacles = layoutColliders(createDefaultShopLayout());
    const priorPlant = { minX: -3.22, maxX: -2.81, minZ: -3.83, maxZ: -3.41 };
    const withPriorPlant = [...obstacles.filter((obstacle) => !FIXED_LAYOUT_OBSTACLES.some((fixed) => JSON.stringify(obstacle) === JSON.stringify(fixed))), priorPlant, FIXED_LAYOUT_OBSTACLES[1]!];
    expect(layoutRoute(SHOP_ENTRANCE_POINT, CHECKOUT_CLERK_POINT, withPriorPlant, shopBounds(0))).toBeNull();
    expectClearRoute(SHOP_ENTRANCE_POINT, CHECKOUT_CLERK_POINT, obstacles, shopBounds(0));
    expect(LAYOUT_WALK_RADIUS).toBe(0.26);
  });

  it("accepts freely positioned and rotated equipment in the original room", () => {
    expect(validateShopLayout(move(createDefaultShopLayout(), "milk-fridge", { x: 0, z: 1, rotation: 1 }))).toEqual({ valid: true });
    expect(validateShopLayout(move(createDefaultShopLayout(), "checkout-counter", { x: 0, z: 0, rotation: 1 }))).toEqual({ valid: true });
  });

  it.each(FURNITURE_IDS)("supports all four orientations of %s in the added floor space", (id) => {
    for (const rotation of [0, 1, 2, 3] as const) {
      // The left side of the extension leaves the original rear fridges out of the service aisle.
      const layout = move({ ...createDefaultShopLayout(), expansion: 1 }, id, { x: -1.7, z: 5.7, rotation });
      expect(validateShopLayout(layout), `${id}, rotation ${rotation}`).toEqual({ valid: true });
    }
  });

  it("rejects physical overlap even when both equipment centres are inside the shop", () => {
    const layout = move(createDefaultShopLayout(), "milk-fridge", { x: -2.2, z: -2.2 });
    expect(validateShopLayout(layout)).toMatchObject({ valid: false, reason: expect.stringContaining("重叠") });
  });

  it("checks the full rotated footprint against walls and keeps the entrance free", () => {
    expect(validateShopLayout(move(createDefaultShopLayout(), "pantry-grains", { rotation: 1 })))
      .toMatchObject({ valid: false, furnitureId: "pantry-grains", reason: expect.stringContaining("超出") });
    expect(validateShopLayout(move(createDefaultShopLayout(), "checkout-counter", { x: 0, z: -3.75 })))
      .toMatchObject({ valid: false, furnitureId: "checkout-counter", reason: expect.stringContaining("店门") });
  });

  it("reserves fixed plants and every indoor unloading pad while keeping empty mats walkable", () => {
    const layout = createDefaultShopLayout();
    expect(validateShopLayout(move(layout, "pantry-grains", { x: -2.75, z: -4.1, rotation: 1 })))
      .toMatchObject({ valid: false, reason: expect.stringContaining("固定盆栽") });
    for (const area of RESERVED_LAYOUT_AREAS) {
      const inPad = move(layout, "pantry-grains", { x: (area.minX + area.maxX) / 2, z: (area.minZ + area.maxZ) / 2 });
      expect(validateShopLayout(inPad), area.name).toMatchObject({ valid: false, reason: expect.stringContaining("卸货") });
    }
    expect(layoutColliders(layout)).toHaveLength(13);
    expectClearRoute({ x: 0.7, z: -2.9 }, { x: 2.1, z: -2.9 }, layoutColliders(layout), shopBounds(0));
  });

  it("rejects a shelf facing the wall even though its physical footprint still fits", () => {
    expect(validateShopLayout(move(createDefaultShopLayout(), "pantry-grains", { rotation: 2 })))
      .toMatchObject({ valid: false, furnitureId: "pantry-grains", reason: expect.stringContaining("取货通道") });
  });

  it("requires the relocated counter's clerk side as well as its customer side to be reachable", () => {
    const layout = move({ ...createDefaultShopLayout(), expansion: 1 }, "checkout-counter", { x: -2.4, z: 6 });
    expect(validateShopLayout(layout)).toMatchObject({ valid: false, furnitureId: "checkout-counter", reason: expect.stringContaining("店员侧") });
    const customerBlocked = move({ ...createDefaultShopLayout(), expansion: 1 }, "checkout-counter", { x: 2.4, z: 6 });
    expect(validateShopLayout(customerBlocked)).toMatchObject({ valid: false, furnitureId: "checkout-counter", reason: expect.stringContaining("顾客侧") });
  });

  it("accounts for wall trim instead of approving service positions that the real world blocks", () => {
    const counter = move({ ...createDefaultShopLayout(), expansion: 1 }, "checkout-counter", { x: 1.875, z: 6 });
    const customerPoint = transformLayoutPoint(counter, "checkout-counter", CHECKOUT_CUSTOMER_POINT);
    expect(customerPoint.x).toBeCloseTo(3.135, 8);
    expect(customerPoint.x).toBeLessThan(shopBounds(1).maxX - LAYOUT_WALK_RADIUS);
    expect(validateShopLayout(counter)).toMatchObject({ valid: false, furnitureId: "checkout-counter", reason: expect.stringContaining("顾客侧") });
    const milk = move({ ...createDefaultShopLayout(), expansion: 1 }, "milk-fridge", { x: 0, z: 5.99, rotation: 2 });
    const milkPoint = transformLayoutPoint(milk, "milk-fridge", PRODUCT_DISPLAYS.milk.approach);
    expect(milkPoint.z).toBeCloseTo(7.335, 8);
    expect(milkPoint.z).toBeLessThan(shopBounds(1).maxZ - LAYOUT_WALK_RADIUS);
    expect(validateShopLayout(milk)).toMatchObject({ valid: false, furnitureId: "milk-fridge", reason: expect.stringContaining("取货通道") });
  });

  it("detects disconnected aisles rather than accepting non-overlapping furniture alone", () => {
    const divider = { minX: -2.735, maxX: 2.59, minZ: 0.90, maxZ: 1.03 };
    const layout = createDefaultShopLayout();
    expect(validateShopLayout(layout, [divider])).toMatchObject({ valid: false, reason: expect.stringContaining("通道") });
    expect(layoutRoute(SHOP_ENTRANCE_POINT, PRODUCT_DISPLAYS.milk.approach, [...layoutColliders(layout), divider], shopBounds(0))).toBeNull();
    expect(validateShopLayout(layout)).toEqual({ valid: true });
  });

  it("rejects overlap with an occupied box, but temporary box blockages do not invalidate a saved static layout", () => {
    const layout = move(createDefaultShopLayout(), "milk-fridge", { x: 0, z: 1, rotation: 1 });
    const crate = { minX: -0.23, maxX: 0.23, minZ: 0.82, maxZ: 1.18 };
    expect(validateShopLayout(layout)).toEqual({ valid: true });
    expect(validateShopLayout(layout, [crate])).toMatchObject({ valid: false, furnitureId: "milk-fridge", reason: expect.stringContaining("货箱") });
    expect(validateShopLayoutStructure(layout)).toBe(true);
    expect(validateShopLayout(layout)).toEqual({ valid: true });
    const entranceCrate = { minX: -0.3, maxX: 0.3, minZ: -4.3, maxZ: -3.9 };
    expect(validateShopLayout(createDefaultShopLayout(), [entranceCrate])).toMatchObject({ valid: false, reason: expect.stringContaining("店门") });
  });

  it("updates cached validation after an in-place edit and never exposes its cached result object", () => {
    const layout = createDefaultShopLayout();
    const first = validateShopLayout(layout); first.valid = false; first.reason = "caller mutation";
    expect(validateShopLayout(layout)).toEqual({ valid: true });
    const pantry = layout.placements.find((placement) => placement.id === "pantry-grains")!;
    pantry.rotation = 2;
    expect(validateShopLayout(layout)).toMatchObject({ valid: false, furnitureId: "pantry-grains" });
    pantry.rotation = 0;
    expect(validateShopLayout(layout)).toEqual({ valid: true });
  });
});

describe("untrusted layout and bounded routing input", () => {
  it.each([
    null, {}, [], { expansion: 0, placements: [] }, { expansion: 3, placements: createDefaultShopLayout().placements },
    { expansion: "1", placements: createDefaultShopLayout().placements },
    { ...createDefaultShopLayout(), placements: createDefaultShopLayout().placements.slice(1) },
    { ...createDefaultShopLayout(), placements: [...createDefaultShopLayout().placements, createDefaultShopLayout().placements[0]] },
  ])("rejects missing equipment or an unsupported layout shape %#", (value) => {
    expect(validateShopLayoutStructure(value)).toBe(false);
    expect(validateShopLayout(value).valid).toBe(false);
  });

  it.each([
    { id: "not-a-machine" }, { id: "milk-fridge" }, { x: Number.NaN }, { x: Number.POSITIVE_INFINITY }, { z: Number.NEGATIVE_INFINITY },
    { x: "0" }, { z: null }, { rotation: -1 }, { rotation: 4 }, { rotation: 1.5 }, { rotation: Number.NaN }, { rotation: "1" },
  ])("rejects duplicate identity and non-finite or illegal coordinates/rotation %#", (change) => {
    const layout = createDefaultShopLayout();
    Object.assign(layout.placements[0]!, change);
    expect(validateShopLayoutStructure(layout)).toBe(false);
    expect(validateShopLayout(layout).valid).toBe(false);
  });

  it("allows continuous metre positions without requiring an invisible grid snap", () => {
    const layout = move(createDefaultShopLayout(), "milk-fridge", { x: 0.123456, z: 1.02468, rotation: 1 as FurnitureRotation });
    expect(validateShopLayoutStructure(layout)).toBe(true);
    expect(validateShopLayout(layout)).toEqual({ valid: true });
  });

  it("rejects blocked endpoints and out-of-room shortcuts, including a zero-length blocked route", () => {
    const bounds = shopBounds(0);
    const obstacle = { minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 };
    expect(layoutRoute({ x: 0, z: 0 }, { x: 0, z: 0 }, [obstacle], bounds)).toBeNull();
    expect(layoutRoute({ x: 0, z: -2 }, { x: 0, z: 0 }, [obstacle], bounds)).toBeNull();
    expect(layoutRoute({ x: 3.3, z: -2 }, { x: 3.3, z: 2 }, [], bounds)).toBeNull();
    expect(layoutRoute({ x: Number.NaN, z: -2 }, { x: 0, z: 2 }, [], bounds)).toBeNull();
    expect(layoutRoute({ x: 0, z: -2 }, { x: 0, z: 2 }, [], bounds, -1)).toBeNull();
    expect(layoutRoute({ x: 0, z: -2 }, { x: 0, z: -2 }, [], bounds)).toEqual([]);
  });

  it("finds a real back-room detour beyond the old route grid while respecting a closed divider", () => {
    const layout = move({ ...createDefaultShopLayout(), expansion: 1 }, "checkout-counter", { x: 0, z: 5.7 });
    const from = { x: -1.3, z: 5.7 }; const to = { x: 1.3, z: 5.7 };
    expectClearRoute(from, to, layoutColliders(layout), shopBounds(1));
    const divider = { minX: -3.4, maxX: 3.4, minZ: 4.9, maxZ: 5.0 };
    expect(layoutRoute(SHOP_ENTRANCE_POINT, { x: 0, z: 6.5 }, [divider], shopBounds(1))).toBeNull();
  });

  it("routes from the street only when the caller explicitly supplies the doorway extent", () => {
    const layout = createDefaultShopLayout();
    const from = { x: 0, z: -5.3 };
    expect(layoutRoute(from, CHECKOUT_CUSTOMER_POINT, layoutColliders(layout), shopBounds(0))).toBeNull();
    expectClearRoute(from, CHECKOUT_CUSTOMER_POINT, layoutColliders(layout), { ...shopBounds(0), minZ: -6 });
  });

  it("rejects malformed extra obstacle data rather than ignoring it", () => {
    const layout = createDefaultShopLayout();
    expect(validateShopLayout(layout, [{ minX: 0, maxX: Number.NaN, minZ: 0, maxZ: 1 }])).toMatchObject({ valid: false });
    expect(validateShopLayout(layout, [{ minX: 1, maxX: 0, minZ: 0, maxZ: 1 }])).toMatchObject({ valid: false });
  });
});
