import { receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTS, SAFE_DROP_POINTS, capacityFor, countAt, createFirstDayState, getCheckoutTotal, getDaySummary,
  getPaymentMethodSummary, reduceSim, validateSimState, type ProductId, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import {
  CASH_DENOMINATIONS_PENCE, MAX_CHANGE_PIECES, cashChangeDuePence, cashPiecesForAmount,
} from "../../src/sim3d/cashPayment";
import { cashDrawerValuePence } from "../../src/sim3d/cashDrawer";

function apply(state: SimState, command: SimCommand) {
  return reduceSim(state, command);
}

function act(state: SimState, command: SimCommand): SimState {
  const result = apply(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(result.state.revision).toBe(state.revision + 1);
  expect(validateSimState(JSON.parse(JSON.stringify(result.state)))).toBe(true);
  return result.state;
}

function expectRejected(state: SimState, command: SimCommand): void {
  const before = structuredClone(state);
  const result = apply(state, command);
  expect(result.changed, command.type).toBe(false);
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}

function stock(state: SimState, productId: ProductId, quantity: number): SimState {
  state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
  for (let index = 0; index < quantity; index += 1) {
    const slot = Array.from({ length: capacityFor(state) }, (_, candidate) => candidate).find((candidate) => !state.items.some((item) =>
      item.location.kind === "shelf" && item.productId === productId && item.location.slot === candidate))!;
    state = act(state, { type: "STOCK", productId, slot });
  }
  return act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position });
}

function stocked(products: ProductId[] = ["milk", "cheese"], quantity = 2): SimState {
  let state = createFirstDayState();
  state = act(state, { type: "PURCHASE_STOCK", orderId: "cash-fixture", lines: products.map((productId) => ({ productId, quantity })) });
  state = receiveAllDeliveries(state);
  for (const product of products) state = stock(state, product, quantity);
  return state;
}

function arrive(state: SimState): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  for (let step = 0; step < 3 && state.customer.phase !== "checkout"; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
  expect(state.customer.phase).toBe("checkout");
  return state;
}

function scan(state: SimState): SimState {
  for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout" && !state.scannedIds.includes(candidate.id))) {
    state = act(state, { type: "SCAN", itemId: item.id });
  }
  return state;
}

function cashCheckout(products: ProductId[] = ["milk", "cheese"], quantity = 2): SimState {
  let state = scan(arrive(stocked(products, quantity)));
  expect(state.payment).toEqual({ method: "card" });
  state = act(state, { type: "PAY", success: true });
  state = act(state, { type: "CUSTOMER_ADVANCE" });
  state = arrive(state);
  expect(state.customer.number).toBe(2);
  expect(state.payment?.method).toBe("cash");
  return state;
}

function finishCash(state: SimState, selection?: number[]): SimState {
  state = scan(state);
  state = act(state, { type: "RECEIVE_CASH" });
  if (state.payment?.method !== "cash") throw new Error("Expected a cash visitor");
  let due = cashChangeDuePence(state.payment, getCheckoutTotal(state));
  const pieces = selection ?? [];
  if (!selection) for (const denomination of [...CASH_DENOMINATIONS_PENCE].reverse()) {
    while (due >= denomination) { pieces.push(denomination); due -= denomination }
  }
  for (const denominationPence of pieces) state = act(state, { type: "ADD_CHANGE", denominationPence });
  return act(state, { type: "CONFIRM_CASH" });
}

function forceFivePoundCash(state: SimState): SimState {
  const copy = structuredClone(state);
  copy.payment = {
    method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true,
    received: false, selectedChange: [],
  };
  expect(validateSimState(copy)).toBe(true);
  return copy;
}

/** Three real 95p cash sales consume every sub-50p coin except 20p + 20p + 5p. */
function changeShortageCheckout(): SimState {
  let state = stocked(["water"], 3);
  const depletion: number[][] = [
    [100, ...Array(6).fill(50), 5],
    [...Array(4).fill(50), ...Array(10).fill(20), 5],
    [...Array(3).fill(20), ...Array(20).fill(10), ...Array(17).fill(5), ...Array(20).fill(2), ...Array(20).fill(1)],
  ];
  for (const selection of depletion) {
    state = forceFivePoundCash(arrive(state));
    state = finishCash(state, selection);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
  }
  expect(state.cashDrawer[50]).toBe(0);
  expect(state.cashDrawer[20]).toBe(2);
  expect(state.cashDrawer[5]).toBe(1);
  state = act(state, { type: "PURCHASE_STOCK", orderId: "cash-shortage-target", lines: [
    { productId: "milk", quantity: 1 }, { productId: "cheese", quantity: 1 },
  ] });
  state = receiveAllDeliveries(state);
  state = stock(state, "milk", 1);
  state = stock(state, "cheese", 1);
  state = forceFivePoundCash(arrive(state));
  expect(getCheckoutTotal(state)).toBe(435);
  return scan(state);
}

describe("cash payment domain lifecycle and atomic settlement", () => {
  it("freezes the method on entry while keeping the original shopping list, models and inventory choice independent", () => {
    let state = stocked();
    expect(state.schemaVersion).toBe(15);
    expect(state.payment).toBeNull();
    state = act(state, { type: "OPEN_STORE" });
    expect(state.payment).toEqual({ method: "card" });
    expect(state.customer.shoppingList).toEqual(["milk", "cheese"]);
    state = act(state, { type: "CANCEL_CUSTOMER" });
    expect(state.payment).toBeNull();
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    state = act(state, { type: "NEXT_CUSTOMER" });
    const payment = structuredClone(state.payment);
    expect(payment).toEqual({ method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: false, selectedChange: [] });
    state = act(state, { type: "INSPECT", productId: "milk" });
    for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(state.payment).toEqual(payment);
    expect(state.customer.shoppingList).toEqual(["milk", "cheese"]);
  });

  it("requires all scans and receipt of cash, and rejects the old PAY path for a cash visitor", () => {
    let state = cashCheckout();
    for (const command of [
      { type: "PAY", success: true }, { type: "RECEIVE_CASH" }, { type: "CONFIRM_CASH" },
      { type: "ADD_CHANGE", denominationPence: 50 },
    ] satisfies SimCommand[]) expectRejected(state, command);
    const item = state.items.find((candidate) => candidate.location.kind === "checkout")!;
    state = act(state, { type: "SCAN", itemId: item.id });
    expectRejected(state, { type: "RECEIVE_CASH" });
    state = scan(state);
    expectRejected(state, { type: "CONFIRM_CASH" });
    expectRejected(state, { type: "ADD_CHANGE", denominationPence: 50 });
    expectRejected(state, { type: "PAY", success: true });
    state = act(state, { type: "RECEIVE_CASH" });
    expectRejected(state, { type: "RECEIVE_CASH" });
    expectRejected(state, { type: "PAY", success: true });
  });

  it("keeps cash, revenue and sold goods unchanged until one correct confirmation commits them together", () => {
    let state = scan(cashCheckout());
    const before = structuredClone(state);
    const drawerBefore = structuredClone(state.cashDrawer);
    const checkoutIds = state.items.filter((item) => item.location.kind === "checkout").map((item) => item.id);
    expect(getCheckoutTotal(state)).toBe(435);
    state = act(state, { type: "RECEIVE_CASH" });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 50 });
    expect(state.cashPence).toBe(before.cashPence);
    expect(state.transactions).toEqual(before.transactions);
    expect(state.items).toEqual(before.items);
    expectRejected(state, { type: "CONFIRM_CASH" });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 20 });
    expectRejected(state, { type: "CONFIRM_CASH" });
    state = act(state, { type: "REMOVE_CHANGE", index: 1 });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 10 });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 5 });
    state = act(state, { type: "CONFIRM_CASH" });
    expect(state.cashPence).toBe(before.cashPence + 435);
    expect(state.transactions).toHaveLength(before.transactions.length + 1);
    expect(state.transactions.at(-1)).toEqual({
      id: "sale-2", customerNumber: 2, itemIds: checkoutIds, amountPence: 435,
      paymentMethod: "cash", tenderedPence: 500, changePence: 65,
      tenderedCash: [500], changeCash: [50, 10, 5], tenderedCashRecorded: true, changeCashRecorded: true,
      cashDrawerTracked: true,
    });
    expect(state.cashDrawer).toEqual({ ...drawerBefore, 5: drawerBefore[5] - 1, 10: drawerBefore[10] - 1,
      50: drawerBefore[50] - 1, 500: drawerBefore[500] + 1 });
    expect(cashDrawerValuePence(state.cashDrawer) - cashDrawerValuePence(drawerBefore)).toBe(435);
    expect(state.items.filter((item) => checkoutIds.includes(item.id)).every((item) => item.location.kind === "sold" && item.location.transactionId === "sale-2")).toBe(true);
    expect(state.scannedIds).toEqual([]);
    expect(state.customer.phase).toBe("leaving");
    expect(state.payment).toBeNull();
    expect(getDaySummary(state).revenuePence - getDaySummary(before).revenuePence).toBe(435);
    for (const command of [{ type: "CONFIRM_CASH" }, { type: "PAY", success: true }, { type: "CANCEL_CUSTOMER" }] satisfies SimCommand[]) expectRejected(state, command);
  });

  it.each([[50, 10, 5], [20, 20, 20, 5], [50, 10, 2, 2, 1]])("accepts a non-prescribed correct change combination %j", (...selection) => {
    const state = finishCash(cashCheckout(), selection);
    expect(state.transactions.at(-1)?.changePence).toBe(65);
    expect(state.payment).toBeNull();
  });

  it.each([
    { products: ["water"] as ProductId[], amount: 95, tender: 500, pieces: [200, 200, 5] },
    { products: ["coffee", "shampoo"] as ProductId[], amount: 740, tender: 1000, pieces: [200, 50, 10] },
  ])("settles the actual one- or two-item basket at $amount pence", ({ products, amount, tender, pieces }) => {
    const before = cashCheckout(products);
    const paid = finishCash(before, pieces);
    expect(paid.cashPence - before.cashPence).toBe(amount);
    expect(paid.transactions.at(-1)).toMatchObject({ amountPence: amount, tenderedPence: tender, changePence: tender - amount });
  });

  it("handles a valid exact-cash exercise without inventing a change requirement", () => {
    let state = scan(cashCheckout());
    state.payment = {
      method: "cash", tenderedPence: 435, tenderedCash: cashPiecesForAmount(435), tenderedCashRecorded: true,
      received: false, selectedChange: [],
    };
    expect(validateSimState(state)).toBe(true);
    expectRejected(state, { type: "CONFIRM_CASH" });
    state = act(state, { type: "RECEIVE_CASH" });
    const paid = act(state, { type: "CONFIRM_CASH" });
    expect(paid.transactions.at(-1)).toMatchObject({ amountPence: 435, tenderedPence: 435, changePence: 0 });
  });

  it("rejects cash operations for a card visitor and preserves failed card payment behavior", () => {
    let state = scan(arrive(stocked()));
    for (const command of [
      { type: "RECEIVE_CASH" }, { type: "ADD_CHANGE", denominationPence: 50 }, { type: "REMOVE_CHANGE", index: 0 },
      { type: "CLEAR_CHANGE" }, { type: "CONFIRM_CASH" }, { type: "PAY", success: false },
    ] satisfies SimCommand[]) expectRejected(state, command);
    state = act(state, { type: "PAY", success: true });
    expect(state.transactions[0]).toMatchObject({ paymentMethod: "card", tenderedPence: 435, changePence: 0 });
    expect(state.payment).toBeNull();
  });

  it("validates denomination and removal commands, limits payload growth, and resets a wrong selection safely", () => {
    let state = act(scan(cashCheckout()), { type: "RECEIVE_CASH" });
    for (const denominationPence of [0, -5, .5, 3, 25, 2000, NaN, Infinity]) expectRejected(state, { type: "ADD_CHANGE", denominationPence });
    for (const index of [0, -1, .5, NaN, Infinity]) expectRejected(state, { type: "REMOVE_CHANGE", index });
    expectRejected(state, { type: "CLEAR_CHANGE" });
    let selectedPieces = 0;
    for (const denominationPence of CASH_DENOMINATIONS_PENCE) {
      for (let piece = 0; piece < state.cashDrawer[denominationPence] && selectedPieces < MAX_CHANGE_PIECES; piece += 1) {
        state = act(state, { type: "ADD_CHANGE", denominationPence });
        selectedPieces += 1;
      }
    }
    expect(state.payment?.method === "cash" ? state.payment.selectedChange : []).toHaveLength(MAX_CHANGE_PIECES);
    expectRejected(state, { type: "ADD_CHANGE", denominationPence: 50 });
    state = act(state, { type: "CLEAR_CHANGE" });
    expect(state.payment).toEqual({ method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: true, selectedChange: [] });
    expectRejected(state, { type: "CONFIRM_CASH" });
  });

  it("never lets one denomination selection exceed the finite drawer inventory", () => {
    let state = changeShortageCheckout();
    state = act(state, { type: "RECEIVE_CASH" });
    expectRejected(state, { type: "ADD_CHANGE", denominationPence: 50 });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 20 });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 20 });
    expectRejected(state, { type: "ADD_CHANGE", denominationPence: 20 });
    expect(state.payment).toMatchObject({ method: "cash", selectedChange: [20, 20] });
    expect(state.cashDrawer[20]).toBe(2);
  });

  it("returns tentative cash and requests exact money when the drawer cannot make change", () => {
    let state = changeShortageCheckout();
    expect(validateSimState(state)).toBe(true);
    const before = structuredClone(state);
    state = act(state, { type: "RECEIVE_CASH" });
    state = act(state, { type: "REQUEST_EXACT_CASH" });
    expect(state.payment).toEqual({
      method: "cash", tenderedPence: 435, tenderedCash: [200, 200, 20, 10, 5], tenderedCashRecorded: true,
      received: false, selectedChange: [],
    });
    expect(state.cashPence).toBe(before.cashPence);
    expect(state.cashDrawer).toEqual(before.cashDrawer);
    expect(state.transactions).toEqual(before.transactions);
    expect(state.items).toEqual(before.items);
    state = act(state, { type: "RECEIVE_CASH" });
    state = act(state, { type: "CONFIRM_CASH" });
    expect(state.cashPence).toBe(before.cashPence + 435);
    expect(state.transactions.at(-1)).toMatchObject({
      paymentMethod: "cash", tenderedPence: 435, changePence: 0,
      tenderedCash: [200, 200, 20, 10, 5], changeCash: [], tenderedCashRecorded: true, changeCashRecorded: true,
      cashDrawerTracked: true,
    });
  });

  it("returns tentative cash and switches the same unpaid basket to card when change is impossible", () => {
    let state = changeShortageCheckout();
    const before = structuredClone(state);
    state = act(state, { type: "RECEIVE_CASH" });
    state = act(state, { type: "SWITCH_CASH_TO_CARD" });
    expect(state.payment).toEqual({ method: "card" });
    expect(state.cashPence).toBe(before.cashPence);
    expect(state.cashDrawer).toEqual(before.cashDrawer);
    expect(state.transactions).toEqual(before.transactions);
    expect(state.items).toEqual(before.items);
    state = act(state, { type: "PAY", success: true });
    expect(state.cashPence).toBe(before.cashPence + 435);
    expect(state.cashDrawer).toEqual(before.cashDrawer);
    expect(state.transactions.at(-1)).toMatchObject({
      paymentMethod: "card", tenderedPence: 435, changePence: 0, tenderedCash: [], changeCash: [],
      tenderedCashRecorded: false, changeCashRecorded: false, cashDrawerTracked: true,
    });
  });

  it("rejects both shortage fallbacks while the drawer can still make the required change", () => {
    const state = act(scan(cashCheckout()), { type: "RECEIVE_CASH" });
    expectRejected(state, { type: "REQUEST_EXACT_CASH" });
    expectRejected(state, { type: "SWITCH_CASH_TO_CARD" });
  });

  it("derives the current-day cash and card split from the committed ledger", () => {
    const state = finishCash(cashCheckout());
    expect(getPaymentMethodSummary(state)).toEqual({
      cashTransactions: 1, cardTransactions: 1, cashRevenuePence: 435, cardRevenuePence: 435,
      cashRefundCount: 0, cardRefundCount: 0, cashRefundPence: 0, cardRefundPence: 0,
      cashNetRevenuePence: 435, cardNetRevenuePence: 435,
    });
    expect(getDaySummary(state).revenuePence).toBe(870);
  });

  it.each([false, true])("cancels pending cash with receipt=%s without increasing money or keeping change selection", (received) => {
    let state = scan(cashCheckout());
    if (received) {
      state = act(state, { type: "RECEIVE_CASH" });
      state = act(state, { type: "ADD_CHANGE", denominationPence: 50 });
    }
    const before = structuredClone(state);
    state = act(state, { type: "CANCEL_CUSTOMER" });
    expect(state.cashPence).toBe(before.cashPence);
    expect(state.transactions).toEqual(before.transactions);
    expect(state.payment).toBeNull();
    expect(state.scannedIds).toEqual([]);
    expect(state.items.filter((item) => item.location.kind === "checkout" || item.location.kind === "basket")).toEqual([]);
    expect(state.customer.phase).toBe("leaving");
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    state = act(state, { type: "NEXT_CUSTOMER" });
    if (state.payment?.method === "cash") expect(state.payment).toMatchObject({ received: false, selectedChange: [] });
  });

  it("keeps the entire pending cash transaction if a return location is temporarily unavailable", () => {
    let state = act(scan(cashCheckout()), { type: "RECEIVE_CASH" });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 50 });
    state = act(state, { type: "PURCHASE_STOCK", orderId: "refill-during-cash", lines: [{ productId: "milk", quantity: 4 }] });
    state = receiveAllDeliveries(state);
    state = stock(state, "milk", 4);
    state = act(state, { type: "PICK_CRATE", crateId: "milk-crate" });
    state = act(state, { type: "RECYCLE_CRATE" });
    expect(countAt(state, "milk", "shelf")).toBe(4);
    expect(state.crates.some((crate) => crate.productId === "milk")).toBe(false);
    expect(validateSimState(state)).toBe(true);
    // Fault injection models return-space exhaustion without fabricating invalid inventory.
    const unavailable = vi.spyOn(SAFE_DROP_POINTS, "find").mockReturnValue(undefined);
    try { expectRejected(state, { type: "CANCEL_CUSTOMER" }) }
    finally { unavailable.mockRestore() }
    expect(state.payment).toEqual({ method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: true, selectedChange: [50] });
    const cancelled = act(state, { type: "CANCEL_CUSTOMER" });
    expect(cancelled.cashPence).toBe(state.cashPence);
    expect(cancelled.payment).toBeNull();
  });

  it("does not carry payment state into day settlement, the next day or a new game", () => {
    let state = act(finishCash(cashCheckout(["milk", "bread"], 3)), { type: "CUSTOMER_ADVANCE" });
    state = arrive(state);
    state = state.payment?.method === "cash" ? finishCash(state) : act(scan(state), { type: "PAY", success: true });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(state.payment).toBeNull();
    expect(getDaySummary(state).paidCustomers).toBe(3);
    const balance = state.cashPence;
    expect(reduceSim(state, { type: "SETTLE_DAY" }).state).toBe(state);
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "SETTLE_DAY" });
    expect(state.payment).toBeNull();
    expect(state.cashPence).toBe(balance);
    state = act(state, { type: "START_NEXT_DAY" });
    expect(state.payment).toBeNull();
    expect(state.customer).toMatchObject({ phase: "outside", shoppingList: [] });
    expect(state.cashPence).toBe(balance);
    expect((createFirstDayState()).payment).toBeNull();
  });
});

describe("payment state and ledger tamper rejection", () => {
  it.each([
    ["missing method", (state: SimState) => { state.payment = null }],
    ["insufficient tender", (state: SimState) => { state.payment = { method: "cash", tenderedPence: 434, tenderedCash: cashPiecesForAmount(434), tenderedCashRecorded: true, received: false, selectedChange: [] } }],
    ["change before receipt", (state: SimState) => { state.payment = { method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: false, selectedChange: [50] } }],
    ["receipt before scanning", (state: SimState) => { state.payment = { method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: true, selectedChange: [] } }],
    ["tender piece mismatch", (state: SimState) => { state.payment = { method: "cash", tenderedPence: 500, tenderedCash: [200, 200], tenderedCashRecorded: true, received: false, selectedChange: [] } }],
    ["tentative cash added to funds", (state: SimState) => { state.cashPence += 500 }],
  ] as const)("rejects %s", (_name, mutate) => {
    const state = cashCheckout();
    mutate(state);
    expect(validateSimState(state)).toBe(false);
  });

  it("rejects lingering payment outside a live visit and received money while still shopping", () => {
    const initial = stocked();
    initial.payment = { method: "card" };
    expect(validateSimState(initial)).toBe(false);
    const state = cashCheckout();
    state.customer.phase = "to-checkout";
    for (const item of state.items) if (item.location.kind === "checkout") item.location = { kind: "basket" };
    state.payment = { method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: true, selectedChange: [] };
    expect(validateSimState(state)).toBe(false);
    const paid = finishCash(cashCheckout());
    paid.payment = { method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: true, selectedChange: [50, 10, 5] };
    expect(validateSimState(paid)).toBe(false);
  });

  it("rejects a forged derived tender and over-reserved change in a new v14 payment", () => {
    const derived = scan(cashCheckout());
    derived.payment = {
      method: "cash", tenderedPence: 500, tenderedCash: [200, 200, 100], tenderedCashRecorded: false,
      received: true, selectedChange: [50, 10, 5],
    };
    expect(validateSimState(derived)).toBe(false);

    const overReserved = scan(cashCheckout());
    overReserved.payment = {
      method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true,
      received: true, selectedChange: Array.from({ length: overReserved.cashDrawer[1] + 1 }, () => 1),
    };
    expect(validateSimState(overReserved)).toBe(false);
  });

  it.each([
    ["short change", (state: SimState) => { state.transactions.at(-1)!.changePence = 64 }],
    ["fractional tender", (state: SimState) => { state.transactions.at(-1)!.tenderedPence = 500.5 }],
    ["underpaid tender", (state: SimState) => { state.transactions.at(-1)!.tenderedPence = 434 }],
    ["cash relabelled card", (state: SimState) => { state.transactions.at(-1)!.paymentMethod = "card" }],
    ["cash pieces do not match tender", (state: SimState) => { state.transactions.at(-1)!.tenderedCash = [200, 200] }],
    ["change pieces do not match change", (state: SimState) => { state.transactions.at(-1)!.changeCash = [50, 10, 2] }],
    ["drawer count detached from ledger", (state: SimState) => { state.cashDrawer[50] += 1 }],
    ["fabricated revenue", (state: SimState) => { state.transactions.at(-1)!.amountPence += 65; state.cashPence += 65 }],
    ["double sale", (state: SimState) => { state.transactions.push(structuredClone(state.transactions.at(-1)!)); state.cashPence += 435 }],
  ] as const)("rejects a paid ledger with %s", (_name, mutate) => {
    const state = finishCash(cashCheckout());
    mutate(state);
    expect(validateSimState(state)).toBe(false);
  });

  it.each([
    ["a changed opening float", (state: SimState) => { state.cashDrawerOpening[50] += 1 }],
    ["a boundary moved past tracked sales", (state: SimState) => { state.cashDrawerTransactionStart = state.transactions.length }],
    ["a tracked sale relabelled as legacy", (state: SimState) => { state.transactions.at(-1)!.cashDrawerTracked = false }],
    ["drawer totals outside the safe integer range", (state: SimState) => {
      for (const denomination of CASH_DENOMINATIONS_PENCE) state.cashDrawer[denomination] = Number.MAX_SAFE_INTEGER;
    }],
  ] as const)("rejects cash-drawer audit data with %s", (_name, mutate) => {
    const state = finishCash(cashCheckout());
    mutate(state);
    expect(validateSimState(state)).toBe(false);
  });

  it("keeps product prices at integer pence and uses basket sums without rounding", () => {
    expect(PRODUCTS.milk.pricePence + PRODUCTS.cheese.pricePence).toBe(435);
    expect(PRODUCTS.water.pricePence).toBe(95);
    expect(getCheckoutTotal(cashCheckout())).toBe(435);
  });
});
