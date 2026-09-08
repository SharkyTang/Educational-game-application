import { describe, expect, it } from "vitest";
import {
  canSettleDay, countAt, createFirstDayState, getDeliverySummary, getObjective, getPurchaseOffer, getRecyclingSummary,
  migrateV14SimState, reduceSim, validateSimState, validateV14SimState, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { getBusinessClock } from "../../src/sim3d/businessTime";
import { asV14BusinessSnapshot, finishDeliveryDeparture, receiveAllDeliveries, waitForDelivery } from "../helpers/sim3dDelivery";
import { payScannedCheckout } from "../helpers/sim3dPayment";
import {
  SIM_STORAGE_KEY, SIM_V14_STORAGE_KEY, SIM_V14_BACKUP_KEY, SIM_WRITER_LOCK,
  loadSimState, parseImportedSimState, saveSimState, SimSaveSession, type StorageLike,
} from "../../src/sim3d/persistence";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(result.state.revision).toBe(state.revision + 1);
  expect(validateSimState(result.state), command.type).toBe(true);
  return result.state;
}
function order(state: SimState, id: string, productId: "milk" | "bread" | "soap" = "soap", quantity = 1): SimState {
  return act(state, { type: "PURCHASE_STOCK", orderId: id, lines: [{ productId, quantity }] });
}
function receive(state: SimState): SimState {
  return act(state, { type: "RECEIVE_DELIVERY", orderId: state.delivery.orderId! });
}
function stocked(): SimState {
  let state = receiveAllDeliveries(order(createFirstDayState(), "opening"));
  state = act(state, { type: "PICK_CRATE", crateId: "soap-crate" });
  state = act(state, { type: "STOCK", productId: "soap", slot: 0 });
  return act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.id === "soap-crate")!.position });
}
class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void { this.data.set(key, value) }
}

describe("v15 order-specific delivery and repeated same-day purchasing", () => {
  it("directs procurement and settlement through the shop computer", () => {
    let state = createFirstDayState();
    expect(getObjective(state)).toContain("走近店务电脑按 E");
    expect(getObjective(state)).toContain("进货");
    state = act(state, { type: "CLOSE_STORE" });
    expect(getObjective(state)).toContain("走近店务电脑按 E");
    expect(getObjective(state)).toContain("营业 / 日结");
  });
  it("keeps a relocated computer usable when unloading a received box", () => {
    let state = createFirstDayState();
    state = act(state, { type: "APPLY_SHOP_LAYOUT", layout: { ...state.renovation.layout,
      workstation: { x: -1.1, z: 1.75, rotation: 0 } } });
    state = receiveAllDeliveries(order(state, "one", "soap"));
    state = act(state, { type: "PICK_CRATE", crateId: "soap-crate" });
    const result = reduceSim(state, { type: "DROP_HELD", position: { x: -1.1, z: 2.6 } });
    expect(result.state).toBe(state);
    expect(result.changed).toBe(false);
    expect(result.message).toContain("电脑的操作位置");
    expect(state.held).toEqual({ kind: "crate", crateId: "soap-crate" });
    state = act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.id === "soap-crate")!.position });
    expect(state.held.kind).toBe("none");
  });
  it("charges three FIFO orders once and cannot sign for any before twelve active seconds", () => {
    let state = order(createFirstDayState(), "one", "soap");
    state = order(state, "two", "milk");
    state = order(state, "three", "bread");
    const paidCash = state.cashPence;
    expect(getDeliverySummary(state)).toMatchObject({ phase: "preparing", orderId: "one", pendingOrders: 3, queuedOrders: 2, remainingMs: 12_000 });
    const original = structuredClone(state);
    for (const orderId of ["one", "two", "three", "missing"]) {
      expect(reduceSim(state, { type: "RECEIVE_DELIVERY", orderId }).state).toBe(state);
    }
    state = act(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 11_999, blocked: false });
    expect(getDeliverySummary(state).canReceive).toBe(false);
    state = act(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 1, blocked: false });
    expect(getDeliverySummary(state)).toMatchObject({ readyUnits: 1, canReceive: true, pendingUnits: 3 });
    expect(reduceSim(state, { type: "RECEIVE_DELIVERY", orderId: "two" }).state).toBe(state);
    state = receive(state);
    expect(state.cashPence).toBe(paidCash);
    expect(state.purchases.map((purchase) => purchase.receivedDay)).toEqual([1, null, null]);
    expect(countAt(state, "soap", "crate")).toBe(1);
    expect(countAt(state, "milk", "delivery")).toBe(1);
    expect(countAt(state, "bread", "delivery")).toBe(1);
    expect(reduceSim(state, { type: "RECEIVE_DELIVERY", orderId: "one" }).state).toBe(state);
    state = act(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 3_999, blocked: false });
    expect(state.delivery).toMatchObject({ phase: "departing", orderId: "one" });
    state = act(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 1, blocked: false });
    expect(state.delivery).toMatchObject({ phase: "preparing", orderId: "two", elapsedMs: 0 });
    state = receiveAllDeliveries(state);
    expect(state.purchases.map((purchase) => purchase.receivedDay)).toEqual([1, 1, 1]);
    expect(state.cashPence).toBe(paidCash);
    expect(state.day.number).toBe(1);
    expect(state.day.elapsedOpenMs).toBe(0);
    expect(original.purchases.every((purchase) => purchase.receivedDay === null)).toBe(true);
  });
  it("allows purchasing during an active customer without changing that basket or payment", () => {
    let state = act(stocked(), { type: "OPEN_STORE" });
    const customer = structuredClone(state.customer);
    const payment = structuredClone(state.payment);
    state = order(state, "supplement", "milk");
    expect(state.customer).toEqual(customer);
    expect(state.payment).toEqual(payment);
    state = receiveAllDeliveries(state);
    expect(state.day.phase).toBe("open");
    expect(state.day.number).toBe(1);
    expect(state.customer).toEqual(customer);
  });
  it("keeps all paid queued units in the capacity reservation", () => {
    let state = order(createFirstDayState(), "one", "milk", 4);
    state = order(state, "two", "milk", 4);
    expect(getPurchaseOffer(state, [{ productId: "milk", quantity: 1 }]).allowed).toBe(false);
    state = receive(waitForDelivery(state));
    expect(countAt(state, "milk", "crate")).toBe(4);
    expect(countAt(state, "milk", "delivery")).toBe(4);
    expect(getPurchaseOffer(state, [{ productId: "milk", quantity: 1 }]).allowed).toBe(false);
  });
  it("merges a later same-SKU receipt without teleporting the existing box or issuing another recycle reward", () => {
    let state = receiveAllDeliveries(order(createFirstDayState(), "one", "soap"));
    state = act(state, { type: "PICK_CRATE", crateId: "soap-crate" });
    state = act(state, { type: "DROP_HELD", position: { x: -1.1, z: 2.6 } });
    const location = { ...state.crates.find((crate) => crate.id === "soap-crate")!.position };
    state = receiveAllDeliveries(order(state, "two", "soap"));
    expect(state.crates.find((crate) => crate.id === "soap-crate")!.position).toEqual(location);
    expect(state.recyclingBatches).toEqual([{ id: "crate-batch-1", productId: "soap", purchaseIds: ["one", "two"] }]);
    state = act(state, { type: "PICK_CRATE", crateId: "soap-crate" });
    for (let slot = 0; slot < 2; slot++) state = act(state, { type: "STOCK", productId: "soap", slot });
    state = act(state, { type: "RECYCLE_CRATE" });
    expect(getRecyclingSummary(state)).toEqual({ recycledToday: 1, incomeTodayPence: 5 });
    state = receiveAllDeliveries(order(state, "three", "soap"));
    expect(state.recyclingBatches[1]?.purchaseIds).toEqual(["three"]);
    expect(getRecyclingSummary(state).incomeTodayPence).toBe(5);
  });
  it("delivers paid orders after manual close and blocks settlement until the last vehicle has left", () => {
    let state = order(order(createFirstDayState(), "one"), "two", "milk");
    state = act(state, { type: "CLOSE_STORE" });
    expect(getPurchaseOffer(state, [{ productId: "soap", quantity: 1 }]).allowed).toBe(false);
    state = receive(waitForDelivery(state));
    expect(canSettleDay(state)).toBe(false);
    state = receive(waitForDelivery(state));
    expect(state.delivery.phase).toBe("departing");
    expect(canSettleDay(state)).toBe(false);
    expect(reduceSim(state, { type: "SETTLE_DAY" }).changed).toBe(false);
    state = finishDeliveryDeparture(state);
    expect(canSettleDay(state)).toBe(true);
    state = act(state, { type: "SETTLE_DAY" });
    expect(reduceSim(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 5_000, blocked: false }).changed).toBe(false);
    state = act(state, { type: "START_NEXT_DAY" });
    expect(state.delivery).toEqual({ phase: "idle", orderId: null, elapsedMs: 0, blocked: false });
  });
  it("preserves the whole paid queue, blocked position and cash through every saved phase", () => {
    const storage = new MemoryStorage();
    let state = order(order(createFirstDayState(), "one"), "two", "milk");
    const snapshots: SimState[] = [state];
    state = act(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 8_000, blocked: false }); snapshots.push(state);
    state = act(state, { type: "ADVANCE_DELIVERY_TIME", elapsedMs: 2_000, blocked: true }); snapshots.push(state);
    state = waitForDelivery(state); snapshots.push(state);
    state = receive(state); snapshots.push(state);
    for (const snapshot of snapshots) {
      saveSimState(snapshot, storage);
      expect(loadSimState(storage).state).toEqual(snapshot);
      expect(parseImportedSimState(JSON.stringify(snapshot))).toEqual(snapshot);
    }
    expect(state.cashPence).toBe(snapshots[0]!.cashPence);
  });
  it("rejects a tampered active delivery without accepting future fields as v14", () => {
    const state = order(order(createFirstDayState(), "one"), "two", "milk");
    for (const delivery of [
      { ...state.delivery, orderId: "two" }, { ...state.delivery, phase: "idle" },
      { ...state.delivery, elapsedMs: 6_000 }, { ...state.delivery, phase: "departing" },
    ]) expect(validateSimState({ ...state, delivery })).toBe(false);
    const previous = asV14BusinessSnapshot(state);
    expect(validateV14SimState(previous)).toBe(true);
    expect(validateV14SimState({ ...previous, delivery: state.delivery })).toBe(false);
    expect(validateV14SimState({ ...previous, renovation: state.renovation })).toBe(false);
    const { workstation: _workstation, ...layout } = state.renovation.layout;
    expect(validateSimState({ ...state, renovation: { ...state.renovation, layout } })).toBe(false);
  });
});

describe("v15 clock scaling and intact pre-delivery snapshots", () => {
  it("retains a real v14 float, refund, cash count and settled net-income ledger", () => {
    let state = stocked();
    state = act(state, { type: "CONFIGURE_CASH_FLOAT", drawer: { ...state.cashDrawer, 1: state.cashDrawer[1] - 1 } });
    state = act(state, { type: "OPEN_STORE" });
    while (state.customer.phase !== "checkout") state = act(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((item) => item.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
    state = act(payScannedCheckout(state), { type: "CUSTOMER_ADVANCE" });
    state = act(state, { type: "REFUND_TRANSACTION", transactionId: state.transactions[0]!.id, reason: "return" });
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "RECORD_CASH_COUNT", counts: { ...state.cashDrawer }, note: "迁移前实盘" });
    state = act(state, { type: "SETTLE_DAY" });
    const old = asV14BusinessSnapshot(state);
    expect(validateV14SimState(old)).toBe(true);
    expect(old.cashJournal.map((entry) => entry.kind)).toEqual(["float", "refund", "count"]);
    const migrated = migrateV14SimState(old);
    expect(migrated.cashReservePence).toBe(1);
    expect(migrated.cashPence).toBe(old.cashPence);
    expect(migrated.cashDrawerOpening).toEqual(old.cashDrawerOpening);
    expect(migrated.cashDrawerTransactionStart).toBe(old.cashDrawerTransactionStart);
    expect(migrated.cashJournal).toEqual(old.cashJournal);
    expect(migrated.transactions).toEqual(old.transactions);
    expect(migrated.items).toEqual(old.items);
    expect(migrated.settlements).toEqual(old.settlements);
    expect(migrated.settlements[0]).toMatchObject({ refundCount: 1, netRevenuePence: 0 });
  });
  it.each([
    ["open", null, 0, "09:00"], ["open", null, 210_000, "14:00"], ["open", null, 419_300, "18:59"],
    ["closing", "manual", 210_000, "14:00"], ["closing", "time", 420_000, "19:00"],
  ] as const)("retains %s/%s at %i old active ms as %s", (phase, closeReason, elapsedOpenMs, label) => {
    const old = asV14BusinessSnapshot(act(stocked(), { type: "OPEN_STORE" }));
    old.day = { ...old.day, phase, closeReason, elapsedOpenMs };
    expect(validateV14SimState(old)).toBe(true);
    const before = structuredClone(old);
    const migrated = migrateV14SimState(old);
    expect(getBusinessClock(migrated.day).timeLabel).toBe(label);
    expect(migrated.day.phase).toBe(phase);
    expect(migrated.day.closeReason).toBe(closeReason);
    expect(migrated.day.elapsedOpenMs).toBe(elapsedOpenMs * 12 / 7);
    expect(migrated.cashPence).toBe(old.cashPence);
    expect(migrated.items).toEqual(old.items);
    expect(migrated.cashJournal).toEqual(old.cashJournal);
    expect(migrated.cashDrawer).toEqual(old.cashDrawer);
    expect(parseImportedSimState(JSON.stringify(migrated))).toEqual(migrated);
    expect(old).toEqual(before);
  });
  it("caps old remaining arrival wait at four seconds while preserving the clock face", () => {
    let state = act(stocked(), { type: "OPEN_STORE" });
    state = act(state, { type: "CANCEL_CUSTOMER" });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    const old = asV14BusinessSnapshot(state);
    old.day.elapsedOpenMs = 210_000; old.day.nextCustomerAtMs = 219_000;
    expect(validateV14SimState(old)).toBe(true);
    const next = migrateV14SimState(old);
    expect(next.day.elapsedOpenMs).toBe(360_000);
    expect(next.day.nextCustomerAtMs).toBe(364_000);
    old.day.nextCustomerAtMs = 209_000;
    const due = migrateV14SimState(old);
    expect(due.day.nextCustomerAtMs).toBe(due.day.elapsedOpenMs);
  });
  it("strictly rejects seven-minute old clocks outside their original range", () => {
    const old = asV14BusinessSnapshot(act(stocked(), { type: "OPEN_STORE" }));
    old.day.elapsedOpenMs = 500_000;
    expect(validateV14SimState(old)).toBe(false);
    expect(() => migrateV14SimState(old)).toThrow("旧版 v14");
  });
  it("migrates the earliest old paid order as ready, preserving every queued item and physical box", () => {
    const old = asV14BusinessSnapshot(order(order(createFirstDayState(), "one"), "two", "milk"));
    const migrated = migrateV14SimState(old);
    expect(migrated.delivery).toEqual({ phase: "ready", orderId: "one", elapsedMs: 0, blocked: false });
    expect(migrated.purchases).toEqual(old.purchases);
    expect(migrated.items).toEqual(old.items);
    expect(migrated.crates).toEqual(old.crates);
    expect(receive(migrated).purchases.map((purchase) => purchase.receivedDay)).toEqual([1, null]);
  });
  it("uses v15 keys and detects an old v14 writer changing its read-only migration source", async () => {
    const storage = new MemoryStorage();
    const old = asV14BusinessSnapshot(order(createFirstDayState(), "one"));
    const raw = JSON.stringify(old);
    storage.data.set(SIM_V14_STORAGE_KEY, raw);
    storage.data.set(SIM_V14_BACKUP_KEY, raw);
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    const loaded = session.load();
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v15");
    expect(SIM_WRITER_LOCK).toBe("english-high-street:sim3d:v4:writer");
    expect(loaded.source).toBe("v14");
    expect(storage.getItem(SIM_V14_STORAGE_KEY)).toBe(raw);
    storage.data.set(SIM_V14_STORAGE_KEY, JSON.stringify({ ...old, revision: old.revision + 1 }));
    expect(() => session.save(loaded.state)).toThrow();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    await session.release();
  });
});
