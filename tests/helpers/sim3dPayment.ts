import { getCheckoutTotal, reduceSim, type SimCommand, type SimState, type SimTransactionV7 } from "../../src/sim3d/domain";
import { CASH_DENOMINATIONS_PENCE, cashChangeDuePence } from "../../src/sim3d/cashPayment";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed) throw new Error(`${command.type}: ${result.message ?? "Fixture command was rejected"}`);
  return result.state;
}

/** Economy/layout fixtures still complete real commands; PAY is never used to bypass cash. */
export function payScannedCheckout(state: SimState): SimState {
  if (state.payment?.method !== "cash") return act(state, { type: "PAY", success: true });
  let change = cashChangeDuePence(state.payment, getCheckoutTotal(state));
  if (!state.payment.received) state = act(state, { type: "RECEIVE_CASH" });
  if (state.payment?.method === "cash" && state.payment.selectedChange.length) state = act(state, { type: "CLEAR_CHANGE" });
  for (const denominationPence of [...CASH_DENOMINATIONS_PENCE].reverse()) {
    while (change >= denominationPence) {
      state = act(state, { type: "ADD_CHANGE", denominationPence });
      change -= denominationPence;
    }
  }
  return act(state, { type: "CONFIRM_CASH" });
}

/** Old fixtures must contain actual pre-cash ledger rows, without future metadata. */
export function preCashTransactions(transactions: readonly SimTransactionV7[]): SimTransactionV7[] {
  return transactions.map(({ id, customerNumber, itemIds, amountPence }) => ({ id, customerNumber, itemIds: [...itemIds], amountPence }));
}
