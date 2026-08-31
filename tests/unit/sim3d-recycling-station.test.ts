import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicTexture, NullEngine, PBRMaterial, Scene, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import { createShop } from "../../src/sim3d/assets";
import { canSettleDay, createFirstDayState, isWalkablePosition, reduceSim, SAFE_DROP_POINTS, validateSimState, type SimCommand, type SimState } from "../../src/sim3d/domain";
import { createRecyclingStation, RECYCLING_POINT } from "../../src/sim3d/recyclingStation";
import { createStreet } from "../../src/sim3d/street";
import { ShopWorld, type InteractionTarget } from "../../src/sim3d/world";

interface WorldHarness {
  state: SimState;
  callbacks: { onTarget: ReturnType<typeof vi.fn>; onGuide: ReturnType<typeof vi.fn> };
  tag(root: TransformNode, data: Pick<InteractionTarget, "id" | "kind" | "position">): void;
  updateTarget(): void;
  updateGuide(): void;
}

describe("cardboard recycling in the physical shop", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = { createLinearGradient: () => gradient, createRadialGradient: () => gradient, measureText: () => ({ width: 100 }) };
      const context = new Proxy(values, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });
  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); });

  function act(state: SimState, command: SimCommand): SimState {
    const result = reduceSim(state, command);
    expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
    expect(validateSimState(result.state)).toBe(true);
    return result.state;
  }
  function soapDelivery(quantity = 1): SimState {
    const ordered = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "recycling-presentation", lines: [{ productId: "soap", quantity }] });
    return act(act(ordered, { type: "RECEIVE_DELIVERY" }), { type: "PICK_CRATE", crateId: "soap-crate" });
  }
  function harness(state: SimState): WorldHarness {
    const camera = new UniversalCamera("recycling-test-camera", new Vector3(3.5, 1.65, -6.7), scene);
    camera.rotation.set(0.10, 0, 0);
    const world = Object.create(ShopWorld.prototype) as WorldHarness;
    Object.assign(world, { state, scene, camera, active: true, targetMesh: null, callbacks: { onTarget: vi.fn(), onGuide: vi.fn() } });
    return world;
  }

  it("keeps every unloading bay, the door, customer exit and parked truck clear", () => {
    const shop = createShop(scene, { catalogFixtures: true });
    const street = createStreet(scene);
    const station = createRecyclingStation(scene);
    const { collider } = station;
    const overlaps = (box: typeof collider): boolean => box.maxX > collider.minX && box.minX < collider.maxX && box.maxZ > collider.minZ && box.minZ < collider.maxZ;
    expect([...shop.colliders, ...street.colliders].some(overlaps)).toBe(false);
    for (const point of SAFE_DROP_POINTS) {
      expect(overlaps({ minX: point.x - 0.40, maxX: point.x + 0.40, minZ: point.z - 0.23, maxZ: point.z + 0.23 }), `bay ${point.x},${point.z}`).toBe(false);
    }
    for (const point of [{ x: 0, z: -4.85 }, { x: 0, z: -5.3 }, { x: 0, z: -6.8 }, { x: 3.5, z: -6.7 }]) {
      expect(isWalkablePosition(point, 0.24)).toBe(true);
      expect(overlaps({ minX: point.x - 0.24, maxX: point.x + 0.24, minZ: point.z - 0.24, maxZ: point.z + 0.24 })).toBe(false);
    }
    expect(overlaps({ minX: 3 - 2.45, maxX: 3 + 2.45, minZ: -9.1 - 0.96, maxZ: -9.1 + 0.96 })).toBe(false);
    const bounds = station.root.getHierarchyBoundingVectors(true);
    expect(bounds.min.y).toBeCloseTo(0.022, 5);
    expect(bounds.min.x).toBeGreaterThanOrEqual(collider.minX - 0.001);
    expect(bounds.max.x).toBeLessThanOrEqual(collider.maxX + 0.001);
    expect(bounds.min.z).toBeGreaterThanOrEqual(collider.minZ - 0.001);
    expect(bounds.max.z).toBeLessThanOrEqual(collider.maxZ + 0.001);
  });

  it("picks the outward-facing bilingual sign and explains empty-hand, full-box and paid recycling actions", () => {
    createShop(scene, { catalogFixtures: true });
    createStreet(scene);
    const station = createRecyclingStation(scene);
    const world = harness(createFirstDayState());
    world.tag(station.root, { id: "cardboard-recycling", kind: "recycling", position: RECYCLING_POINT });
    for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
    const sign = scene.getMeshByName("recycling-sign-label")!;
    const texture = (sign.material as PBRMaterial).albedoTexture as DynamicTexture;
    expect(texture.getContext().fillText).toHaveBeenCalledWith("Cardboard recycling", expect.any(Number), expect.any(Number), expect.any(Number));
    expect(texture.getContext().fillText).toHaveBeenCalledWith("空箱回收", expect.any(Number), expect.any(Number), expect.any(Number));
    const normal = Vector3.TransformNormal(new Vector3(0, 0, -1), sign.computeWorldMatrix(true)).normalize();
    expect(normal.z).toBeLessThan(-0.99);
    world.updateTarget();
    expect(world.callbacks.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "cardboard-recycling", kind: "recycling", label: expect.stringContaining("今日 0 箱"), action: expect.stringContaining("不限量"), inspectable: false,
    }));
    expect(sign.renderOutline).toBe(true);
    world.state = soapDelivery();
    world.updateTarget();
    expect(world.callbacks.onTarget.mock.lastCall?.[0].action).toContain("先全部上架");
    world.state = act(world.state, { type: "STOCK", productId: "soap", slot: 0 });
    world.updateTarget();
    expect(world.callbacks.onTarget.mock.lastCall?.[0].action).toBe("回收空箱 +£0.05");
    world.state = act(world.state, { type: "RECYCLE_CRATE" });
    world.updateTarget();
    expect(world.callbacks.onTarget.mock.lastCall?.[0].label).toContain("今日 1 箱");
    expect(station.root.getChildMeshes().filter((mesh) => mesh.name.startsWith("recycling-flattened-cardboard-"))).toHaveLength(3);
  });

  it("guides a held empty box to recycling during preparation, checkout, closing and after settlement", () => {
    let state = soapDelivery(3);
    for (let slot = 0; slot < 3; slot += 1) state = act(state, { type: "STOCK", productId: "soap", slot });
    const world = harness(state);
    const expectRecyclingGuide = (): void => {
      world.state = state;
      world.updateGuide();
      expect(world.callbacks.onGuide).toHaveBeenLastCalledWith(expect.stringContaining("空箱回收点 · 按 E +£0.05"));
    };
    expectRecyclingGuide();
    for (let customer = 0; customer < 3; customer += 1) {
      state = act(state, { type: customer ? "NEXT_CUSTOMER" : "OPEN_STORE" });
      state = act(state, { type: "CUSTOMER_ADVANCE" });
      expectRecyclingGuide();
      state = act(state, { type: "CUSTOMER_ADVANCE" });
      expectRecyclingGuide();
      const item = state.items.find((candidate) => candidate.location.kind === "checkout")!;
      state = act(state, { type: "SCAN", itemId: item.id });
      state = act(state, { type: "PAY", success: true });
      state = act(state, { type: "CUSTOMER_ADVANCE" });
    }
    expect(canSettleDay(state)).toBe(true);
    expectRecyclingGuide();
    state = act(state, { type: "SETTLE_DAY" });
    expectRecyclingGuide();
    world.state = act(state, { type: "RECYCLE_CRATE" });
    world.updateGuide();
    expect(world.callbacks.onGuide).toHaveBeenLastCalledWith(expect.stringContaining("今日已日结"));
  });
});
