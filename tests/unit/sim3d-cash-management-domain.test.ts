import { describe, expect, it } from "vitest";
import {
  createFirstDayState, getCashCountStatus, getCashManagementSummary, getDaySummary, getPaymentMethodSummary,
  getRefundOffer, migrateV13SimState, reduceSim, validateSimState, validateV13SimState,
  type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { CASH_DENOMINATIONS_PENCE } from "../../src/sim3d/cashPayment";
import { cashDrawerValuePence, createDefaultCashDrawer, type CashDrawerState } from "../../src/sim3d/cashDrawer";
import { validateCashManagementLedger } from "../../src/sim3d/cashManagement";
import { payScannedCheckout } from "../helpers/sim3dPayment";

const emptyDrawer = (): CashDrawerState => Object.fromEntries(CASH_DENOMINATIONS_PENCE.map((value) => [value, 0])) as CashDrawerState;
function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  expect(validateSimState(JSON.parse(JSON.stringify(result.state)))).toBe(true);
  return result.state;
}
function rejected(state: SimState, command: SimCommand): void {
  const before = structuredClone(state);
  const result = reduceSim(state, command);
  expect(result.changed, command.type).toBe(false);
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}
function stockWater(state: SimState, count: number): SimState {
  state = act(state, { type: "PICK_CRATE", crateId: "water-crate" });
  for (let index = 0; index < count; index += 1) {
    const slot = Array.from({ length: 4 }, (_, slot) => slot).find((slot) => !state.items.some((item) =>
      item.location.kind === "shelf" && item.productId === "water" && item.location.slot === slot))!;
    state = act(state, { type: "STOCK", productId: "water", slot });
  }
  return act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.id === "water-crate")!.position });
}
function ready(quantity = 2, drawer?: CashDrawerState): SimState {
  let state = createFirstDayState();
  if (drawer) state = act(state, { type: "CONFIGURE_CASH_FLOAT", drawer });
  state = act(state, { type: "PURCHASE_STOCK", orderId: "cash-management-water", lines: [{ productId: "water", quantity }] });
  state = act(state, { type: "RECEIVE_DELIVERY" });
  return stockWater(state, quantity);
}
function sale(state: SimState, leave = true): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  while (state.customer.phase !== "checkout") state = act(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((item) => item.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  state = payScannedCheckout(state);
  expect(validateSimState(state)).toBe(true);
  return leave ? act(state, { type: "CUSTOMER_ADVANCE" }) : state;
}
function refund(state: SimState, id = state.transactions.at(-1)!.id): SimState {
  return act(state, { type: "REFUND_TRANSACTION", transactionId: id, reason: "return" });
}

describe("cash v3 opening float and physical reserve", () => {
  it("moves value into reserve, exchanges denominations and restores it without creating capital", () => {
    let state = createFirstDayState();
    const funds = state.cashPence;
    const opening = structuredClone(state.cashDrawerOpening);
    state = act(state, { type: "CONFIGURE_CASH_FLOAT", drawer: { ...emptyDrawer(), 100: 10 } });
    expect(state.cashReservePence).toBe(2160);
    expect(getCashManagementSummary(state)).toMatchObject({ drawerPence: 1000, reservePence: 2160, availableFloatPence: 3160 });
    state = act(state, { type: "CONFIGURE_CASH_FLOAT", drawer: { ...emptyDrawer(), 500: 6, 20: 8 } });
    expect(state.cashReservePence).toBe(0);
    state = act(state, { type: "CONFIGURE_CASH_FLOAT", drawer: createDefaultCashDrawer() });
    expect(state.cashPence).toBe(funds);
    expect(state.cashDrawerOpening).toEqual(opening);
    expect(state.cashJournal).toHaveLength(3);
  });

  it("rejects excess value, fractional/negative/overflow counts, no-op and configuration after opening", () => {
    const state = ready();
    for (const drawer of [
      { ...emptyDrawer(), 1000: 4 }, { ...emptyDrawer(), 1: -1 }, { ...emptyDrawer(), 1: 1.5 },
      { ...emptyDrawer(), 1000: Number.MAX_SAFE_INTEGER }, state.cashDrawer,
    ]) rejected(state, { type: "CONFIGURE_CASH_FLOAT", drawer });
    rejected(act(state, { type: "OPEN_STORE" }), { type: "CONFIGURE_CASH_FLOAT", drawer: emptyDrawer() });
  });

  it("retains reserve and the immutable baseline across settlement and the next day", () => {
    let state = act(createFirstDayState(), { type: "CONFIGURE_CASH_FLOAT", drawer: emptyDrawer() });
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "SETTLE_DAY" });
    state = act(state, { type: "START_NEXT_DAY" });
    state = act(state, { type: "CONFIGURE_CASH_FLOAT", drawer: createDefaultCashDrawer() });
    expect(state.cashReservePence).toBe(0);
    expect(state.cashDrawerTransactionStart).toBe(0);
    expect(state.cashPence).toBe(1200);
  });
});

describe("immutable whole-sale refunds and repeated physical inventory ownership", () => {
  it("refunds card without touching the drawer and cancels exactly the corresponding revenue and cost", () => {
    const paid = sale(ready());
    const before = structuredClone(paid);
    const state = refund(paid);
    expect(state.transactions).toEqual(before.transactions);
    expect(state.cashDrawer).toEqual(before.cashDrawer);
    expect(state.cashPence).toBe(before.cashPence - 95);
    expect(state.items.find((item) => item.id === paid.transactions[0]!.itemIds[0])?.location.kind).toBe("shelf");
    expect(getDaySummary(state)).toMatchObject({ paidCustomers: 1, revenuePence: 95, refundCount: 1,
      refundPence: 95, netRevenuePence: 0, costOfGoodsPence: 0, grossProfitPence: 0, remainingStockUnits: 2 });
    expect(getPaymentMethodSummary(state)).toMatchObject({ cardRefundCount: 1, cardRefundPence: 95, cardNetRevenuePence: 0 });
  });

  it("refunds cash from current denominations, keeps original tender/change, and restores total till value", () => {
    const first = sale(ready());
    const paid = sale(first);
    expect(paid.transactions[1]!.paymentMethod).toBe("cash");
    const refunded = refund(paid);
    expect(refunded.transactions).toEqual(paid.transactions);
    expect(cashDrawerValuePence(refunded.cashDrawer)).toBe(cashDrawerValuePence(first.cashDrawer));
    expect(refunded.cashJournal.at(-1)).toMatchObject({ kind: "refund", paymentMethod: "cash", amountPence: 95, returnedCash: [50, 20, 20, 5] });
    expect(getPaymentMethodSummary(refunded)).toMatchObject({ cashRefundCount: 1, cashRefundPence: 95, cashNetRevenuePence: 0 });
  });

  it("sells a returned physical item again, refunds that resale, and rejects every duplicate", () => {
    let state = sale(ready(1));
    const originalItem = state.transactions[0]!.itemIds[0];
    state = refund(state);
    rejected(state, { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "void" });
    state = sale(state);
    expect(state.transactions[1]!.itemIds).toEqual([originalItem]);
    expect(getDaySummary(state)).toMatchObject({ revenuePence: 190, refundPence: 95, netRevenuePence: 95, costOfGoodsPence: 45 });
    rejected(state, { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "return" });
    state = act(state, { type: "REFUND_TRANSACTION", transactionId: "sale-2", reason: "void" });
    expect(getDaySummary(state)).toMatchObject({ refundCount: 2, netRevenuePence: 0, costOfGoodsPence: 0, remainingStockUnits: 1 });
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "SETTLE_DAY" });
    expect(state.settlements[0]).toMatchObject({ refundCount: 2, netRevenuePence: 0 });
    state = act(state, { type: "START_NEXT_DAY" });
    state = sale(state);
    expect(getDaySummary(state)).toMatchObject({ refundCount: 0, netRevenuePence: 95, costOfGoodsPence: 45 });
    expect(state.settlements[0]).toMatchObject({ refundCount: 2, netRevenuePence: 0 });
  });

  it("rejects before departure, during a new visitor, while holding stock, after settlement and on another day", () => {
    const leaving = sale(ready(), false);
    rejected(leaving, { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "return" });
    const complete = act(leaving, { type: "CUSTOMER_ADVANCE" });
    rejected(act(complete, { type: "NEXT_CUSTOMER" }), { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "return" });
    rejected(act(complete, { type: "PICK_CRATE", crateId: "water-crate" }), { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "return" });
    const settled = act(act(complete, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
    rejected(settled, { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "return" });
    rejected(act(settled, { type: "START_NEXT_DAY" }), { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "return" });
  });

  it("rejects a cash refund when current denominations cannot form the amount", () => {
    const drawer = { ...emptyDrawer(), 200: 2, 5: 1 };
    const state = sale(sale(ready(2, drawer)));
    expect(state.cashDrawer).toEqual({ ...emptyDrawer(), 500: 1 });
    expect(getRefundOffer(state, "sale-2").reason).toContain("钱箱");
    rejected(state, { type: "REFUND_TRANSACTION", transactionId: "sale-2", reason: "return" });
  });

  it("rejects insufficient operating funds without moving inventory or denominations", () => {
    let state = sale(ready());
    state = act(state, { type: "PURCHASE_STOCK", orderId: "spend-before-refund", lines: [{ productId: "shampoo", quantity: 6 }] });
    expect(state.cashPence).toBe(65);
    rejected(state, { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "return" });
  });

  it("rejects a return when all display, crate and pending-delivery capacity is occupied", () => {
    let state = sale(ready(4));
    state = act(state, { type: "PURCHASE_STOCK", orderId: "refill-display", lines: [{ productId: "water", quantity: 1 }] });
    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = stockWater(state, 1);
    state = act(state, { type: "PURCHASE_STOCK", orderId: "fill-reserved-box", lines: [{ productId: "water", quantity: 8 }] });
    expect(getRefundOffer(state, "sale-1").reason).toContain("空位");
    rejected(state, { type: "REFUND_TRANSACTION", transactionId: "sale-1", reason: "return" });
  });

  it("rebuilds a safe return crate after recycling without creating another paid recycling reward", () => {
    let state = sale(ready(1));
    state = act(state, { type: "PURCHASE_STOCK", orderId: "shelves-before-return", lines: [{ productId: "water", quantity: 4 }] });
    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = stockWater(state, 4);
    state = act(state, { type: "PICK_CRATE", crateId: "water-crate" });
    state = act(state, { type: "RECYCLE_CRATE" });
    const recyclingIncome = getDaySummary(state).recyclingIncomePence;
    state = refund(state, "sale-1");
    const returned = state.items.find((item) => item.id === state.transactions[0]!.itemIds[0])!;
    expect(returned.location).toEqual({ kind: "crate", crateId: "water-crate" });
    expect(state.crates.some((crate) => crate.id === "water-crate")).toBe(true);
    state = sale(state);
    state = stockWater(state, 1);
    state = act(state, { type: "PICK_CRATE", crateId: "water-crate" });
    state = act(state, { type: "RECYCLE_CRATE" });
    expect(getDaySummary(state).recyclingIncomePence).toBe(recyclingIncome);
  });
});

describe("counted cash audit and freshness", () => {
  it("requires closing and an idle counter, but does not force a count to settle existing flows", () => {
    const initial = createFirstDayState();
    rejected(initial, { type: "RECORD_CASH_COUNT", counts: initial.cashDrawer, note: "" });
    const leaving = act(sale(ready(), false), { type: "CLOSE_STORE" });
    rejected(leaving, { type: "RECORD_CASH_COUNT", counts: leaving.cashDrawer, note: "" });
    const closing = act(leaving, { type: "CUSTOMER_ADVANCE" });
    expect(getCashCountStatus(closing).status).toBe("missing");
    expect(act(closing, { type: "SETTLE_DAY" }).day.phase).toBe("settled");
  });

  it("requires a note for denomination differences even when money totals match", () => {
    const state = act(createFirstDayState(), { type: "CLOSE_STORE" });
    const counts = { ...state.cashDrawer, 1: state.cashDrawer[1] - 2, 2: state.cashDrawer[2] + 1 };
    rejected(state, { type: "RECORD_CASH_COUNT", counts, note: "  " });
    const counted = act(state, { type: "RECORD_CASH_COUNT", counts, note: "  两枚1p被记成一枚2p  " });
    expect(counted.cashDrawer).toEqual(state.cashDrawer);
    expect(counted.cashPence).toBe(state.cashPence);
    expect(getCashCountStatus(counted)).toMatchObject({ status: "current", record: {
      differencePence: 0, denominationDifferences: { 1: -2, 2: 1 }, note: "两枚1p被记成一枚2p",
    } });
  });

  it("records discrepancies without changing balances, then makes old counts stale after a card refund", () => {
    let state = act(sale(ready()), { type: "CLOSE_STORE" });
    const counts = { ...state.cashDrawer, 100: state.cashDrawer[100] - 1 };
    const drawer = structuredClone(state.cashDrawer);
    state = act(state, { type: "RECORD_CASH_COUNT", counts, note: "少一枚£1，待复核" });
    expect(getCashCountStatus(state)).toMatchObject({ status: "current", record: { differencePence: -100 } });
    state = refund(state);
    expect(state.cashDrawer).toEqual(drawer);
    expect(getCashCountStatus(state).status).toBe("stale");
    state = act(state, { type: "RECORD_CASH_COUNT", counts: state.cashDrawer, note: "复核一致" });
    expect(getCashCountStatus(state).status).toBe("current");
    state = act(state, { type: "SETTLE_DAY" });
    expect(getCashCountStatus(state).status).toBe("current");
    expect(getCashCountStatus(act(state, { type: "START_NEXT_DAY" })).status).toBe("missing");
  });
});

describe("v14 audit tamper rejection and exact legacy migration", () => {
  it("migrates v13 receipts, equipment and settled history with zero refund extension", () => {
    const current = act(act(sale(ready()), { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
    const { cashReservePence: _reserve, cashJournal: _journal, ...old } = current;
    const previous = { ...old, schemaVersion: 13, settlements: old.settlements.map(({ refundCount: _count, refundPence: _amount, netRevenuePence: _net, ...summary }) => summary) };
    expect(validateV13SimState(previous)).toBe(true);
    const migrated = migrateV13SimState(previous);
    expect(migrated.transactions).toEqual(current.transactions);
    expect(migrated.cashDrawer).toEqual(current.cashDrawer);
    expect(migrated.equipment).toEqual(current.equipment);
    expect(migrated.cashJournal).toEqual([]);
    expect(migrated.settlements[0]).toMatchObject({ refundCount: 0, refundPence: 0, netRevenuePence: 95 });
    expect(validateV13SimState({ ...previous, cashJournal: [] })).toBe(false);
    expect(validateV13SimState({ ...previous, cashReservePence: 0 })).toBe(false);
  });

  it.each([
    (state: SimState) => { state.cashReservePence += 1; },
    (state: SimState) => { state.cashDrawer[1] += 1; },
    (state: SimState) => { state.cashDrawerOpening[1] += 1; },
    (state: SimState) => { state.cashDrawerTransactionStart = 1; },
    (state: SimState) => { state.cashJournal[0]!.transactionCount = 1; },
    (state: SimState) => { state.cashJournal[0]!.dayNumber = 2; },
    (state: SimState) => { Object.assign(state.cashJournal[0]!, { bogus: 1 }); },
  ])("rejects an altered float baseline, boundary, reserve or audit field %#", (tamper) => {
    const state = act(createFirstDayState(), { type: "CONFIGURE_CASH_FLOAT", drawer: emptyDrawer() });
    tamper(state);
    expect(validateSimState(state)).toBe(false);
  });

  it.each([
    (state: SimState) => { state.cashJournal.push({ ...state.cashJournal[0]!, id: "cash-event-2" }); },
    (state: SimState) => { const event = state.cashJournal[0]!; if (event.kind === "refund") event.amountPence += 1; },
    (state: SimState) => { const event = state.cashJournal[0]!; if (event.kind === "refund") event.paymentMethod = "cash"; },
    (state: SimState) => { state.cashJournal[0]!.transactionCount = 0; },
    (state: SimState) => { state.cashJournal[0]!.transactionCount = 2; },
    (state: SimState) => { state.cashJournal[0]!.dayNumber = 2; },
    (state: SimState) => { state.customer.phase = "leaving"; state.day.nextCustomerAtMs = null; },
  ])("rejects duplicate, forged or reordered refunds %#", (tamper) => {
    const state = refund(sale(ready(1)));
    tamper(state);
    expect(validateSimState(state)).toBe(false);
  });

  it("requires an actual refund event to release an item for resale", () => {
    const state = sale(refund(sale(ready(1))));
    state.cashJournal = [];
    state.cashPence += 95;
    expect(validateSimState(state)).toBe(false);
  });

  it("rejects forged count amounts, missing notes, wrong phase and accessor event entries", () => {
    const valid = act(act(createFirstDayState(), { type: "CLOSE_STORE" }), {
      type: "RECORD_CASH_COUNT", counts: emptyDrawer(), note: "待查" });
    for (const field of ["expectedPence", "countedPence", "differencePence"] as const) {
      const state = structuredClone(valid);
      const record = state.cashJournal[0]!;
      if (record.kind === "count") record[field] += 1;
      expect(validateSimState(state)).toBe(false);
    }
    const missingNote = structuredClone(valid);
    if (missingNote.cashJournal[0]!.kind === "count") missingNote.cashJournal[0]!.note = "";
    expect(validateSimState(missingNote)).toBe(false);
    const early = structuredClone(valid);
    early.day.phase = "preparing"; early.day.closeReason = null;
    expect(validateSimState(early)).toBe(false);
    const getter = structuredClone(valid);
    Object.defineProperty(getter.cashJournal, 0, { enumerable: true, get: () => valid.cashJournal[0] });
    expect(validateCashManagementLedger(getter)).toBe(false);
  });
});
