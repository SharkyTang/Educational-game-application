import { CASH_DENOMINATIONS_PENCE, MAX_CHANGE_PIECES, isCashDenomination, type CashDenominationPence, type PaymentMethod } from "./cashPayment";
import { applyCashDrawerTransaction, cashDrawerValuePence, findExactChange, validateCashDrawerState, type CashDrawerState } from "./cashDrawer";
import type { SimState } from "./domain";

interface CashJournalBase { id: string; dayNumber: number; transactionCount: number }
export interface CashFloatRecord extends CashJournalBase {
  kind: "float";
  drawer: CashDrawerState;
  reservePence: number;
}
export interface CashRefundRecord extends CashJournalBase {
  kind: "refund";
  transactionId: string;
  reason: "return" | "void";
  paymentMethod: PaymentMethod;
  amountPence: number;
  returnedCash: CashDenominationPence[];
}
export interface CashCountRecord extends CashJournalBase {
  kind: "count";
  expected: CashDrawerState;
  counts: CashDrawerState;
  expectedPence: number;
  countedPence: number;
  differencePence: number;
  /** Signed per-denomination differences; counts themselves remain non-negative. */
  denominationDifferences: CashDrawerState;
  note: string;
}
export type CashJournalEntry = CashFloatRecord | CashRefundRecord | CashCountRecord;

export function cashDrawersEqual(left: CashDrawerState, right: CashDrawerState): boolean {
  return CASH_DENOMINATIONS_PENCE.every((denomination) => left[denomination] === right[denomination]);
}

export function cashCountDifferences(expected: CashDrawerState, counts: CashDrawerState): CashDrawerState {
  return Object.fromEntries(CASH_DENOMINATIONS_PENCE.map((denomination) =>
    [denomination, counts[denomination] - expected[denomination]])) as CashDrawerState;
}

/** Refund disbursement uses the existing bounded, minimum-piece exact-change rule. */
export function removeRefundCash(drawer: CashDrawerState, pieces: readonly CashDenominationPence[]): CashDrawerState {
  const next = { ...drawer };
  for (const denomination of pieces) {
    if (!isCashDenomination(denomination) || next[denomination] < 1) throw new Error("钱箱无法支付这笔退款。");
    next[denomination] -= 1;
  }
  cashDrawerValuePence(next);
  return next;
}

const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
function exactKeys(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) => typeof key === "string" && fields.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}
function exactArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      return descriptor?.enumerable === true && "value" in descriptor;
    }).every(Boolean);
}
const baseFields = ["id", "kind", "dayNumber", "transactionCount"];

/**
 * Replays immutable sales and the interleaved cash journal. Item ownership is released
 * only by one valid refund, allowing that same physical item to be sold again later.
 * The fixed v12 opening float and tracked-sale boundary remain the audit baseline.
 */
export function validateCashManagementLedger(state: SimState): boolean {
  try {
    if (!integer(state.cashReservePence) || state.cashReservePence < 0 || !exactArray(state.cashJournal)
      || !Array.isArray(state.settlements) || typeof state.day !== "object" || state.day === null) return false;
    let drawer = { ...state.cashDrawerOpening };
    let reservePence = 0;
    let eventIndex = 0;
    let previousDay = 0;
    const refunded = new Set<string>();
    const soldOwners = new Map<string, string>();
    const transactionIndices = new Map(state.transactions.map((sale, index) => [sale.id, index]));
    const countedDays = new Set<number>();
    const refundedDays = new Set<number>();
    for (let boundary = 0; boundary <= state.transactions.length; boundary += 1) {
      if (boundary > 0) {
        const sale = state.transactions[boundary - 1]!;
        for (const itemId of sale.itemIds) {
          if (soldOwners.has(itemId)) return false;
          soldOwners.set(itemId, sale.id);
        }
        if (sale.cashDrawerTracked && sale.paymentMethod === "cash") drawer = applyCashDrawerTransaction(drawer, {
          tenderedCash: sale.tenderedCash, tenderedPence: sale.tenderedPence,
          changeCash: sale.changeCash, changePence: sale.changePence,
        });
        if (!integer(cashDrawerValuePence(drawer) + reservePence)) return false;
      }
      while (eventIndex < state.cashJournal.length) {
        const event = state.cashJournal[eventIndex]!;
        if (typeof event !== "object" || event === null || !integer(event.transactionCount)
          || event.transactionCount < boundary || event.transactionCount < state.cashDrawerTransactionStart
          || event.transactionCount > state.transactions.length) return false;
        if (event.transactionCount !== boundary) break;
        if (event.id !== `cash-event-${eventIndex + 1}` || !integer(event.dayNumber)
          || event.dayNumber < 1 || event.dayNumber < previousDay || event.dayNumber > state.day.number) return false;
        const past = state.settlements[event.dayNumber - 1];
        const start = past?.transactionStart ?? (event.dayNumber === state.day.number ? state.day.transactionStart : -1);
        const end = past?.transactionEnd ?? state.transactions.length;
        if (!integer(start) || !integer(end) || start < 0 || boundary < start || boundary > end) return false;
        if (event.kind === "float") {
          if (!exactKeys(event, [...baseFields, "drawer", "reservePence"]) || boundary !== start
            || countedDays.has(event.dayNumber) || refundedDays.has(event.dayNumber)
            || !validateCashDrawerState(event.drawer) || !integer(event.reservePence) || event.reservePence < 0) return false;
          const available = cashDrawerValuePence(drawer) + reservePence;
          const total = cashDrawerValuePence(event.drawer);
          if (!integer(available) || total > available || event.reservePence !== available - total) return false;
          drawer = { ...event.drawer };
          reservePence = event.reservePence;
        } else if (event.kind === "refund") {
          if (!exactKeys(event, [...baseFields, "transactionId", "reason", "paymentMethod", "amountPence", "returnedCash"])
            || (event.reason !== "return" && event.reason !== "void") || typeof event.transactionId !== "string"
            || refunded.has(event.transactionId) || !exactArray(event.returnedCash)
            || event.returnedCash.length > MAX_CHANGE_PIECES || event.returnedCash.some((piece) => !isCashDenomination(piece))) return false;
          const index = transactionIndices.get(event.transactionId);
          if (index === undefined || index < start || index >= boundary) return false;
          const sale = state.transactions[index]!;
          if (event.amountPence !== sale.amountPence || event.paymentMethod !== sale.paymentMethod
            || (sale.customerNumber === state.customer.number && state.customer.phase === "leaving")
            || sale.itemIds.some((id) => soldOwners.get(id) !== sale.id)) return false;
          if (event.paymentMethod === "cash") {
            const expected = findExactChange(drawer, sale.amountPence);
            if (expected === null || expected.length !== event.returnedCash.length
              || expected.some((piece, index) => event.returnedCash[index] !== piece)) return false;
            drawer = removeRefundCash(drawer, expected);
          } else if (event.returnedCash.length !== 0) return false;
          for (const id of sale.itemIds) soldOwners.delete(id);
          refunded.add(sale.id);
          refundedDays.add(event.dayNumber);
        } else if (event.kind === "count") {
          if (!exactKeys(event, [...baseFields, "expected", "counts", "expectedPence", "countedPence", "differencePence", "denominationDifferences", "note"])
            || boundary !== end || !validateCashDrawerState(event.expected) || !validateCashDrawerState(event.counts)
            || (event.dayNumber === state.day.number && state.day.phase !== "closing" && state.day.phase !== "settled")
            || !cashDrawersEqual(event.expected, drawer) || typeof event.note !== "string" || event.note.trim() !== event.note
            || event.note.length > 200 || !exactKeys(event.denominationDifferences, CASH_DENOMINATIONS_PENCE.map(String))) return false;
          const expectedPence = cashDrawerValuePence(drawer);
          const countedPence = cashDrawerValuePence(event.counts);
          const differences = cashCountDifferences(drawer, event.counts);
          if (event.expectedPence !== expectedPence || event.countedPence !== countedPence
            || event.differencePence !== countedPence - expectedPence
            || CASH_DENOMINATIONS_PENCE.some((denomination) => event.denominationDifferences[denomination] !== differences[denomination])
            || (!cashDrawersEqual(drawer, event.counts) && event.note.length === 0)) return false;
          countedDays.add(event.dayNumber);
        } else return false;
        previousDay = event.dayNumber;
        if (!integer(cashDrawerValuePence(drawer) + reservePence)) return false;
        eventIndex += 1;
      }
    }
    if (eventIndex !== state.cashJournal.length || reservePence !== state.cashReservePence
      || !cashDrawersEqual(drawer, state.cashDrawer)) return false;
    return state.items.every((item) => item.location.kind === "sold"
      ? soldOwners.get(item.id) === item.location.transactionId : !soldOwners.has(item.id));
  } catch {
    return false;
  }
}
