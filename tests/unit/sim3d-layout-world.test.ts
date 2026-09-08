import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PointLight, Ray, Scene, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import { createShop, type ShopEnvironment } from "../../src/sim3d/assets";
import { createCatalogFixtures, type CatalogFixtures } from "../../src/sim3d/productFixtures";
import { createStreet } from "../../src/sim3d/street";
import { createRecyclingStation } from "../../src/sim3d/recyclingStation";
import { createWorkstation, type WorkstationAsset } from "../../src/sim3d/workstationAsset";
import { workstationServicePoint } from "../../src/sim3d/workstation";
import { createFirstDayState, PRODUCT_IDS, PRODUCTS, type CustomerPhase, type ProductId, type SimState } from "../../src/sim3d/domain";
import { segmentClear, type FloorPoint, type LayoutCollider, type ProductDisplay } from "../../src/sim3d/productLayout";
import { ProductVisuals } from "../../src/sim3d/productPresentation";
import { CHECKOUT_CLERK_POINT, createDefaultShopLayout, furnitureForProduct, transformLayoutPoint, validateShopLayout, type FurnitureId, type FurnitureRotation, type ShopLayout } from "../../src/sim3d/shopLayout";
import { ShopWorld } from "../../src/sim3d/world";
import { CUSTOMER_STOP_SECONDS, CUSTOMER_WALK_SPEED } from "../../src/sim3d/customerSelection";

interface WorldHarness {
  state: SimState;
  active: boolean;
  scene: Scene;
  shop: ShopEnvironment;
  catalogFixtures: CatalogFixtures;
  workstation: WorkstationAsset;
  camera: UniversalCamera;
  customer: TransformNode;
  customerPhase: CustomerPhase;
  colliders: LayoutCollider[];
  displays: Record<ProductId, ProductDisplay>;
  products: Map<string, TransformNode>;
  route: FloorPoint[];
  routeIndex: number;
  customerRouteBlocked: boolean;
  callbacks: { onCustomerArrive: ReturnType<typeof vi.fn>; onGuide: ReturnType<typeof vi.fn> };
  createDisplays(layout: ShopLayout): Record<ProductId, ProductDisplay>;
  syncShopLayout(): void;
  syncInventory(): void;
  setState(state: SimState): void;
  setCustomerRoute(initial: boolean): void;
  customerColliders(): LayoutCollider[];
  updateCustomer(dt: number): void;
  updateGuide(): void;
  isFree(x: number, z: number): boolean;
}

describe("renovation applied to real world interactions, stock and movement", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = { createLinearGradient: () => gradient, createRadialGradient: () => gradient,
        measureText: () => ({ width: 100 }), getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }) };
      const context = new Proxy(values, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });
  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); });

  /** Real ShopWorld methods and actual fixture meshes; only WebGL/input and downloaded actors are omitted. */
  function harness(state = createFirstDayState()): WorldHarness {
    const shop = createShop(scene, { catalogFixtures: true, layout: state.renovation.layout });
    const catalogFixtures = createCatalogFixtures(scene, PRODUCTS, state.renovation.layout);
    const street = createStreet(scene);
    const recycling = createRecyclingStation(scene);
    const workstation = createWorkstation(scene, state.renovation.layout.workstation);
    const customer = new TransformNode("layout-test-customer", scene);
    const basket = new TransformNode("layout-test-basket", scene); basket.parent = customer;
    const view = Object.create(ShopWorld.prototype) as WorldHarness;
    Object.assign(view, {
      state, scene, shop, catalogFixtures, street, workstation, camera: new UniversalCamera("layout-test-eyes", new Vector3(0, 1.65, -3.5), scene),
      expansionLight: new PointLight("layout-test-expanded-light", new Vector3(0, 2.68, 5.5), scene),
      secondExpansionLight: new PointLight("layout-test-second-expanded-light", new Vector3(0, 2.68, 8.5), scene),
      colliders: [...shop.colliders, ...catalogFixtures.colliders, ...street.colliders, recycling.collider, workstation.collider],
      fixedColliders: [...street.colliders, recycling.collider], productVisuals: new ProductVisuals(scene),
      crateSupports: [], occupiedCrates: new Set(), products: new Map(), crates: new Map(),
      hands: new TransformNode("layout-test-hands", scene), basket, customer, customerActors: { play: vi.fn(), select: vi.fn() },
      inspection: new Map(), inspectionProduct: null, shadow: { addShadowCaster: vi.fn(), removeShadowCaster: vi.fn() },
      customerPhase: state.customer.phase, customerObstacleSignature: "", route: [], routeIndex: 0,
      arrivalDelay: 0, arrivedRevision: -1, active: false, truckPhase: "away", targetMesh: null,
      callbacks: { onStatus: vi.fn(), onTarget: vi.fn(), onCustomerArrive: vi.fn(), onGuide: vi.fn() },
    });
    const displays = view.createDisplays(state.renovation.layout);
    Object.assign(view, { displays, shelfSlots: Object.fromEntries(PRODUCT_IDS.map((id) => [id, displays[id].slots.map((point) => new Vector3(point.x, point.y, point.z))])) });
    view.syncShopLayout(); view.syncInventory();
    return view;
  }

  function relocated(id: FurnitureId, rotation: FurnitureRotation): ShopLayout {
    const layout = createDefaultShopLayout(); layout.expansion = 1;
    Object.assign(layout.placements.find((placement) => placement.id === id)!, { x: -1.7, z: 5.7, rotation });
    expect(validateShopLayout(layout)).toEqual({ valid: true });
    return layout;
  }

  function apply(view: WorldHarness, layout: ShopLayout): void {
    const next = structuredClone(view.state);
    next.revision += 1;
    next.renovation = { ...next.renovation, layout: { ...layout, equipment: next.renovation.layout.equipment,
      workstation: { ...(layout.workstation ?? next.renovation.layout.workstation) } },
      expansionDay: layout.expansion ? 1 : null, secondExpansionDay: layout.expansion >= 2 ? 1 : null };
    view.setState(next);
    // The real render loop refreshes descendant matrices before the next visible frame/pick.
    scene.render();
  }

  it("synchronizes a computer-only move with physical picking, collision and the saved interaction destination", () => {
    const view = harness();
    const layout = structuredClone(view.state.renovation.layout);
    layout.expansion = 1;
    layout.workstation = { x: -1.8, z: 5.6, rotation: 1 };
    expect(validateShopLayout(layout).valid).toBe(true);
    apply(view, layout);
    expect(view.workstation.root.position.x).toBe(-1.8);
    expect(view.workstation.root.position.z).toBe(5.6);
    expect(view.colliders).toContain(view.workstation.collider);
    expect(view.isFree(-1.8, 5.6)).toBe(false);
    const service = workstationServicePoint(layout.workstation);
    const origin = new Vector3(service.x, 1.65, service.z);
    const ray = new Ray(origin, view.workstation.interactionPoint.subtract(origin).normalize(), 2.6);
    expect(scene.pickWithRay(ray, (mesh) => mesh.isDescendantOf(view.workstation.root))?.pickedMesh).toBe(view.workstation.interactionMesh);
    expect(view.state.renovation.layout.workstation).toEqual(layout.workstation);
  });

  it("keeps actual stocked models on their physical shelf surfaces and retags moved interaction positions", () => {
    const state = createFirstDayState();
    state.items = (["milk", "bread", "cereal"] as const).map((productId) => ({ id: `stocked-${productId}`, productId, location: { kind: "shelf", productId, slot: 0 } }));
    const view = harness(state);
    for (const productId of ["milk", "bread", "cereal"] as const) for (const rotation of [0, 1, 2, 3] as const) {
      const id = furnitureForProduct(productId);
      apply(view, relocated(id, rotation));
      const product = view.products.get(`stocked-${productId}`)!;
      const position = product.position;
      const ray = new Ray(new Vector3(position.x, position.y + 0.015, position.z), new Vector3(0, -1, 0), 0.06);
      const support = scene.pickWithRay(ray, (mesh) => /-(?:base|extra)-shelf$|^fridge-shelf-|^bread-tray-/.test(mesh.name));
      expect(support?.hit, `${productId} rotation ${rotation}: stock must still sit on a real shelf`).toBe(true);
      expect(support!.pickedPoint!.y).toBeCloseTo(product.position.y, 2);
      const fixture = [...view.shop.targets, ...view.catalogFixtures.targets].find((target) => "productId" in target && target.productId === productId)!;
      expect(fixture.mesh.metadata.interaction).toMatchObject({ kind: "shelf", productId, position: { x: fixture.position.x, z: fixture.position.z } });
      expect(fixture.mesh.getChildMeshes().every((mesh) => mesh.metadata?.interaction?.productId === productId)).toBe(true);
      expect(view.state.items).toEqual(state.items);
      expect(view.state.cashPence).toBe(state.cashPence);
    }
  });

  it("keeps scanned and unscanned goods on the real counter and faces the customer toward its moved position", () => {
    const state = createFirstDayState();
    state.customer = { ...state.customer, phase: "checkout", shoppingList: ["milk", "bread"] };
    state.items = (["milk", "bread"] as const).map((productId) => ({ id: `checkout-${productId}`, productId, location: { kind: "checkout" } }));
    state.scannedIds = ["checkout-milk"];
    const view = harness(state);
    for (const rotation of [0, 1, 2, 3] as const) {
      apply(view, relocated("checkout-counter", rotation));
      const countertop = scene.getMeshByName("counter-oak-top")!;
      for (const item of state.items) {
        const product = view.products.get(item.id)!;
        const ray = new Ray(product.position.add(new Vector3(0, 0.02, 0)), new Vector3(0, -1, 0), 0.06);
        const support = scene.pickWithRay(ray, (mesh) => mesh === countertop);
        expect(support?.hit, `${item.id} rotation ${rotation}: item must stay over the counter`).toBe(true);
        expect(support!.pickedPoint!.y).toBeCloseTo(1.0, 3);
      }
      const counter = scene.getMeshByName("checkout-counter")!;
      const towardCounter = new Vector3(counter.position.x - view.customer.position.x, 0, counter.position.z - view.customer.position.z).normalize();
      const facing = new Vector3(Math.sin(view.customer.rotation.y), 0, Math.cos(view.customer.rotation.y));
      expect(Vector3.Dot(towardCounter, facing)).toBeGreaterThan(0.999);
      expect(scene.getMeshByName("card-terminal")!.metadata.interaction).toMatchObject({ kind: "counter" });
    }
  });

  it("updates physical walking bounds when expanding and removes the old back-wall collision", () => {
    const view = harness();
    expect(view.isFree(0, 6)).toBe(false);
    expect(view.isFree(0, 9)).toBe(false);
    const expanded = createDefaultShopLayout(); expanded.expansion = 1;
    apply(view, expanded);
    expect(view.isFree(0, 6)).toBe(true);
    expect(view.isFree(-1.8, 4.6)).toBe(true);
    expect(view.isFree(0, 7.5)).toBe(false);
    const floorRay = new Ray(new Vector3(0, 1, 6), new Vector3(0, -1, 0), 1.1);
    expect(scene.pickWithRay(floorRay, (mesh) => mesh.name === "oak-floor")?.hit).toBe(true);
    expect(view.isFree(0, 9)).toBe(false);
    const twiceExpanded = createDefaultShopLayout(); twiceExpanded.expansion = 2;
    apply(view, twiceExpanded);
    expect(view.isFree(0, 9)).toBe(true);
    expect(view.isFree(0, 10.8)).toBe(false);
    expect(scene.getLightByName("layout-test-expanded-light")!.isEnabled()).toBe(true);
    expect(scene.getLightByName("layout-test-second-expanded-light")!.isEnabled()).toBe(true);
    view.camera.position.set(0, 1.65, 6);
    apply(view, createDefaultShopLayout());
    expect(view.isFree(0, 6)).toBe(false);
    expect(view.isFree(view.camera.position.x, view.camera.position.z)).toBe(true);
    expect(view.camera.position.z).toBeLessThan(4.6);
  });

  it("routes a customer from all moved shelves through the moved checkout and the real doorway to leave", () => {
    const state = createFirstDayState();
    state.customer = { ...state.customer, phase: "to-milk", shoppingList: ["cereal", "milk"] };
    const view = harness(state);
    apply(view, relocated("pantry-grains", 1));
    for (const phase of ["to-milk", "to-bread", "to-checkout", "leaving"] as const) {
      view.state.customer.phase = phase;
      view.setCustomerRoute(true);
      expect(view.customerRouteBlocked, phase).toBe(false);
      let point = { x: view.customer.position.x, z: view.customer.position.z };
      for (const next of view.route) {
        expect(segmentClear(point, next, view.customerColliders(), 0.26), phase).toBe(true);
        for (let step = 0; step <= 8; step += 1) {
          const x = point.x + (next.x - point.x) * step / 8;
          const z = point.z + (next.z - point.z) * step / 8;
          expect(view.isFree(x, z), `${phase}: NPC route must also fit the smaller player collider`).toBe(true);
        }
        point = next;
      }
      if (phase === "leaving") expect(point).toEqual({ x: 0, z: -5.3 });
    }
    apply(view, relocated("checkout-counter", 3));
    view.state.customer.phase = "leaving";
    view.setCustomerRoute(true);
    expect(view.customerRouteBlocked).toBe(false);
    expect(view.route.at(-1)).toEqual({ x: 0, z: -5.3 });
  });

  it("preserves the planned clearance while the actual NPC animation turns around a counter corner", () => {
    const state = createFirstDayState();
    state.customer = { ...state.customer, phase: "to-milk", shoppingList: ["cereal"] };
    const view = harness(state);
    view.camera.position.set(0, 1.65, -10); // The player must not stop the simulated customer.
    view.active = true;
    for (const dt of [0.05, 1 / 60, 1 / 144]) {
      view.callbacks.onCustomerArrive.mockClear();
      view.setCustomerRoute(true);
      expect(view.customerRouteBlocked).toBe(false);
      const points = [{ x: view.customer.position.x, z: view.customer.position.z }, ...view.route];
      const distance = view.route.reduce((total, next, index) => total + Math.hypot(next.x - points[index]!.x, next.z - points[index]!.z), 0);
      // The visit now includes the distant pavement. Budget actual route time
      // plus waypoint/arrival frames at each tested FPS, retaining every check.
      const frameBudget = Math.ceil((distance / CUSTOMER_WALK_SPEED + CUSTOMER_STOP_SECONDS + 1) / dt) + view.route.length * 2;
      for (let frame = 0; frame < frameBudget && view.callbacks.onCustomerArrive.mock.calls.length === 0; frame += 1) {
        const before = { x: view.customer.position.x, z: view.customer.position.z };
        view.updateCustomer(dt);
        const after = { x: view.customer.position.x, z: view.customer.position.z };
        expect(segmentClear(before, after, view.customerColliders(), 0.26), `dt=${dt}, frame ${frame}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`).toBe(true);
      }
      expect(view.callbacks.onCustomerArrive).toHaveBeenCalledTimes(1);
    }
  });

  it("guides a player already at the moved cashier position to that counter instead of the old location", () => {
    const state = createFirstDayState();
    state.customer = { ...state.customer, phase: "checkout", shoppingList: ["milk"] };
    const view = harness(state);
    const layout = relocated("checkout-counter", 1);
    apply(view, layout);
    const clerk = transformLayoutPoint(layout, "checkout-counter", CHECKOUT_CLERK_POINT);
    view.camera.position.set(clerk.x, 1.65, clerk.z);
    view.updateGuide();
    expect(view.callbacks.onGuide.mock.lastCall?.[0]).toMatch(/收银台内侧.*0\.0 m$/);
  });
});
