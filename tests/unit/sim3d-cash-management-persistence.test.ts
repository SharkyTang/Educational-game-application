import { describe, expect, it } from "vitest";
import {
  createFirstDayState, reduceSim, validateSimState, validateV13SimState,
  type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import {
  SIM_STORAGE_KEY, SIM_BACKUP_KEY, SIM_V13_STORAGE_KEY, SIM_V13_BACKUP_KEY,
  SIM_WRITER_LOCK, SimSaveSession, SimSaveConflictError,
  loadSimState, saveSimState, parseImportedSimState, type StorageLike,
} from "../../src/sim3d/persistence";
import { asV13CashSnapshot } from "../helpers/sim3dLegacyCash";
import { payScannedCheckout } from "../helpers/sim3dPayment";
import { EQUIPMENT_COMMERCE_CATALOG } from "../../src/sim3d/equipmentCommerce";

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  failKey: string | null = null;
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
}

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function pendingCash(): SimState {
  let state = step(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "cash-v3-migration", lines: [
    { productId: "water", quantity: 2 },
  ] });
  state = step(state, { type: "RECEIVE_DELIVERY" });
  state = step(state, { type: "PICK_CRATE", crateId: "water-crate" });
  for (let slot = 0; slot < 2; slot++) state = step(state, { type: "STOCK", productId: "water", slot });
  state = step(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.id === "water-crate")!.position });
  for (let visit = 0; visit < 2; visit++) {
    state = step(state, { type: visit === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" });
    while (state.customer.phase !== "checkout") state = step(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
      state = step(state, { type: "SCAN", itemId: item.id });
    }
    if (visit === 0) state = step(payScannedCheckout(state), { type: "CUSTOMER_ADVANCE" });
  }
  expect(state.payment?.method).toBe("cash");
  state = step(state, { type: "RECEIVE_CASH" });
  return step(state, { type: "ADD_CHANGE", denominationPence: 5 });
}

function completedCash(): SimState {
  return step(payScannedCheckout(pendingCash()), { type: "CUSTOMER_ADVANCE" });
}

function settledCash(): SimState {
  return step(step(completedCash(), { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
}

describe("cash management v14 persistence and read-only v13 migration", () => {
  it("uses a new namespace and keeps the cross-version writer lock", () => {
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v14");
    expect(SIM_BACKUP_KEY).toBe(`${SIM_STORAGE_KEY}:backup`);
    expect(SIM_V13_STORAGE_KEY).toBe("english-high-street:sim3d:v13");
    expect(SIM_V13_BACKUP_KEY).toBe(`${SIM_V13_STORAGE_KEY}:backup`);
    expect(SIM_WRITER_LOCK).toBe("english-high-street:sim3d:v4:writer");
  });

  it.each([
    ["preparing", createFirstDayState], ["pending cash and tray", pendingCash],
    ["completed cash", completedCash], ["historical settlement", settledCash],
  ] as const)("migrates v13 %s without rewriting its source or existing progress", (_label, fixture) => {
    const current = fixture();
    const previous = asV13CashSnapshot(current);
    expect(validateV13SimState(previous)).toBe(true);
    const raw = JSON.stringify(previous);
    const storage = new MemoryStorage();
    storage.data.set(SIM_V13_STORAGE_KEY, raw);
    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v13");
    expect(loaded.state).toEqual(current);
    expect(loaded.state.cashJournal).toEqual([]);
    expect(loaded.state.cashReservePence).toBe(0);
    expect(parseImportedSimState(raw)).toEqual(current);
    expect(storage.getItem(SIM_V13_STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
  });

  it("preserves purchased equipment and layout through migration", () => {
    const current = step(createFirstDayState(), { type: "BUY_EQUIPMENT", purchaseId: "cash-v3-equipment",
      assetId: "wall-shelf-narrow", productId: EQUIPMENT_COMMERCE_CATALOG["wall-shelf-narrow"].compatibleProducts[0]! });
    const previous = asV13CashSnapshot(current);
    expect(validateV13SimState(previous)).toBe(true);
    expect(parseImportedSimState(JSON.stringify(previous))).toEqual(current);
  });

  it("recovers v13 backup with an explicit loss warning when v14 and v13 primary are damaged", () => {
    const storage = new MemoryStorage();
    const previous = asV13CashSnapshot(completedCash());
    storage.data.set(SIM_STORAGE_KEY, "{broken");
    storage.data.set(SIM_BACKUP_KEY, "null");
    storage.data.set(SIM_V13_STORAGE_KEY, "{broken");
    const raw = JSON.stringify(previous);
    storage.data.set(SIM_V13_BACKUP_KEY, raw);
    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v13-backup");
    expect(loaded.warning).toContain("退款");
    expect(loaded.warning).toContain("可能丢失");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe("{broken");
    expect(storage.getItem(SIM_V13_BACKUP_KEY)).toBe(raw);
  });

  it("rejects v14 audit fields disguised inside a v13 snapshot", () => {
    const previous = asV13CashSnapshot(createFirstDayState());
    for (const extra of [{ cashJournal: [] }, { cashReservePence: 0 }]) {
      const disguised = { ...previous, ...extra };
      expect(validateV13SimState(disguised)).toBe(false);
      expect(() => parseImportedSimState(JSON.stringify(disguised))).toThrow(/校验/);
    }
  });

  it.each([SIM_V13_STORAGE_KEY, SIM_V13_BACKUP_KEY])("stops a first v14 write if the migration source changes: %s", async (key) => {
    const storage = new MemoryStorage();
    storage.data.set(SIM_V13_STORAGE_KEY, JSON.stringify(asV13CashSnapshot(createFirstDayState())));
    const session = new SimSaveSession(storage, null);
    expect(await session.acquire()).toBe(true);
    const loaded = session.load();
    expect(loaded.source).toBe("v13");
    storage.data.set(key, "changed by older tab");
    expect(() => session.save(loaded.state)).toThrow(SimSaveConflictError);
    expect(session.canWrite).toBe(false);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
  });

  it("leaves the v13 source intact if the first v14 write fails", async () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify(asV13CashSnapshot(pendingCash()));
    storage.data.set(SIM_V13_STORAGE_KEY, raw);
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    const { state } = session.load();
    storage.failKey = SIM_STORAGE_KEY;
    expect(() => session.save(state)).toThrow("QuotaExceededError");
    expect(storage.getItem(SIM_V13_STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    await session.release();
  });

  it("round-trips actual refunds and discrepancy records and retains the last valid backup", () => {
    let state = completedCash();
    const original = structuredClone(state);
    state = step(state, { type: "REFUND_TRANSACTION", transactionId: state.transactions.at(-1)!.id, reason: "return" });
    state = step(state, { type: "CLOSE_STORE" });
    state = step(state, { type: "RECORD_CASH_COUNT", counts: { ...state.cashDrawer, 1: state.cashDrawer[1] - 1 }, note: "少数一枚，已记录待复核" });
    const storage = new MemoryStorage();
    saveSimState(original, storage);
    saveSimState(state, storage);
    expect(loadSimState(storage).state).toEqual(state);
    expect(parseImportedSimState(JSON.stringify(state))).toEqual(state);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(original);
    const forged = structuredClone(state);
    forged.cashReservePence += 1;
    expect(() => saveSimState(forged, storage)).toThrow(/校验/);
    expect(loadSimState(storage).state).toEqual(state);
  });

  it("persists float changes and their reserve without adding spending money", () => {
    const initial = createFirstDayState();
    const state = step(initial, { type: "CONFIGURE_CASH_FLOAT", drawer: { ...initial.cashDrawer, 200: 0 } });
    expect(state.cashReservePence).toBe(1000);
    expect(state.cashPence).toBe(initial.cashPence);
    const storage = new MemoryStorage();
    saveSimState(state, storage);
    expect(loadSimState(storage).state).toEqual(state);
    expect(() => asV13CashSnapshot(state)).toThrow(/cannot erase/);
  });
});
