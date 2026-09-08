import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Matrix, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { createShop, type ShopEnvironment } from "../../src/sim3d/assets";
import { CashDrawerVisual } from "../../src/sim3d/cashDrawerVisual";
import { createFirstDayState, type SimState } from "../../src/sim3d/domain";
import { ShopWorld } from "../../src/sim3d/world";
import { checkoutPlacement } from "../../src/sim3d/productLayout";

interface Harness {
  state: SimState;
  scene: Scene;
  shop: ShopEnvironment;
  cashVisual: CashDrawerVisual;
  cashDrawerOpen: boolean;
  reducedMotion: boolean;
  createCashVisual(): CashDrawerVisual;
  syncCashVisual(): void;
  setCashDrawerOpen(open: boolean): void;
  setReducedMotion(value: boolean): void;
}

describe("physical cash drawer attached to the actual shop counter", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine();
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = { createLinearGradient: () => gradient, createRadialGradient: () => gradient,
        measureText: () => ({ width: 100 }), getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }) };
      const context = new Proxy(values, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });
  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function harness(): Harness {
    const state = createFirstDayState();
    state.customer = { ...state.customer, phase: "checkout", shoppingList: ["milk", "bread"] };
    state.items = (["milk", "bread"] as const).map((productId) => ({ id: `cash-visual-${productId}`, productId, location: { kind: "checkout" } }));
    state.scannedIds = state.items.map((item) => item.id);
    state.payment = { method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: true, selectedChange: [50] };
    const view = Object.create(ShopWorld.prototype) as Harness;
    Object.assign(view, { state, scene, shop: createShop(scene, { catalogFixtures: true, layout: state.renovation.layout }),
      cashDrawerOpen: false, reducedMotion: true });
    view.cashVisual = view.createCashVisual();
    view.syncCashVisual();
    return view;
  }

  it("replaces the decorative box and parents both cash trays to the movable counter", () => {
    const view = harness();
    const counter = scene.getMeshByName("checkout-counter")!;
    expect(scene.getMeshByName("counter-drawer")).toBeNull();
    expect(view.cashVisual.root.parent).toBe(counter);
    expect(view.cashVisual.tenderAnchor.isDescendantOf(counter)).toBe(true);
    expect(view.cashVisual.changeAnchor.isDescendantOf(counter)).toBe(true);
    const localPositions = [view.cashVisual.root, view.cashVisual.tenderAnchor, view.cashVisual.changeAnchor].map((node) => {
      node.computeWorldMatrix(true);
      return Vector3.TransformCoordinates(node.getAbsolutePosition(), Matrix.Invert(counter.computeWorldMatrix(true)));
    });
    for (const rotation of [0, 1, 2, 3] as const) {
      const layout = structuredClone(view.state.renovation.layout);
      layout.expansion = 1;
      Object.assign(layout.placements.find((placement) => placement.id === "checkout-counter")!, { x: -1.7, z: 5.7, rotation });
      view.shop.applyLayout(layout);
      for (const [index, node] of [view.cashVisual.root, view.cashVisual.tenderAnchor, view.cashVisual.changeAnchor].entries()) {
        node.computeWorldMatrix(true);
        const expected = Vector3.TransformCoordinates(localPositions[index]!, counter.computeWorldMatrix(true));
        expect(Vector3.Distance(node.getAbsolutePosition(), expected)).toBeLessThan(.0001);
      }
    }
    expect(scene.getMeshByName("pos-terminal")).not.toBeNull();
    expect(scene.getMeshByName("card-terminal")).not.toBeNull();
    view.cashVisual.dispose();
  });

  it("projects persisted stock and reservations without adding tentative customer tender", () => {
    const view = harness();
    const before = structuredClone(view.state);
    const stock = (value: number): TransformNode => scene.getTransformNodeByName(`shop-cash-drawer-${value}-stack`)!;
    expect(stock(50).metadata.actualCount).toBe(view.state.cashDrawer[50] - 1);
    expect(stock(500).metadata.actualCount).toBe(view.state.cashDrawer[500]);
    view.setCashDrawerOpen(true);
    expect(view.cashVisual.openRatio).toBe(1);
    expect(view.cashVisual.root.getChildMeshes().every((mesh) => !mesh.isPickable)).toBe(true);
    expect(view.state).toEqual(before);
    view.state.payment = { method: "card" };
    view.syncCashVisual();
    expect(stock(50).metadata.actualCount).toBe(view.state.cashDrawer[50]);
    expect(scene.getTransformNodeByName("shop-cash-tender-500-stack")!.isEnabled()).toBe(false);
    view.cashVisual.dispose();
  });

  it("keeps both cash trays clear of every scanned and unscanned two-item placement", () => {
    const view = harness();
    const surfaces = [view.cashVisual.tenderAnchor, view.cashVisual.changeAnchor];
    for (const tray of surfaces) {
      tray.computeWorldMatrix(true);
      const position = tray.getAbsolutePosition();
      for (const scanned of [false, true]) for (const index of [0, 1]) {
        // This envelope is the upper bound used by the real product fitter.
        const item = checkoutPlacement({ width: .23, height: .34, depth: .32 }, index, scanned);
        const separatedX = Math.abs(position.x - item.position.x) >= .16 + .115;
        const separatedZ = Math.abs(position.z - item.position.z) >= .12 + .16;
        expect(separatedX || separatedZ, `${tray.name} must leave ${scanned ? "scanned" : "unscanned"} item ${index} clear`).toBe(true);
      }
    }
    view.cashVisual.dispose();
  });

  it("opens and closes independently of movement and preserves all payment data", () => {
    const view = harness();
    const before = structuredClone(view.state);
    view.setReducedMotion(false);
    view.setCashDrawerOpen(true);
    expect(view.cashVisual.openRatio).toBe(0);
    view.cashVisual.tick(120);
    expect(view.cashVisual.openRatio).toBeGreaterThan(0);
    expect(view.cashVisual.openRatio).toBeLessThan(1);
    view.setReducedMotion(true);
    expect(view.cashVisual.openRatio).toBe(1);
    view.setCashDrawerOpen(false);
    expect(view.cashVisual.openRatio).toBe(0);
    expect(view.state).toEqual(before);
    view.cashVisual.dispose();
  });

  it("also honours operating-system reduced motion on the physical counter", () => {
    const view = harness();
    vi.stubGlobal("window", Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }) }));
    view.setReducedMotion(false);
    view.setCashDrawerOpen(true);
    expect(view.cashVisual.openRatio).toBe(1);
    view.setCashDrawerOpen(false);
    expect(view.cashVisual.openRatio).toBe(0);
    view.cashVisual.dispose();
  });
});
