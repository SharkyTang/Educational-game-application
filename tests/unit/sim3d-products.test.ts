import { receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { describe, expect, it } from "vitest";
import { payScannedCheckout } from "../helpers/sim3dPayment";
import { PRODUCT_ASSET_IDS, PRODUCT_ASSETS } from "../../src/sim3d/product-library/catalog";
import {
  PRODUCT_IDS, PRODUCTS, DELIVERY_DROP_POINTS, SAFE_DROP_POINTS, CRATE_CAPACITY,
  createFirstDayState, reduceSim, validateSimState, getPurchaseOffer, getDeliverySummary,
  getCustomerOrder, getShoppingProduct, canStartCustomer, countAt, capacityFor, getDaySummary,
  type ProductId, type PurchaseLine, type SimCommand, type SimState,
} from "../../src/sim3d/domain";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(JSON.parse(JSON.stringify(result.state)))).toBe(true);
  return result.state;
}

function order(state: SimState, lines: PurchaseLine[], id = `selection-${state.purchases.length + 1}`): SimState {
  return act(state, { type: "PURCHASE_STOCK", orderId: id, lines });
}

function stock(state: SimState, productId: ProductId, quantity: number): SimState {
  for (let index = 0; index < quantity; index += 1) {
    const item = state.items.find((candidate) => candidate.productId === productId && candidate.location.kind === "crate")!;
    const slot = Array.from({ length: capacityFor(state) }, (_, candidate) => candidate).find((candidate) => !state.items.some((entry) =>
      entry.location.kind === "shelf" && entry.location.productId === productId && entry.location.slot === candidate))!;
    state = act(state, { type: "TAKE_ITEM", itemId: item.id });
    state = act(state, { type: "STOCK", productId, slot });
  }
  return state;
}

function checkout(state: SimState): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  for (let step = 0; step < 3 && state.customer.phase !== "checkout"; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
  expect(state.customer.phase).toBe("checkout");
  return state;
}

function pay(state: SimState): SimState {
  for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  state = payScannedCheckout(state);
  return act(state, { type: "CUSTOMER_ADVANCE" });
}

function afterDays(days: number): SimState {
  let state = createFirstDayState();
  for (let day = 0; day < days; day += 1) {
    state = act(state, { type: "PURCHASE_STOCK", orderId: `startup-day-${day}`, pairs: 3 });
    state = receiveAllDeliveries(state);
    state = stock(stock(state, "milk", 3), "bread", 3);
    for (let customer = 0; customer < 3; customer += 1) state = pay(checkout(state));
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "SETTLE_DAY" });
    state = act(state, { type: "START_NEXT_DAY" });
  }
  return state;
}

describe("every product-library SKU in the real inventory and economy", () => {
  it("uses all 30 catalogue identities and phrases with deliberate positive game margins", () => {
    expect(PRODUCT_IDS).toEqual(PRODUCT_ASSET_IDS);
    expect(PRODUCT_IDS).toHaveLength(30);
    for (const id of PRODUCT_IDS) {
      expect(PRODUCTS[id]).toMatchObject({ nameEn: PRODUCT_ASSETS[id].nameEn, nameZh: PRODUCT_ASSETS[id].nameZh,
        phraseEn: PRODUCT_ASSETS[id].phraseEn, phraseZh: PRODUCT_ASSETS[id].phraseZh, category: PRODUCT_ASSETS[id].category });
      expect(Number.isSafeInteger(PRODUCTS[id].costPence)).toBe(true);
      expect(PRODUCTS[id].costPence).toBeGreaterThan(0);
      expect(PRODUCTS[id].pricePence).toBeGreaterThan(PRODUCTS[id].costPence);
    }
    expect(PRODUCTS.milk).toMatchObject({ costPence: 90, pricePence: 160 });
    expect(PRODUCTS.bread).toMatchObject({ costPence: 140, pricePence: 240 });
  });

  it.each(PRODUCT_IDS)("conserves %s through selection, doorstep receipt, display, single-product sale and JSON reload", (productId) => {
    let state = createFirstDayState();
    const initial = structuredClone(state);
    state = order(state, [{ productId, quantity: 1 }]);
    expect(state.items).toHaveLength(1);
    expect(countAt(state, productId, "delivery")).toBe(1);
    expect(state.cashPence).toBe(initial.cashPence - PRODUCTS[productId].costPence);
    expect(getCustomerOrder(state)).toEqual([]);
    expect(canStartCustomer(state)).toBe(false);
    if (productId !== "milk" && productId !== "bread") expect(state.crates.some((crate) => crate.productId === productId)).toBe(false);
    state = receiveAllDeliveries(state);
    const crate = state.crates.find((candidate) => candidate.productId === productId)!;
    expect(crate.id).toBe(`${productId}-crate`);
    expect(DELIVERY_DROP_POINTS).toContainEqual(crate.position);
    expect(countAt(state, productId, "crate")).toBe(1);
    state = act(state, { type: "INSPECT", productId });
    state = stock(state, productId, 1);
    expect(canStartCustomer(state)).toBe(true);
    state = act(state, { type: "OPEN_STORE" });
    state = JSON.parse(JSON.stringify(state)) as SimState;
    expect(getCustomerOrder(state)).toEqual([productId]);
    expect(state.inspectedProducts).toContain(productId);
    expect(getShoppingProduct(state)).toBe(productId);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(state.customer.phase).toBe("to-checkout");
    expect(getShoppingProduct(state)).toBeNull();
    expect(countAt(state, productId, "basket")).toBe(1);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(state.customer.phase).toBe("checkout");
    expect(countAt(state, productId, "checkout")).toBe(1);
    state = act(state, { type: "SCAN", itemId: state.items[0]!.id });
    expect(reduceSim(state, { type: "PAY", success: false }).state).toBe(state);
    state = act(state, { type: "PAY", success: true });
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]!.itemIds).toEqual([state.items[0]!.id]);
    expect(state.transactions[0]!.amountPence).toBe(PRODUCTS[productId].pricePence);
    expect(countAt(state, productId, "sold")).toBe(1);
    expect(state.cashPence).toBe(1200 - PRODUCTS[productId].costPence + PRODUCTS[productId].pricePence);
    expect(getDaySummary(state)).toMatchObject({ procurementPence: PRODUCTS[productId].costPence,
      revenuePence: PRODUCTS[productId].pricePence, grossProfitPence: PRODUCTS[productId].pricePence - PRODUCTS[productId].costPence });
    expect(reduceSim(state, { type: "PAY", success: true }).state).toBe(state);
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId: "selection-1", lines: [{ productId, quantity: 1 }] }).state).toBe(state);
    expect(initial.items).toEqual([]);
  });

  it("puts a new player's last-listed SKU close to the entrance instead of its catalogue index far down the street", () => {
    const productId = PRODUCT_IDS.at(-1)!;
    let state = order(createFirstDayState(), [{ productId, quantity: 1 }]);
    state = receiveAllDeliveries(state);
    expect(state.crates.find((crate) => crate.productId === productId)?.position).toEqual(DELIVERY_DROP_POINTS[0]);
  });

  it("supports an audited all-30-SKU delivery with distinct reusable boxes and per-product shelf capacity", () => {
    let state = afterDays(4);
    const lines = PRODUCT_IDS.map((productId) => ({ productId, quantity: 1 }));
    const before = state.cashPence;
    const expectedCost = PRODUCT_IDS.reduce((sum, id) => sum + PRODUCTS[id].costPence, 0);
    state = order(state, lines);
    expect(getDeliverySummary(state)).toMatchObject({ pendingUnits: 30, pendingOrders: 1 });
    expect(state.crates).toHaveLength(2);
    state = receiveAllDeliveries(state);
    expect(state.crates).toHaveLength(30);
    expect(new Set(state.crates.map((crate) => `${crate.position.x}:${crate.position.z}`)).size).toBe(30);
    expect(state.cashPence).toBe(before - expectedCost);
    for (const productId of PRODUCT_IDS) {
      expect(countAt(state, productId, "crate")).toBe(1);
      state = stock(state, productId, 1);
      expect(countAt(state, productId, "shelf")).toBe(1);
    }
    const selected = act(state, { type: "OPEN_STORE" });
    expect(getCustomerOrder(selected)).toHaveLength(2);
    expect(new Set(getCustomerOrder(selected)).size).toBe(2);
    for (const id of getCustomerOrder(selected)) expect(countAt(selected, id, "shelf")).toBe(1);
    expect(state.items.filter((item) => item.location.kind === "shelf")).toHaveLength(30);
  });
});

describe("explicit selected purchase input and conserved reservations", () => {
  it("normalizes valid distinct rows without changing the caller's cart and preserves idempotency across row order", () => {
    const lines: PurchaseLine[] = [{ productId: "soap", quantity: 2 }, { productId: "apple", quantity: 3 }];
    const original = structuredClone(lines);
    const offer = getPurchaseOffer(createFirstDayState(), lines);
    expect(offer).toEqual({ lines: [{ productId: "apple", quantity: 3 }, { productId: "soap", quantity: 2 }],
      unitCount: 5, costPence: 230, allowed: true });
    expect(lines).toEqual(original);
    const state = order(createFirstDayState(), lines, "cart-once");
    expect(state.purchases[0]?.pairs).toBeUndefined();
    const replay = reduceSim(state, { type: "PURCHASE_STOCK", orderId: "cart-once", lines: [...lines].reverse() });
    expect(replay.state).toBe(state);
    expect(replay.changed).toBe(false);
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId: "cart-once", lines: [{ productId: "coffee", quantity: 1 }] }).state).toBe(state);
  });

  it.each([[], [{ productId: "soap", quantity: 1 }, { productId: "soap", quantity: 1 }], [{ productId: "not-a-sku", quantity: 1 }],
    [{ productId: "soap", quantity: 0 }], [{ productId: "soap", quantity: -1 }], [{ productId: "soap", quantity: 9 }],
    [{ productId: "soap", quantity: 1.5 }], [{ productId: "soap", quantity: Number.NaN }],
    [{ productId: "soap", quantity: Number.POSITIVE_INFINITY }], [{ productId: "soap", quantity: "2" }],
    [{ productId: "soap", quantity: null }], [null], [{ productId: "soap" }],
  ].map((input) => ({ input })))("rejects an empty, duplicate, unknown or invalid selection %# without debit or merchandise", ({ input }) => {
    const state = createFirstDayState();
    const lines = input as unknown as PurchaseLine[];
    expect(getPurchaseOffer(state, lines).allowed).toBe(false);
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId: "invalid", lines }).state).toBe(state);
  });

  it("rejects unaffordable selections without silently changing quantities", () => {
    const state = createFirstDayState();
    expect(getPurchaseOffer(state, [{ productId: "coffee", quantity: 5 }])).toMatchObject({ allowed: false, unitCount: 5, costPence: 1250 });
    expect(reduceSim(state, { type: "PURCHASE_STOCK", orderId: "too-costly", lines: [{ productId: "coffee", quantity: 5 }] }).state).toBe(state);
  });

  it("reserves each SKU's crate capacity across pending goods and a hand-held item's return", () => {
    let state = order(createFirstDayState(), [{ productId: "carrot", quantity: 8 }]);
    expect(getPurchaseOffer(state, [{ productId: "carrot", quantity: 1 }]).allowed).toBe(false);
    state = receiveAllDeliveries(state);
    state = stock(state, "carrot", 4);
    state = order(state, [{ productId: "carrot", quantity: 4 }]);
    const item = state.items.find((candidate) => candidate.location.kind === "crate")!;
    state = act(state, { type: "TAKE_ITEM", itemId: item.id });
    expect(countAt(state, "carrot", "crate")).toBe(3);
    expect(getPurchaseOffer(state, [{ productId: "carrot", quantity: 1 }]).allowed).toBe(false);
    expect(getPurchaseOffer(state, [{ productId: "water", quantity: 1 }]).allowed).toBe(true);
    expect(reduceSim(state, { type: "RECEIVE_DELIVERY", orderId: state.delivery.orderId ?? "already-received" }).state).toBe(state);
    state = act(state, { type: "RETURN_ITEM" });
    state = receiveAllDeliveries(state);
    expect(countAt(state, "carrot", "crate")).toBe(CRATE_CAPACITY);
    expect(countAt(state, "carrot", "shelf")).toBe(4);
  });

  it("keeps empty box locations reserved so canceled single-SKU goods cannot reappear inside another box", () => {
    let state = order(createFirstDayState(), [{ productId: "carrot", quantity: 4 }]);
    state = receiveAllDeliveries(state);
    state = stock(state, "carrot", 4);
    const emptyPosition = state.crates.find((crate) => crate.productId === "carrot")!.position;
    state = order(state, [{ productId: "soap", quantity: 1 }]);
    state = receiveAllDeliveries(state);
    expect(state.crates.find((crate) => crate.productId === "soap")!.position).not.toEqual(emptyPosition);
    state = act(state, { type: "OPEN_STORE" });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    state = order(state, [{ productId: "carrot", quantity: 1 }]);
    state = receiveAllDeliveries(state);
    state = stock(state, "carrot", 1);
    const beforeCash = state.cashPence;
    state = act(state, { type: "CANCEL_CUSTOMER" });
    expect(countAt(state, "carrot", "crate")).toBe(1);
    expect(countAt(state, "carrot", "shelf")).toBe(4);
    expect(state.cashPence).toBe(beforeCash);
    expect(new Set(state.crates.map((crate) => `${crate.position.x}:${crate.position.z}`)).size).toBe(state.crates.length);
  });

  it("refuses a direct drop into another empty reusable box's reserved position", () => {
    let state = act(createFirstDayState(), { type: "PICK_CRATE", crateId: "milk-crate" });
    expect(reduceSim(state, { type: "DROP_HELD", position: state.crates[1]!.position }).state).toBe(state);
    state = act(state, { type: "DROP_HELD", position: SAFE_DROP_POINTS[2]! });
    expect(validateSimState(state)).toBe(true);
  });
});

describe("frozen current orders, variable checkout size and save validation", () => {
  it("keeps a chosen order through reload, later delivery and a temporarily emptied requested shelf", () => {
    let state = order(createFirstDayState(), [{ productId: "water", quantity: 1 }, { productId: "apple", quantity: 1 }, { productId: "soap", quantity: 1 }]);
    state = receiveAllDeliveries(state);
    for (const id of ["water", "apple", "soap"] as const) state = stock(state, id, 1);
    state = act(state, { type: "OPEN_STORE" });
    const request = [...getCustomerOrder(state)];
    expect(request).toHaveLength(2);
    state = JSON.parse(JSON.stringify(state)) as SimState;
    state = order(state, [{ productId: "coffee", quantity: 1 }]);
    state = receiveAllDeliveries(state);
    state = stock(state, "coffee", 1);
    expect(getCustomerOrder(state)).toEqual(request);
    const firstItem = state.items.find((item) => item.productId === request[0] && item.location.kind === "shelf")!;
    state = act(state, { type: "TAKE_ITEM", itemId: firstItem.id });
    expect(reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state).toBe(state);
    expect(getShoppingProduct(state)).toBe(request[0]);
    state = act(state, { type: "RETURN_ITEM" });
    for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(state.items.filter((item) => item.location.kind === "checkout").map((item) => item.productId).sort()).toEqual([...request].sort());
    const beforeCash = state.cashPence;
    state = pay(state);
    expect(state.cashPence).toBe(beforeCash + request.reduce((sum, id) => sum + PRODUCTS[id].pricePence, 0));
    expect(getCustomerOrder(state)).toEqual(request);
  });

  it.each([
    ["missing selected lines", (state: SimState) => { delete (state.purchases[0] as Partial<typeof state.purchases[number]>).lines }],
    ["changed quantity", (state: SimState) => { state.purchases[0]!.lines[0]!.quantity = 2 }],
    ["duplicate selected row", (state: SimState) => { state.purchases[0]!.lines.push({ ...state.purchases[0]!.lines[0]! }) }],
    ["unpaid extra item", (state: SimState) => { state.items.push({ id: "free-soap", productId: "soap", location: { kind: "delivery", orderId: state.purchases[0]!.id } }) }],
    ["invented discount", (state: SimState) => { state.purchases[0]!.amountPence -= 1; state.cashPence += 1 }],
    ["legacy pair conflicting with selection", (state: SimState) => { state.purchases[0]!.pairs = 1 }],
    ["missing current shopping list", (state: SimState) => { delete (state.customer as Partial<typeof state.customer>).shoppingList }],
    ["unpaid extra crate", (state: SimState) => { state.crates.push({ id: "soap-crate", productId: "soap", position: { ...DELIVERY_DROP_POINTS[5]! } }) }],
  ])("rejects %s rather than weakening the v6 ledger", (_label, mutate) => {
    const state = order(createFirstDayState(), [{ productId: "soap", quantity: 1 }]);
    mutate(state);
    expect(validateSimState(state)).toBe(false);
  });

  it("rejects a checkout re-labelled with a different shopping list and deletion of a sold SKU's reusable crate", () => {
    let state = order(createFirstDayState(), [{ productId: "soap", quantity: 1 }]);
    state = receiveAllDeliveries(state);
    state = checkout(stock(state, "soap", 1));
    const relabelled = structuredClone(state);
    relabelled.customer.shoppingList = ["milk"];
    expect(validateSimState(relabelled)).toBe(false);
    state = pay(state);
    const lostCrate = structuredClone(state);
    lostCrate.crates = lostCrate.crates.filter((crate) => crate.productId !== "soap");
    expect(validateSimState(lostCrate)).toBe(false);
  });
});
