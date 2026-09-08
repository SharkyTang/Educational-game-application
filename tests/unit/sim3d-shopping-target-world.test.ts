import { receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, Scene, TransformNode } from "@babylonjs/core";
import {
  createFirstDayState,
  getShoppingShelfLocation,
  reduceSim,
  validateSimState,
  type CustomerPhase,
  type SimCommand,
  type SimState,
} from "../../src/sim3d/domain";
import { suggestEquipmentPlacement } from "../../src/sim3d/equipmentLayout";
import { createEquipmentSceneFixtures, type EquipmentSceneFixtures } from "../../src/sim3d/equipmentScene";
import { PRODUCT_DISPLAYS, type FloorPoint, type ProductDisplay } from "../../src/sim3d/productLayout";
import type { ProductId } from "../../src/sim3d/products";
import { ShopWorld } from "../../src/sim3d/world";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function shoppingState(): SimState {
  let state = act(createFirstDayState(), {
    type: "BUY_EQUIPMENT", purchaseId: "route-shelf", assetId: "wall-shelf-narrow", productId: "cereal",
  });
  const placement = suggestEquipmentPlacement(state.renovation.layout, state.equipment, "shop-equipment-1");
  expect(placement).not.toBeNull();
  const equipmentLayout: SimState["renovation"]["layout"] = { ...state.renovation.layout, equipment: [placement!] };
  state = act(state, { type: "APPLY_SHOP_LAYOUT", layout: equipmentLayout });
  state = act(state, {
    type: "PURCHASE_STOCK", orderId: "route-cereal", lines: [{ productId: "cereal", quantity: 2 }],
  });
  state = receiveAllDeliveries(state);
  const [baseItem, equipmentItem] = state.items.filter((item) => item.productId === "cereal");
  state = act(state, { type: "TAKE_ITEM", itemId: baseItem!.id });
  state = act(state, { type: "STOCK", productId: "cereal", slot: 0 });
  state = act(state, { type: "TAKE_ITEM", itemId: equipmentItem!.id });
  state = act(state, { type: "STOCK", productId: "cereal", slot: 0, equipmentId: "shop-equipment-1" });
  return act(state, { type: "OPEN_STORE" });
}

interface TargetWorld {
  state: SimState;
  customer: TransformNode;
  customerPhase: CustomerPhase;
  displays: Record<ProductId, ProductDisplay>;
  equipmentFixtures: EquipmentSceneFixtures;
  route: FloorPoint[];
  customerShoppingTargetSignature: string;
  callbacks: { onStatus: ReturnType<typeof vi.fn> };
  setState(state: SimState): void;
  setCustomerRoute(initial: boolean): void;
}

describe("live customer shopping target routing", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: 800, renderHeight: 600, textureSize: 512,
      deterministicLockstep: false, lockstepMaxSteps: 4,
    });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = {
        createLinearGradient: () => gradient,
        createRadialGradient: () => gradient,
        measureText: () => ({ width: 100 }),
        getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
      };
      const context = new Proxy(values, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
    vi.restoreAllMocks();
  });

  it("replans from the shopper's current position when TAKE_ITEM moves the chosen SKU to another fixture", () => {
    const state = shoppingState();
    expect(getShoppingShelfLocation(state)).toEqual({ kind: "shelf", productId: "cereal", slot: 0 });
    const equipmentFixtures = createEquipmentSceneFixtures(scene, state.equipment, state.renovation.layout.equipment);
    const customer = new TransformNode("target-refresh-customer", scene);
    customer.position.set(0, 0, -5.3);
    const view = Object.create(ShopWorld.prototype) as TargetWorld;
    Object.assign(view, {
      state,
      customer,
      customerPhase: state.customer.phase,
      displays: PRODUCT_DISPLAYS,
      equipmentFixtures,
      route: [],
      routeIndex: 0,
      arrivalDelay: 0,
      arrivedRevision: -1,
      customerRouteBlocked: false,
      customerObstacleSignature: "",
      customerShoppingTargetSignature: "",
      customerEntryAnnounced: true,
      occupiedCrates: new Set(),
      colliders: [],
      callbacks: { onStatus: vi.fn(), onTarget: vi.fn() },
      customerActors: { select: vi.fn() },
      streetNeighbourActors: { select: vi.fn(() => false), colliders: [] },
      crateObstacleSignature: vi.fn(() => ""),
      customerColliders: vi.fn(() => []),
      syncInventory: vi.fn(),
      syncStreet: vi.fn(),
      ensureSafePose: vi.fn(),
      updateTarget: vi.fn(),
    });

    view.setCustomerRoute(false);
    const originalEndpoint = view.route.at(-1)!;
    const firstStep = view.route[0]!;
    customer.position.set(firstStep.x / 2, 0, (-5.3 + firstStep.z) / 2);
    const currentPosition = { x: customer.position.x, z: customer.position.z };

    const baseItem = state.items.find((item) => item.location.kind === "shelf" && item.location.equipmentId === undefined)!;
    const next = act(state, { type: "TAKE_ITEM", itemId: baseItem.id });
    expect(getShoppingShelfLocation(next)?.equipmentId).toBe("shop-equipment-1");
    const service = equipmentFixtures.servicePoint("shop-equipment-1", 0)!;
    const replan = vi.spyOn(view, "setCustomerRoute");
    view.setState(next);

    expect(replan).toHaveBeenCalledWith(false);
    expect({ x: customer.position.x, z: customer.position.z }).toEqual(currentPosition);
    expect(view.route.at(-1)).toEqual({ x: service.position.x, z: service.position.z });
    expect(view.route.at(-1)).not.toEqual(originalEndpoint);
  });
});
