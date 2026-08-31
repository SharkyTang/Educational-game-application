import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mesh, NullEngine, Ray, Scene, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import { createCrate, createShop, setShelfCapacity } from "../../src/sim3d/assets";
import { createCatalogFixtures, createReceivingPads } from "../../src/sim3d/productFixtures";
import { PRODUCT_ASSET_IDS } from "../../src/sim3d/product-library/catalog";
import { basketPlacement, checkoutPlacement, crateDimensions, cratePlacement, findCustomerRoute, fitProduct, PRODUCT_DISPLAYS, segmentClear, type LayoutCollider } from "../../src/sim3d/productLayout";
import { crateRestingHeight, measureCrateSupport, ProductVisuals, productDimensions, type CrateSupport } from "../../src/sim3d/productPresentation";
import { createStreet } from "../../src/sim3d/street";
import { ShopWorld } from "../../src/sim3d/world";
import { createFirstDayState, DELIVERY_DROP_POINTS, getCustomerOrder, PRODUCTS, reduceSim, SAFE_DROP_POINTS, type CrateId, type ProductId, type SimCommand, type SimState } from "../../src/sim3d/domain";

interface RendererHarness {
  state: SimState;
  products: Map<string, TransformNode>;
  crates: Map<CrateId, TransformNode>;
  productVisuals: ProductVisuals;
  inspection: Map<ProductId, TransformNode>;
  route: { x: number; z: number }[];
  customerRouteBlocked: boolean;
  syncInventory(): void;
  setCustomerRoute(initial: boolean): void;
  inspect(id: ProductId | null): void;
}

/** Test the real renderer methods using a NullEngine, without browser input or NPC downloads. */
describe("all-product game presentation", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = { createLinearGradient: () => gradient, createRadialGradient: () => gradient, measureText: () => ({ width: 100 }), getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }) };
      const context = new Proxy(values, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });
  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); });

  function harness(state: SimState, colliders: LayoutCollider[] = [], crateSupports: CrateSupport[] = []): RendererHarness {
    const customer = new TransformNode("harness-customer", scene);
    const basket = new TransformNode("harness-basket", scene); basket.parent = customer;
    const world = Object.create(ShopWorld.prototype) as RendererHarness;
    Object.assign(world, {
      state, scene, camera: new UniversalCamera("harness-camera", new Vector3(0, 1.65, -3.5), scene), canvas: { clientWidth: 1000 },
      colliders, crateSupports, productVisuals: new ProductVisuals(scene), occupiedCrates: new Set(), products: new Map(), crates: new Map(),
      shelfSlots: Object.fromEntries(PRODUCT_ASSET_IDS.map((id) => [id, PRODUCT_DISPLAYS[id].slots.map((point) => new Vector3(point.x, point.y, point.z))])),
      hands: new TransformNode("harness-hands", scene), basket, customer, inspection: new Map(), inspectionProduct: null,
      shadow: { addShadowCaster: vi.fn(), removeShadowCaster: vi.fn() }, callbacks: { onStatus: vi.fn() },
      customerPhase: state.customer.phase, customerObstacleSignature: "", route: [],
    });
    world.syncInventory();
    return world;
  }
  function command(state: SimState, action: SimCommand): SimState {
    const result = reduceSim(state, action);
    expect(result.changed, `${action.type}: ${result.message ?? ""}`).toBe(true);
    return result.state;
  }

  it("provides 30 distinct compartments and measured non-overlapping model positions on actual shelf surfaces", () => {
    const shop = createShop(scene, { catalogFixtures: true });
    const fixtures = createCatalogFixtures(scene, PRODUCTS);
    expect([...shop.targets, ...fixtures.targets].filter((target) => target.kind === "shelf")).toHaveLength(30);
    expect(scene.getTransformNodeByName("pantry-display")).toBeNull();
    const visuals = new ProductVisuals(scene);
    expect(visuals.loadedProductCount).toBe(0);
    for (const id of PRODUCT_ASSET_IDS) {
      const visual = visuals.create(id, `placed-${id}`);
      expect(visual.metadata).toMatchObject({ productId: id, libraryVersion: "corner-shop-products@1.0.0", baseAnchored: true });
      const display = PRODUCT_DISPLAYS[id];
      expect(display.slots).toHaveLength(8);
      const dimensions = productDimensions(visual);
      const bounds: { min: Vector3; max: Vector3 }[] = [];
      for (const slot of display.slots) {
        visual.position.set(slot.x, slot.y, slot.z); visual.rotation.y = display.yaw;
        visual.scaling.setAll(fitProduct(dimensions, display.maxSize));
        const bound = visual.getHierarchyBoundingVectors(true);
        expect(bound.min.y, `${id} sits on shelf`).toBeCloseTo(slot.y, 5);
        bounds.push(bound);
        const ray = new Ray(new Vector3(slot.x, slot.y + 0.015, slot.z), new Vector3(0, -1, 0), 0.06);
        const support = scene.pickWithRay(ray, (mesh) => /-(?:base|extra)-shelf$|^fridge-shelf-|^bread-tray-/.test(mesh.name));
        expect(support?.hit, `${id} needs a real support at slot y=${slot.y}`).toBe(true);
        expect(support!.pickedPoint!.y).toBeCloseTo(slot.y, 2);
      }
      for (let a = 0; a < bounds.length; a += 1) for (let b = a + 1; b < bounds.length; b += 1) {
        const first = bounds[a]!; const second = bounds[b]!;
        const overlap = ["x", "y", "z"].every((axis) => {
          const coordinate = axis as "x" | "y" | "z";
          return Math.min(first.max[coordinate], second.max[coordinate]) - Math.max(first.min[coordinate], second.min[coordinate]) > 0.001;
        });
        expect(overlap, `${id} slots ${a}/${b} overlap`).toBe(false);
      }
      visual.dispose(false, false);
    }
    expect(visuals.loadedProductCount).toBe(30);
    setShelfCapacity(scene, true);
    for (const id of PRODUCT_ASSET_IDS) expect(scene.getMeshByName(`${id}-capacity-note`)!.isEnabled()).toBe(false);
  });

  it("fits all models in their own crates, the shopping basket and checkout without destroying shared geometry", () => {
    const visuals = new ProductVisuals(scene);
    for (const id of PRODUCT_ASSET_IDS) {
      const one = visuals.create(id, `packed-${id}`); const two = visuals.create(id, `another-${id}`);
      const dimensions = productDimensions(one); const crate = crateDimensions(id);
      const firstMesh = one.getChildMeshes()[0] as Mesh; const secondMesh = two.getChildMeshes()[0] as Mesh;
      expect(firstMesh.geometry).toBe(secondMesh.geometry);
      for (let index = 0; index < 8; index += 1) {
        const packed = cratePlacement(id, dimensions, index);
        one.position.set(packed.position.x, packed.position.y, packed.position.z); one.rotation.setAll(0); one.scaling.setAll(packed.scale);
        const bounds = one.getHierarchyBoundingVectors(true);
        expect(bounds.min.x).toBeGreaterThan(-crate.width / 2);
        expect(bounds.max.x).toBeLessThan(crate.width / 2);
        expect(bounds.min.z).toBeGreaterThan(-crate.depth / 2);
        expect(bounds.max.z).toBeLessThan(crate.depth / 2);
        expect(bounds.min.y).toBeGreaterThan(0);
      }
      for (const quantity of [1, 2]) for (let index = 0; index < quantity; index += 1) {
        const packed = basketPlacement(dimensions, index, quantity);
        one.position.set(packed.position.x, packed.position.y, packed.position.z); one.rotation.set(0, packed.yaw, 0); one.scaling.setAll(packed.scale);
        const bounds = one.getHierarchyBoundingVectors(true);
        expect(bounds.min.x).toBeGreaterThan(-0.181);
        expect(bounds.max.x).toBeLessThan(0.181);
        expect(bounds.min.z).toBeGreaterThan(-0.141);
        expect(bounds.max.z).toBeLessThan(0.141);
        const checkout = checkoutPlacement(dimensions, index, false);
        one.position.set(checkout.position.x, checkout.position.y, checkout.position.z); one.rotation.y = checkout.yaw; one.scaling.setAll(checkout.scale);
        const onCounter = one.getHierarchyBoundingVectors(true);
        expect(onCounter.min.y).toBeCloseTo(1.012, 5);
        expect(onCounter.max.x).toBeLessThan(-1.56);
        expect(onCounter.min.z).toBeGreaterThan(-3.035);
        expect(onCounter.max.z).toBeLessThan(-1.365);
      }
      one.dispose(false, false);
      expect(two.getChildMeshes().every((mesh) => !mesh.isDisposed() && mesh.material)).toBe(true);
      expect((two.getChildMeshes()[0] as Mesh).geometry).not.toBeNull();
      two.dispose(false, false);
    }
  });

  it("routes every SKU through reachable shop space, including around occupied old indoor drop points", () => {
    const shop = createShop(scene, { catalogFixtures: true });
    const fixtures = createCatalogFixtures(scene, PRODUCTS);
    const colliders = [...shop.colliders, ...fixtures.colliders];
    for (const point of [{ x: 1.35, z: -2.9 }, { x: 2.2, z: -2.9 }, { x: -1.1, z: 2.6 }, { x: 1.8, z: 1.35 }]) colliders.push({ minX: point.x - 0.40, maxX: point.x + 0.40, minZ: point.z - 0.23, maxZ: point.z + 0.23 });
    const checkout = { x: -0.94, z: -2.15 };
    for (const id of PRODUCT_ASSET_IDS) {
      const destination = PRODUCT_DISPLAYS[id].approach;
      for (const origin of [{ x: 0, z: -4.35 }, checkout, PRODUCT_DISPLAYS.soap.approach, PRODUCT_DISPLAYS.cucumber.approach]) {
        const route = findCustomerRoute(origin, destination, colliders);
        expect(route, `${id}: route from (${origin.x}, ${origin.z})`).not.toBeNull();
        let from = origin;
        for (const point of route!) {
          expect(segmentClear(from, point, colliders), `${id} route clips a fixture or crate`).toBe(true);
          from = point;
        }
        expect(Math.hypot(from.x - destination.x, from.z - destination.z)).toBeLessThan(0.03);
      }
    }
  });

  it("keeps all 35 receiving bays off street fixtures and the delivery vehicle", () => {
    const street = createStreet(scene);
    expect(DELIVERY_DROP_POINTS.length).toBeGreaterThanOrEqual(30);
    for (const point of DELIVERY_DROP_POINTS) {
      const overlaps = street.colliders.some((collider) => point.x + 0.40 > collider.minX && point.x - 0.40 < collider.maxX && point.z + 0.23 > collider.minZ && point.z - 0.23 < collider.maxZ);
      expect(overlaps, `receiving point (${point.x}, ${point.z}) overlaps scenery`).toBe(false);
      expect(point.z - 0.23).toBeGreaterThan(-8.14);
      expect(point.x).toBeGreaterThan(1);
    }
  });

  it("rests every product crate above real indoor/new/legacy pad surfaces and picks its centre instead of the pad", () => {
    const shop = createShop(scene, { catalogFixtures: true });
    const street = createStreet(scene);
    const receiving = createReceivingPads(scene, SAFE_DROP_POINTS);
    const pads = [...shop.targets, ...street.targets, ...receiving].filter((target) => target.kind === "drop-zone");
    const supports = pads.map((pad) => measureCrateSupport(pad.position, pad.mesh));
    const indoor = supports.find((entry) => entry.z > -4.6)!;
    const legacy = supports.find((entry) => entry.x === 1.35 && entry.z === -6)!;
    const additional = supports.find((entry) => entry.x > 4)!;
    expect(supports).toHaveLength(SAFE_DROP_POINTS.length);
    expect(indoor.height).toBeCloseTo(0.012, 5);
    expect(legacy.height).toBeCloseTo(0.039, 5);
    expect(additional.height).toBeCloseTo(0.026, 5);
    const visuals = new ProductVisuals(scene);
    for (const id of PRODUCT_ASSET_IDS) {
      const crate = createCrate(scene, id, `supported-${id}`);
      const product = visuals.create(id, `supported-product-${id}`);
      const placement = cratePlacement(id, productDimensions(product), 0);
      product.parent = crate; product.position.set(placement.position.x, placement.position.y, placement.position.z); product.scaling.setAll(placement.scale);
      for (const support of [indoor, legacy, additional]) {
        crate.position.set(support.x, crateRestingHeight(support, supports), support.z);
        const crateBounds = crate.getHierarchyBoundingVectors(true);
        const productBounds = product.getHierarchyBoundingVectors(true);
        expect(crateBounds.min.y - support.height, `${id}: bottom must clear the support without floating`).toBeCloseTo(0.001, 5);
        expect(productBounds.min.y, `${id}: goods must never sink into the pad`).toBeGreaterThan(support.height + 0.01);
        const ray = new Ray(new Vector3(support.x, 0.8, support.z), new Vector3(0, -1, 0), 1);
        const hit = scene.pickWithRay(ray, (mesh) => mesh.isPickable && mesh.isEnabled());
        expect(hit?.hit).toBe(true);
        expect(hit!.pickedMesh!.isDescendantOf(crate), `${id}: centre ray must select the carton bottom, never a DELIVERY sign`).toBe(true);
      }
      crate.dispose(false, false);
    }
    // Exercise the world placement too; lifting a box must keep its established hand pose.
    let state = command(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "supported-soap", lines: [{ productId: "soap", quantity: 1 }] });
    state = command(state, { type: "RECEIVE_DELIVERY" });
    const view = harness(state, [...shop.colliders, ...street.colliders], supports);
    const soapCrate = view.crates.get("soap-crate")!;
    const soap = [...view.products.values()][0]!;
    const groundPosition = state.crates.find((entry) => entry.id === "soap-crate")!.position;
    expect(soapCrate.position.y).toBeCloseTo(crateRestingHeight(groundPosition, supports), 6);
    expect(soap.getHierarchyBoundingVectors(true).min.y).toBeGreaterThan(crateRestingHeight(groundPosition, supports));
    state = command(state, { type: "PICK_CRATE", crateId: "soap-crate" }); view.state = state; view.syncInventory();
    expect(soapCrate.position.y).toBe(-0.39);
  });

  it("dynamically renders a soap-only purchase, hand/inspection, shelving, basket and single-item checkout", () => {
    const shop = createShop(scene, { catalogFixtures: true }); const fixtures = createCatalogFixtures(scene, PRODUCTS);
    let state = createFirstDayState(); const view = harness(state, [...shop.colliders, ...fixtures.colliders]);
    expect(view.productVisuals.loadedProductCount).toBe(0); expect(view.products.size).toBe(0); expect(view.inspection.size).toBe(0);
    state = command(state, { type: "PURCHASE_STOCK", orderId: "soap-visual", lines: [{ productId: "soap", quantity: 1 }] });
    view.state = state; view.syncInventory();
    expect(view.products.size).toBe(0); expect(view.productVisuals.loadedProductCount).toBe(0);
    state = command(state, { type: "RECEIVE_DELIVERY" }); view.state = state; view.syncInventory();
    const item = state.items.find((entry) => entry.productId === "soap")!;
    const visual = view.products.get(item.id)!;
    expect(visual.metadata.productId).toBe("soap"); expect(visual.parent).toBe(view.crates.get("soap-crate"));
    state = command(state, { type: "TAKE_ITEM", itemId: item.id }); view.state = state; view.syncInventory();
    expect(visual.parent).toBeInstanceOf(UniversalCamera);
    view.inspect("soap"); expect(view.inspection.size).toBe(1);
    expect(view.inspection.get("soap")!.getChildren()[0]!.metadata.productId).toBe("soap");
    expect(view.inspection.get("soap")!.isEnabled()).toBe(true);
    view.inspect(null);
    state = command(state, { type: "RETURN_ITEM" });
    state = command(state, { type: "PICK_CRATE", crateId: "soap-crate" });
    state = command(state, { type: "STOCK", productId: "soap", slot: 0 });
    state = command(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.id === "soap-crate")!.position });
    view.state = state; view.syncInventory();
    expect(view.crates.get("soap-crate")!.isEnabled()).toBe(false);
    expect(visual.position.asArray()).toEqual(Object.values(PRODUCT_DISPLAYS.soap.slots[0]!));
    state = command(state, { type: "OPEN_STORE" }); view.state = state; view.syncInventory(); view.setCustomerRoute(true);
    expect(getCustomerOrder(state)).toEqual(["soap"]); expect(view.customerRouteBlocked).toBe(false);
    expect(view.route.at(-1)).toEqual(PRODUCT_DISPLAYS.soap.approach);
    state = command(state, { type: "CUSTOMER_ADVANCE" }); view.state = state; view.syncInventory();
    expect(state.customer.phase).toBe("to-checkout"); expect(visual.parent?.name).toBe("harness-basket");
    state = command(state, { type: "CUSTOMER_ADVANCE" }); view.state = state; view.syncInventory();
    expect(state.customer.phase).toBe("checkout"); expect(visual.parent).toBeNull(); expect(visual.position.y).toBeCloseTo(1.012);
    state = command(state, { type: "SCAN", itemId: item.id });
    state = command(state, { type: "PAY", success: true }); view.state = state; view.syncInventory();
    expect(view.products.size).toBe(0); expect(visual.isDisposed()).toBe(true);
    // Starting from a later save with sold soap and a new paid-but-undelivered SKU allocates neither.
    state = command(state, { type: "PURCHASE_STOCK", orderId: "water-pending", lines: [{ productId: "water", quantity: 1 }] });
    const later = harness(state);
    expect(later.products.size).toBe(0); expect(later.productVisuals.loadedProductCount).toBe(0);
  });
});
