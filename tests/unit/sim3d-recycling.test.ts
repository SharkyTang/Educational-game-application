import { describe, expect, it } from "vitest";
import { payScannedCheckout } from "../helpers/sim3dPayment";
import {
  PRODUCTS, RECYCLING_REWARD_PENCE, SAFE_DROP_POINTS,
  createFirstDayState, createInitialSimState, countAt, capacityFor, getDaySummary, getRecyclingOffer,
  getRecyclingSummary, getDeliverySummary, reduceSim, validateSimState,
  type ProductId, type PurchaseLine, type SimCommand, type SimState,
} from "../../src/sim3d/domain";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(result.state.revision).toBe(state.revision + 1);
  expect(validateSimState(JSON.parse(JSON.stringify(result.state)))).toBe(true);
  return result.state;
}

function buy(state: SimState, lines: PurchaseLine[], receive = true): SimState {
  state = act(state, { type: "PURCHASE_STOCK", orderId: `order-${state.purchases.length + 1}`, lines });
  return receive ? act(state, { type: "RECEIVE_DELIVERY" }) : state;
}

function stock(state: SimState, productId: ProductId, quantity: number): SimState {
  state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
  for (let index = 0; index < quantity; index += 1) {
    const slot = Array.from({ length: capacityFor(state) }, (_, candidate) => candidate).find((candidate) => !state.items.some((item) =>
      item.location.kind === "shelf" && item.location.productId === productId && item.location.slot === candidate))!;
    state = act(state, { type: "STOCK", productId, slot });
  }
  return state;
}

function drop(state: SimState): SimState {
  const held = state.held;
  const crate = state.crates.find((candidate) => held.kind === "crate" && candidate.id === held.crateId)!;
  return act(state, { type: "DROP_HELD", position: crate.position });
}

function recycle(state: SimState, productId: ProductId): SimState {
  if (state.held.kind === "none") state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
  return act(state, { type: "RECYCLE_CRATE" });
}

function sale(state: SimState): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  while (state.customer.phase !== "checkout") state = act(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  state = payScannedCheckout(state);
  return act(state, { type: "CUSTOMER_ADVANCE" });
}

function paidEmptyBox(): SimState {
  return stock(buy(createFirstDayState(), [{ productId: "carrot", quantity: 1 }]), "carrot", 1);
}

describe("physical empty-crate recycling", () => {
  it("requires a held empty crate and never discards goods or a hand-held product", () => {
    const emptyHands = createFirstDayState();
    expect(getRecyclingOffer(emptyHands)).toMatchObject({ allowed: false, rewardPence: 0 });
    expect(reduceSim(emptyHands, { type: "RECYCLE_CRATE" }).state).toBe(emptyHands);
    const delivery = buy(emptyHands, [{ productId: "carrot", quantity: 1 }]);
    const heldBox = act(delivery, { type: "PICK_CRATE", crateId: "carrot-crate" });
    expect(getRecyclingOffer(heldBox)).toMatchObject({ allowed: false, rewardPence: 0 });
    const rejectedBox = reduceSim(heldBox, { type: "RECYCLE_CRATE" });
    expect(rejectedBox.state).toBe(heldBox);
    expect(rejectedBox.message).toContain("还有商品");
    const heldItem = act(delivery, { type: "TAKE_ITEM", itemId: delivery.items[0]!.id });
    expect(reduceSim(heldItem, { type: "RECYCLE_CRATE" }).state).toBe(heldItem);
    expect(countAt(heldItem, "carrot", "hand")).toBe(1);
  });

  it("removes the actual empty box, frees both hands and its drop position, and rewards once", () => {
    const held = paidEmptyBox();
    const before = structuredClone(held);
    const position = held.crates.find((crate) => crate.productId === "carrot")!.position;
    expect(getRecyclingOffer(held)).toEqual({ allowed: true, rewardPence: 5 });
    let state = recycle(held, "carrot");
    expect(held).toEqual(before);
    expect(state.held).toEqual({ kind: "none" });
    expect(state.crates.some((crate) => crate.productId === "carrot")).toBe(false);
    expect(state.items).toEqual(held.items);
    expect(state.cashPence).toBe(held.cashPence + RECYCLING_REWARD_PENCE);
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 1, incomeTodayPence: 5 });
    expect(reduceSim(state, { type: "RECYCLE_CRATE" }).state).toBe(state);
    expect(reduceSim(state, { type: "PICK_CRATE", crateId: "carrot-crate" }).state).toBe(state);
    state = act(state, { type: "PICK_CRATE", crateId: "bread-crate" });
    state = act(state, { type: "DROP_HELD", position });
    expect(state.crates.find((crate) => crate.productId === "bread")!.position).toEqual(position);
  });

  it("can recycle every free opening box without creating money, then receives new boxes normally", () => {
    let state = recycle(recycle(createFirstDayState(), "milk"), "bread");
    expect(state.crates).toEqual([]);
    expect(state.cashPence).toBe(1200);
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 2, incomeTodayPence: 0 });
    expect(state.recyclingRecords.every((record) => record.purchaseIds.length === 0 && record.amountPence === 0)).toBe(true);
    state = buy(state, [{ productId: "milk", quantity: 1 }]);
    expect(state.crates.map((crate) => crate.id)).toEqual(["milk-crate"]);
    state = recycle(stock(state, "milk", 1), "milk");
    expect(state.cashPence).toBe(1200 - PRODUCTS.milk.costPence + 5);
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 3, incomeTodayPence: 5 });
  });

  it("clears a used legacy trial box without rewarding its free opening goods", () => {
    let state = stock(createInitialSimState(), "milk", 4);
    expect(getRecyclingOffer(state)).toEqual({ allowed: true, rewardPence: 0 });
    state = recycle(state, "milk");
    expect(state.cashPence).toBe(0);
    expect(state.items).toHaveLength(8);
    expect(countAt(state, "milk", "shelf")).toBe(4);
  });

  it("lets an emptied box be put down and picked up before recycling with the same reward", () => {
    let state = drop(paidEmptyBox());
    expect(getRecyclingOffer(state).allowed).toBe(false);
    state = act(state, { type: "PICK_CRATE", crateId: "carrot-crate" });
    expect(getRecyclingOffer(state).rewardPence).toBe(5);
    expect(recycle(state, "carrot").recyclingRecords).toHaveLength(1);
  });
});

describe("recycling income follows paid box sources", () => {
  it("consumes every merged order for a SKU but gives only one physical-box reward", () => {
    let state = buy(createFirstDayState(), [{ productId: "carrot", quantity: 1 }]);
    state = buy(state, [{ productId: "carrot", quantity: 1 }]);
    state = recycle(stock(state, "carrot", 2), "carrot");
    expect(state.recyclingBatches).toEqual([{ id: "crate-batch-1", productId: "carrot", purchaseIds: ["order-1", "order-2"] }]);
    expect(state.recyclingRecords[0]).toMatchObject({ productId: "carrot", amountPence: 5, purchaseIds: ["order-1", "order-2"] });
    expect(state.cashPence).toBe(1200 - PRODUCTS.carrot.costPence * 2 + 5);
    expect(getDaySummary(state)).toMatchObject({ revenuePence: 0, grossProfitPence: 0, recycledCrates: 1, recyclingIncomePence: 5 });
    state = buy(state, [{ productId: "carrot", quantity: 1 }]);
    state = recycle(stock(state, "carrot", 1), "carrot");
    expect(state.recyclingRecords[1]!.purchaseIds).toEqual(["order-3"]);
    expect(getRecyclingSummary(state).incomeTodayPence).toBe(10);
  });

  it("keeps a later same-day pending order separate when the earlier physical box is recycled before receipt", () => {
    let state = buy(paidEmptyBox(), [{ productId: "carrot", quantity: 1 }], false);
    state = recycle(state, "carrot");
    expect(state.recyclingBatches).toHaveLength(1);
    expect(state.recyclingRecords[0]!.purchaseIds).toEqual(["order-1"]);
    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = recycle(stock(state, "carrot", 1), "carrot");
    expect(state.recyclingBatches.map((batch) => batch.purchaseIds)).toEqual([["order-1"], ["order-2"]]);
    expect(state.recyclingRecords.map((record) => record.batchId)).toEqual(["crate-batch-1", "crate-batch-2"]);
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 2, incomeTodayPence: 10 });
  });

  it("assigns orders accepted in one receipt to a single box before any reward is claimed", () => {
    let state = buy(createFirstDayState(), [{ productId: "carrot", quantity: 1 }], false);
    state = buy(state, [{ productId: "carrot", quantity: 1 }], false);
    expect(state.recyclingBatches).toEqual([]);
    state = act(state, { type: "RECEIVE_DELIVERY" });
    expect(state.recyclingBatches).toEqual([{ id: "crate-batch-1", productId: "carrot", purchaseIds: ["order-1", "order-2"] }]);
    state = recycle(stock(state, "carrot", 2), "carrot");
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 1, incomeTodayPence: 5 });
  });

  it("awards one reward for each SKU box in the same paid multi-product order", () => {
    let state = buy(createFirstDayState(), [{ productId: "carrot", quantity: 1 }, { productId: "water", quantity: 1 }]);
    state = recycle(stock(state, "carrot", 1), "carrot");
    state = recycle(stock(state, "water", 1), "water");
    expect(state.recyclingRecords.map((record) => record.purchaseIds)).toEqual([["order-1"], ["order-1"]]);
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 2, incomeTodayPence: 10 });
  });

  it("does not claim a pending delivery while clearing an initial empty box", () => {
    let state = buy(createFirstDayState(), [{ productId: "milk", quantity: 1 }], false);
    state = recycle(state, "milk");
    expect(state.recyclingRecords[0]!.purchaseIds).toEqual([]);
    expect(state.cashPence).toBe(1200 - PRODUCTS.milk.costPence);
    expect(getDeliverySummary(state).canReceive).toBe(true);
    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = recycle(stock(state, "milk", 1), "milk");
    expect(state.recyclingRecords[1]!.purchaseIds).toEqual(["order-1"]);
    expect(getRecyclingSummary(state).incomeTodayPence).toBe(5);
  });

  it("restores canceled goods safely when the empty box was recycled, without a repeatable reward", () => {
    let state = recycle(stock(buy(createFirstDayState(), [{ productId: "carrot", quantity: 4 }]), "carrot", 4), "carrot");
    state = act(state, { type: "OPEN_STORE" });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    state = recycle(stock(buy(state, [{ productId: "carrot", quantity: 1 }]), "carrot", 1), "carrot");
    state = act(state, { type: "SAVE_POSE", pose: { ...state.playerPose, ...SAFE_DROP_POINTS[2]! } });
    const cash = state.cashPence;
    state = act(state, { type: "CANCEL_CUSTOMER" });
    expect(countAt(state, "carrot", "shelf")).toBe(4);
    expect(countAt(state, "carrot", "crate")).toBe(1);
    const restored = state.crates.find((crate) => crate.productId === "carrot")!;
    expect(restored.position).not.toEqual(SAFE_DROP_POINTS[2]);
    expect(new Set(state.crates.map((crate) => `${crate.position.x}:${crate.position.z}`)).size).toBe(state.crates.length);
    expect(state.cashPence).toBe(cash);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      state = act(state, { type: "CUSTOMER_ADVANCE" });
      state = act(state, { type: "NEXT_CUSTOMER" });
      state = act(state, { type: "CUSTOMER_ADVANCE" });
      state = stock(state, "carrot", 1);
      expect(getRecyclingOffer(state)).toEqual({ allowed: true, rewardPence: 0 });
      state = recycle(state, "carrot");
      state = act(state, { type: "CANCEL_CUSTOMER" });
      expect(state.cashPence).toBe(cash);
      expect(countAt(state, "carrot", "crate")).toBe(1);
      expect(state.items).toHaveLength(5);
    }
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 5, incomeTodayPence: 10 });
  });

  it("keeps pickup capacity and exact single-item return ownership intact after a new delivery", () => {
    let state = recycle(paidEmptyBox(), "carrot");
    state = buy(state, [{ productId: "carrot", quantity: 1 }]);
    const goods = state.items.find((item) => item.location.kind === "crate")!;
    state = act(state, { type: "TAKE_ITEM", itemId: goods.id });
    expect(reduceSim(state, { type: "RECYCLE_CRATE" }).state).toBe(state);
    state = act(state, { type: "RETURN_ITEM" });
    expect(countAt(state, "carrot", "crate")).toBe(1);
    expect(state.items.find((item) => item.id === goods.id)!.location).toEqual({ kind: "crate", crateId: "carrot-crate" });
  });
});

describe("daily accounts and recycling audits", () => {
  it("merges later receipts into an unrecycled box across business days", () => {
    let state = buy(createFirstDayState(), [{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }]);
    state = drop(stock(state, "milk", 3));
    state = drop(stock(state, "bread", 3));
    for (let customer = 0; customer < 3; customer += 1) state = sale(state);
    state = act(state, { type: "SETTLE_DAY" });
    state = act(state, { type: "START_NEXT_DAY" });
    state = buy(state, [{ productId: "milk", quantity: 1 }]);
    state = recycle(stock(state, "milk", 1), "milk");
    expect(state.recyclingRecords[0]).toMatchObject({ dayNumber: 2, productId: "milk", purchaseIds: ["order-1", "order-2"], amountPence: 5 });
    expect(state.recyclingBatches.filter((batch) => batch.productId === "milk")).toHaveLength(1);
    expect(state.settlements[0]).toMatchObject({ recycledCrates: 0, recyclingIncomePence: 0 });
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 1, incomeTodayPence: 5 });
  });

  it("accounts cleanup after settlement on that day and carries the balance and sources into tomorrow", () => {
    let state = buy(createFirstDayState(), [{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }]);
    state = drop(stock(state, "milk", 3));
    state = drop(stock(state, "bread", 3));
    for (let customer = 0; customer < 3; customer += 1) state = sale(state);
    state = act(state, { type: "SETTLE_DAY" });
    expect(state.cashPence).toBe(1710);
    state = recycle(state, "milk");
    expect(state.cashPence).toBe(1715);
    expect(state.settlements[0]).toMatchObject({ revenuePence: 1200, grossProfitPence: 510, recycledCrates: 1, recyclingIncomePence: 5, closingCashPence: 1715 });
    state = act(state, { type: "BUY_UPGRADE" });
    expect(state.settlements[0]).toMatchObject({ recyclingIncomePence: 5, upgradeSpendPence: 800, closingCashPence: 915 });
    const yesterday = structuredClone(state.settlements[0]);
    state = act(state, { type: "START_NEXT_DAY" });
    expect(state.day.openingCashPence).toBe(915);
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 0, incomeTodayPence: 0 });
    state = recycle(state, "bread");
    expect(state.cashPence).toBe(920);
    expect(getDaySummary(state)).toMatchObject({ dayNumber: 2, revenuePence: 0, grossProfitPence: 0, recycledCrates: 1, recyclingIncomePence: 5, closingCashPence: 920 });
    expect(state.settlements[0]).toEqual(yesterday);
    expect(state.recyclingRecords.map((record) => record.dayNumber)).toEqual([1, 2]);
  });

  it.each([
    ["unrecorded income", (state: SimState) => { state.cashPence += 5 }],
    ["excess reward", (state: SimState) => { state.recyclingRecords[0]!.amountPence = 10; state.cashPence += 5 }],
    ["paid reward without sources", (state: SimState) => { state.recyclingRecords[0]!.purchaseIds = [] }],
    ["unknown paid source", (state: SimState) => { state.recyclingRecords[0]!.purchaseIds = ["not-purchased"] }],
    ["duplicate source inside a claim", (state: SimState) => { state.recyclingRecords[0]!.purchaseIds.push("order-1") }],
    ["future cleanup", (state: SimState) => { state.recyclingRecords[0]!.dayNumber = 2 }],
    ["fractional cleanup day", (state: SimState) => { state.recyclingRecords[0]!.dayNumber = 1.5 }],
    ["missing disposal record", (state: SimState) => { state.recyclingRecords = []; state.cashPence -= 5 }],
    ["wrong source product", (state: SimState) => { state.recyclingRecords[0]!.productId = "milk" }],
    ["duplicated reward under a fresh id", (state: SimState) => {
      state.recyclingRecords.push({ ...structuredClone(state.recyclingRecords[0]!), id: "recycle-2" }); state.cashPence += 5;
    }],
    ["missing recycling ledger", (state: SimState) => { delete (state as Partial<SimState>).recyclingRecords }],
    ["missing receipt batch ledger", (state: SimState) => { delete (state as Partial<SimState>).recyclingBatches }],
    ["unknown physical batch", (state: SimState) => { state.recyclingRecords[0]!.batchId = "crate-batch-99" }],
    ["duplicated source assigned to a second batch", (state: SimState) => {
      state.recyclingBatches.push({ ...structuredClone(state.recyclingBatches[0]!), id: "crate-batch-2" });
    }],
  ] as const)("rejects %s", (_description, corrupt) => {
    const state = recycle(paidEmptyBox(), "carrot");
    corrupt(state);
    expect(validateSimState(state)).toBe(false);
  });

  it("rejects splitting a merged physical box into two credited recycling records", () => {
    let state = buy(createFirstDayState(), [{ productId: "carrot", quantity: 1 }]);
    state = buy(state, [{ productId: "carrot", quantity: 1 }]);
    state = recycle(stock(state, "carrot", 2), "carrot");
    const original = state.recyclingRecords[0]!;
    state.recyclingRecords = [
      { ...original, purchaseIds: ["order-1"] },
      { ...original, id: "recycle-2", purchaseIds: ["order-2"] },
    ];
    state.cashPence += 5;
    expect(validateSimState(state)).toBe(false);
  });

  it("does not allow a pending paid source to justify a claimed reward", () => {
    const state = buy(recycle(createFirstDayState(), "milk"), [{ productId: "milk", quantity: 1 }], false);
    state.recyclingRecords[0]!.purchaseIds = ["order-1"];
    state.recyclingRecords[0]!.amountPence = 5;
    state.cashPence += 5;
    expect(validateSimState(state)).toBe(false);
  });
});
