import { reduceSim, validateSimState, type SimState, type SimStateV14 } from "../../src/sim3d/domain";
import { DELIVERY_ARRIVE_MS, DELIVERY_DEPART_MS, DELIVERY_PREPARE_MS } from "../../src/sim3d/delivery";
import { BUSINESS_DURATION_MS, LEGACY_BUSINESS_DURATION_MS } from "../../src/sim3d/businessTime";

/** Fixture setup uses the same saved delivery commands as active gameplay, never free receipt. */
export function waitForDelivery(state: SimState): SimState {
  if (state.delivery.phase === "ready") return state;
  const result = reduceSim(state, { type: "ADVANCE_DELIVERY_TIME",
    elapsedMs: DELIVERY_DEPART_MS + DELIVERY_PREPARE_MS + DELIVERY_ARRIVE_MS, blocked: false });
  if (!result.changed || result.state.delivery.phase !== "ready" || !validateSimState(result.state)) {
    throw new Error(`Fixture delivery cannot arrive: ${result.message ?? state.delivery.phase}`);
  }
  return result.state;
}

export function finishDeliveryDeparture(state: SimState): SimState {
  if (state.delivery.phase !== "departing") return state;
  const result = reduceSim(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: DELIVERY_DEPART_MS, blocked: false });
  if (!result.changed || !validateSimState(result.state)) throw new Error("Fixture delivery departure failed");
  return result.state;
}

export function receiveNextDelivery(state: SimState): SimState {
  state = waitForDelivery(state);
  const result = reduceSim(state, { type: "RECEIVE_DELIVERY", orderId: state.delivery.orderId! });
  if (!result.changed || !validateSimState(result.state)) throw new Error(`Fixture receipt failed: ${result.message}`);
  return finishDeliveryDeparture(result.state);
}

/** Old fixtures that received several orders at once now actually receive each FIFO trip. */
export function receiveAllDeliveries(state: SimState): SimState {
  while (state.purchases.some((purchase) => purchase.receivedDay === null)) state = receiveNextDelivery(state);
  return finishDeliveryDeparture(state);
}

/** Build a real v14 shape, preserving the old seven-minute clock's displayed time. */
export function asV14BusinessSnapshot(state: SimState): SimStateV14 {
  const { delivery: _delivery, renovation, day, ...previous } = structuredClone(state);
  const { workstation: _workstation, ...layout } = renovation.layout;
  const elapsedOpenMs = day.elapsedOpenMs * LEGACY_BUSINESS_DURATION_MS / BUSINESS_DURATION_MS;
  return {
    ...previous, schemaVersion: 14, renovation: { ...renovation, layout },
    day: { ...day, elapsedOpenMs, nextCustomerAtMs: day.nextCustomerAtMs === null ? null
      : Math.min(LEGACY_BUSINESS_DURATION_MS, Math.max(Number.EPSILON, elapsedOpenMs + Math.max(0, day.nextCustomerAtMs - day.elapsedOpenMs))) },
  };
}
