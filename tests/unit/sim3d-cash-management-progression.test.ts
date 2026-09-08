import { receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { describe, expect, it } from "vitest";
import { createFirstDayState, reduceSim, validateSimState, type SimCommand, type SimState } from "../../src/sim3d/domain";
import { getStreetProgress, getVenueProgress } from "../../src/sim3d/progression";
import { getShopAchievements } from "../../src/sim3d/shopDevelopment";
import { payScannedCheckout } from "../helpers/sim3dPayment";

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function serve(state: SimState): SimState {
  state = step(state, { type: state.day.phase === "preparing" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  while (state.customer.phase !== "checkout") state = step(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
    state = step(state, { type: "SCAN", itemId: item.id });
  }
  return step(payScannedCheckout(state), { type: "CUSTOMER_ADVANCE" });
}

describe("refund-aware business progress", () => {
  it("removes refunded orders from experience and achievements and awards a resale only once", () => {
    let state = step(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "refund-progress", lines: [{ productId: "water", quantity: 1 }] });
    state = receiveAllDeliveries(state);
    state = step(state, { type: "PICK_CRATE", crateId: "water-crate" });
    state = step(state, { type: "STOCK", productId: "water", slot: 0 });
    state = step(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.id === "water-crate")!.position });
    state = serve(state);
    expect(getStreetProgress(state)).toMatchObject({ experience: 10, paidOrders: 1 });
    state = step(state, { type: "REFUND_TRANSACTION", transactionId: state.transactions[0]!.id, reason: "void" });
    expect(getStreetProgress(state)).toMatchObject({ experience: 0, paidOrders: 0 });
    expect(getShopAchievements(state).find((entry) => entry.id === "first-sale")?.completed).toBe(false);
    state = serve(state);
    expect(state.transactions).toHaveLength(2);
    expect(state.transactions[1]!.itemIds).toEqual(state.transactions[0]!.itemIds);
    expect(getStreetProgress(state)).toMatchObject({ experience: 10, paidOrders: 1 });
    state = step(state, { type: "REFUND_TRANSACTION", transactionId: state.transactions[1]!.id, reason: "return" });
    state = step(step(state, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
    expect(getShopAchievements(state).find((entry) => entry.id === "first-day")?.completed).toBe(false);
    expect(getVenueProgress(state, "cafe").requirements.find((entry) => entry.id === "settlement")?.completed).toBe(false);
  });
});
