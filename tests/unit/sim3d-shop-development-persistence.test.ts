import { describe, expect, it } from "vitest";
import { asV13CashSnapshot } from "../helpers/sim3dLegacyCash";
import {
  createFirstDayState, createInitialSimState, getDaySummary, migrateV8SimState, migrateV9SimState, reduceSim,
  validateSimState, validateV8SimState, validateV9SimState,
  type LegacySimState, type SimCommand, type SimState, type SimStateV8, type SimStateV9,
} from "../../src/sim3d/domain";
import {
  SIM_BACKUP_KEY, SIM_STORAGE_KEY, SIM_V9_STORAGE_KEY, SIM_V9_BACKUP_KEY, SIM_WRITER_LOCK,
  SimSaveConflictError, SimSaveSession, loadSimState, parseImportedSimState, saveSimState, type StorageLike,
} from "../../src/sim3d/persistence";
import { createDefaultCashDrawer } from "../../src/sim3d/cashDrawer";
import { cashPiecesForAmount } from "../../src/sim3d/cashPayment";
import { payScannedCheckout, preCashTransactions } from "../helpers/sim3dPayment";

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void { this.data.set(key, value) }
}

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function stocked(): SimState {
  let state = createFirstDayState(); state.customerSeed = 239;
  state = act(state, { type: "PURCHASE_STOCK", orderId: "renovation-migration", pairs: 3 });
  state = act(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
    for (let slot = 0; slot < 3; slot += 1) state = act(state, { type: "STOCK", productId, slot });
    state = act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position });
  }
  return state;
}

function checkout(state: SimState): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  while (state.customer.phase !== "checkout") state = act(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  return state;
}

function pendingCash(): SimState {
  let state = act(payScannedCheckout(checkout(stocked())), { type: "CUSTOMER_ADVANCE" });
  state = checkout(state);
  expect(state.payment).toEqual({
    method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: false, selectedChange: [],
  });
  state = act(state, { type: "RECEIVE_CASH" });
  state = act(state, { type: "ADD_CHANGE", denominationPence: 50 });
  return act(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 34_567.25 });
}

function earned(): SimState {
  let state = stocked();
  for (let order = 0; order < 3; order += 1) state = act(payScannedCheckout(checkout(state)), { type: "CUSTOMER_ADVANCE" });
  return act(act(state, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
}

/** Removing future-only fields gives a real v9 snapshot; the v9 validator proves its ledger. */
function asV9(state: SimState): SimStateV9 {
  const {
    renovation,
    streetSupportRecords: _streetSupportRecords,
    cashDrawer: _cashDrawer,
    cashDrawerOpening: _cashDrawerOpening,
    cashDrawerTransactionStart: _cashDrawerTransactionStart,
    customer,
    payment,
    transactions,
    settlements,
    ...base
  } = asV13CashSnapshot(state);
  if (renovation.layout.expansion !== 0) throw new Error("Cannot turn a purchased v10 extension into an old free-floor fixture");
  const { contentVersion: _contentVersion, ...oldCustomer } = customer;
  const oldPayment: SimStateV9["payment"] = payment?.method === "cash"
    ? { method: "cash", tenderedPence: payment.tenderedPence, received: payment.received, selectedChange: [...payment.selectedChange] }
    : payment ? { method: "card" } : null;
  const previous: SimStateV9 = {
    ...base, schemaVersion: 9, customer: oldCustomer, payment: oldPayment,
    transactions: transactions.map(({
      tenderedCash: _tenderedCash,
      changeCash: _changeCash,
      tenderedCashRecorded: _tenderedCashRecorded,
      changeCashRecorded: _changeCashRecorded,
      cashDrawerTracked: _cashDrawerTracked,
      ...transaction
    }) => transaction),
    settlements: settlements.map(({
      expansionSpendPence: _spent,
      communitySupportCount: _communitySupportCount,
      communityCashPence: _communityCashPence,
      ...record
    }) => record),
  };
  expect(validateV9SimState(previous)).toBe(true);
  return previous;
}

function asV8(state: SimState): SimStateV8 {
  const prior = asV9(state);
  if (prior.day.phase === "closing") throw new Error("No closing phase existed in v8");
  const { elapsedOpenMs: _elapsed, nextCustomerAtMs: _arrival, closeReason: _reason, ...day } = prior.day;
  const previous: SimStateV8 = { ...prior, schemaVersion: 8,
    day: { ...day, phase: prior.day.phase, targetCustomers: 3 },
    settlements: prior.settlements.map((record) => ({ ...record, targetCustomers: 3 })),
  };
  expect(validateV8SimState(previous)).toBe(true);
  return previous;
}

describe("renovation migration into current v14 without rewriting old cash or clocks", () => {
  it("uses a separate current key and retains the shared writer lock", () => {
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v14");
    expect(SIM_BACKUP_KEY).toBe("english-high-street:sim3d:v14:backup");
    expect(SIM_V9_STORAGE_KEY).toBe("english-high-street:sim3d:v9");
    expect(SIM_WRITER_LOCK).toBe("english-high-street:sim3d:v4:writer");
  });

  it("keeps an active v9 cash tender, selected change, customer and fractional clock exactly intact", () => {
    const original = pendingCash(); const old = asV9(original); const before = structuredClone(old);
    const current = migrateV9SimState(old);
    expect(old).toEqual(before);
    const openingDrawer = createDefaultCashDrawer();
    expect(current).toEqual({
      ...old,
      schemaVersion: 14,
      cashReservePence: 0, cashJournal: [],
      renovation: createFirstDayState().renovation,
      streetSupportRecords: [],
      customer: { ...old.customer, contentVersion: 1 },
      settlements: [],
      payment: old.payment?.method === "cash" ? {
        ...old.payment, tenderedCash: cashPiecesForAmount(old.payment.tenderedPence), tenderedCashRecorded: false,
      } : old.payment,
      transactions: old.transactions.map((transaction) => ({
        ...transaction,
        tenderedCash: transaction.paymentMethod === "cash" ? cashPiecesForAmount(transaction.tenderedPence) : [],
        changeCash: transaction.paymentMethod === "cash" && transaction.changePence > 0 ? cashPiecesForAmount(transaction.changePence) : [],
        tenderedCashRecorded: false,
        changeCashRecorded: false,
        cashDrawerTracked: false,
      })),
      cashDrawer: openingDrawer,
      cashDrawerOpening: openingDrawer,
      cashDrawerTransactionStart: old.transactions.length,
    });
    expect(current.day.elapsedOpenMs).toBe(34_567.25);
    expect(current.payment).toEqual({
      method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: false, received: true, selectedChange: [50],
    });
    expect(current.cashPence).toBe(910);
    expect(current.items).toEqual(original.items);
    expect(current.renovation).not.toBe(original.renovation);
    const paid = act(act(current, { type: "ADD_CHANGE", denominationPence: 50 }), { type: "CONFIRM_CASH" });
    expect(paid.cashPence).toBe(1310);
    expect(paid.day.elapsedOpenMs).toBe(34_567.25);
    expect(paid.transactions).toHaveLength(2);
    expect(paid.transactions[1]).toMatchObject({
      paymentMethod: "cash", tenderedCashRecorded: false, changeCashRecorded: true, cashDrawerTracked: true,
    });
    expect(reduceSim(paid, { type: "CONFIRM_CASH" }).changed).toBe(false);
    if (old.payment?.method === "cash") old.payment.selectedChange.push(1);
    expect(current.payment).toEqual(before.payment?.method === "cash"
      ? { ...before.payment, tenderedCash: [500], tenderedCashRecorded: false }
      : before.payment);
  });

  it("retains legacy three-order summaries when buying floor space after an already-settled v8 day", () => {
    const old = asV8(earned());
    const migrated = migrateV8SimState(old);
    expect(migrated.day.closeReason).toBe("legacy");
    expect(migrated.settlements[0]).toMatchObject({ targetCustomers: 3, expansionSpendPence: 0, closingCashPence: 1710 });
    const expanded = act(migrated, { type: "BUY_SPACE_EXPANSION" });
    expect(expanded.settlements[0]).toMatchObject({ targetCustomers: 3, expansionSpendPence: 1500, closingCashPence: 210 });
    const tomorrow = act(expanded, { type: "START_NEXT_DAY" });
    expect(tomorrow.day).toMatchObject({ targetCustomers: null, elapsedOpenMs: 0, openingCashPence: 210 });
    expect(tomorrow.settlements[0]!.targetCustomers).toBe(3);
    expect(getDaySummary(tomorrow).expansionSpendPence).toBe(0);
  });

  it("retains v9 timed summaries with a zero expansion column and no credit until purchase", () => {
    const old = asV9(earned()); const current = migrateV9SimState(old);
    expect(current.settlements).toEqual(old.settlements.map((record) => ({
      ...record, expansionSpendPence: 0, communitySupportCount: 0, communityCashPence: 0, equipmentSpendPence: 0,
      refundCount: 0, refundPence: 0, netRevenuePence: record.revenuePence,
    })));
    expect(current.cashPence).toBe(old.cashPence);
    expect(current.day).toEqual(old.day);
    const expanded = act(current, { type: "BUY_SPACE_EXPANSION" });
    expect(expanded.settlements[0]).toMatchObject({ targetCustomers: null, expansionSpendPence: 1500, grossProfitPence: 510 });
  });

  it("imports every supported v3–v9 schema into a default renovation without minting money or merchandise", () => {
    let newest = stocked();
    // v4 predates outdoor delivery bays. Move the real cartons into its supported pads first.
    for (const [productId, x] of [["milk", 1.35], ["bread", 2.2]] as const) {
      newest = act(newest, { type: "PICK_CRATE", crateId: `${productId}-crate` });
      newest = act(newest, { type: "DROP_HELD", position: { x, z: -2.9 } });
    }
    const v9 = asV9(newest); const v8 = asV8(newest);
    const { payment: _payment, ...noPayment } = v8;
    const v7 = { ...noPayment, schemaVersion: 7, transactions: preCashTransactions(v8.transactions) };
    const { recyclingBatches: _batches, recyclingRecords: _records, ...noRecycling } = v7;
    const v6 = { ...noRecycling, schemaVersion: 6, settlements: [] };
    const v5 = { ...v6, schemaVersion: 5, purchases: v6.purchases.map(({ lines: _lines, ...purchase }) => ({ ...purchase, pairs: 3 })) };
    const v4 = { ...v5, schemaVersion: 4, purchases: v5.purchases.map(({ receivedDay: _received, ...purchase }) => purchase) };
    const initial = createInitialSimState();
    const v3: LegacySimState = {
      schemaVersion: 3, revision: initial.revision, items: initial.items, crates: initial.crates,
      held: initial.held, inspectedProducts: initial.inspectedProducts, customer: { phase: initial.customer.phase, number: initial.customer.number },
      scannedIds: initial.scannedIds, transactions: [], cashPence: initial.cashPence, upgraded: initial.upgraded, playerPose: initial.playerPose,
    };
    for (const previous of [v3, v4, v5, v6, v7, v8, v9]) {
      const raw = JSON.stringify(previous);
      expect(() => parseImportedSimState(raw), `v${previous.schemaVersion} import`).not.toThrow();
      const migrated = parseImportedSimState(raw);
      expect(migrated.schemaVersion).toBe(14);
      expect(migrated.renovation).toEqual(createFirstDayState().renovation);
      expect(migrated.cashPence).toBe(previous.cashPence);
      expect(migrated.items).toEqual(previous.items);
      expect(getDaySummary(migrated).expansionSpendPence).toBe(0);
      expect(JSON.stringify(previous)).toBe(raw);
      expect(validateSimState(migrated)).toBe(true);
    }
  });

  it("rejects invalid old clocks, balances and poses before attempting migration", () => {
    const old = asV9(pendingCash());
    for (const mutation of [
      (state: SimStateV9) => { state.cashPence += 1 },
      (state: SimStateV9) => { state.day.elapsedOpenMs = -1 },
      (state: SimStateV9) => { state.playerPose.z = 6.5 },
    ]) {
      const corrupt = structuredClone(old); mutation(corrupt);
      expect(validateV9SimState(corrupt)).toBe(false);
      expect(() => migrateV9SimState(corrupt)).toThrow("校验失败");
      expect(() => parseImportedSimState(JSON.stringify(corrupt))).toThrow("校验未通过");
    }
  });
});

describe("v14 current saves, read-only recovery and cross-version conflicts", () => {
  it("round-trips a paid extension, moved equipment and a player standing in the new area", () => {
    let state = act(earned(), { type: "BUY_SPACE_EXPANSION" });
    const layout = structuredClone(state.renovation.layout);
    Object.assign(layout.placements.find((placement) => placement.id === "pantry-grains")!, { x: -1.7, z: 5.7, rotation: 1 });
    state = act(state, { type: "APPLY_SHOP_LAYOUT", layout });
    state = act(state, { type: "SAVE_POSE", pose: { x: 0, z: 6.5, yaw: 0.2, pitch: 0 } });
    const storage = new MemoryStorage(); saveSimState(state, storage);
    expect(loadSimState(storage)).toEqual({ source: "primary", state });
    expect(parseImportedSimState(storage.getItem(SIM_STORAGE_KEY)!)).toEqual(state);
  });

  it("retains previous v14 snapshots as backup and never overwrites good recovery with a corrupt primary", () => {
    const before = earned(); const after = act(before, { type: "BUY_SPACE_EXPANSION" });
    const storage = new MemoryStorage(); saveSimState(before, storage); saveSimState(after, storage);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(before);
    const invalid = structuredClone(after); invalid.renovation.layout.placements.pop();
    storage.data.set(SIM_STORAGE_KEY, JSON.stringify(invalid));
    const restored = loadSimState(storage);
    expect(restored).toMatchObject({ source: "backup", state: before, warning: expect.stringContaining("装修") });
    const backupRaw = storage.getItem(SIM_BACKUP_KEY);
    saveSimState(restored.state, storage);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(backupRaw);
    expect(loadSimState(storage)).toEqual({ source: "primary", state: before });
  });

  it("prefers a v9 backup over older versions, warns about lost renovation and keeps all old keys untouched", () => {
    const old = asV9(pendingCash()); const raw = JSON.stringify(old);
    const storage = new MemoryStorage();
    storage.data.set(SIM_STORAGE_KEY, "{broken-v14"); storage.data.set(SIM_BACKUP_KEY, "null");
    storage.data.set(SIM_V9_STORAGE_KEY, "{broken-v9"); storage.data.set(SIM_V9_BACKUP_KEY, raw);
    storage.data.set("english-high-street:sim3d:v8", JSON.stringify(asV8(stocked())));
    storage.data.set("english-high-street:save:v2", "untouched 2D data");
    const before = [...storage.data]; const restored = loadSimState(storage);
    expect(restored.source).toBe("v9-backup");
    expect(restored.warning).toContain("最近的装修、扩建与营业进度可能丢失");
    expect(restored.state.day).toEqual(old.day);
    expect(restored.state.payment).toEqual(old.payment?.method === "cash"
      ? { ...old.payment, tenderedCash: cashPiecesForAmount(old.payment.tenderedPence), tenderedCashRecorded: false }
      : old.payment);
    expect([...storage.data]).toEqual(before);
    saveSimState(restored.state, storage);
    for (const [key, value] of before.filter(([key]) => key !== SIM_STORAGE_KEY)) expect(storage.getItem(key)).toBe(value);
    expect(parseImportedSimState(raw)).toEqual(restored.state);
  });

  it("does not reset a valid v9 clock when no current v14 save exists", () => {
    const old = asV9(pendingCash()); const storage = new MemoryStorage();
    storage.data.set(SIM_V9_STORAGE_KEY, JSON.stringify(old));
    const restored = loadSimState(storage);
    expect(restored.source).toBe("v9");
    expect(restored.warning).not.toContain("09:00");
    expect(restored.state.day.elapsedOpenMs).toBe(old.day.elapsedOpenMs);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
  });

  it("freezes migration when an old v9 page changes its source after load", async () => {
    const current = pendingCash(); const old = asV9(current); const storage = new MemoryStorage();
    storage.data.set(SIM_V9_STORAGE_KEY, JSON.stringify(old));
    const session = new SimSaveSession(storage, null);
    expect(await session.acquire()).toBe(true);
    const loaded = session.load();
    const changedOld = asV9(act(current, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 100 }));
    storage.data.set(SIM_V9_STORAGE_KEY, JSON.stringify(changedOld));
    expect(() => session.save(loaded.state)).toThrow(SimSaveConflictError);
    expect(session.canWrite).toBe(false);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    await session.release();
  });

  it("refuses corrupt paid-floor summaries without destroying a valid current save", () => {
    const current = act(earned(), { type: "BUY_SPACE_EXPANSION" });
    const storage = new MemoryStorage(); saveSimState(current, storage);
    const raw = storage.getItem(SIM_STORAGE_KEY)!;
    const corrupt = structuredClone(current); corrupt.settlements[0]!.expansionSpendPence = 0;
    expect(() => saveSimState(corrupt, storage)).toThrow("校验失败");
    expect(() => parseImportedSimState(JSON.stringify(corrupt))).toThrow("校验未通过");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBeNull();
  });
});
