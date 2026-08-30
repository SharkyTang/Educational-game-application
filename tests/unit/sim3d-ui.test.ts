import { describe, expect, it, vi } from "vitest";
import { createInitialSimState, reduceSim, type SimState } from "../../src/sim3d/domain";
import type { InteractionTarget } from "../../src/sim3d/world";

// Pure UI decisions do not require a WebGL engine or a browser document.
vi.mock("../../src/sim3d/world", () => ({ ShopWorld: class {} }));
import { commandForInteraction, inspectableProduct, interactionInReach } from "../../src/sim3d/App3D";

function target(overrides: Partial<InteractionTarget> = {}): InteractionTarget {
  return { id: "milk-crate", kind: "crate", crateId: "milk-crate", productId: "milk", label: "牛奶货箱", action: "抱起货箱", inspectable: true, distance: 1.3, ...overrides };
}

function checkoutState(): SimState {
  let state = createInitialSimState();
  for (const productId of ["milk", "bread"] as const) {
    state = reduceSim(state, { type: "TAKE_ITEM", itemId: `${productId}-1` }).state;
    state = reduceSim(state, { type: "STOCK", productId, slot: 0 }).state;
  }
  state = reduceSim(state, { type: "OPEN_STORE" }).state;
  for (let index = 0; index < 3; index += 1) state = reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state;
  return state;
}

describe("3D accessible interaction decisions", () => {
  it.each([2.61, 20, Infinity, NaN, -1])("rejects distant or invalid target distance %s", (distance) => {
    const object = target({ distance });
    expect(interactionInReach(object)).toBe(false);
    expect(commandForInteraction(createInitialSimState(), object).command).toBeUndefined();
    expect(inspectableProduct(createInitialSimState(), object)).toBeNull();
  });

  it("does not invent an interaction when the player is not looking at an object", () => {
    expect(commandForInteraction(createInitialSimState(), null)).toEqual({});
    expect(inspectableProduct(createInitialSimState(), null)).toBeNull();
  });

  it("maps a nearby crate to a real pickup and nearby shelf to its first empty slot", () => {
    let state = createInitialSimState();
    const pickup = commandForInteraction(state, target()).command!;
    expect(pickup).toEqual({ type: "PICK_CRATE", crateId: "milk-crate" });
    state = reduceSim(state, pickup).state;
    const rack = target({ kind: "shelf", id: "milk-shelf" });
    const stock = commandForInteraction(state, rack).command!;
    expect(stock).toEqual({ type: "STOCK", productId: "milk", slot: 0 });
    state = reduceSim(state, stock).state;
    expect(commandForInteraction(state, rack).command).toEqual({ type: "STOCK", productId: "milk", slot: 1 });
    for (let slot = 1; slot < 4; slot += 1) state = reduceSim(state, { type: "STOCK", productId: "milk", slot }).state;
    expect(commandForInteraction(state, rack)).toEqual({ message: "这一侧货架已经放满了。" });
    expect(inspectableProduct(state, target())).toBeNull();
  });

  it("prefers the real held product over a different product under the crosshair", () => {
    const state = reduceSim(createInitialSimState(), { type: "TAKE_ITEM", itemId: "bread-1" }).state;
    expect(inspectableProduct(state, target())).toBe("bread");
    expect(inspectableProduct(state, null)).toBe("bread");
    expect(commandForInteraction(state, target({ kind: "drop-zone", position: { x: -1.1, z: 2.6 } })).command).toEqual({ type: "RETURN_ITEM" });
  });

  it("the counter scans each unswept item before creating the payment command", () => {
    let state = checkoutState();
    const counter = target({ id: "counter", kind: "counter", inspectable: false });
    const first = commandForInteraction(state, counter).command!;
    expect(first).toEqual({ type: "SCAN", itemId: "milk-1" });
    state = reduceSim(state, first).state;
    const second = commandForInteraction(state, counter).command!;
    expect(second).toEqual({ type: "SCAN", itemId: "bread-1" });
    state = reduceSim(state, second).state;
    const pay = commandForInteraction(state, counter).command!;
    expect(pay).toEqual({ type: "PAY", success: true });
    state = reduceSim(state, pay).state;
    expect(commandForInteraction(state, counter).command).toBeUndefined();
    expect(state.cashPence).toBe(400);
  });

  it("distinguishes a checkout item from an item available for pickup", () => {
    const object = target({ kind: "item", itemId: "milk-1" });
    expect(commandForInteraction(createInitialSimState(), object).command).toEqual({ type: "TAKE_ITEM", itemId: "milk-1" });
    expect(commandForInteraction(checkoutState(), object).command).toEqual({ type: "SCAN", itemId: "milk-1" });
  });

  it("requires an actual target position to put a crate down", () => {
    const state = reduceSim(createInitialSimState(), { type: "PICK_CRATE", crateId: "milk-crate" }).state;
    expect(commandForInteraction(state, target({ kind: "drop-zone" })).command).toBeUndefined();
    expect(commandForInteraction(state, target({ kind: "drop-zone", position: { x: -1.1, z: 2.6 } })).command)
      .toEqual({ type: "DROP_HELD", position: { x: -1.1, z: 2.6 } });
  });
});
