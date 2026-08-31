import { describe, expect, it } from "vitest";
import {
  createFirstDayState, getCheckoutTotal, getDaySummary, reduceSim, validateSimState,
  type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import {
  SIM_BACKUP_KEY, SIM_STORAGE_KEY, SIM_WRITER_LOCK, SimSaveConflictError, SimSaveSession,
  loadSimState, parseImportedSimState, saveSimState, type StorageLike,
} from "../../src/sim3d/persistence";

const V7_PRIMARY = "english-high-street:sim3d:v7";
const V7_BACKUP = `${V7_PRIMARY}:backup`;

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
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function arrive(state: SimState): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  return state;
}

function pendingCash(): SimState {
  let state = createFirstDayState();
  state.customerSeed = 239;
  state = act(state, { type: "PURCHASE_STOCK", orderId: "cash-save-fixture", pairs: 3 });
  state = act(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
    for (let slot = 0; slot < 3; slot += 1) state = act(state, { type: "STOCK", productId, slot });
    state = act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position });
  }
  state = act(arrive(state), { type: "PAY", success: true });
  state = act(state, { type: "CUSTOMER_ADVANCE" });
  state = arrive(state);
  expect(state.payment).toEqual({ method: "cash", tenderedPence: 500, received: false, selectedChange: [] });
  return state;
}

function partialCash(): SimState {
  return act(act(pendingCash(), { type: "RECEIVE_CASH" }), { type: "ADD_CHANGE", denominationPence: 50 });
}

function readyCash(): SimState {
  return act(partialCash(), { type: "ADD_CHANGE", denominationPence: 50 });
}

function v7Snapshot(state: SimState = partialCash()) {
  const { payment: _payment, transactions, ...previous } = structuredClone(state);
  return {
    ...previous, schemaVersion: 7,
    transactions: transactions.map(({ id, customerNumber, itemIds, amountPence }) => ({ id, customerNumber, itemIds, amountPence })),
  };
}

describe("v8 read-only migration from v7 and older save sources", () => {
  it("uses a new v8 namespace, preserving the cross-version writer lock", () => {
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v8");
    expect(SIM_BACKUP_KEY).toBe("english-high-street:sim3d:v8:backup");
    expect(SIM_WRITER_LOCK).toBe("english-high-street:sim3d:v4:writer");
  });

  it("retains v7 money, stock, scans and recycling while labelling old sales and the current visit as card", () => {
    const current = partialCash();
    const old = v7Snapshot(current);
    const raw = JSON.stringify(old, null, 2);
    const storage = new MemoryStorage();
    storage.data.set(V7_PRIMARY, raw);
    storage.data.set(V7_BACKUP, JSON.stringify(v7Snapshot(pendingCash())));
    storage.data.set("english-high-street:sim3d:v6", "retained v6 source");
    storage.data.set("english-high-street:save:v2", "retained 2d source");
    const originals = [...storage.data];
    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v7");
    expect(loaded.state).toEqual({
      ...old, schemaVersion: 8, payment: { method: "card" },
      transactions: old.transactions.map((transaction) => ({ ...transaction, paymentMethod: "card", tenderedPence: transaction.amountPence, changePence: 0 })),
    });
    expect(loaded.state.cashPence).toBe(current.cashPence);
    expect(loaded.state.scannedIds).toEqual(current.scannedIds);
    expect(loaded.state.items).toEqual(current.items);
    expect(loaded.state.recyclingBatches).toEqual(current.recyclingBatches);
    expect(loaded.state.recyclingRecords).toEqual(current.recyclingRecords);
    expect([...storage.data]).toEqual(originals);
    expect(parseImportedSimState(raw)).toEqual(loaded.state);
    saveSimState(loaded.state, storage);
    for (const [key, value] of originals) expect(storage.getItem(key)).toBe(value);
    const paid = act(loaded.state, { type: "PAY", success: true });
    expect(paid.cashPence).toBe(current.cashPence + getCheckoutTotal(current));
    expect(paid.payment).toBeNull();
  });

  it("does not add active payment to migrated outside, leaving or complete snapshots", () => {
    const paid = act(readyCash(), { type: "CONFIRM_CASH" });
    const completed = act(paid, { type: "CUSTOMER_ADVANCE" });
    for (const state of [createFirstDayState(), paid, completed]) {
      const old = v7Snapshot(state);
      const restored = parseImportedSimState(JSON.stringify(old));
      expect(restored.payment).toBeNull();
      expect(restored.cashPence).toBe(old.cashPence);
      expect(restored.items).toEqual(old.items);
      expect(restored.transactions.every((transaction) => transaction.paymentMethod === "card" && transaction.tenderedPence === transaction.amountPence && transaction.changePence === 0)).toBe(true);
    }
  });

  it("prefers a valid v8 backup, then a v7 backup, without deleting corrupt primary snapshots", () => {
    const storage = new MemoryStorage();
    const current = partialCash();
    storage.data.set(SIM_STORAGE_KEY, "{corrupt-v8");
    storage.data.set(SIM_BACKUP_KEY, JSON.stringify(current));
    storage.data.set(V7_PRIMARY, "{corrupt-v7");
    storage.data.set(V7_BACKUP, JSON.stringify(v7Snapshot()));
    const before = [...storage.data];
    expect(loadSimState(storage)).toMatchObject({ source: "backup", state: current });
    expect([...storage.data]).toEqual(before);
    storage.data.set(SIM_BACKUP_KEY, "null");
    const restored = loadSimState(storage);
    expect(restored.source).toBe("v7-backup");
    expect((restored.state).payment).toEqual({ method: "card" });
    expect(restored.warning).toBeTruthy();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe("{corrupt-v8");
    expect(storage.getItem(V7_PRIMARY)).toBe("{corrupt-v7");
  });

  it("rejects a tampered v7 ledger before migration and leaves all sources untouched", () => {
    const old = v7Snapshot();
    old.cashPence += 500;
    const raw = JSON.stringify(old);
    expect(() => parseImportedSimState(raw)).toThrow("校验未通过");
    const storage = new MemoryStorage();
    storage.data.set(V7_PRIMARY, raw);
    expect(loadSimState(storage).source).toBe("new");
    expect(storage.getItem(V7_PRIMARY)).toBe(raw);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
  });

  it("detects an old page changing the v7 migration source before this page can write v8", async () => {
    const storage = new MemoryStorage();
    const old = v7Snapshot();
    storage.data.set(V7_PRIMARY, JSON.stringify(old));
    const session = new SimSaveSession(storage, null);
    expect(await session.acquire()).toBe(true);
    const migrated = session.load().state;
    storage.data.set(V7_PRIMARY, JSON.stringify({ ...old, revision: old.revision + 1 }));
    expect(() => session.save(migrated)).toThrow(SimSaveConflictError);
    expect(session.canWrite).toBe(false);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    await session.release();
  });
});

describe("cash selection recovery, write failure and exactly-once saves", () => {
  it.each([pendingCash, partialCash, readyCash])("round-trips $name without rerolling tender or applying a tentative receipt to the ledger", (fixture) => {
    const state = fixture();
    const storage = new MemoryStorage();
    saveSimState(state, storage);
    const restored = loadSimState(storage).state;
    expect(restored).toEqual(state);
    expect(parseImportedSimState(JSON.stringify(state))).toEqual(state);
    expect(restored.customerSeed).toBe(239);
    expect(restored.payment).toEqual(state.payment);
    expect(restored.cashPence).toBe(state.cashPence);
    expect(restored.transactions).toEqual(state.transactions);
    const oldPay = reduceSim(restored, { type: "PAY", success: true });
    expect(oldPay.state).toBe(restored);
    expect(oldPay.changed).toBe(false);
  });

  it("resumes partial change, commits only net revenue once, and restores a paid backup without replay", () => {
    const storage = new MemoryStorage();
    const partial = partialCash();
    saveSimState(partial, storage);
    const restored = loadSimState(storage).state;
    const paid = act(act(restored, { type: "ADD_CHANGE", denominationPence: 50 }), { type: "CONFIRM_CASH" });
    saveSimState(paid, storage);
    expect(paid.cashPence).toBe(partial.cashPence + 400);
    expect(paid.transactions).toHaveLength(partial.transactions.length + 1);
    expect(getDaySummary(paid).revenuePence - getDaySummary(partial).revenuePence).toBe(400);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(partial);
    const moved = act(paid, { type: "SAVE_POSE", pose: { ...paid.playerPose, z: -3.2 } });
    saveSimState(moved, storage);
    storage.data.set(SIM_STORAGE_KEY, "{interrupted-write");
    const recovered = loadSimState(storage);
    expect(recovered.source).toBe("backup");
    expect(recovered.state).toEqual(paid);
    expect(reduceSim(recovered.state, { type: "PAY", success: true }).state).toBe(recovered.state);
    expect(reduceSim(recovered.state, { type: "CONFIRM_CASH" }).state).toBe(recovered.state);
  });

  it("keeps the pending cash snapshot on write failure and safely retries the same committed state", async () => {
    const storage = new MemoryStorage();
    const ready = readyCash();
    saveSimState(ready, storage);
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    const before = session.load().state;
    const paid = act(before, { type: "CONFIRM_CASH" });
    storage.failKey = SIM_STORAGE_KEY;
    expect(() => session.save(paid)).toThrow("QuotaExceededError");
    expect(loadSimState(storage).state).toEqual(before);
    expect(session.canWrite).toBe(true);
    storage.failKey = undefined;
    session.save(paid);
    session.save(paid);
    const final = loadSimState(storage).state;
    expect(final).toEqual(paid);
    expect(final.transactions.filter((transaction) => transaction.id === "sale-2")).toHaveLength(1);
    expect(final.payment).toBeNull();
    expect(final.cashPence).toBe(before.cashPence + 400);
    await session.release();
  });

  it("keeps the original v7 source intact if the initial migrated v8 write fails", async () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify(v7Snapshot());
    storage.data.set(V7_PRIMARY, raw);
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    const migrated = session.load().state;
    storage.failKey = SIM_STORAGE_KEY;
    expect(() => session.save(migrated)).toThrow("QuotaExceededError");
    expect(storage.getItem(V7_PRIMARY)).toBe(raw);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    storage.failKey = undefined;
    session.save(migrated);
    expect(loadSimState(storage).state).toEqual(migrated);
    expect(storage.getItem(V7_PRIMARY)).toBe(raw);
    await session.release();
  });

  it("freezes a stale cash page instead of overwriting another page's successful confirmation", async () => {
    const storage = new MemoryStorage();
    saveSimState(readyCash(), storage);
    const first = new SimSaveSession(storage, null);
    const stale = new SimSaveSession(storage, null);
    await first.acquire();
    await stale.acquire();
    const a = first.load().state;
    const b = stale.load().state;
    const paid = act(a, { type: "CONFIRM_CASH" });
    first.save(paid);
    expect(() => stale.save(b)).toThrow(SimSaveConflictError);
    expect(loadSimState(storage).state).toEqual(paid);
    await first.release();
    await stale.release();
  });

  it("rejects imported tentative cash and paid ledgers with fabricated money without replacing the current save", () => {
    const storage = new MemoryStorage();
    const current = partialCash();
    saveSimState(current, storage);
    const original = storage.getItem(SIM_STORAGE_KEY);
    const premature = structuredClone(current);
    premature.cashPence += 500;
    const malformed = structuredClone(current);
    malformed.payment = { method: "cash", tenderedPence: 500, received: false, selectedChange: [50] };
    const badPaid = act(readyCash(), { type: "CONFIRM_CASH" });
    badPaid.transactions.at(-1)!.changePence += 1;
    for (const bad of [premature, malformed, badPaid]) {
      expect(() => parseImportedSimState(JSON.stringify(bad))).toThrow("校验未通过");
      expect(storage.getItem(SIM_STORAGE_KEY)).toBe(original);
    }
  });
});
