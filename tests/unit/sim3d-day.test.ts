import { describe, expect, it } from "vitest";
import {
  CRATE_CAPACITY, DAY_CUSTOMER_TARGET, DELIVERY_DROP_POINTS, INITIAL_CAPITAL_PENCE, PRODUCTS, PURCHASE_PAIR_COST_PENCE,
  canSettleDay, capacityFor, countAt, createFirstDayState, createInitialSimState, getDaySummary, getObjective,
  getDeliverySummary, getPurchaseOffer, migrateLegacySimState, reduceSim, validateLegacySimState, validateSimState,
  type LegacySimState, type ProductId, type PurchasePairs, type SimCommand, type SimState,
} from "../../src/sim3d/domain";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  expect(result.state.revision).toBe(state.revision + 1);
  return result.state;
}

function buy(state = createFirstDayState(), pairs: PurchasePairs = 3, id = `order-${state.purchases.length + 1}`): SimState {
  return act(act(state, { type: "PURCHASE_STOCK", orderId: id, pairs }), { type: "RECEIVE_DELIVERY" });
}

function stock(state: SimState, quantity: number): SimState {
  for (const productId of ["milk", "bread"] as const) {
    state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
    for (let index = 0; index < quantity; index += 1) {
      const slot = Array.from({ length: capacityFor(state) }, (_, candidate) => candidate)
        .find((candidate) => !state.items.some((item) => item.location.kind === "shelf" && item.location.productId === productId && item.location.slot === candidate))!;
      state = act(state, { type: "STOCK", productId, slot });
    }
    state = act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position });
  }
  return state;
}

function checkout(state: SimState): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
  return state;
}

function sale(state: SimState, leave = true): SimState {
  state = checkout(state);
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  state = act(state, { type: "PAY", success: true });
  return leave ? act(state, { type: "CUSTOMER_ADVANCE" }) : state;
}

function fullDay(state = createFirstDayState()): SimState {
  state = stock(buy(state), 3);
  for (let customer = 0; customer < DAY_CUSTOMER_TARGET; customer += 1) state = sale(state);
  return state;
}

function afterDays(days: number): SimState {
  let state = createFirstDayState();
  for (let day = 0; day < days; day += 1) {
    state = fullDay(state);
    state = act(state, { type: "SETTLE_DAY" });
    state = act(state, { type: "START_NEXT_DAY" });
  }
  return state;
}

function asLegacy(state: SimState): LegacySimState {
  return {
    schemaVersion: 3, revision: state.revision, items: structuredClone(state.items), crates: structuredClone(state.crates),
    held: structuredClone(state.held), inspectedProducts: [...state.inspectedProducts], customer: { ...state.customer },
    scannedIds: [...state.scannedIds], transactions: structuredClone(state.transactions), cashPence: state.cashPence,
    upgraded: state.upgraded, playerPose: { ...state.playerPose },
  };
}

describe("first-day paired purchasing and conserved goods", () => {
  it("opens with £12 capital, two empty reusable crates and no free merchandise", () => {
    const state = createFirstDayState();
    expect(validateSimState(state)).toBe(true);
    expect(state.schemaVersion).toBe(7);
    expect(state.cashPence).toBe(INITIAL_CAPITAL_PENCE);
    expect(state.items).toEqual([]);
    expect(state.crates).toHaveLength(2);
    expect(state.day).toMatchObject({ number: 1, phase: "preparing", targetCustomers: 3, openingCashPence: 1200, openingStockUnits: 0 });
    expect(state.purchases).toEqual([]);
    expect(state.inspectedProducts).toEqual([]);
    expect(getObjective(state)).toContain("进货");
    expect(reduceSim(state, { type: "OPEN_STORE" }).changed).toBe(false);
    expect(reduceSim(state, { type: "INSPECT", productId: "milk" }).changed).toBe(false);
  });

  it("buys three pairs for £6.90 with traceable unique units in the corresponding crates", () => {
    const original = createFirstDayState();
    const state = buy(original, 3, "opening-delivery");
    expect(state.cashPence).toBe(510);
    expect(state.items).toHaveLength(6);
    expect(new Set(state.items.map((item) => item.id)).size).toBe(6);
    expect(state.purchases).toEqual([{
      id: "opening-delivery", dayNumber: 1, pairs: 3, amountPence: 690, receivedDay: 1,
      lines: [{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }],
      itemIds: ["milk-purchase-opening-delivery-1", "milk-purchase-opening-delivery-2", "milk-purchase-opening-delivery-3",
        "bread-purchase-opening-delivery-1", "bread-purchase-opening-delivery-2", "bread-purchase-opening-delivery-3"],
    }]);
    for (const id of ["milk", "bread"] as const) expect(countAt(state, id, "crate")).toBe(3);
    expect(original.cashPence).toBe(1200);
    expect(original.items).toEqual([]);
    expect(getPurchaseOffer(original, 3)).toEqual({ pairs: 3, costPence: 690, allowed: true, unitCount: 6,
      lines: [{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }] });
    expect(getPurchaseOffer(original, 6)).toMatchObject({ allowed: false, costPence: 1380 });
  });

  it("replays an order id as a no-op even after consumption or with a different quantity", () => {
    let state = buy(createFirstDayState(), 3, "one-order");
    state = sale(stock(state, 3));
    for (const pairs of [3, 1] as const) {
      const result = reduceSim(state, { type: "PURCHASE_STOCK", orderId: "one-order", pairs });
      expect(result.changed).toBe(false);
      expect(result.state).toBe(state);
    }
    const next = buy(state, 1, "another-order");
    expect(next.items).toHaveLength(8);
    expect(new Set(next.items.map((item) => item.id)).size).toBe(8);
    expect(next.cashPence).toBe(state.cashPence - PURCHASE_PAIR_COST_PENCE);
  });

  it.each([0, 2, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects unsupported quantity %s without debit or goods", (pairs) => {
    const state = createFirstDayState();
    expect(getPurchaseOffer(state, pairs as PurchasePairs).allowed).toBe(false);
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId: "bad-quantity", pairs: pairs as PurchasePairs }).state).toBe(state);
  });

  it.each(["", "../evil", "<script>", "a".repeat(81)])("rejects malformed order id %s", (orderId) => {
    const state = createFirstDayState();
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId, pairs: 1 }).state).toBe(state);
  });

  it("accepts a paid order while carrying a crate but refuses to move that crate on receipt", () => {
    let state = createFirstDayState();
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId: "too-large", pairs: 6 }).state).toBe(state);
    state = act(state, { type: "PICK_CRATE", crateId: "bread-crate" });
    expect(getObjective(state)).toContain("空");
    const beforeCrates = structuredClone(state.crates);
    state = act(state, { type: "PURCHASE_STOCK", orderId: "held-order", pairs: 3 });
    expect(state.held).toEqual({ kind: "crate", crateId: "bread-crate" });
    expect(countAt(state, "bread", "crate")).toBe(0);
    expect(countAt(state, "bread", "delivery")).toBe(3);
    expect(getDeliverySummary(state)).toMatchObject({ pendingOrders: 1, pendingUnits: 6, canReceive: false });
    expect(reduceSim(state, { type: "RECEIVE_DELIVERY" }).state).toBe(state);
    expect(state.crates).toEqual(beforeCrates);
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId: "not-affordable", pairs: 3 }).state).toBe(state);
    expect(getPurchaseOffer(state, 1).allowed).toBe(true);
    state = act(state, { type: "DROP_HELD", position: state.crates[1]!.position });
    const balance = state.cashPence;
    state = act(state, { type: "RECEIVE_DELIVERY" });
    expect(state.crates.map((crate) => crate.position)).toEqual(DELIVERY_DROP_POINTS.slice(0, 2));
    expect(countAt(state, "bread", "crate")).toBe(3);
    expect(state.cashPence).toBe(balance);
  });

  it("caps crates at eight including a hand-held unit's reserved return space", () => {
    let state = buy(afterDays(2), 6);
    state = buy(state, 1);
    state = buy(state, 1);
    expect(countAt(state, "milk", "crate")).toBe(CRATE_CAPACITY);
    expect(state.cashPence).toBeGreaterThanOrEqual(PURCHASE_PAIR_COST_PENCE);
    expect(getPurchaseOffer(state, 1)).toMatchObject({ allowed: false });
    const milk = state.items.find((item) => item.productId === "milk" && item.location.kind === "crate")!;
    state = act(state, { type: "TAKE_ITEM", itemId: milk.id });
    expect(countAt(state, "milk", "crate")).toBe(7);
    expect(getPurchaseOffer(state, 1).allowed).toBe(false);
    state = act(state, { type: "RETURN_ITEM" });
    expect(countAt(state, "milk", "crate")).toBe(8);
  });

  it("keeps safe cancellation capacity after refilling shelves and crates during checkout", () => {
    let state = buy(afterDays(4), 6);
    state = stock(state, 4);
    state = buy(state, 3);
    state = checkout(state);
    state = stock(state, 1);
    state = buy(state, 3);
    expect(state.cashPence).toBeGreaterThanOrEqual(PURCHASE_PAIR_COST_PENCE);
    expect(getPurchaseOffer(state, 1).allowed).toBe(false);
    expect(getPurchaseOffer(state, 1).reason).toContain("暂存空间");
    const milk = state.items.find((item) => item.productId === "milk" && item.location.kind === "shelf")!;
    state = act(state, { type: "TAKE_ITEM", itemId: milk.id });
    const beforeCash = state.cashPence;
    state = act(state, { type: "CANCEL_CUSTOMER" });
    state = act(state, { type: "RETURN_ITEM" });
    expect(state.cashPence).toBe(beforeCash);
    for (const id of ["milk", "bread"] as const) {
      expect(countAt(state, id, "crate")).toBe(8);
      expect(countAt(state, id, "shelf")).toBe(4);
    }
  });
});

describe("a complete business day and continued operation", () => {
  it("accounts procurement, £12 sales, £5.10 gross profit and £17.10 cash without double expensing stock", () => {
    const state = fullDay();
    expect(getDaySummary(state)).toEqual({
      dayNumber: 1, paidCustomers: 3, targetCustomers: 3, openingCashPence: 1200,
      revenuePence: 1200, procurementPence: 690, costOfGoodsPence: 690, grossProfitPence: 510,
      upgradeSpendPence: 0, closingCashPence: 1710, remainingStockUnits: 0, remainingInventoryValuePence: 0,
      recycledCrates: 0, recyclingIncomePence: 0,
    });
    expect(state.cashPence).toBe(1710);
    expect(state.items.filter((item) => item.location.kind === "sold")).toHaveLength(6);
    expect(canSettleDay(state)).toBe(true);
    expect(getObjective(state)).toContain("日结");
    expect(reduceSim(state, { type: "NEXT_CUSTOMER" }).state).toBe(state);
  });

  it("requires three paid orders, not just arrivals, and waits for the last customer to leave", () => {
    let state = stock(buy(), 3);
    expect(canSettleDay(state)).toBe(false);
    expect(reduceSim(state, { type: "SETTLE_DAY" }).state).toBe(state);
    state = checkout(state);
    state = act(state, { type: "CANCEL_CUSTOMER" });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(getDaySummary(state).paidCustomers).toBe(0);
    for (let customer = 0; customer < 2; customer += 1) state = sale(state);
    expect(state.customer.number).toBe(3);
    expect(canSettleDay(state)).toBe(false);
    state = sale(state, false);
    expect(state.customer.number).toBe(4);
    expect(state.customer.phase).toBe("leaving");
    expect(getDaySummary(state).paidCustomers).toBe(3);
    expect(canSettleDay(state)).toBe(false);
    expect(reduceSim(state, { type: "SETTLE_DAY" }).state).toBe(state);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(canSettleDay(state)).toBe(true);
  });

  it("records a settlement once without adding revenue again and blocks procurement until the next day", () => {
    const paid = fullDay();
    let state = act(paid, { type: "SETTLE_DAY" });
    expect(state.day.phase).toBe("settled");
    expect(state.cashPence).toBe(paid.cashPence);
    expect(state.transactions).toEqual(paid.transactions);
    expect(state.settlements).toHaveLength(1);
    expect(state.settlements[0]).toMatchObject(getDaySummary(state));
    expect(reduceSim(state, { type: "SETTLE_DAY" }).state).toBe(state);
    expect(reduceSim(state, { type: "OPEN_STORE" }).state).toBe(state);
    expect(reduceSim(state, { type: "NEXT_CUSTOMER" }).state).toBe(state);
    expect(getPurchaseOffer(state, 1).allowed).toBe(false);
    state = act(state, { type: "START_NEXT_DAY" });
    expect(state.cashPence).toBe(1710);
    expect(state.day).toMatchObject({ number: 2, phase: "preparing", openingCashPence: 1710, transactionStart: 3, purchaseStart: 1 });
    expect(state.customer).toEqual({ number: 4, phase: "outside", shoppingList: [] });
    expect(getDaySummary(state).revenuePence).toBe(0);
    expect(getDaySummary(state).procurementPence).toBe(0);
    expect(reduceSim(state, { type: "START_NEXT_DAY" }).state).toBe(state);
    state = fullDay(state);
    expect(state.cashPence).toBe(2220);
    expect(state.transactions).toHaveLength(6);
    expect(state.items).toHaveLength(12);
  });

  it("carries unsold shelf goods, crates, held objects, pose, cash and capacity through midnight", () => {
    let state = stock(buy(buy(), 1), 4);
    for (let order = 0; order < 3; order += 1) state = sale(state);
    expect(state.cashPence).toBe(1480);
    expect(getDaySummary(state)).toMatchObject({ procurementPence: 920, costOfGoodsPence: 690, grossProfitPence: 510, remainingStockUnits: 2, remainingInventoryValuePence: 230 });
    state = act(state, { type: "PICK_CRATE", crateId: "milk-crate" });
    state = act(state, { type: "SAVE_POSE", pose: { x: 0.5, z: -1, yaw: 0.3, pitch: 0.1 } });
    state = act(state, { type: "SETTLE_DAY" });
    state = act(state, { type: "BUY_UPGRADE" });
    expect(state.cashPence).toBe(680);
    expect(state.settlements[0]).toMatchObject({ closingCashPence: 680, upgradeSpendPence: 800, remainingStockUnits: 2 });
    const before = structuredClone(state);
    state = act(state, { type: "START_NEXT_DAY" });
    expect(state.items).toEqual(before.items);
    expect(state.crates).toEqual(before.crates);
    expect(state.held).toEqual(before.held);
    expect(state.playerPose).toEqual(before.playerPose);
    expect(state.cashPence).toBe(680);
    expect(capacityFor(state)).toBe(8);
    expect(state.day).toMatchObject({ openingCashPence: 680, openingStockUnits: 2, openingInventoryValuePence: 230 });
    expect(getDaySummary(state)).toMatchObject({ upgradeSpendPence: 0, remainingInventoryValuePence: 230, remainingStockUnits: 2 });
  });

  it("allows the ordinary upgrade immediately and still leaves a viable rolling one-pair business", () => {
    let state = act(createFirstDayState(), { type: "BUY_UPGRADE" });
    expect(state.cashPence).toBe(400);
    expect(state.items).toEqual([]);
    for (let order = 0; order < 3; order += 1) state = sale(stock(buy(state, 1), 1));
    expect(state.cashPence).toBe(910);
    expect(state.inspectedProducts).toEqual([]);
    expect(getDaySummary(state)).toMatchObject({ upgradeSpendPence: 800, grossProfitPence: 510 });
    expect(reduceSim(state, { type: "BUY_UPGRADE" }).state).toBe(state);
    state = act(state, { type: "SETTLE_DAY" });
    expect(state.settlements[0]?.closingCashPence).toBe(910);
  });

  it("does not gate a funded upgrade on hands, active customers, day number or English progress", () => {
    let state = sale(stock(buy(), 3));
    state = act(state, { type: "NEXT_CUSTOMER" });
    state = act(state, { type: "PICK_CRATE", crateId: "bread-crate" });
    const before = structuredClone(state);
    state = act(state, { type: "BUY_UPGRADE" });
    expect(state.cashPence).toBe(110);
    expect(state.items).toEqual(before.items);
    expect(state.held).toEqual(before.held);
    expect(state.customer).toEqual(before.customer);
    expect(state.inspectedProducts).toEqual([]);
    expect(state.upgradeDay).toBe(1);
  });
});

describe("doorstep delivery ownership and receipt", () => {
  it("debits once but keeps paid goods on the vehicle until signed for", () => {
    const original = createFirstDayState();
    const pending = act(original, { type: "PURCHASE_STOCK", orderId: "doorstep", pairs: 3 });
    expect(pending.cashPence).toBe(510);
    expect(pending.purchases[0]?.receivedDay).toBeNull();
    expect(getDeliverySummary(pending)).toEqual({ pendingOrders: 1, pendingUnits: 6, receivedToday: 0, canReceive: true });
    expect(pending.crates).toEqual(original.crates);
    for (const productId of ["milk", "bread"] as const) {
      expect(countAt(pending, productId, "crate")).toBe(0);
      expect(countAt(pending, productId, "delivery")).toBe(3);
      expect(reduceSim(pending, { type: "INSPECT", productId }).changed).toBe(false);
    }
    expect(reduceSim(pending, { type: "TAKE_ITEM", itemId: pending.items[0]!.id }).changed).toBe(false);
    expect(reduceSim(pending, { type: "OPEN_STORE" }).changed).toBe(false);
    expect(getObjective(pending)).toContain("签收");
    expect(getDaySummary(pending)).toMatchObject({ procurementPence: 690, remainingStockUnits: 6, remainingInventoryValuePence: 690 });
    const received = act(pending, { type: "RECEIVE_DELIVERY" });
    expect(received.cashPence).toBe(pending.cashPence);
    expect(received.items.map((item) => item.id)).toEqual(pending.items.map((item) => item.id));
    expect(received.crates.map((crate) => crate.position)).toEqual(DELIVERY_DROP_POINTS.slice(0, 2));
    expect(getDeliverySummary(received)).toMatchObject({ pendingOrders: 0, pendingUnits: 0, receivedToday: 1, canReceive: false });
    expect(reduceSim(received, { type: "RECEIVE_DELIVERY" }).state).toBe(received);
    expect(reduceSim(received, { type: "PURCHASE_STOCK", orderId: "doorstep", pairs: 3 }).state).toBe(received);
  });

  it("combines independently paid same-day orders into a single safe unloading", () => {
    let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "morning", pairs: 3 });
    state = act(state, { type: "PURCHASE_STOCK", orderId: "extra", pairs: 1 });
    expect(getDeliverySummary(state)).toMatchObject({ pendingOrders: 2, pendingUnits: 8, receivedToday: 0 });
    state = act(state, { type: "RECEIVE_DELIVERY" });
    expect(state.cashPence).toBe(280);
    expect(state.purchases.map((purchase) => purchase.receivedDay)).toEqual([1, 1]);
    expect(countAt(state, "milk", "crate")).toBe(4);
    expect(countAt(state, "bread", "crate")).toBe(4);
    expect(getDeliverySummary(state).receivedToday).toBe(2);
  });

  it("reserves crate capacity for all paid pending goods before further orders", () => {
    let state = act(afterDays(2), { type: "PURCHASE_STOCK", orderId: "large", pairs: 6 });
    state = act(state, { type: "PURCHASE_STOCK", orderId: "extra-one", pairs: 1 });
    state = act(state, { type: "PURCHASE_STOCK", orderId: "extra-two", pairs: 1 });
    expect(countAt(state, "milk", "crate")).toBe(0);
    expect(countAt(state, "milk", "delivery")).toBe(8);
    expect(state.cashPence).toBeGreaterThanOrEqual(PURCHASE_PAIR_COST_PENCE);
    expect(getPurchaseOffer(state, 1).allowed).toBe(false);
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId: "overflow", pairs: 1 }).state).toBe(state);
    state = act(state, { type: "RECEIVE_DELIVERY" });
    expect(countAt(state, "milk", "crate")).toBe(8);
  });

  it("does not unload into the player or move a crate that owns a held item's return place", () => {
    let state = buy();
    state = act(state, { type: "PURCHASE_STOCK", orderId: "supplement", pairs: 1 });
    const milk = state.items.find((item) => item.productId === "milk" && item.location.kind === "crate")!;
    state = act(state, { type: "TAKE_ITEM", itemId: milk.id });
    expect(getDeliverySummary(state).reason).toContain("放下");
    expect(reduceSim(state, { type: "RECEIVE_DELIVERY" }).state).toBe(state);
    state = act(state, { type: "RETURN_ITEM" });
    state = act(state, { type: "SAVE_POSE", pose: { ...DELIVERY_DROP_POINTS[0]!, yaw: 0, pitch: 0 } });
    expect(getDeliverySummary(state).reason).toContain("卸货点");
    expect(reduceSim(state, { type: "RECEIVE_DELIVERY" }).state).toBe(state);
    state = act(state, { type: "SAVE_POSE", pose: { x: 0, z: -6, yaw: 0, pitch: 0 } });
    state = act(state, { type: "RECEIVE_DELIVERY" });
    expect(state.items.find((item) => item.id === milk.id)?.location).toEqual({ kind: "crate", crateId: "milk-crate" });
    expect(countAt(state, "milk", "crate")).toBe(4);
  });

  it("keeps space for unpaid cancellation and a held shelf return while another delivery is pending", () => {
    let state = buy(afterDays(4), 6);
    state = stock(state, 4);
    state = buy(state, 3);
    state = checkout(state);
    state = stock(state, 1);
    state = act(state, { type: "PURCHASE_STOCK", orderId: "cancel-safe", pairs: 3 });
    const milk = state.items.find((item) => item.productId === "milk" && item.location.kind === "shelf")!;
    state = act(state, { type: "TAKE_ITEM", itemId: milk.id });
    expect(getPurchaseOffer(state, 1).allowed).toBe(false);
    state = act(state, { type: "CANCEL_CUSTOMER" });
    state = act(state, { type: "RETURN_ITEM" });
    expect(countAt(state, "milk", "crate")).toBe(5);
    expect(countAt(state, "milk", "delivery")).toBe(3);
    state = act(state, { type: "RECEIVE_DELIVERY" });
    expect(countAt(state, "milk", "crate")).toBe(8);
    expect(countAt(state, "bread", "crate")).toBe(8);
  });

  it("waits for the last delivery before day-end and resets receipt counts without granting free next-day stock", () => {
    let state = fullDay();
    state = act(state, { type: "PURCHASE_STOCK", orderId: "last-minute", pairs: 1 });
    expect(canSettleDay(state)).toBe(false);
    const closing = reduceSim(state, { type: "SETTLE_DAY" });
    expect(closing.state).toBe(state);
    expect(closing.message).toContain("先签收");
    expect(reduceSim(state, { type: "START_NEXT_DAY" }).state).toBe(state);
    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = act(state, { type: "SETTLE_DAY" });
    const before = structuredClone(state);
    state = act(state, { type: "START_NEXT_DAY" });
    expect(state.items).toEqual(before.items);
    expect(state.cashPence).toBe(before.cashPence);
    expect(getDeliverySummary(state)).toMatchObject({ pendingOrders: 0, receivedToday: 0, canReceive: false });
    state = act(state, { type: "PURCHASE_STOCK", orderId: "day-two", pairs: 1 });
    expect(getDeliverySummary(state)).toMatchObject({ pendingOrders: 1, pendingUnits: 2, receivedToday: 0 });
    state = act(state, { type: "RECEIVE_DELIVERY" });
    expect(state.purchases.at(-1)?.receivedDay).toBe(2);
  });

  it.each([
    ["missing receipt state", (state: SimState) => { delete (state.purchases[0] as Partial<typeof state.purchases[number]>).receivedDay }],
    ["false receipt", (state: SimState) => { state.purchases[0]!.receivedDay = 1 }],
    ["premature crate ownership", (state: SimState) => { state.items[0]!.location = { kind: "crate", crateId: "milk-crate" } }],
    ["another order's cargo", (state: SimState) => { state.items[0]!.location = { kind: "delivery", orderId: "other-order" } }],
    ["unreceived day end", (state: SimState) => { state.day.phase = "settled" }],
  ])("rejects %s in saved delivery ownership", (_label, mutate) => {
    const state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "pending", pairs: 3 });
    mutate(state);
    expect(validateSimState(state)).toBe(false);
  });
});

describe("v3 legacy baseline migration", () => {
  it("preserves the original world, active scan and cash without new first-day capital", () => {
    let state = checkout(stock(createInitialSimState(), 3));
    state = act(state, { type: "SCAN", itemId: "milk-1" });
    state = act(state, { type: "TAKE_ITEM", itemId: "bread-4" });
    const legacy = asLegacy(state);
    expect(validateLegacySimState(legacy)).toBe(true);
    const result = migrateLegacySimState(legacy);
    expect(validateSimState(result)).toBe(true);
    expect(result.openingKind).toBe("legacy-s0");
    expect(result.cashPence).toBe(0);
    expect(result.items).toEqual(legacy.items);
    expect(result.held).toEqual(legacy.held);
    expect(result.customer).toEqual(legacy.customer);
    expect(result.scannedIds).toEqual(legacy.scannedIds);
    expect(result.transactions).toEqual(legacy.transactions);
    expect(result.day.phase).toBe("open");
    expect(result.day.openingInventoryValuePence).toBe(920);
    result.items[0]!.id = "mutated-copy";
    expect(legacy.items[0]!.id).toBe("milk-1");
  });

  it("preserves a fully paid four-customer S0 save and permits settling without another sale", () => {
    let state = stock(createInitialSimState(), 4);
    for (let order = 0; order < 3; order += 1) state = sale(state);
    state = act(state, { type: "SETTLE_DAY" });
    state = act(state, { type: "START_NEXT_DAY" });
    state = sale(state);
    state = act(state, { type: "BUY_UPGRADE" });
    const legacy = asLegacy(state);
    expect(validateLegacySimState(legacy)).toBe(true);
    let result = migrateLegacySimState(legacy);
    expect(result.transactions).toEqual(legacy.transactions);
    expect(result.cashPence).toBe(800);
    expect(result.upgraded).toBe(true);
    expect(result.upgradeDay).toBe(1);
    expect(getDaySummary(result).paidCustomers).toBe(4);
    expect(canSettleDay(result)).toBe(true);
    result = act(result, { type: "SETTLE_DAY" });
    result = act(result, { type: "START_NEXT_DAY" });
    expect(result.cashPence).toBe(800);
    expect(result.items).toHaveLength(8);
    expect(result.day.openingStockUnits).toBe(0);
    expect(getPurchaseOffer(result, 3).allowed).toBe(true);
  });

  it("rejects malformed old worlds rather than blessing them with a migration baseline", () => {
    const legacy = asLegacy(createInitialSimState());
    legacy.cashPence = 1200;
    expect(validateLegacySimState(legacy)).toBe(false);
    expect(() => migrateLegacySimState(legacy)).toThrow("校验失败");
    expect(validateLegacySimState(createFirstDayState())).toBe(false);
  });
});

describe("day and purchase ledger tamper validation", () => {
  it.each([
    ["unfunded cash", (state: SimState) => { state.cashPence += 100 }],
    ["missing purchase", (state: SimState) => { state.purchases.pop() }],
    ["duplicate purchase", (state: SimState) => { state.purchases.push(structuredClone(state.purchases[0]!)) }],
    ["changed charge", (state: SimState) => { state.purchases[0]!.amountPence -= 10; state.cashPence += 10 }],
    ["changed quantity", (state: SimState) => { state.purchases[0]!.pairs = 1 }],
    ["future delivery", (state: SimState) => { state.purchases[0]!.dayNumber = 2 }],
    ["orphan delivery unit", (state: SimState) => { state.items[0]!.id = "milk-unpaid" }],
    ["invented product", (state: SimState) => { state.items[0]!.productId = "eggs" as ProductId }],
    ["unsourced extra stock", (state: SimState) => { state.items.push({ id: "free-milk", productId: "milk", location: { kind: "crate", crateId: "milk-crate" } }) }],
    ["free extension", (state: SimState) => { state.upgraded = true; state.upgradeDay = 1 }],
    ["forged opening cash", (state: SimState) => { state.day.openingCashPence += 50 }],
    ["forged opening units", (state: SimState) => { state.day.openingStockUnits += 2 }],
    ["forged opening valuation", (state: SimState) => { state.day.openingInventoryValuePence += 230 }],
    ["changed target", (state: SimState) => { (state.day as { targetCustomers: number }).targetCustomers = 1 }],
    ["skipped days", (state: SimState) => { state.day.number = 3 }],
    ["premature settlement", (state: SimState) => { state.day.phase = "settled" }],
    ["incomplete purchase range", (state: SimState) => { state.day.purchaseStart = 1 }],
    ["partial day object", (state: SimState) => { delete (state.day as Partial<typeof state.day>).transactionStart }],
  ])("rejects %s", (_label, mutate) => {
    const state = buy();
    mutate(state);
    expect(validateSimState(state)).toBe(false);
  });

  it.each([
    ["changed revenue", (state: SimState) => { state.settlements[0]!.revenuePence += 400 }],
    ["changed margin", (state: SimState) => { state.settlements[0]!.grossProfitPence -= 690 }],
    ["changed ending cash", (state: SimState) => { state.settlements[0]!.closingCashPence += 1200 }],
    ["false paid customer", (state: SimState) => { state.settlements[0]!.paidCustomers += 1 }],
    ["repeated settlement", (state: SimState) => { state.settlements.push(structuredClone(state.settlements[0]!)) }],
    ["empty sales range", (state: SimState) => { state.settlements[0]!.transactionEnd = 0 }],
    ["unpaid customer at close", (state: SimState) => { state.customer.phase = "to-milk" }],
  ])("rejects settled report with %s", (_label, mutate) => {
    const state = act(fullDay(), { type: "SETTLE_DAY" });
    mutate(state);
    expect(validateSimState(state)).toBe(false);
  });

  it("rejects bogus next-day carry balances and retained fresh-start capital", () => {
    const state = afterDays(2);
    for (const mutate of [
      (value: SimState) => { value.day.openingCashPence = INITIAL_CAPITAL_PENCE },
      (value: SimState) => { value.cashPence += INITIAL_CAPITAL_PENCE },
      (value: SimState) => { value.day.openingInventoryValuePence = PRODUCTS.milk.costPence },
      (value: SimState) => { value.settlements[1]!.transactionStart = 0 },
      (value: SimState) => { value.purchases[1]!.dayNumber = 1 },
    ]) {
      const broken = structuredClone(state);
      mutate(broken);
      expect(validateSimState(broken)).toBe(false);
    }
  });

  it("rejects historical sales relabelled with goods that were only bought the following day", () => {
    const state = afterDays(2);
    const dayOneSale = state.transactions[0]!;
    const dayTwoSale = state.transactions[3]!;
    const firstMilk = state.items.find((item) => item.id === dayOneSale.itemIds[0])!;
    const laterMilk = state.items.find((item) => item.id === dayTwoSale.itemIds[0])!;
    [dayOneSale.itemIds[0], dayTwoSale.itemIds[0]] = [dayTwoSale.itemIds[0]!, dayOneSale.itemIds[0]!];
    [firstMilk.location, laterMilk.location] = [laterMilk.location, firstMilk.location];
    // Counts, total cash, product prices and current sale ownership still match;
    // only source-day provenance reveals the impossible historical sale.
    expect(validateSimState(state)).toBe(false);
  });

  it("rejects non-string phase/kind payloads without invoking hostile string coercion", () => {
    const poisoned = { toString: null, valueOf: null };
    for (const mutate of [
      (state: SimState) => { (state.customer as unknown as Record<string, unknown>).phase = poisoned },
      (state: SimState) => { (state.day as unknown as Record<string, unknown>).phase = poisoned },
      (state: SimState) => { (state.items[0]!.location as unknown as Record<string, unknown>).kind = poisoned },
    ]) {
      const state = buy();
      mutate(state);
      expect(() => validateSimState(state)).not.toThrow();
      expect(validateSimState(state)).toBe(false);
    }
  });
});
