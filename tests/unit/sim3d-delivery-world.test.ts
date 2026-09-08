import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { createFirstDayState, type SimState } from "../../src/sim3d/domain";
import { ShopWorld } from "../../src/sim3d/world";
import { deliveryTruckX, type DeliveryState } from "../../src/sim3d/delivery";

interface DeliveryWorld {
  state: SimState;
  camera: { position: Vector3 };
  street: { truck: { position: Vector3; setEnabled: ReturnType<typeof vi.fn> }; wheels: { rotation: { z: number } }[] };
  truckPhase: string;
  active: boolean;
  setDeliveryState(state: SimState): void;
  isDeliveryBlocked(elapsedMs: number): boolean;
}
function world(delivery: DeliveryState): DeliveryWorld {
  return Object.assign(Object.create(ShopWorld.prototype), {
    state: { ...createFirstDayState(), delivery },
    camera: { position: new Vector3(0, 1.65, -3.5) },
    street: { truck: { position: new Vector3(25, 0, -9.1), setEnabled: vi.fn() }, wheels: [{ rotation: { z: 0 } }] },
    truckPhase: "away", active: false,
    syncDeliveryStatus: vi.fn(),
  }) as DeliveryWorld;
}

describe("saved delivery state drives the physical vehicle", () => {
  it.each([0, 750, 3000, 5999])("restores an arriving truck at the same position after %i ms, even during cashier mode", (elapsedMs) => {
    const delivery: DeliveryState = { phase: "arriving", orderId: "order-one", elapsedMs, blocked: false };
    const view = world(delivery);
    view.setDeliveryState(view.state);
    expect(view.street.truck.position.x).toBeCloseTo(deliveryTruckX(delivery), 8);
    expect(view.street.truck.position.z).toBe(-9.1);
    expect(view.street.truck.setEnabled).toHaveBeenLastCalledWith(true);
    expect(view.active).toBe(false);
  });
  it("has no parked truck before an order, and shows exactly the saved parked or departing phase", () => {
    const view = world({ phase: "idle", orderId: null, elapsedMs: 0, blocked: false });
    view.setDeliveryState(view.state);
    expect(view.street.truck.setEnabled).toHaveBeenLastCalledWith(false);
    view.setDeliveryState({ ...view.state, delivery: { phase: "ready", orderId: "paid", elapsedMs: 0, blocked: false } });
    expect(view.truckPhase).toBe("parked");
    expect(view.street.truck.position.x).toBe(3);
    view.setDeliveryState({ ...view.state, delivery: { phase: "departing", orderId: "paid", elapsedMs: 2000, blocked: false } });
    expect(view.street.truck.position.x).toBe(14);
  });
  it("sweeps long driving steps to stop for a player, while a clear pavement never blocks the van", () => {
    const view = world({ phase: "arriving", orderId: "order-one", elapsedMs: 3000, blocked: false });
    view.camera.position.set(-8, 1.65, -9.1);
    expect(view.isDeliveryBlocked(1000)).toBe(true);
    view.camera.position.z = -6.1;
    expect(view.isDeliveryBlocked(1000)).toBe(false);
    view.state.delivery = { phase: "departing", orderId: "order-one", elapsedMs: 0, blocked: false };
    view.camera.position.set(10, 1.65, -9.1);
    expect(view.isDeliveryBlocked(2000)).toBe(true);
  });
  it("checks the driven part of a frame that finishes preparation", () => {
    const view = world({ phase: "preparing", orderId: "order-one", elapsedMs: 5999, blocked: false });
    view.camera.position.set(-5, 1.65, -9.1);
    expect(view.isDeliveryBlocked(1)).toBe(false);
    expect(view.isDeliveryBlocked(5000)).toBe(true);
    view.camera.position.z = -6.1;
    expect(view.isDeliveryBlocked(5000)).toBe(false);
  });
});
