import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PointLight, Scene, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import { createShop, type ShopEnvironment } from "../../src/sim3d/assets";
import {
  CUSTOMER_DOORSTEP, CUSTOMER_STREET_BOUNDS, CUSTOMER_STREET_SPAWNS,
  customerArrivalOrigins, customerJourneyRoute,
} from "../../src/sim3d/customerJourney";
import { CUSTOMER_STOP_SECONDS, CUSTOMER_WALK_SPEED } from "../../src/sim3d/customerSelection";
import {
  DELIVERY_DROP_POINTS, PRODUCT_IDS, PRODUCTS, createFirstDayState, isWalkablePosition, reduceSim, validateSimState,
  type CustomerPhase, type ProductId, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { createCatalogFixtures, type CatalogFixtures } from "../../src/sim3d/productFixtures";
import { PRODUCT_DISPLAYS, segmentClear, type FloorPoint, type LayoutCollider, type ProductDisplay } from "../../src/sim3d/productLayout";
import { ProductVisuals } from "../../src/sim3d/productPresentation";
import { createRecyclingStation } from "../../src/sim3d/recyclingStation";
import {
  LAYOUT_WALK_RADIUS, createDefaultShopLayout, furnitureForProduct, transformLayoutPoint, validateShopLayout,
  type FurnitureRotation, type ShopLayout,
} from "../../src/sim3d/shopLayout";
import { createStreet, type StreetEnvironment } from "../../src/sim3d/street";
import { ShopWorld } from "../../src/sim3d/world";
import { payScannedCheckout } from "../helpers/sim3dPayment";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state), command.type).toBe(true);
  return result.state;
}

function stock(state: SimState, productId: ProductId, quantity: number): SimState {
  for (let slot = 0; slot < quantity; slot += 1) {
    const item = state.items.find((candidate) => candidate.productId === productId && candidate.location.kind === "crate")!;
    state = act(state, { type: "TAKE_ITEM", itemId: item.id });
    state = act(state, { type: "STOCK", productId, slot });
  }
  return state;
}

function preparedState(productId: ProductId = "milk", quantity = 3, initial = createFirstDayState()): SimState {
  let state = act(initial, { type: "PURCHASE_STOCK", orderId: `journey-stock-${initial.purchases.length}`, lines: [{ productId, quantity }] });
  state = act(state, { type: "RECEIVE_DELIVERY" });
  return stock(state, productId, quantity);
}

let fundedFixture: SimState | undefined;

/** Earn the full-catalogue delivery budget through real, validated sales. */
function fundedState(): SimState {
  if (!fundedFixture) {
    let state = createFirstDayState();
    for (let day = 0; day < 4; day += 1) {
      state = act(state, { type: "PURCHASE_STOCK", orderId: `journey-funds-${day}`, pairs: 3 });
      state = act(state, { type: "RECEIVE_DELIVERY" });
      state = stock(stock(state, "milk", 3), "bread", 3);
      for (let visit = 0; visit < 3; visit += 1) {
        state = act(state, { type: visit === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" });
        while (state.customer.phase !== "checkout") state = act(state, { type: "CUSTOMER_ADVANCE" });
        for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
        state = payScannedCheckout(state);
        state = act(state, { type: "CUSTOMER_ADVANCE" });
      }
      state = act(state, { type: "CLOSE_STORE" });
      state = act(state, { type: "SETTLE_DAY" });
      state = act(state, { type: "START_NEXT_DAY" });
    }
    fundedFixture = state;
  }
  return structuredClone(fundedFixture);
}

function allCratesState(): SimState {
  let state = act(fundedState(), {
    type: "PURCHASE_STOCK", orderId: "journey-all-thirty",
    lines: PRODUCT_IDS.map((productId) => ({ productId, quantity: productId === "milk" ? 2 : 1 })),
  });
  state = act(state, { type: "RECEIVE_DELIVERY" });
  state = stock(state, "milk", 1);
  return act(state, { type: "OPEN_STORE" });
}

function point(node: { x: number; z: number }): FloorPoint { return { x: node.x, z: node.z }; }
function routeLength(from: FloorPoint, route: readonly FloorPoint[]): number {
  let length = 0;
  for (const next of route) { length += Math.hypot(next.x - from.x, next.z - from.z); from = next; }
  return length;
}

function seedForSide(x: number): number {
  for (let seed = 0; seed < 100; seed += 1) {
    if (customerArrivalOrigins({ customerSeed: seed, customer: { number: 1 } })[0]!.x === x) return seed;
  }
  throw new Error(`No deterministic seed selected the ${x} street entrance`);
}

interface JourneyWorld {
  state: SimState;
  active: boolean;
  scene: Scene;
  shop: ShopEnvironment;
  catalogFixtures: CatalogFixtures;
  street: StreetEnvironment;
  camera: UniversalCamera;
  customer: TransformNode;
  customerPhase: CustomerPhase;
  colliders: LayoutCollider[];
  displays: Record<ProductId, ProductDisplay>;
  route: FloorPoint[];
  routeIndex: number;
  arrivalDelay: number;
  customerRouteBlocked: boolean;
  customerEntryAnnounced: boolean;
  customerObstacleSignature: string;
  occupiedCrates: Set<string>;
  callbacks: {
    onCustomerArrive: ReturnType<typeof vi.fn>;
    onCustomerEnter: ReturnType<typeof vi.fn>;
    onStatus: ReturnType<typeof vi.fn>;
  };
  customerActors: { play: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> };
  createDisplays(layout: ShopLayout): Record<ProductId, ProductDisplay>;
  syncShopLayout(): void;
  syncInventory(): void;
  setState(state: SimState): void;
  setCustomerRoute(initial: boolean): void;
  customerColliders(): LayoutCollider[];
  updateCustomer(dt: number): void;
  isCustomerApproaching(): boolean;
  isFree(x: number, z: number): boolean;
}

describe("deterministic distant customer arrival origins", () => {
  it("places the two starts far apart on the near pavement and keeps the existing departure point", () => {
    expect(CUSTOMER_STREET_SPAWNS).toEqual([{ x: -19, z: -6.1 }, { x: 19, z: -6.1 }]);
    expect(CUSTOMER_DOORSTEP).toEqual({ x: 0, z: -5.3 });
    expect(CUSTOMER_STREET_BOUNDS).toEqual({ minX: -20, maxX: 20, minZ: -8.12, maxZ: -4.65 });
    for (const origin of CUSTOMER_STREET_SPAWNS) {
      expect(Math.hypot(origin.x - CUSTOMER_DOORSTEP.x, origin.z - CUSTOMER_DOORSTEP.z)).toBeGreaterThan(18);
      expect(isWalkablePosition(origin, LAYOUT_WALK_RADIUS)).toBe(true);
    }
  });

  it.each([undefined, 0, 31, 42, 0xffff_ffff])("alternates sides without redrawing an existing visit for seed %s", (customerSeed) => {
    let previous: number | undefined;
    for (let number = 1; number <= 30; number += 1) {
      const state = { ...(customerSeed === undefined ? {} : { customerSeed }), customer: { number } };
      const before = structuredClone(state);
      const origins = customerArrivalOrigins(state);
      expect(origins).toHaveLength(2);
      expect(new Set(origins.map((origin) => origin.x))).toEqual(new Set([-19, 19]));
      expect(origins[0]!.x).not.toBe(previous);
      expect(customerArrivalOrigins(JSON.parse(JSON.stringify(state)))).toEqual(origins);
      expect(state).toEqual(before);
      previous = origins[0]!.x;
    }
  });

  it("supports a safely imported large customer number without changing the visit or its economy", () => {
    const state = { customerSeed: 17, customer: { number: Number.MAX_SAFE_INTEGER } };
    expect(customerArrivalOrigins(state)).toEqual(customerArrivalOrigins(structuredClone(state)));
    expect(customerArrivalOrigins(state)[0]).not.toEqual(customerArrivalOrigins({ ...state, customer: { number: state.customer.number - 1 } })[0]);
  });
});

describe("customer journeys through the actual street and renovated shop", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = {
        createLinearGradient: () => gradient, createRadialGradient: () => gradient,
        measureText: () => ({ width: 100 }),
        getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
      };
      const context = new Proxy(values, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });

  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); });

  function geometry(layout = createDefaultShopLayout()) {
    const shop = createShop(scene, { catalogFixtures: true, layout });
    const catalogFixtures = createCatalogFixtures(scene, PRODUCTS, layout);
    const street = createStreet(scene);
    const recycling = createRecyclingStation(scene);
    const fixedColliders = [...street.colliders, recycling.collider];
    const colliders = [...shop.colliders, ...catalogFixtures.colliders, ...fixedColliders];
    // Match the real vehicle's conservative player collision envelope, not
    // just its painted parking location. The pavement route must clear it.
    const truck = street.truck.position;
    const truckCollider = { minX: truck.x - 2.45, maxX: truck.x + 2.45, minZ: truck.z - .96, maxZ: truck.z + .96 };
    return { shop, catalogFixtures, street, fixedColliders, colliders, truckCollider };
  }

  /** Real world methods and meshes; only input/WebGL and downloaded actors are omitted. */
  function harness(state: SimState, extraColliders: LayoutCollider[] = []): JourneyWorld {
    const environment = geometry(state.renovation.layout);
    const view = Object.create(ShopWorld.prototype) as JourneyWorld;
    const customer = new TransformNode("journey-test-customer", scene);
    const basket = new TransformNode("journey-test-basket", scene); basket.parent = customer;
    Object.assign(view, {
      ...environment, scene, state,
      colliders: [...environment.colliders, ...extraColliders],
      fixedColliders: [...environment.fixedColliders, ...extraColliders],
      camera: new UniversalCamera("journey-test-eyes", new Vector3(0, 1.65, -10), scene),
      expansionLight: new PointLight("journey-test-expanded-light", new Vector3(0, 2.68, 5.5), scene),
      productVisuals: new ProductVisuals(scene), crateSupports: [], occupiedCrates: new Set(), products: new Map(), crates: new Map(),
      hands: new TransformNode("journey-test-hands", scene), basket, customer,
      customerActors: { play: vi.fn(), select: vi.fn() }, inspection: new Map(), inspectionProduct: null,
      shadow: { addShadowCaster: vi.fn(), removeShadowCaster: vi.fn() },
      customerPhase: state.customer.phase, customerObstacleSignature: "", route: [], routeIndex: 0,
      arrivalDelay: 0, arrivedRevision: -1, customerRouteBlocked: false, customerEntryAnnounced: false, active: false, truckPhase: "parked", targetMesh: null,
      callbacks: { onStatus: vi.fn(), onTarget: vi.fn(), onCustomerArrive: vi.fn(), onCustomerEnter: vi.fn(), onGuide: vi.fn() },
    });
    const displays = view.createDisplays(state.renovation.layout);
    Object.assign(view, { displays, shelfSlots: Object.fromEntries(PRODUCT_IDS.map((id) => [id, displays[id].slots.map((slot) => new Vector3(slot.x, slot.y, slot.z))])) });
    view.syncShopLayout();
    view.syncInventory();
    view.setCustomerRoute(true);
    return view;
  }

  function expectClearRoute(from: FloorPoint, route: readonly FloorPoint[], colliders: readonly LayoutCollider[], expansion: 0 | 1): void {
    for (const destination of route) {
      expect(segmentClear(from, destination, colliders, LAYOUT_WALK_RADIUS), `${JSON.stringify(from)} -> ${JSON.stringify(destination)}`).toBe(true);
      const steps = Math.max(1, Math.ceil(Math.hypot(destination.x - from.x, destination.z - from.z) / .15));
      for (let step = 0; step <= steps; step += 1) {
        const sample = { x: from.x + (destination.x - from.x) * step / steps, z: from.z + (destination.z - from.z) * step / steps };
        expect(isWalkablePosition(sample, LAYOUT_WALK_RADIUS, expansion), JSON.stringify(sample)).toBe(true);
      }
      // Crossing the facade is legal only through its actual central door.
      if ((from.z < -4.6) !== (destination.z < -4.6)) {
        const crossingX = from.x + (destination.x - from.x) * (-4.6 - from.z) / (destination.z - from.z);
        expect(Math.abs(crossingX)).toBeLessThanOrEqual(.95 - LAYOUT_WALK_RADIUS + 1e-8);
      }
      from = destination;
    }
  }

  function expectStreetPrefix(from: FloorPoint, route: readonly FloorPoint[]): void {
    const doorstepIndex = route.findIndex((next) => next.x === CUSTOMER_DOORSTEP.x && next.z === CUSTOMER_DOORSTEP.z);
    expect(doorstepIndex).toBeGreaterThanOrEqual(0);
    for (const next of [from, ...route.slice(0, doorstepIndex + 1)]) {
      expect(next.x).toBeGreaterThanOrEqual(CUSTOMER_STREET_BOUNDS.minX + LAYOUT_WALK_RADIUS - 1e-8);
      expect(next.x).toBeLessThanOrEqual(CUSTOMER_STREET_BOUNDS.maxX - LAYOUT_WALK_RADIUS + 1e-8);
      expect(next.z).toBeGreaterThanOrEqual(CUSTOMER_STREET_BOUNDS.minZ + LAYOUT_WALK_RADIUS - 1e-8);
      expect(next.z).toBeLessThanOrEqual(CUSTOMER_STREET_BOUNDS.maxZ - LAYOUT_WALK_RADIUS + 1e-8);
    }
  }

  function finishWalking(view: JourneyWorld, dt = .05): void {
    const budget = Math.ceil((routeLength(point(view.customer.position), view.route.slice(view.routeIndex)) / CUSTOMER_WALK_SPEED + 2) / dt) + view.route.length * 4;
    for (let frame = 0; frame < budget && !view.callbacks.onCustomerArrive.mock.calls.length; frame += 1) view.updateCustomer(dt);
    expect(view.callbacks.onCustomerArrive).toHaveBeenCalledOnce();
  }

  it.each([-19, 19])("takes the distant %s side around real trees and lamps, through the door, to all thirty shelf approaches", (x) => {
    const { colliders, truckCollider, street } = geometry();
    const obstacles = [...colliders, truckCollider];
    const from = { x, z: -6.1 };
    expect(street.colliders.some((box) => box.minX < -8.2 && box.maxX > -8.2 && box.minZ < -6.4 && box.maxZ > -6.4)).toBe(true);
    expect(street.colliders.some((box) => box.minX < 8.25 && box.maxX > 8.25 && box.minZ < -7.48 && box.maxZ > -7.48)).toBe(true);
    expect(segmentClear(from, CUSTOMER_DOORSTEP, obstacles, LAYOUT_WALK_RADIUS)).toBe(false);
    for (const productId of PRODUCT_IDS) {
      const destination = PRODUCT_DISPLAYS[productId].approach;
      const route = customerJourneyRoute(from, destination, obstacles, 0);
      expect(route, `${x}: ${productId}`).not.toBeNull();
      expect(route!.at(-1)).toEqual(destination);
      expectStreetPrefix(from, route!);
      expectClearRoute(from, route!, obstacles, 0);
    }
  });

  it("accepts Babylon Vector3 positions without losing getter-backed x/z values or skipping street obstacles", () => {
    const { colliders } = geometry();
    const from = new Vector3(-19, 0, -6.1);
    const destination = new Vector3(0, 0, 2.72);
    const before = from.clone();
    const route = customerJourneyRoute(from, destination, colliders, 0);
    expect(route).toEqual(customerJourneyRoute(point(from), point(destination), colliders, 0));
    expect(route).not.toBeNull();
    expect(route!.every((next) => Number.isFinite(next.x) && Number.isFinite(next.z))).toBe(true);
    expectClearRoute(point(from), route!, colliders, 0);
    expect(from.equals(before)).toBe(true);
  });

  it.each([0, 1, 2, 3] as const)("reaches a cereal shelf moved into the expansion at rotation %s without using the old back wall", (rotation: FurnitureRotation) => {
    const layout = createDefaultShopLayout(); layout.expansion = 1;
    Object.assign(layout.placements.find((placement) => placement.id === "pantry-grains")!, { x: -1.7, z: 5.7, rotation });
    expect(validateShopLayout(layout)).toEqual({ valid: true });
    const { colliders } = geometry(layout);
    const destination = transformLayoutPoint(layout, furnitureForProduct("cereal"), PRODUCT_DISPLAYS.cereal.approach);
    expect(destination.z).toBeGreaterThan(4.6);
    for (const from of CUSTOMER_STREET_SPAWNS) {
      const route = customerJourneyRoute(from, destination, colliders, layout.expansion);
      expect(route).not.toBeNull();
      expect(route!.at(-1)).toEqual(destination);
      expectStreetPrefix(from, route!);
      expectClearRoute(from, route!, colliders, 1);
      expect(customerJourneyRoute(from, destination, colliders, 0)).toBeNull();
    }
  });

  it("returns null for a sealed doorway and recovers when the same passage is cleared without mutating its inputs", () => {
    const { colliders } = geometry();
    const closure = { minX: -.95, maxX: .95, minZ: -4.82, maxZ: -4.45 };
    const blocked = [...colliders, closure];
    const before = structuredClone(blocked);
    const destination = PRODUCT_DISPLAYS.milk.approach;
    for (const from of CUSTOMER_STREET_SPAWNS) {
      expect(customerJourneyRoute(from, destination, blocked, 0)).toBeNull();
      const route = customerJourneyRoute(from, destination, colliders, 0);
      expect(route).not.toBeNull();
      expectClearRoute(from, route!, colliders, 0);
    }
    expect(blocked).toEqual(before);
  });

  it("keeps same-shop journeys local and preserves the existing doorstep-only departure destination", () => {
    const { colliders } = geometry();
    const from = PRODUCT_DISPLAYS.milk.approach;
    const toShelf = customerJourneyRoute(from, PRODUCT_DISPLAYS.bread.approach, colliders, 0);
    expect(toShelf).not.toBeNull();
    expect(toShelf).not.toContainEqual(CUSTOMER_DOORSTEP);
    expectClearRoute(from, toShelf!, colliders, 0);
    const leaving = customerJourneyRoute(from, CUSTOMER_DOORSTEP, colliders, 0);
    expect(leaving?.at(-1)).toEqual(CUSTOMER_DOORSTEP);
    expectClearRoute(from, leaving!, colliders, 0);
    expect(customerJourneyRoute(CUSTOMER_DOORSTEP, CUSTOMER_DOORSTEP, colliders, 0)).toEqual([]);
  });

  it("keeps a legal route with thirty real occupied delivery crates, using the other distant side if needed", () => {
    const state = allCratesState();
    const before = structuredClone(state);
    expect(state.crates).toHaveLength(30);
    expect(new Set(state.crates.map((crate) => JSON.stringify(crate.position))).size).toBe(30);
    const view = harness(state);
    expect(view.occupiedCrates.size).toBe(30);
    const obstacles = view.customerColliders();
    expect(obstacles).toHaveLength(view.colliders.length + 30);
    const candidates = customerArrivalOrigins(state).map((origin) => ({ origin, route: customerJourneyRoute(origin, view.displays.milk.approach, obstacles, 0) }));
    const reachable = candidates.filter((entry) => entry.route !== null);
    expect(reachable.length).toBeGreaterThan(0);
    for (const { origin, route } of reachable) {
      expectStreetPrefix(origin, route!);
      expectClearRoute(origin, route!, obstacles, 0);
    }
    expect(point(view.customer.position)).toEqual(reachable[0]!.origin);
    expect(view.customerRouteBlocked).toBe(false);
    expect(view.route.at(-1)).toEqual(view.displays.milk.approach);
    expect(state).toEqual(before);
  });

  it("starts the first visitor far away when opening and alternates the next visitor after the existing lifecycle", () => {
    const prepared = preparedState();
    const view = harness(prepared);
    expect(view.customer.isEnabled()).toBe(false);
    const first = act(prepared, { type: "OPEN_STORE" });
    view.setState(first);
    const firstOrigin = point(view.customer.position);
    expect(firstOrigin).toEqual(customerArrivalOrigins(first)[0]);
    expect(Math.abs(firstOrigin.x)).toBe(19);
    expect(view.customer.isEnabled()).toBe(true);
    expect(view.isCustomerApproaching()).toBe(true);
    expect(view.callbacks.onCustomerEnter).not.toHaveBeenCalled();
    const complete = act(act(first, { type: "CANCEL_CUSTOMER" }), { type: "CUSTOMER_ADVANCE" });
    view.setState(complete);
    expect(view.customer.isEnabled()).toBe(false);
    const next = act(complete, { type: "NEXT_CUSTOMER" });
    const before = structuredClone(next);
    view.setState(next);
    expect(point(view.customer.position)).toEqual(customerArrivalOrigins(next)[0]);
    expect(view.customer.position.x).toBe(-firstOrigin.x);
    expect(view.customer.position.z).toBe(-6.1);
    expect(view.customerEntryAnnounced).toBe(false);
    expect(view.isCustomerApproaching()).toBe(true);
    expect(view.state).toBe(next);
    expect(next).toEqual(before);
  });

  it("chooses the other distant origin only when a new visitor's preferred origin is blocked", () => {
    const state = act(preparedState(), { type: "OPEN_STORE" });
    const [preferred, backup] = customerArrivalOrigins(state);
    const block = { minX: preferred!.x - .4, maxX: preferred!.x + .4, minZ: preferred!.z - .4, maxZ: preferred!.z + .4 };
    const view = harness(state, [block]);
    expect(point(view.customer.position)).toEqual(backup);
    expect(view.customerRouteBlocked).toBe(false);
    expectStreetPrefix(point(view.customer.position), view.route);
    expectClearRoute(point(view.customer.position), view.route, view.customerColliders(), 0);
  });

  it("replans after lifting and moving a real occupied crate without teleporting a visitor already walking outside", () => {
    let state = preparedState();
    state = act(state, { type: "PURCHASE_STOCK", orderId: "journey-moving-crate", lines: [{ productId: "bread", quantity: 1 }] });
    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = act(state, { type: "OPEN_STORE" });
    const view = harness(state); view.active = true;
    for (let frame = 0; frame < 20; frame += 1) view.updateCustomer(.05);
    const position = point(view.customer.position);
    expect(position).not.toEqual(customerArrivalOrigins(state)[0]);
    expect(position.z).toBeLessThan(-4.6);
    const replan = vi.spyOn(view, "setCustomerRoute");
    state = act(state, { type: "PICK_CRATE", crateId: "bread-crate" });
    view.setState(state);
    expect(replan).toHaveBeenLastCalledWith(false);
    expect(point(view.customer.position)).toEqual(position);
    expect(view.customerRouteBlocked).toBe(false);
    state = act(state, { type: "DROP_HELD", position: DELIVERY_DROP_POINTS.at(-1)! });
    const before = structuredClone(state);
    view.setState(state);
    expect(replan).toHaveBeenCalledTimes(2);
    expect(replan).toHaveBeenLastCalledWith(false);
    expect(point(view.customer.position)).toEqual(position);
    expect(view.route.at(-1)).toEqual(view.displays.milk.approach);
    expect(view.customerPhase).toBe("to-milk");
    expect(view.callbacks.onCustomerArrive).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it("waits without advancing when a passage becomes blocked and resumes from the same point after replanning", () => {
    const state = act(preparedState(), { type: "OPEN_STORE" });
    const before = structuredClone(state);
    const view = harness(state); view.active = true;
    for (let frame = 0; frame < 20; frame += 1) view.updateCustomer(.05);
    const position = point(view.customer.position);
    const closure = { minX: -.95, maxX: .95, minZ: -4.82, maxZ: -4.45 };
    view.colliders.push(closure);
    view.setCustomerRoute(false);
    expect(view.customerRouteBlocked).toBe(true);
    expect(view.route).toEqual([]);
    expect(view.callbacks.onStatus).toHaveBeenCalledWith(expect.stringContaining("挡住"));
    for (let frame = 0; frame < 50; frame += 1) view.updateCustomer(.05);
    expect(point(view.customer.position)).toEqual(position);
    expect(view.arrivalDelay).toBe(0);
    expect(view.callbacks.onCustomerArrive).not.toHaveBeenCalled();
    expect(view.customerActors.play).toHaveBeenLastCalledWith(false);
    view.colliders.splice(view.colliders.indexOf(closure), 1);
    view.setCustomerRoute(false);
    expect(view.customerRouteBlocked).toBe(false);
    expect(point(view.customer.position)).toEqual(position);
    view.updateCustomer(.05);
    expect(point(view.customer.position)).not.toEqual(position);
    expect(state).toEqual(before);
  });

  it.each([{ x: -19, dt: .05 }, { x: 19, dt: 1 / 144 }])("walks safely from $x at timestep $dt, never advancing at the doorstep or while paused", ({ x, dt }) => {
    const initial = createFirstDayState(); initial.customerSeed = seedForSide(x);
    const state = act(preparedState("milk", 1, initial), { type: "OPEN_STORE" });
    const before = structuredClone(state);
    const view = harness(state);
    expect(view.customer.position.x).toBe(x);
    const from = point(view.customer.position);
    for (let frame = 0; frame < 50; frame += 1) view.updateCustomer(dt);
    expect(point(view.customer.position)).toEqual(from);
    expect(view.routeIndex).toBe(0);
    expect(view.arrivalDelay).toBe(0);
    expect(view.isCustomerApproaching()).toBe(true);
    expect(view.callbacks.onCustomerEnter).not.toHaveBeenCalled();
    view.active = true;
    const doorstepIndex = view.route.findIndex((next) => next.x === 0 && next.z === -5.3);
    expect(doorstepIndex).toBeGreaterThanOrEqual(0);
    const obstacles = view.customerColliders();
    const budget = Math.ceil((routeLength(from, view.route) / CUSTOMER_WALK_SPEED + 2) / dt) + view.route.length * 4;
    let passedDoorstep = false;
    for (let frame = 0; frame < budget && !view.callbacks.onCustomerArrive.mock.calls.length; frame += 1) {
      const previous = point(view.customer.position);
      view.updateCustomer(dt);
      expect(segmentClear(previous, point(view.customer.position), obstacles, LAYOUT_WALK_RADIUS), `frame ${frame}`).toBe(true);
      if (view.routeIndex <= doorstepIndex) expect(view.callbacks.onCustomerArrive).not.toHaveBeenCalled();
      if (!passedDoorstep && view.routeIndex > doorstepIndex) {
        passedDoorstep = true;
        expect(view.callbacks.onCustomerArrive).not.toHaveBeenCalled();
        expect(view.customer.position.z).toBeCloseTo(-5.3, 8);
        expect(view.state.customer.phase).toBe("to-milk");
        expect(view.isCustomerApproaching()).toBe(true);
        expect(view.callbacks.onCustomerEnter).not.toHaveBeenCalled();
      }
      if (view.customer.position.z < -4.5) expect(view.callbacks.onCustomerEnter).not.toHaveBeenCalled();
      else {
        expect(view.callbacks.onCustomerEnter).toHaveBeenCalledOnce();
        expect(view.isCustomerApproaching()).toBe(false);
      }
    }
    expect(passedDoorstep).toBe(true);
    expect(view.callbacks.onCustomerArrive).toHaveBeenCalledOnce();
    expect(view.callbacks.onCustomerEnter).toHaveBeenCalledOnce();
    expect(view.customerEntryAnnounced).toBe(true);
    expect(Math.hypot(view.customer.position.x - view.displays.milk.approach.x, view.customer.position.z - view.displays.milk.approach.z)).toBeLessThan(.045);
    expect(state.customer.phase).toBe("to-milk");
    expect(state).toEqual(before);
    for (let frame = 0; frame < Math.ceil(CUSTOMER_STOP_SECONDS / dt) + 5; frame += 1) view.updateCustomer(dt);
    expect(view.callbacks.onCustomerArrive).toHaveBeenCalledOnce();
    expect(view.callbacks.onCustomerEnter).toHaveBeenCalledOnce();
  });

  it("does not repeat a physical entry announcement after crate replanning and rearms it for the next visitor", () => {
    let state = preparedState();
    state = act(state, { type: "PURCHASE_STOCK", orderId: "journey-entry-crate", lines: [{ productId: "bread", quantity: 1 }] });
    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = act(state, { type: "OPEN_STORE" });
    const beforeWalking = structuredClone(state);
    const view = harness(state); view.active = true;
    const budget = Math.ceil((routeLength(point(view.customer.position), view.route) / CUSTOMER_WALK_SPEED + 2) / .05) + view.route.length * 4;
    for (let frame = 0; frame < budget && !view.callbacks.onCustomerEnter.mock.calls.length; frame += 1) view.updateCustomer(.05);
    expect(view.callbacks.onCustomerEnter).toHaveBeenCalledOnce();
    expect(view.callbacks.onCustomerArrive).not.toHaveBeenCalled();
    expect(view.isCustomerApproaching()).toBe(false);
    expect(state).toEqual(beforeWalking);
    const inside = point(view.customer.position);
    state = act(state, { type: "PICK_CRATE", crateId: "bread-crate" });
    view.setState(state);
    expect(point(view.customer.position)).toEqual(inside);
    expect(view.customerEntryAnnounced).toBe(true);
    state = act(state, { type: "DROP_HELD", position: DELIVERY_DROP_POINTS.at(-1)! });
    view.setState(state);
    finishWalking(view);
    expect(view.callbacks.onCustomerEnter).toHaveBeenCalledOnce();

    state = act(act(state, { type: "CANCEL_CUSTOMER" }), { type: "CUSTOMER_ADVANCE" });
    view.setState(state);
    state = act(state, { type: "NEXT_CUSTOMER" });
    const beforeNextWalking = structuredClone(state);
    view.setState(state);
    expect(view.customerEntryAnnounced).toBe(false);
    expect(view.isCustomerApproaching()).toBe(true);
    expect(view.callbacks.onCustomerEnter).toHaveBeenCalledOnce();
    const nextBudget = Math.ceil((routeLength(point(view.customer.position), view.route) / CUSTOMER_WALK_SPEED + 2) / .05) + view.route.length * 4;
    for (let frame = 0; frame < nextBudget && view.callbacks.onCustomerEnter.mock.calls.length < 2; frame += 1) view.updateCustomer(.05);
    expect(view.callbacks.onCustomerEnter).toHaveBeenCalledTimes(2);
    expect(view.isCustomerApproaching()).toBe(false);
    expect(state.customer.phase).toBe("to-milk");
    expect(state).toEqual(beforeNextWalking);
  });

  it("lets a visit cancelled on the street reach the unchanged exit without teleporting through the shop or changing money", () => {
    const state = act(preparedState(), { type: "OPEN_STORE" });
    const view = harness(state); view.active = true;
    for (let frame = 0; frame < 30; frame += 1) view.updateCustomer(.05);
    const position = point(view.customer.position);
    const cancelled = act(state, { type: "CANCEL_CUSTOMER" });
    const before = structuredClone(cancelled);
    view.setState(cancelled);
    expect(point(view.customer.position)).toEqual(position);
    expect(view.customerRouteBlocked).toBe(false);
    expect(view.customerPhase).toBe("leaving");
    expect(view.isCustomerApproaching()).toBe(false);
    expect(view.route.at(-1)).toEqual(CUSTOMER_DOORSTEP);
    expect(view.route.every((next) => next.z <= -4.65)).toBe(true);
    expectClearRoute(position, view.route, view.customerColliders(), 0);
    finishWalking(view);
    expect(view.callbacks.onCustomerEnter).not.toHaveBeenCalled();
    expect(point(view.customer.position)).toEqual(CUSTOMER_DOORSTEP);
    expect(cancelled.cashPence).toBe(state.cashPence);
    expect(cancelled.items).toEqual(state.items);
    expect(cancelled.transactions).toEqual(state.transactions);
    expect(cancelled).toEqual(before);
  });
});
