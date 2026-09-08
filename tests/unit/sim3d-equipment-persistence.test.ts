import { receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { describe, expect, it } from "vitest";
import { asV13CashSnapshot } from "../helpers/sim3dLegacyCash";
import {
  createFirstDayState,
  reduceSim,
  validateSimState,
  validateV10SimState,
  validateV11SimState,
  validateV12SimState,
  type SimState,
  type SimStateV10,
  type SimStateV11,
  type SimStateV12,
} from "../../src/sim3d/domain";
import { EQUIPMENT_COMMERCE_CATALOG } from "../../src/sim3d/equipmentCommerce";
import {
  SIM_BACKUP_KEY,
  SIM_STORAGE_KEY,
  SIM_V10_STORAGE_KEY,
  SIM_V11_BACKUP_KEY,
  SIM_V11_STORAGE_KEY,
  SIM_V12_BACKUP_KEY,
  SIM_V12_STORAGE_KEY,
  SIM_WRITER_LOCK,
  SimSaveConflictError,
  SimSaveSession,
  loadSimState,
  parseImportedSimState,
  saveSimState,
  type StorageLike,
} from "../../src/sim3d/persistence";

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void { this.data.set(key, value) }
}

function purchaseEquipmentSnapshot(): SimState {
  const productId = EQUIPMENT_COMMERCE_CATALOG["wall-shelf-narrow"].compatibleProducts[0];
  if (!productId) throw new Error("wall shelf fixture needs at least one compatible product");
  const result = reduceSim(createFirstDayState(), {
    type: "BUY_EQUIPMENT",
    purchaseId: "equipment-save-roundtrip",
    assetId: "wall-shelf-narrow",
    productId,
  });
  if (!result.changed) throw new Error(result.message);
  return result.state;
}

function step(state: SimState, command: Parameters<typeof reduceSim>[1]): SimState {
  const result = reduceSim(state, command);
  if (!result.changed) throw new Error(`${command.type}: ${result.message ?? "fixture rejected"}`);
  return result.state;
}

function partialCashSnapshot(): SimState {
  let state = createFirstDayState();
  state.customerSeed = 239;
  state = step(state, { type: "PURCHASE_STOCK", orderId: "equipment-v12-cash", pairs: 3 });
  state = receiveAllDeliveries(state);
  for (const productId of ["milk", "bread"] as const) {
    state = step(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
    for (let slot = 0; slot < 3; slot += 1) state = step(state, { type: "STOCK", productId, slot });
    state = step(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position });
  }
  state = step(state, { type: "OPEN_STORE" });
  for (let move = 0; move < 3; move += 1) state = step(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = step(state, { type: "SCAN", itemId: item.id });
  state = step(state, { type: "PAY", success: true });
  state = step(state, { type: "CUSTOMER_ADVANCE" });
  state = step(state, { type: "NEXT_CUSTOMER" });
  for (let move = 0; move < 3; move += 1) state = step(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = step(state, { type: "SCAN", itemId: item.id });
  state = step(state, { type: "RECEIVE_CASH" });
  return step(state, { type: "ADD_CHANGE", denominationPence: 50 });
}

function completedCashSnapshot(): SimState {
  let state = step(partialCashSnapshot(), { type: "ADD_CHANGE", denominationPence: 50 });
  return step(state, { type: "CONFIRM_CASH" });
}

function asV12(state = createFirstDayState()): SimStateV12 {
  const snapshot = asV13CashSnapshot(state);
  const {
    schemaVersion: currentSchemaVersion,
    equipment: currentEquipment,
    renovation,
    settlements,
    ...legacyState
  } = snapshot;
  const { layout, secondExpansionDay: currentSecondExpansionDay, ...renovationRecord } = renovation;
  const { equipment: currentPlacements, ...legacyLayout } = layout;
  if (legacyLayout.expansion > 1) throw new Error("v11 fixture cannot contain a second expansion");
  const legacySettlements = settlements.map(({ equipmentSpendPence: _equipmentSpendPence, ...record }) => record);
  void currentSchemaVersion;
  void currentEquipment;
  void currentPlacements;
  void currentSecondExpansionDay;
  return {
    ...legacyState,
    schemaVersion: 12,
    renovation: { ...renovationRecord, layout: { ...legacyLayout, expansion: legacyLayout.expansion as 0 | 1 } },
    settlements: legacySettlements,
  };
}

function asV11(state = createFirstDayState()): SimStateV11 {
  const snapshot = asV12(state);
  const {
    schemaVersion: _schemaVersion,
    cashDrawer: _cashDrawer,
    cashDrawerOpening: _cashDrawerOpening,
    cashDrawerTransactionStart: _cashDrawerTransactionStart,
    payment,
    transactions,
    ...legacyState
  } = snapshot;
  return {
    ...legacyState,
    schemaVersion: 11,
    payment: payment?.method === "cash" ? {
      method: "cash", tenderedPence: payment.tenderedPence,
      received: payment.received, selectedChange: [...payment.selectedChange],
    } : payment,
    transactions: transactions.map(({ tenderedCash: _tenderedCash, changeCash: _changeCash,
      tenderedCashRecorded: _tenderedCashRecorded, changeCashRecorded: _changeCashRecorded,
      cashDrawerTracked: _cashDrawerTracked, ...transaction }) => transaction),
  };
}

function asV10(state = createFirstDayState()): SimStateV10 {
  const snapshot = asV11(state);
  const {
    schemaVersion: currentSchemaVersion,
    streetSupportRecords,
    customer,
    settlements,
    ...legacyState
  } = snapshot;
  const { contentVersion, ...legacyCustomer } = customer;
  const legacySettlements = settlements.map(({ communitySupportCount: _communitySupportCount, communityCashPence: _communityCashPence, ...record }) => record);
  void currentSchemaVersion;
  void streetSupportRecords;
  void contentVersion;
  return {
    ...legacyState,
    schemaVersion: 10,
    customer: legacyCustomer,
    settlements: legacySettlements,
  };
}

describe("v14 equipment schema persistence", () => {
  it("uses the v14 namespace while retaining the shared v4 writer lock and read-only v12 namespace", () => {
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v15");
    expect(SIM_BACKUP_KEY).toBe("english-high-street:sim3d:v15:backup");
    expect(SIM_V12_STORAGE_KEY).toBe("english-high-street:sim3d:v12");
    expect(SIM_V12_BACKUP_KEY).toBe("english-high-street:sim3d:v12:backup");
    expect(SIM_V11_STORAGE_KEY).toBe("english-high-street:sim3d:v11");
    expect(SIM_V11_BACKUP_KEY).toBe("english-high-street:sim3d:v11:backup");
    expect(SIM_WRITER_LOCK).toBe("english-high-street:sim3d:v4:writer");
  });

  it("round-trips complete v14 equipment ownership and backs up the previous valid v14 snapshot", () => {
    const storage = new MemoryStorage();
    const beforePurchase = createFirstDayState();
    const afterPurchase = purchaseEquipmentSnapshot();
    saveSimState(beforePurchase, storage);
    saveSimState(afterPurchase, storage);

    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(beforePurchase);
    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("primary");
    expect(loaded.state).toEqual(afterPurchase);
    expect(loaded.state.equipment.instances).toHaveLength(1);
    expect(parseImportedSimState(JSON.stringify(afterPurchase))).toEqual(afterPurchase);
  });

  it.each([
    ["pending tender and selected change", partialCashSnapshot],
    ["completed cash transaction and updated drawer", completedCashSnapshot],
  ] as const)("migrates v12 %s byte-for-byte while starting equipment empty", (_label, fixture) => {
    const storage = new MemoryStorage();
    const legacy = asV12(fixture());
    const raw = JSON.stringify(legacy);
    expect(validateV12SimState(legacy)).toBe(true);
    storage.setItem(SIM_V12_STORAGE_KEY, raw);

    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v12");
    expect(loaded.state.schemaVersion).toBe(15);
    expect(loaded.state.payment).toEqual(legacy.payment);
    expect(loaded.state.transactions).toEqual(legacy.transactions);
    expect(loaded.state.cashDrawer).toEqual(legacy.cashDrawer);
    expect(loaded.state.cashDrawerOpening).toEqual(legacy.cashDrawerOpening);
    expect(loaded.state.cashDrawerTransactionStart).toBe(legacy.cashDrawerTransactionStart);
    expect(loaded.state.cashPence).toBe(legacy.cashPence);
    expect(loaded.state.equipment).toEqual({ instances: [], purchases: [], nextSequence: 1 });
    expect(loaded.state.renovation.layout.equipment).toEqual([]);
    expect(loaded.state.renovation.secondExpansionDay).toBeNull();
    expect(storage.getItem(SIM_V12_STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    expect(parseImportedSimState(raw)).toEqual(loaded.state);
  });

  it("migrates v11 primary read-only and adds empty equipment records without changing money", () => {
    const storage = new MemoryStorage();
    const legacy = asV11();
    const raw = JSON.stringify(legacy);
    expect(validateV11SimState(legacy)).toBe(true);
    storage.setItem(SIM_V11_STORAGE_KEY, raw);

    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v11");
    expect(loaded.warning).toContain("设备仓库从空开始");
    expect(loaded.state.schemaVersion).toBe(15);
    expect(loaded.state.cashPence).toBe(legacy.cashPence);
    expect(loaded.state.equipment).toEqual({ instances: [], purchases: [], nextSequence: 1 });
    expect(loaded.state.renovation.layout.equipment).toEqual([]);
    expect(loaded.state.settlements.every((record) => record.equipmentSpendPence === 0)).toBe(true);
    expect(validateSimState(loaded.state)).toBe(true);
    expect(parseImportedSimState(raw)).toEqual(loaded.state);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(SIM_V11_STORAGE_KEY)).toBe(raw);

    saveSimState(loaded.state, storage);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(JSON.stringify(loaded.state));
    expect(storage.getItem(SIM_V11_STORAGE_KEY)).toBe(raw);
  });

  it("prefers the valid v11 backup over v10 when current and v11 primary snapshots are corrupt", () => {
    const storage = new MemoryStorage();
    const v11 = asV11();
    const v10 = asV10();
    expect(validateV10SimState(v10)).toBe(true);
    storage.setItem(SIM_STORAGE_KEY, "{broken-current");
    storage.setItem(SIM_BACKUP_KEY, "{broken-current-backup");
    storage.setItem(SIM_V11_STORAGE_KEY, "{broken-v11");
    storage.setItem(SIM_V11_BACKUP_KEY, JSON.stringify(v11));
    storage.setItem(SIM_V10_STORAGE_KEY, JSON.stringify(v10));

    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v11-backup");
    expect(loaded.state.cashPence).toBe(v11.cashPence);
    expect(loaded.warning).toContain("v11");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe("{broken-current");
  });

  it("keeps the v10 fallback and rejects malformed v11 imports", () => {
    const storage = new MemoryStorage();
    const v10 = asV10();
    storage.setItem(SIM_V11_STORAGE_KEY, JSON.stringify({ ...asV11(), cashPence: null }));
    storage.setItem(SIM_V10_STORAGE_KEY, JSON.stringify(v10));

    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v10");
    expect(validateSimState(loaded.state)).toBe(true);
    expect(() => parseImportedSimState(JSON.stringify({ ...asV11(), cashPence: null }))).toThrow("校验未通过");
  });

  it.each([
    ["v11 primary", SIM_V11_STORAGE_KEY, false],
    ["v11 backup", SIM_V11_BACKUP_KEY, true],
  ] as const)("freezes a CAS session if its %s migration source changes before the first v14 save", async (_label, sourceKey, useBackup) => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify(asV11());
    if (useBackup) storage.setItem(SIM_V11_STORAGE_KEY, "{broken-v11");
    storage.setItem(sourceKey, raw);
    const session = new SimSaveSession(storage, null);
    expect(await session.acquire()).toBe(true);
    const loaded = session.load();
    expect(loaded.source).toBe(useBackup ? "v11-backup" : "v11");

    storage.setItem(sourceKey, `${raw} `);
    expect(() => session.save(loaded.state)).toThrow(SimSaveConflictError);
    expect(session.canWrite).toBe(false);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
  });
});
