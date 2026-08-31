import {
  reduceSim, validateSimState, type SimCommand, type SimState,
} from "../../../src/sim3d/domain";

function step(state: SimState, action: SimCommand): SimState {
  const result = reduceSim(state, action);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${action.type}: ${result.message ?? "invalid business-time fixture"}`);
  return result.state;
}

/** Honour the saved arrival appointment instead of bypassing the real customer cooldown. */
export function beginNextFixtureCustomer(state: SimState): SimState {
  const nextCustomerAtMs = state.day.nextCustomerAtMs;
  if (state.day.phase !== "open" || nextCustomerAtMs === null) throw new Error("The fixture has no scheduled customer arrival");
  if (nextCustomerAtMs > state.day.elapsedOpenMs) {
    state = step(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: nextCustomerAtMs - state.day.elapsedOpenMs });
  }
  return step(state, { type: "NEXT_CUSTOMER" });
}
