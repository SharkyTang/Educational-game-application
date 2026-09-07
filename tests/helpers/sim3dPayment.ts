import { getCheckoutTotal, reduceSim, type SimCommand, type SimState, type SimTransactionV7 } from "../../src/sim3d/domain";
import { cashChangeDuePence } from "../../src/sim3d/cashPayment";
import { findExactChange } from "../../src/sim3d/cashDrawer";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed) throw new Error(`${command.type}: ${result.message ?? "Fixture command was rejected"}`);
  return result.state;
}

/** Economy/layout fixtures still complete real commands; PAY is never used to bypass cash. */
export function payScannedCheckout(state: SimState): SimState {
  if (state.payment?.method !== "cash") return act(state, { type: "PAY", success: true });
  const change = cashChangeDuePence(state.payment, getCheckoutTotal(state));
  if (!state.payment.received) state = act(state, { type: "RECEIVE_CASH" });
  if (state.payment?.method === "cash" && state.payment.selectedChange.length) state = act(state, { type: "CLEAR_CHANGE" });
  const pieces = findExactChange(state.cashDrawer, change);
  if (pieces === null) {
    state = act(state, { type: "REQUEST_EXACT_CASH" });
    state = act(state, { type: "RECEIVE_CASH" });
    return act(state, { type: "CONFIRM_CASH" });
  }
  for (const denominationPence of pieces) state = act(state, { type: "ADD_CHANGE", denominationPence });
  return act(state, { type: "CONFIRM_CASH" });
}

/** Old fixtures must contain actual pre-cash ledger rows, without future metadata. */
export function preCashTransactions(transactions: readonly SimTransactionV7[]): SimTransactionV7[] {
  return transactions.map(({ id, customerNumber, itemIds, amountPence }) => ({ id, customerNumber, itemIds: [...itemIds], amountPence }));
}
