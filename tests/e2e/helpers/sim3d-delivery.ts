import { reduceSim, validateSimState, type SimState } from "../../../src/sim3d/domain";

/** Prepare audited fixtures by advancing real delivery commands, never by editing shipment state. */
export function receiveFixtureDeliveries(state: SimState): SimState {
  for (let limit = 0; limit < 500; limit += 1) {
    if (state.delivery.phase === "idle" && state.purchases.every((order) => order.receivedDay !== null)) return state;
    const result = state.delivery.phase === "ready"
      ? reduceSim(state, { type: "RECEIVE_DELIVERY", orderId: state.delivery.orderId! })
      : reduceSim(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 1000, blocked: false });
    if (!result.changed || !validateSimState(result.state)) throw new Error(`Invalid fixture delivery: ${result.message ?? state.delivery.phase}`);
    state = result.state;
  }
  throw new Error("Fixture delivery did not finish");
}
