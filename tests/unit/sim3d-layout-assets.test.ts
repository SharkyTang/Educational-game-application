import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PBRMaterial, Ray, Scene, Texture, TransformNode, Vector3 } from "@babylonjs/core";
import { createShop } from "../../src/sim3d/assets";
import { createCatalogFixtures } from "../../src/sim3d/productFixtures";
import { CATALOG_RACKS, type LayoutCollider } from "../../src/sim3d/productLayout";
import { FURNITURE_DEFINITIONS, type FurnitureId, type ShopLayout } from "../../src/sim3d/shopLayout";

describe("movable shop furniture and physical floor expansion", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const context = {
        fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), clearRect: vi.fn(),
        drawImage: vi.fn(), fillStyle: "", strokeStyle: "", lineWidth: 1,
        textAlign: "left", font: "12px Arial",
      };
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });

  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); });

  function originalLayout(): ShopLayout {
    return { expansion: 0, placements: FURNITURE_DEFINITIONS.map(({ id, origin }) => ({ id, ...origin, rotation: 0 })) };
  }

  function furnitureNode(id: FurnitureId): TransformNode {
    const node = scene.getTransformNodeByName(`catalog-rack-${id}`) ?? scene.getMeshByName(id);
    expect(node, `${id}: furniture has one persistent root`).not.toBeNull();
    return node!;
  }

  function nearPoint(actual: { x: number; y?: number; z: number }, expected: { x: number; y?: number; z: number }): void {
    expect(actual.x).toBeCloseTo(expected.x, 5);
    expect(actual.z).toBeCloseTo(expected.z, 5);
    if (expected.y !== undefined) expect(actual.y).toBeCloseTo(expected.y, 5);
  }

  function nearBounds(actual: LayoutCollider, expected: LayoutCollider): void {
    for (const axis of ["minX", "maxX", "minZ", "maxZ"] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 5);
  }

  // Independent quarter-turn expectations: rotation 1 maps +x to -z in Babylon.
  function turnPoint(point: { x: number; y?: number; z: number }, id: FurnitureId, layout: ShopLayout): { x: number; y?: number; z: number } {
    const { origin } = FURNITURE_DEFINITIONS.find((entry) => entry.id === id)!;
    const placement = layout.placements.find((entry) => entry.id === id)!;
    const dx = point.x - origin.x; const dz = point.z - origin.z;
    const [x, z] = [[dx, dz], [dz, -dx], [-dx, -dz], [-dz, dx]][placement.rotation]!;
    return { x: placement.x + x!, y: point.y, z: placement.z + z! };
  }

  function turnedBounds(bounds: LayoutCollider, id: FurnitureId, layout: ShopLayout): LayoutCollider {
    const points = [bounds.minX, bounds.maxX].flatMap((x) => [bounds.minZ, bounds.maxZ].map((z) => turnPoint({ x, z }, id, layout)));
    return { minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)), minZ: Math.min(...points.map((point) => point.z)), maxZ: Math.max(...points.map((point) => point.z)) };
  }

  function measuredBounds(node: TransformNode): LayoutCollider {
    const { min, max } = node.getHierarchyBoundingVectors(true);
    return { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z };
  }

  it("preserves existing furniture anchors, targets and shelf stock coordinates at the initial layout", () => {
    const shop = createShop(scene, { catalogFixtures: true });
    const fixtures = createCatalogFixtures(scene, {});
    nearPoint(furnitureNode("milk-fridge").position, { x: 0, y: 1.11, z: 4.43 });
    nearPoint(furnitureNode("bread-rack").position, { x: 3.22, y: 0.94, z: 0.3 });
    nearPoint(furnitureNode("checkout-counter").position, { x: -2.2, y: 0.465, z: -2.2 });
    const positions = [...shop.targets, ...fixtures.targets].map((target) => ({ target, anchor: target.position, original: target.position.clone() }));
    const originalColliders = [...shop.colliders, ...fixtures.colliders].map((bounds) => ({ ...bounds }));
    shop.applyLayout(originalLayout()); fixtures.applyLayout(originalLayout());
    for (const { target, anchor, original } of positions) {
      expect(target.position).toBe(anchor);
      nearPoint(target.position, original);
    }
    [...shop.colliders, ...fixtures.colliders].forEach((bounds, index) => nearBounds(bounds, originalColliders[index]!));
    expect(shop.colliders).toHaveLength(10); // Five walls, three devices, two fixed plants.
    expect(fixtures.colliders).toHaveLength(8);
    expect(fixtures.targets).toHaveLength(28);
    expect(fixtures.root.metadata.noDecorativeStock).toBe(true);
    nearPoint(shop.root.metadata.shelfSlots.milk[0], { x: -0.30, y: 0.94, z: 3.77 });
    nearPoint(shop.root.metadata.shelfSlots.bread[0], { x: 2.78, y: 0.82, z: -0.21 });
    nearBounds(measuredBounds(scene.getMeshByName("oak-floor")!), { minX: -3.4, maxX: 3.4, minZ: -4.6, maxZ: 4.6 });
    expect(scene.getMeshByName("pendant-bulb-5.5")!.isEnabled()).toBe(false);
    expect(scene.getMeshByName("wainscot-stile-1-19")!.isEnabled()).toBe(false);
    nearPoint(scene.getTransformNodeByName("window-plant")!.position, { x: -3.01, z: -4.10 });
  });

  it("moves and turns all eleven complete models together with their targets and collision envelopes", () => {
    const shop = createShop(scene, { catalogFixtures: true }); const fixtures = createCatalogFixtures(scene, {});
    const nodes = FURNITURE_DEFINITIONS.map(({ id }) => ({ id, node: furnitureNode(id), bounds: measuredBounds(furnitureNode(id)), position: furnitureNode(id).position.clone(), yaw: furnitureNode(id).rotation.y }));
    const colliders = new Map<FurnitureId, LayoutCollider>([
      ["checkout-counter", { ...shop.colliders[5]! }], ["milk-fridge", { ...shop.colliders[6]! }], ["bread-rack", { ...shop.colliders[7]! }],
      ...CATALOG_RACKS.map((rack, index): [FurnitureId, LayoutCollider] => [rack.id as FurnitureId, { ...fixtures.colliders[index]! }]),
    ]);
    const targets = [...shop.targets, ...fixtures.targets].filter((target) => target.kind === "shelf" || target.kind === "counter").map((target) => ({
      target, position: target.position.clone(), id: (target.mesh.metadata?.furnitureId ?? target.mesh.parent?.metadata?.furnitureId) as FurnitureId,
    }));
    const counts = () => [scene.meshes.length, scene.transformNodes.length, scene.materials.length, scene.textures.length];
    const allocated = counts(); const shopColliders = shop.colliders; const rackColliders = fixtures.colliders;
    for (const rotation of [1, 2, 3, 0] as const) {
      const layout = originalLayout();
      layout.placements = layout.placements.map((entry) => ({ ...entry, x: entry.x + 0.45, z: entry.z + 1.6, rotation }));
      shop.applyLayout(layout); fixtures.applyLayout(layout);
      for (const { id, node, bounds, position, yaw } of nodes) {
        expect(furnitureNode(id)).toBe(node);
        expect(node.metadata.furnitureId).toBe(id);
        nearPoint(node.position, turnPoint(position, id, layout));
        expect(node.rotation.y).toBeCloseTo(yaw + rotation * Math.PI / 2);
        nearBounds(measuredBounds(node), turnedBounds(bounds, id, layout));
      }
      for (const { id, target, position } of targets) nearPoint(target.position, turnPoint(position, id, layout));
      for (const [id, bounds] of colliders) {
        const index = CATALOG_RACKS.findIndex((rack) => rack.id === id);
        const current = index >= 0 ? fixtures.colliders[index]! : shop.colliders[["checkout-counter", "milk-fridge", "bread-rack"].indexOf(id) + 5]!;
        nearBounds(current, turnedBounds(bounds, id, layout));
      }
      expect(shop.colliders).toBe(shopColliders); expect(fixtures.colliders).toBe(rackColliders);
      expect(counts()).toEqual(allocated);
    }
    shop.applyLayout(originalLayout()); fixtures.applyLayout(originalLayout());
    for (const { id, node, bounds, position, yaw } of nodes) {
      expect(furnitureNode(id)).toBe(node);
      nearPoint(node.position, position); nearBounds(measuredBounds(node), bounds); expect(node.rotation.y).toBe(yaw);
    }
    expect(counts()).toEqual(allocated);
  });

  it("carries the scanner, card reader, receipt printer and their pickable surfaces with the counter", () => {
    const shop = createShop(scene, { catalogFixtures: true });
    const layout = originalLayout();
    Object.assign(layout.placements.find((entry) => entry.id === "checkout-counter")!, { x: 1.1, z: 5.5, rotation: 1 });
    const originalSlot = shop.root.metadata.shelfSlots.milk[0].clone();
    shop.applyLayout(layout);
    for (const [name, x, y, z] of [
      ["checkout-scanner", 1.38, 1.028, 5.25], ["card-terminal", 0.64, 1.037, 5.08], ["receipt-printer", 1.22, 1.076, 5.9],
    ] as const) {
      const child = scene.getMeshByName(name)!;
      child.computeWorldMatrix(true);
      expect(child.isDescendantOf(furnitureNode("checkout-counter"))).toBe(true);
      expect(child.isPickable).toBe(true);
      nearPoint(child.getAbsolutePosition(), { x, y, z });
    }
    nearPoint(shop.targets.find((target) => target.id === "counter")!.position, { x: 1.15, y: 1.05, z: 4.93 });
    nearPoint(shop.root.metadata.shelfSlots.milk[0], originalSlot);
    const scanner = scene.getMeshByName("checkout-scanner")!;
    const ray = new Ray(new Vector3(1.38, 1.6, 5.25), new Vector3(0, -1, 0), 1);
    const hit = scene.pickWithRay(ray, (mesh) => mesh === scanner || mesh.isDescendantOf(scanner));
    expect(hit?.hit).toBe(true);
  });

  it("adds both three-metre shop stages and moves the real rear wall without stretching floor planks", () => {
    const shop = createShop(scene, { catalogFixtures: true });
    const floor = scene.getMeshByName("oak-floor")!;
    const rear = scene.getMeshByName("back-plaster")!;
    const texture = (floor.material as PBRMaterial).albedoTexture as Texture;
    const drops = shop.targets.filter((target) => target.kind === "drop-zone").map((target) => ({ target, position: target.position.clone(), bounds: measuredBounds(target.mesh) }));
    const oldWallRay = new Ray(new Vector3(0, 1.8, 4.4), new Vector3(0, 0, 1), 0.4);
    const newFloorRay = new Ray(new Vector3(0, 1, 6.4), new Vector3(0, -1, 0), 2);
    expect(scene.pickWithRay(oldWallRay, (mesh) => mesh === rear)?.hit).toBe(true);
    expect(scene.pickWithRay(newFloorRay, (mesh) => mesh === floor)?.hit).toBe(false);
    const layout = originalLayout(); layout.expansion = 1;
    const allocated = [scene.meshes.length, scene.materials.length, scene.textures.length];
    shop.applyLayout(layout); shop.applyLayout(layout);
    nearBounds(measuredBounds(floor), { minX: -3.4, maxX: 3.4, minZ: -4.6, maxZ: 7.6 });
    for (const side of [-1, 1]) {
      const wall = measuredBounds(scene.getMeshByName(`wall-${side}`)!);
      expect(wall.minZ).toBeCloseTo(-4.675, 5); expect(wall.maxZ).toBeCloseTo(7.675, 5);
      const lining = measuredBounds(scene.getMeshByName(`wainscot-${side}`)!);
      expect(lining.minZ).toBeCloseTo(-4.6, 5); expect(lining.maxZ).toBeCloseTo(7.6, 5);
    }
    const ceiling = measuredBounds(scene.getMeshByName("shop-ceiling")!);
    expect(ceiling.minZ).toBeCloseTo(-4.75, 5); expect(ceiling.maxZ).toBeCloseTo(7.75, 5);
    expect(measuredBounds(rear).minZ).toBeCloseTo(7.6, 5);
    expect(scene.getMeshByName("stockroom-door")!.position.z).toBeCloseTo(7.49);
    expect(scene.getMeshByName("back-wall-shop-mark")!.position.z).toBeCloseTo(7.576);
    expect(scene.getMeshByName("ceiling-cornice-4.5")!.position.z).toBeCloseTo(7.5);
    expect(scene.pickWithRay(oldWallRay, (mesh) => mesh === rear)?.hit).toBe(false);
    expect(scene.pickWithRay(newFloorRay, (mesh) => mesh === floor)?.hit).toBe(true);
    expect(shop.colliders.some((bounds) => bounds.minX < 0 && bounds.maxX > 0 && bounds.minZ < 4.69 && bounds.maxZ > 4.69)).toBe(false);
    nearBounds(shop.colliders[2]!, { minX: -3.6, maxX: 3.6, minZ: 7.56, maxZ: 7.8 });
    expect(texture.uScale).toBeCloseTo(6.8 / 1.2); expect(texture.vScale).toBeCloseTo(12.2 / 1.2);
    expect(scene.getMeshByName("pendant-bulb-5.5")!.isEnabled()).toBe(true);
    expect(scene.getMeshByName("pendant-bulb-8.5")!.isEnabled()).toBe(false);
    expect(scene.getMeshByName("wainscot-stile-1-19")!.isEnabled()).toBe(true);
    expect(scene.getMeshByName("wainscot-stile-1-24")!.isEnabled()).toBe(false);
    nearPoint(scene.getTransformNodeByName("back-corner-plant")!.position, { x: -0.90, z: 4.02 });
    nearPoint(scene.getTransformNodeByName("window-plant")!.position, { x: -3.01, z: -4.10 });
    for (const { target, position, bounds } of drops) { nearPoint(target.position, position); nearBounds(measuredBounds(target.mesh), bounds); }
    layout.expansion = 2;
    shop.applyLayout(layout); shop.applyLayout(layout);
    nearBounds(measuredBounds(floor), { minX: -3.4, maxX: 3.4, minZ: -4.6, maxZ: 10.6 });
    expect(measuredBounds(rear).minZ).toBeCloseTo(10.6, 5);
    expect(scene.getMeshByName("stockroom-door")!.position.z).toBeCloseTo(10.49);
    nearBounds(shop.colliders[2]!, { minX: -3.6, maxX: 3.6, minZ: 10.56, maxZ: 10.8 });
    expect(texture.vScale).toBeCloseTo(15.2 / 1.2);
    expect(scene.getMeshByName("pendant-bulb-8.5")!.isEnabled()).toBe(true);
    expect(scene.getMeshByName("wainscot-stile-1-24")!.isEnabled()).toBe(true);
    expect([scene.meshes.length, scene.materials.length, scene.textures.length]).toEqual(allocated);
    shop.applyLayout(originalLayout());
    expect(measuredBounds(floor).maxZ).toBeCloseTo(4.6, 5);
    expect(scene.pickWithRay(oldWallRay, (mesh) => mesh === rear)?.hit).toBe(true);
    expect(texture.vScale).toBeCloseTo(9.2 / 1.2);
    expect(scene.getMeshByName("pendant-bulb-5.5")!.isEnabled()).toBe(false);
    expect(scene.getMeshByName("pendant-bulb-8.5")!.isEnabled()).toBe(false);
    expect(scene.getMeshByName("wainscot-stile-1-19")!.isEnabled()).toBe(false);
    expect(scene.getMeshByName("wainscot-stile-1-24")!.isEnabled()).toBe(false);
    expect([scene.meshes.length, scene.materials.length, scene.textures.length]).toEqual(allocated);
  });

  it("loads expanded and moved layouts directly without a frame at the old positions", () => {
    const layout = originalLayout(); layout.expansion = 1;
    Object.assign(layout.placements.find((entry) => entry.id === "milk-fridge")!, { x: 1.1, z: 6.8, rotation: 2 });
    Object.assign(layout.placements.find((entry) => entry.id === "pantry-grains")!, { x: -1.8, z: 5.7, rotation: 1 });
    const shop = createShop(scene, { catalogFixtures: true, layout });
    const fixtures = createCatalogFixtures(scene, {}, layout);
    nearPoint(furnitureNode("milk-fridge").position, turnPoint({ x: 0, y: 1.11, z: 4.43 }, "milk-fridge", layout));
    nearPoint(furnitureNode("pantry-grains").position, { x: -1.8, y: 0, z: 5.7 });
    expect(furnitureNode("pantry-grains").rotation.y).toBeCloseTo(0);
    expect(measuredBounds(scene.getMeshByName("oak-floor")!).maxZ).toBeCloseTo(7.6, 5);
    nearPoint(shop.root.metadata.shelfSlots.milk[0], turnPoint({ x: -0.30, y: 0.94, z: 3.77 }, "milk-fridge", layout));
    expect(shop.root.metadata.productYaw.milk).toBeCloseTo(Math.PI);
    expect(fixtures.targets.every((target) => target.mesh.getTotalVertices() === 0)).toBe(true);
  });
});
