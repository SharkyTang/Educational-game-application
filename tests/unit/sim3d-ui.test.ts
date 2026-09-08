import { waitForDelivery, receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { describe, expect, it, vi } from "vitest";
import { createFirstDayState, createInitialSimState, getDeliverySummary, PRODUCTS, reduceSim, type ProductId, type SimState } from "../../src/sim3d/domain";
import type { InteractionTarget } from "../../src/sim3d/world";
import { payScannedCheckout } from "../helpers/sim3dPayment";
import { computerPurchaseOrders, computerPurchaseOrdersMarkup } from "../../src/sim3d/shopComputer";

// Pure UI decisions do not require a WebGL engine or a browser document.
vi.mock("../../src/sim3d/world", () => ({ ShopWorld: class {} }));
import { commandForInteraction, inspectableProduct, interactionInReach, parsePurchaseQuantities } from "../../src/sim3d/App3D";

function target(overrides: Partial<InteractionTarget> = {}): InteractionTarget {
  return { id: "milk-crate", kind: "crate", crateId: "milk-crate", productId: "milk", label: "牛奶货箱", action: "抱起货箱", inspectable: true, distance: 1.3, ...overrides };
}

function checkoutState(): SimState {
  let state = createInitialSimState();
  for (const productId of ["milk", "bread"] as const) {
    state = reduceSim(state, { type: "TAKE_ITEM", itemId: `${productId}-1` }).state;
    state = reduceSim(state, { type: "STOCK", productId, slot: 0 }).state;
  }
  state = reduceSim(state, { type: "OPEN_STORE" }).state;
  for (let index = 0; index < 3; index += 1) state = reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state;
  return state;
}

describe("3D accessible interaction decisions", () => {
  it.each([2.61, 20, Infinity, NaN, -1])("rejects distant or invalid target distance %s", (distance) => {
    const object = target({ distance });
    expect(interactionInReach(object)).toBe(false);
    expect(commandForInteraction(createInitialSimState(), object).command).toBeUndefined();
    expect(inspectableProduct(createInitialSimState(), object)).toBeNull();
  });

  it("does not invent an interaction when the player is not looking at an object", () => {
    expect(commandForInteraction(createInitialSimState(), null)).toEqual({});
    expect(inspectableProduct(createInitialSimState(), null)).toBeNull();
  });

  it("uses the opening sign for manual opening only, never to skip a scheduled arrival or reopen after closing", () => {
    const sign = target({ kind: "open-sign", id: "open-sign", inspectable: false });
    expect(commandForInteraction(createFirstDayState(), sign)).toEqual({ command: { type: "OPEN_STORE" } });
    let state = checkoutState();
    expect(commandForInteraction(state, sign)).toEqual({ message: expect.stringContaining("电脑") });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = reduceSim(state, { type: "SCAN", itemId: item.id }).state;
    state = reduceSim(payScannedCheckout(state), { type: "CUSTOMER_ADVANCE" }).state;
    expect(state.day.nextCustomerAtMs).toBeGreaterThan(state.day.elapsedOpenMs);
    expect(commandForInteraction(state, sign)).toEqual({ message: expect.stringContaining("电脑") });
    state = reduceSim(state, { type: "CLOSE_STORE" }).state;
    expect(commandForInteraction(state, sign)).toEqual({ message: expect.stringContaining("电脑") });
    state = reduceSim(state, { type: "SETTLE_DAY" }).state;
    expect(commandForInteraction(state, sign)).toEqual({ message: expect.stringContaining("电脑") });
  });

  it("keeps the real counter available to finish an unpaid order after closing", () => {
    let state = reduceSim(checkoutState(), { type: "CLOSE_STORE" }).state;
    const counter = target({ id: "counter", kind: "counter", inspectable: false });
    for (let item = 0; item < 2; item += 1) {
      const decision = commandForInteraction(state, counter);
      expect(decision.command?.type).toBe("SCAN");
      state = reduceSim(state, decision.command!).state;
    }
    expect(commandForInteraction(state, counter)).toEqual({ command: { type: "PAY", success: true } });
    state = reduceSim(state, commandForInteraction(state, counter).command!).state;
    expect(state.day.phase).toBe("closing");
    expect(state.transactions).toHaveLength(1);
  });

  it("maps a nearby crate to a real pickup and nearby shelf to its first empty slot", () => {
    let state = createInitialSimState();
    const pickup = commandForInteraction(state, target()).command!;
    expect(pickup).toEqual({ type: "PICK_CRATE", crateId: "milk-crate" });
    state = reduceSim(state, pickup).state;
    const rack = target({ kind: "shelf", id: "milk-shelf" });
    const stock = commandForInteraction(state, rack).command!;
    expect(stock).toEqual({ type: "STOCK", productId: "milk", slot: 0 });
    state = reduceSim(state, stock).state;
    expect(commandForInteraction(state, rack).command).toEqual({ type: "STOCK", productId: "milk", slot: 1 });
    for (let slot = 1; slot < 4; slot += 1) state = reduceSim(state, { type: "STOCK", productId: "milk", slot }).state;
    expect(commandForInteraction(state, rack)).toEqual({ message: "这一侧货架已经放满了。" });
    expect(inspectableProduct(state, target())).toBeNull();
  });

  it("prefers the real held product over a different product under the crosshair", () => {
    const state = reduceSim(createInitialSimState(), { type: "TAKE_ITEM", itemId: "bread-1" }).state;
    expect(inspectableProduct(state, target())).toBe("bread");
    expect(inspectableProduct(state, null)).toBe("bread");
    expect(commandForInteraction(state, target({ kind: "drop-zone", position: { x: -1.1, z: 2.6 } })).command).toEqual({ type: "RETURN_ITEM" });
  });

  it("the counter scans each unswept item before creating the payment command", () => {
    let state = checkoutState();
    const counter = target({ id: "counter", kind: "counter", inspectable: false });
    const first = commandForInteraction(state, counter).command!;
    expect(first).toEqual({ type: "SCAN", itemId: "milk-1" });
    state = reduceSim(state, first).state;
    const second = commandForInteraction(state, counter).command!;
    expect(second).toEqual({ type: "SCAN", itemId: "bread-1" });
    state = reduceSim(state, second).state;
    const pay = commandForInteraction(state, counter).command!;
    expect(pay).toEqual({ type: "PAY", success: true });
    state = reduceSim(state, pay).state;
    expect(commandForInteraction(state, counter).command).toBeUndefined();
    expect(state.cashPence).toBe(400);
  });

  it("routes a scanned cash customer to the cash register, never the old PAY shortcut", () => {
    let state: SimState = { ...checkoutState(), payment: {
      method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true,
      received: false, selectedChange: [],
    } };
    const counter = target({ id: "counter", kind: "counter", inspectable: false });
    for (let index = 0; index < 2; index += 1) {
      const decision = commandForInteraction(state, counter);
      expect(decision.cashRegister).toBeUndefined();
      expect(decision.command?.type).toBe("SCAN");
      state = reduceSim(state, decision.command!).state;
    }
    expect(commandForInteraction(state, counter)).toEqual({ cashRegister: true });
    expect(commandForInteraction(state, { ...counter, distance: 3 }).cashRegister).toBeUndefined();
    expect(commandForInteraction(state, null).cashRegister).toBeUndefined();
    state = reduceSim(state, { type: "RECEIVE_CASH" }).state;
    expect(commandForInteraction(state, counter)).toEqual({ cashRegister: true });
    expect(state.cashPence).toBe(0);
  });

  it("distinguishes a checkout item from an item available for pickup", () => {
    const object = target({ kind: "item", itemId: "milk-1" });
    expect(commandForInteraction(createInitialSimState(), object).command).toEqual({ type: "TAKE_ITEM", itemId: "milk-1" });
    expect(commandForInteraction(checkoutState(), object).command).toEqual({ type: "SCAN", itemId: "milk-1" });
  });

  it("requires an actual target position to put a crate down", () => {
    const state = reduceSim(createInitialSimState(), { type: "PICK_CRATE", crateId: "milk-crate" }).state;
    expect(commandForInteraction(state, target({ kind: "drop-zone" })).command).toBeUndefined();
    expect(commandForInteraction(state, target({ kind: "drop-zone", position: { x: -1.1, z: 2.6 } })).command)
      .toEqual({ type: "DROP_HELD", position: { x: -1.1, z: 2.6 } });
  });

  it("receives paid delivery only through an in-reach target and never charges again", () => {
    const state = waitForDelivery(reduceSim(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "ui-delivery", pairs: 3 }).state);
    const truck = target({ kind: "delivery", id: "delivery-truck", inspectable: false });
    expect(commandForInteraction(state, { ...truck, distance: 2.61 }).command).toBeUndefined();
    expect(getDeliverySummary(state).pendingUnits).toBe(6);
    const receive = commandForInteraction(state, truck).command!;
    expect(receive).toEqual({ type: "RECEIVE_DELIVERY", orderId: "ui-delivery" });
    const delivered = reduceSim(state, receive).state;
    expect(delivered.cashPence).toBe(state.cashPence);
    expect(getDeliverySummary(delivered).pendingUnits).toBe(0);
    expect(commandForInteraction(delivered, truck)).toEqual({ message: expect.stringContaining("电脑") });
  });

  it("explains why a delivery cannot unload when the player's hands are full", () => {
    let state = reduceSim(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "first-batch", pairs: 1 }).state;
    state = receiveAllDeliveries(state);
    state = reduceSim(state, { type: "PICK_CRATE", crateId: "milk-crate" }).state;
    state = reduceSim(state, { type: "PURCHASE_STOCK", orderId: "second-batch", pairs: 1 }).state;
    state = waitForDelivery(state);
    const decision = commandForInteraction(state, target({ kind: "delivery", inspectable: false }));
    expect(decision.command).toBeUndefined();
    expect(decision.computer).toBeUndefined();
    expect(decision.message).toContain("先放下");
    expect(getDeliverySummary(state).pendingOrders).toBe(1);
  });

  it("routes nearby future shop signs to their requirements without creating an entry command", () => {
    const sign = target({ kind: "venue", id: "restaurant-sign", venueId: "restaurant", inspectable: false });
    expect(commandForInteraction(createFirstDayState(), sign)).toEqual({ venueId: "restaurant" });
    expect(commandForInteraction(createFirstDayState(), { ...sign, distance: 10 }).computer).toBeUndefined();
    expect(inspectableProduct(createFirstDayState(), sign)).toBeNull();
  });

  it("opens only the named, nearby street neighbour and rejects distant or untagged actors", () => {
    const sam = target({
      id: "street-neighbour-sam", kind: "street-neighbour", streetNeighbourId: "sam", inspectable: false,
    });
    expect(commandForInteraction(createFirstDayState(), sam)).toEqual({ streetNeighbourId: "sam" });
    expect(commandForInteraction(createFirstDayState(), { ...sam, distance: 2.61 })).toEqual({
      message: "再走近一点，才能操作这件物品。",
    });
    expect(commandForInteraction(createFirstDayState(), { ...sam, streetNeighbourId: undefined })).toEqual({
      message: "这位街头邻居暂时不能交谈。",
    });
    expect(inspectableProduct(createFirstDayState(), sam)).toBeNull();
  });

  it("recycles only a held empty box through the real, nearby recycling target", () => {
    let state = reduceSim(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "recycling-ui", lines: [{ productId: "milk", quantity: 1 }] }).state;
    state = receiveAllDeliveries(state);
    const station = target({ id: "cardboard-recycling", kind: "recycling", productId: undefined, crateId: undefined, inspectable: false });
    expect(commandForInteraction(state, station).command).toBeUndefined();
    state = reduceSim(state, { type: "PICK_CRATE", crateId: "milk-crate" }).state;
    expect(commandForInteraction(state, station).command).toBeUndefined();
    state = reduceSim(state, { type: "STOCK", productId: "milk", slot: 0 }).state;
    expect(commandForInteraction(state, null).command).toBeUndefined();
    expect(commandForInteraction(state, { ...station, distance: 2.61 }).command).toBeUndefined();
    const recycle = commandForInteraction(state, station).command!;
    expect(recycle).toEqual({ type: "RECYCLE_CRATE" });
    const recycled = reduceSim(state, recycle).state;
    expect(recycled.cashPence).toBe(state.cashPence + 5);
    expect(recycled.held.kind).toBe("none");
    expect(recycled.crates.some((crate) => crate.id === "milk-crate")).toBe(false);
    expect(commandForInteraction(recycled, station).command).toBeUndefined();
    expect(inspectableProduct(recycled, station)).toBeNull();
  });

  it("keeps G/drop-zone placement separate from recycling and never discards held merchandise", () => {
    const state = reduceSim(createInitialSimState(), { type: "TAKE_ITEM", itemId: "milk-1" }).state;
    const station = target({ id: "cardboard-recycling", kind: "recycling", inspectable: false });
    expect(commandForInteraction(state, station).command).toBeUndefined();
    const dropZone = target({ kind: "drop-zone", position: { x: -1.1, z: 2.6 } });
    expect(commandForInteraction(state, dropZone).command).toEqual({ type: "RETURN_ITEM" });
    expect(state.items.find((item) => item.id === "milk-1")?.location.kind).toBe("hand");
  });

  it("uses the opening sign to explain end-of-day deliveries instead of starting an extra customer", () => {
    let state = createInitialSimState();
    for (const productId of ["milk", "bread"] as const) {
      state = reduceSim(state, { type: "PICK_CRATE", crateId: `${productId}-crate` }).state;
      for (let slot = 0; slot < 4; slot += 1) state = reduceSim(state, { type: "STOCK", productId, slot }).state;
      state = reduceSim(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position }).state;
    }
    for (let guest = 0; guest < 3; guest += 1) {
      state = reduceSim(state, { type: guest === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" }).state;
      for (let stop = 0; stop < 3; stop += 1) state = reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state;
      for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = reduceSim(state, { type: "SCAN", itemId: item.id }).state;
      state = payScannedCheckout(state);
      state = reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state;
    }
    state = reduceSim(state, { type: "PURCHASE_STOCK", orderId: "end-of-day-delivery", pairs: 1 }).state;
    expect(getDeliverySummary(state).pendingUnits).toBe(2);
    expect(state.transactions).toHaveLength(3);
    expect(commandForInteraction(state, target({ kind: "open-sign", inspectable: false }))).toEqual({ message: expect.stringContaining("电脑") });
  });
});

describe("manually selected procurement quantities", () => {
  it("never fills an empty cart or converts zero into a default purchase", () => {
    expect(parsePurchaseQuantities(new Map())).toEqual({ lines: [], invalidProductIds: [] });
    expect(parsePurchaseQuantities(new Map([["milk", "0"], ["bread", "0"]]))).toEqual({ lines: [], invalidProductIds: [] });
  });

  it("keeps independently chosen product amounts and does not add milk or bread", () => {
    expect(parsePurchaseQuantities(new Map<ProductId, string>([["soap", "1"], ["apple", "2"]]))).toEqual({
      lines: [{ productId: "apple", quantity: 2 }, { productId: "soap", quantity: 1 }], invalidProductIds: [],
    });
  });

  it.each(["", "-1", "1.5", "NaN", "Infinity", "9", "abc"])("flags invalid quantity %s even with another valid selection", (value) => {
    const selected = parsePurchaseQuantities(new Map<ProductId, string>([["milk", "1"], ["apple", value]]));
    expect(selected.invalidProductIds).toEqual(["apple"]);
    expect(selected.error).toContain("苹果");
    expect(selected.error).toContain("0–8");
    expect(selected.lines).toEqual([{ productId: "milk", quantity: 1 }]);
  });

  it("scans and pays for a single newly integrated product without assuming a second item", () => {
    let state = reduceSim(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "one-soap", lines: [{ productId: "soap", quantity: 1 }] }).state;
    state = receiveAllDeliveries(state);
    const item = state.items.find((entry) => entry.productId === "soap")!;
    state = reduceSim(state, { type: "TAKE_ITEM", itemId: item.id }).state;
    expect(inspectableProduct(state, null)).toBe("soap");
    state = reduceSim(state, { type: "STOCK", productId: "soap", slot: 0 }).state;
    state = reduceSim(state, { type: "OPEN_STORE" }).state;
    for (let stop = 0; stop < 3 && state.customer.phase !== "checkout"; stop += 1) state = reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state;
    const counter = target({ id: "counter", kind: "counter", inspectable: false });
    expect(commandForInteraction(state, counter).command).toEqual({ type: "SCAN", itemId: item.id });
    state = reduceSim(state, commandForInteraction(state, counter).command!).state;
    expect(commandForInteraction(state, counter).command).toEqual({ type: "PAY", success: true });
    state = reduceSim(state, commandForInteraction(state, counter).command!).state;
    expect(state.transactions[0]?.amountPence).toBe(PRODUCTS.soap.pricePence);
  });
});

describe("computer per-order delivery ledger", () => {
  function orderedState(): SimState {
    let state = createFirstDayState();
    for (const [orderId, productId, quantity] of [["ledger-1", "apple", 2], ["ledger-2", "soap", 1], ["ledger-3", "bread", 1]] as const) {
      const purchase = reduceSim(state, { type: "PURCHASE_STOCK", orderId, lines: [{ productId, quantity }] });
      expect(purchase.changed).toBe(true);
      state = purchase.state;
    }
    return state;
  }

  it("shows exact line quantities and paid amounts in purchase order without giving every order a 12-second ETA", () => {
    const state = orderedState();
    const rows = computerPurchaseOrders(state);
    expect(rows.map((row) => row.id)).toEqual(["ledger-1", "ledger-2", "ledger-3"]);
    expect(rows[0]).toMatchObject({ title: "第 1 单 · 第 1 天采购", products: "苹果 × 2", amount: `£${(PRODUCTS.apple.costPence * 2 / 100).toFixed(2)}`, status: "备货中 · 约 12 秒后停稳" });
    expect(rows.slice(1).map((row) => row.status)).toEqual(["排队中 · 前方 1 单", "排队中 · 前方 2 单"]);
    expect(state.purchases.every((order) => order.receivedDay === null)).toBe(true);
  });

  it("keeps a received but departing vehicle ahead of queued orders, then advances their count only after departure", () => {
    let state = waitForDelivery(orderedState());
    expect(computerPurchaseOrders(state)[0]?.status).toContain("待签收");
    state = reduceSim(state, { type: "RECEIVE_DELIVERY", orderId: "ledger-1" }).state;
    const afterReceipt = computerPurchaseOrders(state);
    expect(afterReceipt[0]).toMatchObject({ awaitingReceipt: false, status: "已签收 · 货车驶离中，约 4 秒" });
    expect(afterReceipt.slice(1).map((row) => [row.awaitingReceipt, row.status])).toEqual([[true, "排队中 · 前方 1 单"], [true, "排队中 · 前方 2 单"]]);
    expect(state.purchases.slice(1).every((order) => order.receivedDay === null)).toBe(true);
    state = reduceSim(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 4000, blocked: false }).state;
    expect(computerPurchaseOrders(state).map((row) => row.status)).toEqual(["已签收 · 第 1 天", "备货中 · 约 12 秒后停稳", "排队中 · 前方 1 单"]);
    state = reduceSim(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 6000, blocked: false }).state;
    state = reduceSim(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 1000, blocked: true }).state;
    expect(computerPurchaseOrders(state)[1]?.status).toContain("驶入暂停 · 让行中");
  });

  it("retains all pending and current-day orders plus the most recent historical receipt", () => {
    const base = orderedState();
    const historical = [0, 1, 2].map((index) => ({ ...base.purchases[0]!, id: `history-${index}`, dayNumber: index + 1, receivedDay: index + 1 }));
    const state = { ...base, day: { ...base.day, number: 5 }, purchases: [
      ...historical,
      { ...base.purchases[0]!, id: "current-received", dayNumber: 5, receivedDay: 5 },
      { ...base.purchases[1]!, dayNumber: 5 },
    ], delivery: { ...base.delivery, orderId: "ledger-2" } };
    expect(computerPurchaseOrders(state).map((row) => row.id)).toEqual(["current-received", "ledger-2"]);
    state.day.number = 6;
    expect(computerPurchaseOrders(state).map((row) => row.id)).toEqual(["current-received", "ledger-2"]);
    expect(computerPurchaseOrders(state)[0]?.title).toBe("第 4 单 · 第 5 天采购");
  });

  it("escapes every dynamic markup field and explains an empty ledger", () => {
    const attack = '<img src=x onerror="alert(1)">';
    const markup = computerPurchaseOrdersMarkup([{ id: '" onmouseover="oops', title: attack, products: attack, amount: attack, status: attack, awaitingReceipt: true }]);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    expect(markup).toContain('data-order-id="&quot; onmouseover=&quot;oops"');
    expect(computerPurchaseOrdersMarkup([])).toContain("还没有进货订单");
  });
});
