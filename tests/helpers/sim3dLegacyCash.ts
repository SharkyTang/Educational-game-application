import { asV14BusinessSnapshot } from "./sim3dDelivery";
import type { SimState, SimStateV13 } from "../../src/sim3d/domain";

/** Build an actual pre-cash-management snapshot, never relabel a v14 audit ledger. */
export function asV13CashSnapshot(state: SimState): SimStateV13 {
  if (state.cashJournal.length !== 0 || state.cashReservePence !== 0) {
    throw new Error("A v13 fixture cannot erase cash management history.");
  }
  const { cashJournal: _journal, cashReservePence: _reserve, settlements, ...previous } = asV14BusinessSnapshot(state);
  return {
    ...previous,
    schemaVersion: 13,
    settlements: settlements.map(({ refundCount: _refundCount, refundPence: _refundPence,
      netRevenuePence: _netRevenuePence, ...record }) => record),
  };
}
