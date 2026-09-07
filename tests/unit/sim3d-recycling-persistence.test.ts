import { createDefaultCashDrawer } from "../../src/sim3d/cashDrawer";
import { describe, expect, it } from "vitest";
import { payScannedCheckout, preCashTransactions } from "../helpers/sim3dPayment";
import {
  RECYCLING_REWARD_PENCE, createFirstDayState, getDaySummary, getDeliverySummary, getRecyclingSummary,
  migrateV6SimState, reduceSim, validateSimState, validateV6SimState,
  type SimCommand, type SimState, type SimStateV6,
} from "../../src/sim3d/domain";
import {
  SIM_BACKUP_KEY, SIM_STORAGE_KEY, SIM_V6_STORAGE_KEY, SIM_V6_BACKUP_KEY,
  SIM_V5_STORAGE_KEY, SIM_V5_BACKUP_KEY, SIM_V4_STORAGE_KEY, SIM_V4_BACKUP_KEY,
  SIM_LEGACY_STORAGE_KEY, SIM_LEGACY_BACKUP_KEY, SimSaveConflictError, SimSaveSession,
  loadSimState, parseImportedSimState, saveSimState, type StorageLike,
} from "../../src/sim3d/persistence";

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  failKey?: string;
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
}

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state), command.type).toBe(true);
  return result.state;
}

function receivedStock(): SimState {
  const purchased = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "paid-opening", pairs: 3 });
  return act(purchased, { type: "RECEIVE_DELIVERY" });
}

function heldEmptyCrate(): SimState {
  let state = act(receivedStock(), { type: "PICK_CRATE", crateId: "milk-crate" });
  for (let slot = 0; slot < 3; slot += 1) state = act(state, { type: "STOCK", productId: "milk", slot });
  return state;
}

function settledDay(): SimState {
  let state = receivedStock();
  for (const productId of ["milk", "bread"] as const) {
    const items = state.items.filter((item) => item.productId === productId);
    for (const [slot, item] of items.entries()) {
      state = act(state, { type: "TAKE_ITEM", itemId: item.id });
      state = act(state, { type: "STOCK", productId, slot });
    }
  }
  for (let customer = 0; customer < 3; customer += 1) {
    state = act(state, { type: customer === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" });
    for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
      state = act(state, { type: "SCAN", itemId: item.id });
    }
    state = payScannedCheckout(state);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
  }
  state = act(state, { type: "CLOSE_STORE" });
  return act(state, { type: "SETTLE_DAY" });
}

/** Genuine v6 has fixed three-customer days, no timed-day fields and no recycling ledger. */
function v6Snapshot(state = heldEmptyCrate()): SimStateV6 {
  expect(state.recyclingRecords).toEqual([]);
  const {
    payment: _payment,
    recyclingBatches: _recyclingBatches,
    recyclingRecords: _recyclingRecords,
    renovation: _renovation,
    streetSupportRecords: _streetSupportRecords,
    cashDrawer: _cashDrawer,
    cashDrawerOpening: _cashDrawerOpening,
    cashDrawerTransactionStart: _cashDrawerTransactionStart,
    customer,
    settlements,
    ...previous
  } = structuredClone(state);
  const { contentVersion: _contentVersion, ...oldCustomer } = customer;
  return {
    ...previous, schemaVersion: 6,
    customer: oldCustomer,
    day: {
      number: previous.day.number, phase: previous.day.phase === "closing" ? "open" : previous.day.phase,
      targetCustomers: 3, transactionStart: previous.day.transactionStart, purchaseStart: previous.day.purchaseStart,
      openingCashPence: previous.day.openingCashPence, openingStockUnits: previous.day.openingStockUnits,
      openingInventoryValuePence: previous.day.openingInventoryValuePence,
    },
    transactions: preCashTransactions(previous.transactions),
    settlements: settlements.map(({
      targetCustomers: _targetCustomers,
      recycledCrates: _recycledCrates,
      recyclingIncomePence: _recyclingIncomePence,
      expansionSpendPence: _expansionSpendPence,
      communitySupportCount: _communitySupportCount,
      communityCashPence: _communityCashPence,
      ...record
    }) => ({ ...record, targetCustomers: 3 })),
  };
}

describe("read-only v6 migration into the recycling ledger", () => {
  it("preserves cash, selected pending goods, a carried empty box and the whole old world without issuing a reward", () => {
    let state = act(heldEmptyCrate(), {
      type: "PURCHASE_STOCK", orderId: "pending-soap", lines: [{ productId: "soap", quantity: 1 }],
    });
    state = act(state, { type: "SAVE_POSE", pose: { x: -13, z: -8, yaw: 0.4, pitch: 0.1 } });
    state.customerSeed = 0xffffffff;
    const old = v6Snapshot(state);
    expect(old).not.toHaveProperty("recyclingBatches");
    expect(old).not.toHaveProperty("recyclingRecords");
    expect(validateV6SimState(old)).toBe(true);
    expect(validateSimState(old)).toBe(false);
    const raw = JSON.stringify(old, null, 2);
    const backup = JSON.stringify(v6Snapshot());
    const storage = new MemoryStorage();
    storage.data.set(SIM_V6_STORAGE_KEY, raw);
    storage.data.set(SIM_V6_BACKUP_KEY, backup);
    for (const key of [SIM_V5_STORAGE_KEY, SIM_V5_BACKUP_KEY, SIM_V4_STORAGE_KEY, SIM_V4_BACKUP_KEY,
      SIM_LEGACY_STORAGE_KEY, SIM_LEGACY_BACKUP_KEY, "english-high-street:save:v2"]) {
      storage.data.set(key, `retained source: ${key}`);
    }
    const originals = [...storage.data];
    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v6");
    expect(loaded.warning).toContain("不会额外发钱");
    expect(loaded.state).toEqual({
      ...old, schemaVersion: 13, renovation: createFirstDayState().renovation, payment: null, recyclingRecords: [], streetSupportRecords: [],
      cashDrawer: createDefaultCashDrawer(), cashDrawerOpening: createDefaultCashDrawer(), cashDrawerTransactionStart: 0,
      customer: { ...old.customer, contentVersion: 1 },
      day: { ...old.day, targetCustomers: null, elapsedOpenMs: 0, nextCustomerAtMs: null, closeReason: null },
      recyclingBatches: [
        { id: "crate-batch-1", productId: "milk", purchaseIds: ["paid-opening"] },
        { id: "crate-batch-2", productId: "bread", purchaseIds: ["paid-opening"] },
      ],
    });
    expect(loaded.state.held).toEqual({ kind: "crate", crateId: "milk-crate" });
    expect(getDeliverySummary(loaded.state)).toMatchObject({ pendingOrders: 1, pendingUnits: 1, receivedToday: 1 });
    expect(getRecyclingSummary(loaded.state)).toEqual({ recycledToday: 0, incomeTodayPence: 0 });
    expect([...storage.data]).toEqual(originals);
    expect(parseImportedSimState(raw)).toEqual(loaded.state);
    saveSimState(loaded.state, storage);
    for (const [key, value] of originals) expect(storage.getItem(key)).toBe(value);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBeNull();
    expect(loadSimState(storage)).toEqual({ state: loaded.state, source: "primary" });
    expect(reduceSim(loaded.state, { type: "RECEIVE_DELIVERY" }).state).toBe(loaded.state);
    const received = act(act(loaded.state, { type: "RECYCLE_CRATE" }), { type: "RECEIVE_DELIVERY" });
    expect(received.items).toHaveLength(old.items.length);
    expect(received.cashPence).toBe(old.cashPence + RECYCLING_REWARD_PENCE);
    expect(reduceSim(received, { type: "RECEIVE_DELIVERY" }).state).toBe(received);
  });

  it("retains settled sales and closing cash, then audits closing-time recycling without repeating settlement", () => {
    const state = act(settledDay(), { type: "PICK_CRATE", crateId: "milk-crate" });
    const old = v6Snapshot(state);
    expect(old.settlements[0]).not.toHaveProperty("recyclingIncomePence");
    expect(old.settlements[0]).not.toHaveProperty("recycledCrates");
    expect(validateV6SimState(old)).toBe(true);
    const restored = parseImportedSimState(JSON.stringify(old));
    expect(restored.cashPence).toBe(1710);
    expect(restored.items).toEqual(old.items);
    expect(restored.transactions).toEqual(old.transactions.map((transaction) => ({
      ...transaction, paymentMethod: "card", tenderedPence: transaction.amountPence, changePence: 0,
      tenderedCash: [], changeCash: [], tenderedCashRecorded: false, changeCashRecorded: false,
      cashDrawerTracked: false,
    })));
    expect(restored.held).toEqual(old.held);
    expect(restored.day).toEqual({ ...old.day, targetCustomers: null, elapsedOpenMs: 0, nextCustomerAtMs: null, closeReason: "legacy" });
    expect(restored.settlements).toEqual(old.settlements.map((record) => ({
      ...record, recycledCrates: 0, recyclingIncomePence: 0, expansionSpendPence: 0,
      communitySupportCount: 0, communityCashPence: 0,
    })));
    expect(reduceSim(restored, { type: "SETTLE_DAY" }).state).toBe(restored);
    const recycled = act(restored, { type: "RECYCLE_CRATE" });
    expect(recycled.cashPence).toBe(1715);
    expect(recycled.settlements).toHaveLength(1);
    expect(recycled.settlements[0]).toMatchObject({ recycledCrates: 1, recyclingIncomePence: 5, closingCashPence: 1715 });
    expect(getDaySummary(recycled).grossProfitPence).toBe(getDaySummary(restored).grossProfitPence);
    const storage = new MemoryStorage();
    saveSimState(recycled, storage);
    const reloaded = loadSimState(storage).state;
    expect(reduceSim(reloaded, { type: "SETTLE_DAY" }).state).toBe(reloaded);
    expect(reduceSim(reloaded, { type: "RECYCLE_CRATE" }).state).toBe(reloaded);
    const tomorrow = act(reloaded, { type: "START_NEXT_DAY" });
    expect(tomorrow.day.openingCashPence).toBe(1715);
    expect(tomorrow.settlements).toEqual(recycled.settlements);
    expect(getRecyclingSummary(tomorrow)).toEqual({ recycledToday: 0, incomeTodayPence: 0 });
  });

  it.each([false, true])("recovers a valid v6 backup without changing either old key (newer corrupt progress: %s)", (newerCorrupt) => {
    const storage = new MemoryStorage();
    const old = v6Snapshot();
    const backup = JSON.stringify(old);
    storage.data.set(SIM_V6_STORAGE_KEY, "{corrupt-v6");
    storage.data.set(SIM_V6_BACKUP_KEY, backup);
    if (newerCorrupt) {
      storage.data.set(SIM_STORAGE_KEY, "{corrupt-v7");
      storage.data.set(SIM_BACKUP_KEY, "null");
    }
    const before = [...storage.data];
    const restored = loadSimState(storage);
    expect(restored.source).toBe("v6-backup");
    expect(restored.state).toEqual(migrateV6SimState(old));
    expect(restored.warning).toContain(newerCorrupt ? "回收与营业进度可能丢失" : "从旧备份迁移");
    expect([...storage.data]).toEqual(before);
    saveSimState(restored.state, storage);
    expect(storage.getItem(SIM_V6_STORAGE_KEY)).toBe("{corrupt-v6");
    expect(storage.getItem(SIM_V6_BACKUP_KEY)).toBe(backup);
  });

  it.each([
    ["unearned cash", (old: SimStateV6) => { old.cashPence += 5 }],
    ["uncapped day in an old schema", (old: SimStateV6) => { Object.assign(old.day, { targetCustomers: null }) }],
    ["removed reusable box", (old: SimStateV6) => { old.crates.pop() }],
    ["future receipt", (old: SimStateV6) => { old.purchases[0]!.receivedDay = 2 }],
    ["missing purchased goods", (old: SimStateV6) => { old.items.pop() }],
  ])("validates the complete v6 ledger before migrating %s", (_label, mutate) => {
    const old = v6Snapshot();
    mutate(old);
    expect(validateV6SimState(old)).toBe(false);
    expect(() => migrateV6SimState(old)).toThrow("校验失败");
    expect(() => parseImportedSimState(JSON.stringify(old))).toThrow("校验未通过");
    const storage = new MemoryStorage();
    const raw = JSON.stringify(old);
    storage.data.set(SIM_V6_STORAGE_KEY, raw);
    expect(loadSimState(storage).source).toBe("new");
    expect(storage.getItem(SIM_V6_STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
  });
});

describe("recycling rewards survive save, reload and backup recovery exactly once", () => {
  it("restores removed boxes, money and claims together from the primary, an export and the last valid backup", () => {
    const storage = new MemoryStorage();
    const starting = heldEmptyCrate();
    saveSimState(starting, storage);
    const recycled = act(starting, { type: "RECYCLE_CRATE" });
    saveSimState(recycled, storage);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(starting);
    const moved = act(recycled, { type: "SAVE_POSE", pose: { x: 0, z: -3.3, yaw: 0, pitch: 0 } });
    saveSimState(moved, storage);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(recycled);
    saveSimState(moved, storage);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(recycled);
    const primary = loadSimState(storage);
    expect(primary.source).toBe("primary");
    expect(primary.state).toEqual(moved);
    expect(parseImportedSimState(JSON.stringify(primary.state))).toEqual(moved);
    expect(primary.state.cashPence).toBe(starting.cashPence + 5);
    expect(primary.state.crates.some((crate) => crate.id === "milk-crate")).toBe(false);
    expect(primary.state.held).toEqual({ kind: "none" });
    expect(primary.state.recyclingRecords).toHaveLength(1);
    expect(reduceSim(primary.state, { type: "RECYCLE_CRATE" }).state).toBe(primary.state);
    expect(reduceSim(primary.state, { type: "PICK_CRATE", crateId: "milk-crate" }).state).toBe(primary.state);
    storage.data.set(SIM_STORAGE_KEY, "{broken-latest");
    const recovered = loadSimState(storage);
    expect(recovered.source).toBe("backup");
    expect(recovered.state).toEqual(recycled);
    expect(reduceSim(recovered.state, { type: "RECYCLE_CRATE" }).state).toBe(recovered.state);
    saveSimState(recovered.state, storage);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(recycled);
    expect(loadSimState(storage).state.cashPence).toBe(starting.cashPence + 5);
  });

  it("retains the old v6 source and original money after a quota failure, and retries one reward safely", async () => {
    const storage = new MemoryStorage();
    const original = JSON.stringify(v6Snapshot());
    storage.data.set(SIM_V6_STORAGE_KEY, original);
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    const starting = session.load().state;
    const recycled = act(starting, { type: "RECYCLE_CRATE" });
    storage.failKey = SIM_STORAGE_KEY;
    expect(() => session.save(recycled)).toThrow("QuotaExceededError");
    expect(session.canWrite).toBe(true);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(SIM_V6_STORAGE_KEY)).toBe(original);
    expect(loadSimState(storage).state.cashPence).toBe(starting.cashPence);
    storage.failKey = undefined;
    session.save(recycled);
    session.save(recycled);
    const reloaded = loadSimState(storage).state;
    expect(reloaded.cashPence).toBe(starting.cashPence + 5);
    expect(reloaded.recyclingRecords).toHaveLength(1);
    expect(reduceSim(reloaded, { type: "RECYCLE_CRATE" }).state).toBe(reloaded);
    expect(storage.getItem(SIM_V6_STORAGE_KEY)).toBe(original);
  });

  it.each([
    ["duplicate credited source", (state: SimState) => {
      state.recyclingRecords.push({ ...structuredClone(state.recyclingRecords[0]!), id: "recycle-2" });
      state.cashPence += 5;
    }],
    ["inflated reward", (state: SimState) => { state.recyclingRecords[0]!.amountPence += 5; state.cashPence += 5 }],
    ["unrecognised purchase", (state: SimState) => { state.recyclingRecords[0]!.purchaseIds = ["invented-order"] }],
    ["future recycling day", (state: SimState) => { state.recyclingRecords[0]!.dayNumber = 2 }],
    ["missing reward ledger", (state: SimState) => { state.recyclingRecords = [] }],
    ["wrong product ownership", (state: SimState) => { state.recyclingRecords[0]!.productId = "soap" }],
  ])("rejects an invalid %s without overwriting the primary or valid backup", (_label, mutate) => {
    const storage = new MemoryStorage();
    const starting = heldEmptyCrate();
    saveSimState(starting, storage);
    const recycled = act(starting, { type: "RECYCLE_CRATE" });
    saveSimState(recycled, storage);
    const before = [...storage.data];
    const invalid = structuredClone(recycled);
    mutate(invalid);
    expect(validateSimState(invalid)).toBe(false);
    expect(() => parseImportedSimState(JSON.stringify(invalid))).toThrow("校验未通过");
    expect(() => saveSimState(invalid, storage)).toThrow("原存档未被覆盖");
    expect([...storage.data]).toEqual(before);
    expect(loadSimState(storage).state).toEqual(recycled);
  });
});

describe("v6 migration sources remain protected from concurrent pages", () => {
  it.each([
    ["v6", SIM_V6_STORAGE_KEY], ["v6", SIM_V6_BACKUP_KEY],
    ["v6-backup", SIM_V6_STORAGE_KEY], ["v6-backup", SIM_V6_BACKUP_KEY],
  ] as const)("freezes a %s migration when an older page changes %s", async (source, changedKey) => {
    const storage = new MemoryStorage();
    const old = v6Snapshot();
    storage.data.set(SIM_V6_STORAGE_KEY, source === "v6" ? JSON.stringify(old) : "{broken-v6");
    storage.data.set(SIM_V6_BACKUP_KEY, JSON.stringify(old));
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    const loaded = session.load();
    expect(loaded.source).toBe(source);
    const changedRaw = JSON.stringify({ ...old, revision: old.revision + 1 });
    storage.data.set(changedKey, changedRaw);
    expect(() => session.save(loaded.state)).toThrow("迁移源");
    expect(session.canWrite).toBe(false);
    expect(storage.getItem(changedKey)).toBe(changedRaw);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(SIM_BACKUP_KEY)).toBeNull();
  });

  it("lets only the first CAS page persist a migrated empty box reward", async () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify(v6Snapshot());
    storage.data.set(SIM_V6_STORAGE_KEY, raw);
    const first = new SimSaveSession(storage, null);
    const stale = new SimSaveSession(storage, null);
    await first.acquire(); await stale.acquire();
    const firstState = first.load().state;
    const staleState = stale.load().state;
    first.save(act(firstState, { type: "RECYCLE_CRATE" }));
    expect(() => stale.save(act(staleState, { type: "RECYCLE_CRATE" }))).toThrow(SimSaveConflictError);
    expect(stale.canWrite).toBe(false);
    const restored = loadSimState(storage).state;
    expect(restored.cashPence).toBe(firstState.cashPence + 5);
    expect(restored.recyclingRecords).toHaveLength(1);
    expect(storage.getItem(SIM_V6_STORAGE_KEY)).toBe(raw);
  });
});
