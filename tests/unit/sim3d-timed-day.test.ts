import { receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { describe, expect, it, vi } from "vitest";
import { asV13CashSnapshot } from "../helpers/sim3dLegacyCash";
import {
  canSettleDay, canStartCustomer, createFirstDayState, getCheckoutTotal, getDaySummary, getDeliverySummary,
  migrateV8SimState, reduceSim, validateSimState, validateV8SimState,
  type ProductId, type SimCommand, type SimState, type SimStateV8,
} from "../../src/sim3d/domain";
import { BUSINESS_DURATION_MS, customerArrivalDelayMs, getBusinessClock } from "../../src/sim3d/businessTime";
import { cashChangeDuePence, cashPiecesForAmount } from "../../src/sim3d/cashPayment";
import { findExactChange } from "../../src/sim3d/cashDrawer";
import {
  SIM_BACKUP_KEY, SIM_STORAGE_KEY, SIM_V8_BACKUP_KEY, SIM_V8_STORAGE_KEY, SIM_WRITER_LOCK,
  SimSaveConflictError, SimSaveSession, loadSimState, parseImportedSimState, saveSimState, type StorageLike,
} from "../../src/sim3d/persistence";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(result.state.revision).toBe(state.revision + 1);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function rejected(state: SimState, command: SimCommand): void {
  const before = structuredClone(state);
  const result = reduceSim(state, command);
  expect(result.changed, command.type).toBe(false);
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}

function stock(state: SimState, productId: ProductId, quantity: number): SimState {
  state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
  for (let slot = 0; slot < quantity; slot += 1) state = act(state, { type: "STOCK", productId, slot });
  return act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position });
}

function stocked(quantity = 4): SimState {
  let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "timed-opening",
    lines: [{ productId: "milk", quantity }, { productId: "bread", quantity }] });
  state = receiveAllDeliveries(state);
  for (const productId of ["milk", "bread"] as const) state = stock(state, productId, quantity);
  return state;
}

function checkout(state: SimState): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  for (let stage = 0; stage < 3; stage += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
    state = act(state, { type: "SCAN", itemId: item.id });
  }
  return state;
}

function pay(state: SimState): SimState {
  if (state.payment?.method === "card") return act(state, { type: "PAY", success: true });
  if (state.payment?.method !== "cash") throw new Error("Expected an active payment");
  if (!state.payment.received) state = act(state, { type: "RECEIVE_CASH" });
  if (state.payment?.method !== "cash") throw new Error("Cash payment lost during receipt");
  if (state.payment.selectedChange.length) state = act(state, { type: "CLEAR_CHANGE" });
  if (state.payment?.method !== "cash") throw new Error("Cash payment lost during selection");
  const changePence = cashChangeDuePence(state.payment, getCheckoutTotal(state));
  const pieces = findExactChange(state.cashDrawer, changePence);
  if (pieces === null) {
    state = act(state, { type: "REQUEST_EXACT_CASH" });
    state = act(state, { type: "RECEIVE_CASH" });
    return act(state, { type: "CONFIRM_CASH" });
  }
  for (const denominationPence of pieces) state = act(state, { type: "ADD_CHANGE", denominationPence });
  return act(state, { type: "CONFIRM_CASH" });
}

function serve(state: SimState): SimState {
  return act(pay(checkout(state)), { type: "CUSTOMER_ADVANCE" });
}

function closedDay(customers = 3): SimState {
  let state = stocked(Math.max(1, customers));
  for (let visit = 0; visit < customers; visit += 1) state = serve(state);
  return act(act(state, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
}

/** Reconstruct the exact pre-clock shape; never merely relabel a current timed snapshot. */
function v8Snapshot(state: SimState): SimStateV8 {
  const {
    renovation: _renovation,
    streetSupportRecords: _streetSupportRecords,
    cashDrawer: _cashDrawer,
    cashDrawerOpening: _cashDrawerOpening,
    cashDrawerTransactionStart: _cashDrawerTransactionStart,
    customer,
    payment,
    transactions,
    settlements,
    day: currentDay,
    ...current
  } = asV13CashSnapshot(state);
  const { contentVersion: _contentVersion, ...oldCustomer } = customer;
  const oldPayment: SimStateV8["payment"] = payment?.method === "cash"
    ? { method: "cash", tenderedPence: payment.tenderedPence, received: payment.received, selectedChange: [...payment.selectedChange] }
    : payment ? { method: "card" } : null;
  const { elapsedOpenMs: _elapsedOpenMs, nextCustomerAtMs: _nextCustomerAtMs, closeReason: _closeReason,
    phase, targetCustomers: _targetCustomers, ...day } = currentDay;
  if (phase === "closing") throw new Error("v8 did not have a closing phase");
  return {
    ...current,
    schemaVersion: 8,
    customer: oldCustomer,
    payment: oldPayment,
    transactions: transactions.map(({
      tenderedCash: _tenderedCash,
      changeCash: _changeCash,
      tenderedCashRecorded: _tenderedCashRecorded,
      changeCashRecorded: _changeCashRecorded,
      cashDrawerTracked: _cashDrawerTracked,
      ...transaction
    }) => transaction),
    day: { ...day, phase, targetCustomers: 3 },
    settlements: settlements.map(({
      targetCustomers: _settlementTarget,
      expansionSpendPence: _expansionSpendPence,
      communitySupportCount: _communitySupportCount,
      communityCashPence: _communityCashPence,
      ...record
    }) => ({ ...record, targetCustomers: 3 })),
  };
}

describe("v9 active-time days and a lightweight clock path", () => {
  it("starts preparation at 08:30 with no customer-count target or running timer", () => {
    const state = createFirstDayState();
    expect(state.schemaVersion).toBe(15);
    expect(state.day).toMatchObject({ phase: "preparing", elapsedOpenMs: 0, nextCustomerAtMs: null, closeReason: null, targetCustomers: null });
    expect(getBusinessClock(state.day).timeLabel).toBe("08:30");
    expect(getDaySummary(state).targetCustomers).toBeNull();
    rejected(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 1_000 });
    rejected(state, { type: "SETTLE_DAY" });
  });

  it("admits the first customer immediately and keeps the fourth paid visit in the same business day", () => {
    let state = stocked();
    for (let visitor = 1; visitor <= 4; visitor += 1) {
      expect(canStartCustomer(state)).toBe(true);
      state = serve(state);
      expect(state.day.phase).toBe("open");
      expect(state.day.elapsedOpenMs).toBe(0);
      expect(getDaySummary(state).paidCustomers).toBe(visitor);
      expect(canSettleDay(state)).toBe(false);
      expect(state.day.nextCustomerAtMs).toBe(customerArrivalDelayMs(state.customerSeed, 1, visitor + 1));
    }
    expect(state.transactions).toHaveLength(4);
    for (const transaction of state.transactions) {
      expect(transaction.cashDrawerTracked).toBe(true);
      expect(transaction.tenderedCashRecorded).toBe(transaction.paymentMethod === "cash");
      expect(transaction.changeCashRecorded).toBe(transaction.paymentMethod === "cash");
    }
    expect(state.customer.number).toBe(4);
    expect(getDaySummary(state)).toMatchObject({ targetCustomers: null, revenuePence: 1_600, costOfGoodsPence: 920, grossProfitPence: 680 });
    expect(canStartCustomer(state)).toBe(false);
    state = act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: BUSINESS_DURATION_MS });
    expect(canSettleDay(state)).toBe(true);
    state = act(state, { type: "SETTLE_DAY" });
    expect(state.settlements[0]).toMatchObject({ paidCustomers: 4, targetCustomers: null, closingCashPence: 1880 });
  });

  it("shallow-copies only clock state while preserving cash, payment and all inventory references", () => {
    const state = checkout(stocked());
    const before = structuredClone(state);
    const clone = vi.spyOn(globalThis, "structuredClone");
    let result;
    try {
      result = reduceSim(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 100.25 });
      expect(clone).not.toHaveBeenCalled();
    } finally { clone.mockRestore() }
    expect(result.changed).toBe(true);
    expect(result.state.day).not.toBe(state.day);
    expect(result.state.day.elapsedOpenMs).toBe(100.25);
    for (const key of ["items", "crates", "customer", "payment", "transactions", "purchases", "settlements", "recyclingBatches", "recyclingRecords"] as const) {
      expect(result.state[key]).toBe(state[key]);
    }
    expect(result.state.cashPence).toBe(state.cashPence);
    expect(state).toEqual(before);
    expect(validateSimState(result.state)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid active-time delta %s without changing the snapshot", (elapsedMs) => {
    rejected(checkout(stocked()), { type: "ADVANCE_BUSINESS_TIME", elapsedMs });
  });

  it("saturates huge finite deltas and produces the same clock for subdivided active steps", () => {
    const state = checkout(stocked());
    let stepped = state;
    for (let step = 0; step < 1_200; step += 1) stepped = reduceSim(stepped, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 30 }).state;
    const single = act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 36_000 });
    expect(stepped.day).toEqual(single.day);
    const closing = act(single, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: Number.MAX_VALUE });
    expect(closing.day).toMatchObject({ elapsedOpenMs: BUSINESS_DURATION_MS, phase: "closing", closeReason: "time", nextCustomerAtMs: null });
    expect(closing.payment).toBe(single.payment);
  });

  it("stops exactly at 19:00 and prevents a last-moment scheduled arrival from entering", () => {
    let state = pay(checkout(stocked(2)));
    state = act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: BUSINESS_DURATION_MS - .5 });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(state.day.nextCustomerAtMs).toBe(BUSINESS_DURATION_MS);
    expect(getBusinessClock(state.day).timeLabel).toBe("18:59");
    state = act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: .5 });
    expect(state.day).toMatchObject({ phase: "closing", closeReason: "time", nextCustomerAtMs: null, elapsedOpenMs: BUSINESS_DURATION_MS });
    expect(getBusinessClock(state.day).timeLabel).toBe("19:00");
    expect(canStartCustomer(state)).toBe(false);
    rejected(state, { type: "NEXT_CUSTOMER" });
    rejected(state, { type: "CLOSE_STORE" });
    rejected(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 2_000 });
  });

  it("keeps clock and arrival progress when shelves are empty, then accepts replenished stock", () => {
    let state = serve(stocked(1));
    const nextCustomerAtMs = state.day.nextCustomerAtMs;
    expect(canStartCustomer(state)).toBe(false);
    state = act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 15_000 });
    expect(state.day.nextCustomerAtMs).toBe(nextCustomerAtMs);
    state = act(state, { type: "PURCHASE_STOCK", orderId: "timed-restock", pairs: 1 });
    state = receiveAllDeliveries(state);
    state = stock(state, "milk", 1);
    state = stock(state, "bread", 1);
    expect(canStartCustomer(state)).toBe(true);
    state = act(state, { type: "NEXT_CUSTOMER" });
    expect(state.day.elapsedOpenMs).toBe(15_000);
    expect(state.day.nextCustomerAtMs).toBeNull();
  });
});

describe("closing, zero-sale days and unfinished work", () => {
  it("allows a zero-sale early close, settles once and carries the same cash into a fresh morning", () => {
    let state = createFirstDayState();
    for (let day = 1; day <= 3; day += 1) {
      state = act(state, { type: "CLOSE_STORE" });
      expect(state.day).toMatchObject({ phase: "closing", elapsedOpenMs: 0, closeReason: "manual", nextCustomerAtMs: null });
      expect(canSettleDay(state)).toBe(true);
      rejected(state, { type: "CLOSE_STORE" });
      state = act(state, { type: "SETTLE_DAY" });
      expect(state.settlements).toHaveLength(day);
      expect(state.settlements.at(-1)).toMatchObject({ targetCustomers: null, paidCustomers: 0, revenuePence: 0, closingCashPence: 1200 });
      expect(state.transactions).toHaveLength(0);
      rejected(state, { type: "SETTLE_DAY" });
      rejected(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 700 });
      state = act(state, { type: "START_NEXT_DAY" });
      expect(state.day).toMatchObject({ number: day + 1, phase: "preparing", elapsedOpenMs: 0, closeReason: null, nextCustomerAtMs: null });
      expect(state.cashPence).toBe(1200);
    }
  });

  it("preserves a current cash payment across automatic close and books the sale only after correct change", () => {
    let state = checkout(serve(stocked(2)));
    expect(state.payment?.method).toBe("cash");
    state = act(state, { type: "RECEIVE_CASH" });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 50 });
    const pending = structuredClone(state);
    state = act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: BUSINESS_DURATION_MS });
    expect(state.payment).toEqual(pending.payment);
    expect(state.cashPence).toBe(pending.cashPence);
    expect(state.transactions).toEqual(pending.transactions);
    expect(canSettleDay(state)).toBe(false);
    rejected(state, { type: "SETTLE_DAY" });
    rejected(state, { type: "CONFIRM_CASH" });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 50 });
    state = act(state, { type: "CONFIRM_CASH" });
    expect(state.cashPence).toBe(pending.cashPence + 400);
    expect(state.payment).toBeNull();
    expect(canSettleDay(state)).toBe(false);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(state.day.nextCustomerAtMs).toBeNull();
    state = act(state, { type: "SETTLE_DAY" });
    expect(state.settlements[0]).toMatchObject({ paidCustomers: 2, targetCustomers: null, revenuePence: 800 });
    rejected(state, { type: "CONFIRM_CASH" });
  });

  it("allows a last customer to finish shopping and card payment after an early close", () => {
    let state = act(stocked(1), { type: "OPEN_STORE" });
    state = act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 36_000 });
    state = act(state, { type: "CLOSE_STORE" });
    expect(state.customer.phase).toBe("to-milk");
    expect(getBusinessClock(state.day).timeLabel).toBe("09:30");
    for (let stage = 0; stage < 3; stage += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
    state = act(pay(state), { type: "CUSTOMER_ADVANCE" });
    expect(state.day.elapsedOpenMs).toBe(36_000);
    expect(state.day.nextCustomerAtMs).toBeNull();
    state = act(state, { type: "SETTLE_DAY" });
    expect(getBusinessClock(state.day).timeLabel).toBe("09:30");
    expect(state.settlements[0]?.paidCustomers).toBe(1);
  });

  it("can cancel after closing without charging tentative cash or losing unpurchased goods", () => {
    let state = checkout(serve(stocked(2)));
    state = act(state, { type: "RECEIVE_CASH" });
    const cash = state.cashPence;
    const ids = state.items.map((item) => item.id);
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "CANCEL_CUSTOMER" });
    expect(state.payment).toBeNull();
    expect(state.cashPence).toBe(cash);
    expect(state.items.map((item) => item.id)).toEqual(ids);
    expect(state.items.filter((item) => item.location.kind === "shelf")).toHaveLength(2);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    state = act(state, { type: "SETTLE_DAY" });
    expect(state.settlements[0]?.paidCustomers).toBe(1);
  });

  it("blocks new purchases after close but signs for existing paid deliveries before a zero-sale day-end", () => {
    let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "closing-delivery", pairs: 1 });
    const cash = state.cashPence;
    state = act(state, { type: "CLOSE_STORE" });
    expect(canSettleDay(state)).toBe(false);
    rejected(state, { type: "PURCHASE_STOCK", orderId: "too-late", pairs: 1 });
    rejected(state, { type: "SETTLE_DAY" });
    rejected(state, { type: "START_NEXT_DAY" });
    state = receiveAllDeliveries(state);
    expect(state.cashPence).toBe(cash);
    expect(getDeliverySummary(state)).toMatchObject({ pendingOrders: 0, receivedToday: 1 });
    state = act(state, { type: "SETTLE_DAY" });
    const goods = structuredClone(state.items);
    state = act(state, { type: "START_NEXT_DAY" });
    expect(state.items).toEqual(goods);
    expect(state.cashPence).toBe(cash);
    expect(getDaySummary(state).remainingStockUnits).toBe(2);
    expect(getDeliverySummary(state).receivedToday).toBe(0);
  });

  it("does not allow invalid live clocks or inconsistent pending-arrival states into a v9 snapshot", () => {
    const state = serve(stocked(2));
    for (const override of [
      { elapsedOpenMs: NaN }, { elapsedOpenMs: Infinity }, { elapsedOpenMs: -1 }, { elapsedOpenMs: BUSINESS_DURATION_MS },
      { nextCustomerAtMs: null }, { nextCustomerAtMs: NaN }, { nextCustomerAtMs: -1 }, { nextCustomerAtMs: BUSINESS_DURATION_MS + 1 },
      { targetCustomers: 3 }, { closeReason: "manual" },
      { phase: "closing", closeReason: "time", elapsedOpenMs: BUSINESS_DURATION_MS - 1, nextCustomerAtMs: null },
      { phase: "closing", closeReason: "legacy", elapsedOpenMs: 0, nextCustomerAtMs: null },
    ]) expect(validateSimState({ ...state, day: { ...state.day, ...override } }), JSON.stringify(override)).toBe(false);
    const active = checkout(state);
    expect(validateSimState({ ...active, day: { ...active.day, nextCustomerAtMs: 1_000 } })).toBe(false);
  });
});

describe("strict v8 migration and persisted business time", () => {
  it("preserves the complete clock and the next-arrival appointment across save, load and file import", () => {
    let state = serve(stocked(2));
    state = act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 2345.75 });
    const storage = new MemoryStorage();
    saveSimState(state, storage);
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v15");
    expect(SIM_WRITER_LOCK).toBe("english-high-street:sim3d:v4:writer");
    expect(loadSimState(storage)).toEqual({ source: "primary", state });
    expect(parseImportedSimState(JSON.stringify(state))).toEqual(state);
    expect(state.day.elapsedOpenMs).toBe(2345.75);
  });

  it("keeps an old cash customer's exact partial change and all money without inventing elapsed time", () => {
    let current = checkout(serve(stocked(3)));
    current = act(current, { type: "RECEIVE_CASH" });
    current = act(current, { type: "ADD_CHANGE", denominationPence: 50 });
    const old = v8Snapshot(current);
    expect(validateV8SimState(old)).toBe(true);
    const before = structuredClone(old);
    const migrated = migrateV8SimState(old);
    expect(old).toEqual(before);
    expect(migrated.day).toMatchObject({ phase: "open", targetCustomers: null, elapsedOpenMs: 0, nextCustomerAtMs: null, closeReason: null });
    for (const key of ["items", "purchases", "recyclingBatches", "recyclingRecords"] as const) expect(migrated[key]).toEqual(old[key]);
    expect(migrated.payment).toEqual(old.payment?.method === "cash"
      ? { ...old.payment, tenderedCash: cashPiecesForAmount(old.payment.tenderedPence), tenderedCashRecorded: false }
      : old.payment);
    expect(migrated.transactions).toEqual(old.transactions.map((transaction) => ({
      ...transaction,
      tenderedCash: transaction.paymentMethod === "cash" ? cashPiecesForAmount(transaction.tenderedPence) : [],
      changeCash: transaction.paymentMethod === "cash" && transaction.changePence > 0 ? cashPiecesForAmount(transaction.changePence) : [],
      tenderedCashRecorded: false,
      changeCashRecorded: false,
      cashDrawerTracked: false,
    })));
    expect(migrated.settlements).toEqual(old.settlements.map((record) => ({
      ...record, expansionSpendPence: 0, communitySupportCount: 0, communityCashPence: 0,
    })));
    expect(migrated.cashDrawerTransactionStart).toBe(old.transactions.length);
    expect(migrated.cashDrawerOpening).toEqual(migrated.cashDrawer);
    expect(migrated.cashPence).toBe(old.cashPence);
    expect(parseImportedSimState(JSON.stringify(old))).toEqual(migrated);
    let paid = act(migrated, { type: "CLOSE_STORE" });
    paid = act(paid, { type: "ADD_CHANGE", denominationPence: 50 });
    paid = act(paid, { type: "CONFIRM_CASH" });
    expect(paid.cashPence).toBe(old.cashPence + 400);
    expect(paid.transactions.at(-1)).toMatchObject({
      paymentMethod: "cash", tenderedCashRecorded: false, changeCashRecorded: true, cashDrawerTracked: true,
    });
  });

  it("resumes a completed old three-sale day at 09:00 and schedules the fourth visit", () => {
    let current = stocked(4);
    for (let count = 0; count < 3; count += 1) current = serve(current);
    const old = v8Snapshot(current);
    expect(validateV8SimState(old)).toBe(true);
    const migrated = migrateV8SimState(old);
    expect(migrated.day).toMatchObject({ phase: "open", elapsedOpenMs: 0, targetCustomers: null, closeReason: null,
      nextCustomerAtMs: customerArrivalDelayMs(old.customerSeed, old.day.number, old.customer.number + 1) });
    expect(canStartCustomer(migrated)).toBe(true);
    expect(serve(migrated).transactions).toHaveLength(4);
  });

  it("preserves old settled targets through later recycling, expansion and a following zero-sale timed day", () => {
    const old = v8Snapshot(closedDay(3));
    expect(validateV8SimState(old)).toBe(true);
    let state = migrateV8SimState(old);
    expect(state.day).toMatchObject({ phase: "settled", closeReason: "legacy", elapsedOpenMs: 0, targetCustomers: null });
    expect(state.settlements).toEqual(old.settlements.map((record) => ({
      ...record, expansionSpendPence: 0, communitySupportCount: 0, communityCashPence: 0,
      refundCount: 0, refundPence: 0, netRevenuePence: record.revenuePence,
    })));
    expect(getDaySummary(state).targetCustomers).toBeNull();
    rejected(state, { type: "SETTLE_DAY" });
    state = act(state, { type: "BUY_UPGRADE" });
    state = act(state, { type: "PICK_CRATE", crateId: "milk-crate" });
    state = act(state, { type: "RECYCLE_CRATE" });
    expect(state.settlements[0]).toMatchObject({ targetCustomers: 3, paidCustomers: 3, upgradeSpendPence: 800, recycledCrates: 1, recyclingIncomePence: 5 });
    const historical = structuredClone(state.settlements[0]);
    state = act(state, { type: "START_NEXT_DAY" });
    state = act(act(state, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
    expect(state.settlements[0]).toEqual(historical);
    expect(state.settlements[1]).toMatchObject({ targetCustomers: null, paidCustomers: 0 });
    expect(validateSimState({ ...state, day: { ...state.day, closeReason: "legacy" } })).toBe(false);
  });

  it("rejects a fabricated fourth old sale, an old under-target settlement and an altered old target", () => {
    let four = stocked(4);
    for (let count = 0; count < 4; count += 1) four = serve(four);
    const invalid = [
      v8Snapshot(four),
      v8Snapshot(closedDay(2)),
      { ...v8Snapshot(closedDay(3)), settlements: closedDay(3).settlements },
      { ...v8Snapshot(stocked()), cashPence: 9_999 },
    ];
    for (const old of invalid) {
      expect(validateV8SimState(old)).toBe(false);
      expect(() => migrateV8SimState(old)).toThrow("校验失败");
      expect(() => parseImportedSimState(JSON.stringify(old))).toThrow("校验未通过");
    }
    const timed = closedDay(4);
    const relabelled = { ...timed, day: { ...timed.day, closeReason: "legacy" },
      settlements: timed.settlements.map((record) => ({ ...record, targetCustomers: 3 })) };
    expect(validateSimState(relabelled)).toBe(false);
  });

  it("prefers current backup, then v8 backup, and preserves every old source while warning about missing clocks", () => {
    const old = v8Snapshot(serve(stocked(2)));
    const storage = new MemoryStorage();
    storage.setItem(SIM_STORAGE_KEY, "{corrupt-v14");
    storage.setItem(SIM_V8_STORAGE_KEY, "{corrupt-v8");
    storage.setItem(SIM_V8_BACKUP_KEY, JSON.stringify(old, null, 2));
    const before = [...storage.values];
    const migrated = loadSimState(storage);
    expect(migrated.source).toBe("v8-backup");
    expect(migrated.warning).toContain("09:00");
    expect(migrated.warning).toContain("旧档未记录营业时间");
    expect([...storage.values]).toEqual(before);
    const current = act(migrated.state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 777.5 });
    storage.setItem(SIM_BACKUP_KEY, JSON.stringify(current));
    expect(loadSimState(storage)).toMatchObject({ source: "backup", state: current });
    saveSimState(current, storage);
    expect(loadSimState(storage)).toMatchObject({ source: "primary", state: current });
    expect(storage.getItem(SIM_V8_STORAGE_KEY)).toBe("{corrupt-v8");
    expect(storage.getItem(SIM_V8_BACKUP_KEY)).toBe(JSON.stringify(old, null, 2));
  });

  it("protects the old v8 migration source from concurrent-tab writes before the first v9 save", async () => {
    const storage = new MemoryStorage();
    const old = v8Snapshot(stocked());
    storage.setItem(SIM_V8_STORAGE_KEY, JSON.stringify(old));
    const session = new SimSaveSession(storage, null);
    expect(await session.acquire()).toBe(true);
    const state = session.load().state;
    storage.setItem(SIM_V8_STORAGE_KEY, JSON.stringify({ ...old, revision: old.revision + 1 }));
    expect(() => session.save(state)).toThrow(SimSaveConflictError);
    expect(session.canWrite).toBe(false);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    await session.release();
  });
});
