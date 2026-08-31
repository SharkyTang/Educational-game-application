import { describe, expect, it } from "vitest";
import { SAFE_DROP_POINTS, createFirstDayState, createInitialSimState, getDeliverySummary, migrateV4SimState, reduceSim, validateSimState, validateV4SimState, type LegacySimState, type SimState, type SimStateV4 } from "../../src/sim3d/domain";
import {
  SIM_BACKUP_KEY, SIM_STORAGE_KEY, SIM_LEGACY_STORAGE_KEY, SIM_LEGACY_BACKUP_KEY, SimSaveConflictError, SimSaveSession,
  SIM_V4_STORAGE_KEY, SIM_V4_BACKUP_KEY, SIM_WRITER_LOCK,
  loadSimState, parseImportedSimState, saveSimState,
  type SimLockManager, type StorageLike,
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

class ExclusiveLocks implements SimLockManager {
  held = false;
  async request(_name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<void> {
    if (this.held) { await callback(null); return }
    this.held = true;
    try { await callback({}) }
    finally { this.held = false }
  }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve() };

function paidSnapshot(): SimState {
  let state = createInitialSimState();
  for (const productId of ["milk", "bread"] as const) {
    state = reduceSim(state, { type: "TAKE_ITEM", itemId: `${productId}-1` }).state;
    state = reduceSim(state, { type: "STOCK", productId, slot: 0 }).state;
  }
  state = reduceSim(state, { type: "OPEN_STORE" }).state;
  for (let i = 0; i < 3; i += 1) state = reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state;
  for (const itemId of ["milk-1", "bread-1"]) state = reduceSim(state, { type: "SCAN", itemId }).state;
  return reduceSim(state, { type: "PAY", success: true }).state;
}

function oldSnapshot(state = paidSnapshot()): LegacySimState {
  return {
    schemaVersion: 3, revision: state.revision, items: structuredClone(state.items), crates: structuredClone(state.crates),
    held: structuredClone(state.held), inspectedProducts: [...state.inspectedProducts], customer: { ...state.customer },
    scannedIds: [...state.scannedIds], transactions: structuredClone(state.transactions), cashPence: state.cashPence,
    upgraded: state.upgraded, playerPose: { ...state.playerPose },
  };
}

function v4Snapshot(): SimStateV4 {
  let state = reduceSim(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "v4-original", pairs: 3 }).state;
  state = reduceSim(state, { type: "RECEIVE_DELIVERY" }).state;
  return {
    ...structuredClone(state), schemaVersion: 4,
    crates: state.crates.map((crate, index) => ({ ...crate, position: { ...SAFE_DROP_POINTS[index]! } })),
    purchases: state.purchases.map(({ id, dayNumber, pairs, itemIds, amountPence }) => ({ id, dayNumber, pairs, itemIds: [...itemIds], amountPence })),
  };
}

describe("3D single-writer save sessions", () => {
  it("holds the Web Lock until release and denies the second page permission to write progress or settings", async () => {
    const storage = new MemoryStorage();
    const locks = new ExclusiveLocks();
    const first = new SimSaveSession(storage, locks);
    const second = new SimSaveSession(storage, locks);
    expect(await first.acquire()).toBe(true);
    expect(first.strategy).toBe("web-locks");
    const state = first.load().state;
    first.save(state);
    expect(await second.acquire()).toBe(false);
    expect(second.canWrite).toBe(false);
    second.load();
    expect(() => second.save(paidSnapshot())).toThrow(SimSaveConflictError);
    expect(() => second.assertCurrent()).toThrow("进度或设置");
    first.release();
    await settle();
    expect(await second.acquire()).toBe(true);
    second.load();
    second.save(paidSnapshot());
    expect(loadSimState(storage).state.cashPence).toBe(400);
    second.release();
    await settle();
    expect(locks.held).toBe(false);
  });

  it("allows the same page to reacquire after pagehide but requires a fresh load", async () => {
    const storage = new MemoryStorage();
    const locks = new ExclusiveLocks();
    const session = new SimSaveSession(storage, locks);
    await session.acquire();
    session.load();
    session.save(createInitialSimState());
    session.release();
    await settle();
    expect(await session.acquire()).toBe(true);
    expect(() => session.save(createInitialSimState())).toThrow("尚未读取");
    session.load();
    expect(() => session.save(paidSnapshot())).not.toThrow();
    session.release();
  });

  it("releasing during pending acquisition does not leave a hidden lifetime lock", async () => {
    const storage = new MemoryStorage();
    let grant: (() => Promise<void>) | undefined;
    const locks: SimLockManager = {
      request: (_name, _options, callback) => new Promise<void>((resolve) => {
        grant = async () => { await callback({}); resolve() };
      }),
    };
    const session = new SimSaveSession(storage, locks);
    const acquired = session.acquire();
    await settle();
    session.release();
    expect(await acquired).toBe(false);
    await grant!();
    expect(session.canWrite).toBe(false);
  });

  it("reports a denied Lock API without silently granting fallback write permission", async () => {
    const storage = new MemoryStorage();
    const locks: SimLockManager = { request: () => { throw new Error("SecurityError") } };
    const session = new SimSaveSession(storage, locks);
    await expect(session.acquire()).rejects.toThrow("SecurityError");
    expect(session.canWrite).toBe(false);
    await expect(session.acquire()).rejects.toThrow("SecurityError");
  });

  it("CAS fallback rejects an older tab before it can roll paid cash and sold stock back", async () => {
    const storage = new MemoryStorage();
    saveSimState(createInitialSimState(), storage);
    const first = new SimSaveSession(storage, null);
    const stale = new SimSaveSession(storage, null);
    await first.acquire(); await stale.acquire();
    first.load();
    const oldState = stale.load().state;
    first.save(paidSnapshot());
    expect(stale.strategy).toBe("snapshot-cas");
    expect(() => stale.save(oldState)).toThrow(SimSaveConflictError);
    expect(stale.canWrite).toBe(false);
    expect(loadSimState(storage).state.cashPence).toBe(400);
    expect(loadSimState(storage).state.items.filter((item) => item.location.kind === "sold")).toHaveLength(2);
  });

  it("compares the full original snapshot, even when the stale branch has a larger local revision", async () => {
    const storage = new MemoryStorage();
    saveSimState(createInitialSimState(), storage);
    const first = new SimSaveSession(storage, null);
    const stale = new SimSaveSession(storage, null);
    await first.acquire(); await stale.acquire();
    const a = first.load().state;
    let b = stale.load().state;
    for (let i = 0; i < 6; i += 1) b = reduceSim(b, { type: "SAVE_POSE", pose: { x: 0, z: -3 + i * 0.1, yaw: 0, pitch: 0 } }).state;
    first.save(reduceSim(a, { type: "INSPECT", productId: "milk" }).state);
    expect(b.revision).toBeGreaterThan(loadSimState(storage).state.revision);
    expect(() => stale.save(b)).toThrow(SimSaveConflictError);
    expect(loadSimState(storage).state.inspectedProducts).toEqual(["milk"]);
  });

  it("freezes the session immediately on a conflicting storage event", async () => {
    const storage = new MemoryStorage();
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    session.load();
    session.save(createInitialSimState());
    expect(session.observeExternalSnapshot(storage.getItem(SIM_STORAGE_KEY))).toBe(false);
    expect(session.observeExternalSnapshot(JSON.stringify(paidSnapshot()))).toBe(true);
    expect(session.canWrite).toBe(false);
    expect(() => session.assertCurrent()).toThrow(SimSaveConflictError);
  });

  it("retains write ownership and its original CAS baseline after a quota failure so retry remains safe", async () => {
    const storage = new MemoryStorage();
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    session.load();
    session.save(createInitialSimState());
    storage.failKey = SIM_STORAGE_KEY;
    expect(() => session.save(paidSnapshot())).toThrow("QuotaExceededError");
    expect(session.canWrite).toBe(true);
    storage.failKey = undefined;
    session.save(paidSnapshot());
    expect(loadSimState(storage).state.cashPence).toBe(400);
  });
});

describe("3D complete snapshot import", () => {
  it("round-trips a paid snapshot and retains the pre-import world as the valid backup", async () => {
    const storage = new MemoryStorage();
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    session.load();
    const current = reduceSim(createInitialSimState(), { type: "PICK_CRATE", crateId: "bread-crate" }).state;
    session.save(current);
    const imported = parseImportedSimState(JSON.stringify(paidSnapshot(), null, 2));
    expect(validateSimState(imported)).toBe(true);
    session.save(imported);
    expect(loadSimState(storage).state).toEqual(imported);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(current);
    expect(reduceSim(loadSimState(storage).state, { type: "PAY", success: true }).changed).toBe(false);
  });

  it("rejects malformed, legacy, tampered and oversized files without touching the current save", () => {
    const storage = new MemoryStorage();
    const current = createInitialSimState();
    saveSimState(current, storage);
    const before = storage.getItem(SIM_STORAGE_KEY);
    for (const raw of ["{broken", "null", JSON.stringify({ schemaVersion: 2 }), JSON.stringify({ ...current, cashPence: 10000 }), " ".repeat(2_000_001)]) {
      expect(() => parseImportedSimState(raw)).toThrow();
      expect(storage.getItem(SIM_STORAGE_KEY)).toBe(before);
    }
  });
});

describe("safe crate placement around the player", () => {
  it.each(["milk", "bread"] as const)("rejects placing the %s crate on the player's feet", (productId) => {
    let state = reduceSim(createInitialSimState(), { type: "PICK_CRATE", crateId: `${productId}-crate` }).state;
    const position = state.crates.find((crate) => crate.productId === productId)!.position;
    state = reduceSim(state, { type: "SAVE_POSE", pose: { ...position, yaw: 0, pitch: 0 } }).state;
    const result = reduceSim(state, { type: "DROP_HELD", position });
    expect(result.changed).toBe(false);
    expect(result.message).toContain("脚下");
    expect(result.state).toBe(state);
    expect(result.state.held.kind).toBe("crate");
  });
});

describe("v5 delivery persistence and read-only v3 migration", () => {
  it("starts the new namespace with £12 and empty crates without rewriting unrelated 2D data", () => {
    const storage = new MemoryStorage();
    storage.data.set("english-high-street:save:v2", "legacy-2d-content");
    const before = [...storage.data];
    expect(loadSimState(storage)).toEqual({ state: createFirstDayState(), source: "new" });
    expect([...storage.data]).toEqual(before);
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v5");
  });

  it("migrates the valid v3 world once and leaves both original v3 keys byte-for-byte intact", () => {
    const storage = new MemoryStorage();
    const primary = JSON.stringify(oldSnapshot(), null, 2);
    const backup = JSON.stringify(oldSnapshot(createInitialSimState()));
    storage.data.set(SIM_LEGACY_STORAGE_KEY, primary);
    storage.data.set(SIM_LEGACY_BACKUP_KEY, backup);
    const before = [...storage.data];
    const migrated = loadSimState(storage);
    expect(migrated.source).toBe("legacy");
    expect(migrated.warning).toContain("不会额外发放");
    expect(migrated.state.cashPence).toBe(400);
    expect(migrated.state.schemaVersion).toBe(5);
    expect(migrated.state.transactions).toEqual(oldSnapshot().transactions);
    expect([...storage.data]).toEqual(before);
    saveSimState(migrated.state, storage);
    expect(storage.getItem(SIM_LEGACY_STORAGE_KEY)).toBe(primary);
    expect(storage.getItem(SIM_LEGACY_BACKUP_KEY)).toBe(backup);
    expect(loadSimState(storage)).toEqual({ state: migrated.state, source: "primary" });
    storage.data.set(SIM_LEGACY_STORAGE_KEY, backup);
    expect(loadSimState(storage).state.cashPence).toBe(400);
  });

  it("migrates the old valid backup when the old primary is corrupt, without destroying either", () => {
    const storage = new MemoryStorage();
    const backup = JSON.stringify(oldSnapshot());
    storage.data.set(SIM_LEGACY_STORAGE_KEY, "{invalid");
    storage.data.set(SIM_LEGACY_BACKUP_KEY, backup);
    const result = loadSimState(storage);
    expect(result.source).toBe("legacy-backup");
    expect(result.state.cashPence).toBe(400);
    expect(result.warning).toContain("旧备份");
    saveSimState(result.state, storage);
    expect(storage.getItem(SIM_LEGACY_STORAGE_KEY)).toBe("{invalid");
    expect(storage.getItem(SIM_LEGACY_BACKUP_KEY)).toBe(backup);
  });

  it("prefers a valid v5 backup over older v3 progress", () => {
    const storage = new MemoryStorage();
    const state = reduceSim(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "real-purchase", pairs: 3 }).state;
    storage.data.set(SIM_STORAGE_KEY, "{bad");
    storage.data.set(SIM_BACKUP_KEY, JSON.stringify(state));
    storage.data.set(SIM_LEGACY_STORAGE_KEY, JSON.stringify(oldSnapshot()));
    const result = loadSimState(storage);
    expect(result.source).toBe("backup");
    expect(result.state).toEqual(state);
    expect(result.state.cashPence).toBe(510);
  });

  it("clearly warns when corrupt new progress can only recover the older S0 source", () => {
    const storage = new MemoryStorage();
    storage.data.set(SIM_STORAGE_KEY, "{bad");
    storage.data.set(SIM_BACKUP_KEY, "null");
    storage.data.set(SIM_LEGACY_STORAGE_KEY, JSON.stringify(oldSnapshot()));
    const result = loadSimState(storage);
    expect(result.source).toBe("legacy");
    expect(result.warning).toContain("采购与营业进度可能丢失");
    expect(result.state.cashPence).toBe(400);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe("{bad");
  });

  it("rejects fabricated old money even when JSON parses and preserves both bad old snapshots", () => {
    const storage = new MemoryStorage();
    const bad = oldSnapshot();
    bad.cashPence += 1200;
    const raw = JSON.stringify(bad);
    storage.data.set(SIM_LEGACY_STORAGE_KEY, raw);
    storage.data.set(SIM_LEGACY_BACKUP_KEY, "null");
    const result = loadSimState(storage);
    expect(result.source).toBe("new");
    expect(result.state).toEqual(createFirstDayState());
    expect(result.warning).toContain("未被删除");
    expect(storage.getItem(SIM_LEGACY_STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(SIM_LEGACY_BACKUP_KEY)).toBe("null");
    expect(() => parseImportedSimState(raw)).toThrow("校验未通过");
  });

  it("accepts validated v3 file imports with the same no-grant migration", () => {
    const old = oldSnapshot();
    const imported = parseImportedSimState(JSON.stringify(old));
    expect(validateSimState(imported)).toBe(true);
    expect(imported.cashPence).toBe(old.cashPence);
    expect(imported.items).toEqual(old.items);
    expect(imported.customer).toEqual(old.customer);
    expect(imported.scannedIds).toEqual(old.scannedIds);
    expect(imported.day.openingCashPence).toBe(0);
  });

  it("detects a live S0 writer changing the migration source before the first v5 save", async () => {
    const storage = new MemoryStorage();
    storage.data.set(SIM_LEGACY_STORAGE_KEY, JSON.stringify(oldSnapshot(createInitialSimState())));
    const session = new SimSaveSession(storage, null);
    expect(await session.acquire()).toBe(true);
    const snapshot = session.load();
    expect(snapshot.source).toBe("legacy");
    storage.data.set(SIM_LEGACY_STORAGE_KEY, JSON.stringify(oldSnapshot()));
    expect(() => session.save(snapshot.state)).toThrow("迁移源");
    expect(session.canWrite).toBe(false);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    expect(loadSimState(storage).state.cashPence).toBe(400);
  });

  it("prevents two CAS-fallback pages from independently persisting the same migration", async () => {
    const storage = new MemoryStorage();
    storage.data.set(SIM_LEGACY_STORAGE_KEY, JSON.stringify(oldSnapshot()));
    const first = new SimSaveSession(storage, null);
    const stale = new SimSaveSession(storage, null);
    await first.acquire(); await stale.acquire();
    const firstState = first.load().state;
    const staleState = stale.load().state;
    const advanced = reduceSim(firstState, { type: "CUSTOMER_ADVANCE" }).state;
    first.save(advanced);
    expect(() => stale.save(staleState)).toThrow(SimSaveConflictError);
    expect(loadSimState(storage).state.customer.phase).toBe("complete");
    expect(storage.getItem(SIM_LEGACY_STORAGE_KEY)).toBe(JSON.stringify(oldSnapshot()));
  });

  it("preserves the last complete procurement ledger on quota failure and imports without minting goods", async () => {
    const storage = new MemoryStorage();
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    const fresh = session.load().state;
    session.save(fresh);
    const purchased = reduceSim(fresh, { type: "PURCHASE_STOCK", orderId: "real-order", pairs: 3 }).state;
    storage.failKey = SIM_STORAGE_KEY;
    expect(() => session.save(purchased)).toThrow("QuotaExceededError");
    expect(loadSimState(storage).state).toEqual(fresh);
    storage.failKey = undefined;
    session.save(purchased);
    const restored = parseImportedSimState(storage.getItem(SIM_STORAGE_KEY)!);
    expect(restored).toEqual(purchased);
    expect(reduceSim(restored, { type: "PURCHASE_STOCK", orderId: "real-order", pairs: 3 }).state).toBe(restored);
    expect(restored.items).toHaveLength(6);
    expect(restored.cashPence).toBe(510);
    expect(getDeliverySummary(restored)).toMatchObject({ pendingOrders: 1, pendingUnits: 6, receivedToday: 0 });
    const signed = reduceSim(restored, { type: "RECEIVE_DELIVERY" }).state;
    session.save(signed);
    const reloaded = loadSimState(storage).state;
    expect(getDeliverySummary(reloaded)).toMatchObject({ pendingOrders: 0, receivedToday: 1 });
    expect(reduceSim(reloaded, { type: "RECEIVE_DELIVERY" }).state).toBe(reloaded);
    expect(reloaded.cashPence).toBe(510);
    expect(reloaded.items.map((item) => item.id)).toEqual(restored.items.map((item) => item.id));
  });
});

describe("audited v4 migration and coexistence with an older page", () => {
  it("keeps the v4 writer lock across the namespace upgrade", () => {
    expect(SIM_WRITER_LOCK).toBe("english-high-street:sim3d:v4:writer");
  });

  it("migrates paid v4 goods in place without new money, cargo or receipt actions", () => {
    const storage = new MemoryStorage();
    const old = v4Snapshot();
    expect(validateV4SimState(old)).toBe(true);
    const primary = JSON.stringify(old, null, 2);
    const backup = JSON.stringify({ ...old, revision: old.revision + 1 });
    storage.data.set(SIM_V4_STORAGE_KEY, primary);
    storage.data.set(SIM_V4_BACKUP_KEY, backup);
    storage.data.set(SIM_LEGACY_STORAGE_KEY, JSON.stringify(oldSnapshot()));
    const before = [...storage.data];
    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v4");
    expect(loaded.warning).toContain("不会重复扣款或发货");
    expect(validateSimState(loaded.state)).toBe(true);
    expect(loaded.state.cashPence).toBe(old.cashPence);
    expect(loaded.state.items).toEqual(old.items);
    expect(loaded.state.crates).toEqual(old.crates);
    expect(loaded.state.transactions).toEqual(old.transactions);
    expect(loaded.state.purchases[0]?.receivedDay).toBe(1);
    expect(getDeliverySummary(loaded.state)).toMatchObject({ pendingOrders: 0, pendingUnits: 0, receivedToday: 1 });
    expect(reduceSim(loaded.state, { type: "RECEIVE_DELIVERY" }).state).toBe(loaded.state);
    expect([...storage.data]).toEqual(before);
    saveSimState(loaded.state, storage);
    expect(storage.getItem(SIM_V4_STORAGE_KEY)).toBe(primary);
    expect(storage.getItem(SIM_V4_BACKUP_KEY)).toBe(backup);
    expect(loadSimState(storage).source).toBe("primary");
    expect(parseImportedSimState(primary)).toEqual(loaded.state);
  });

  it("uses the validated v4 backup before v3 and explicitly warns if newer progress is unavailable", () => {
    const storage = new MemoryStorage();
    const old = JSON.stringify(v4Snapshot());
    storage.data.set(SIM_STORAGE_KEY, "{corrupt-v5");
    storage.data.set(SIM_V4_STORAGE_KEY, "{corrupt-v4");
    storage.data.set(SIM_V4_BACKUP_KEY, old);
    storage.data.set(SIM_LEGACY_STORAGE_KEY, JSON.stringify(oldSnapshot()));
    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v4-backup");
    expect(loaded.warning).toContain("进度可能丢失");
    expect(loaded.state.cashPence).toBe(510);
    saveSimState(loaded.state, storage);
    expect(storage.getItem(SIM_V4_STORAGE_KEY)).toBe("{corrupt-v4");
    expect(storage.getItem(SIM_V4_BACKUP_KEY)).toBe(old);
  });

  it.each([
    ["cash", (old: SimStateV4) => { old.cashPence += 1200 }],
    ["missing purchase", (old: SimStateV4) => { old.purchases = [] }],
    ["incorrect purchase charge", (old: SimStateV4) => { old.purchases[0]!.amountPence = 100 }],
    ["unaudited extra goods", (old: SimStateV4) => { old.items.push({ id: "free-milk", productId: "milk", location: { kind: "crate", crateId: "milk-crate" } }) }],
    ["new cargo in an old schema", (old: SimStateV4) => { old.items[0]!.location = { kind: "delivery", orderId: old.purchases[0]!.id } }],
  ])("does not bless forged old %s through migration", (_label, mutate) => {
    const old = v4Snapshot();
    mutate(old);
    expect(validateV4SimState(old)).toBe(false);
    expect(() => migrateV4SimState(old)).toThrow("校验失败");
    expect(() => parseImportedSimState(JSON.stringify(old))).toThrow("校验未通过");
  });

  it.each([SIM_V4_STORAGE_KEY, SIM_V4_BACKUP_KEY])("rejects a migration when an old writer changes %s", async (sourceKey) => {
    const storage = new MemoryStorage();
    storage.data.set(SIM_V4_STORAGE_KEY, JSON.stringify(v4Snapshot()));
    const session = new SimSaveSession(storage, null);
    expect(await session.acquire()).toBe(true);
    const snapshot = session.load();
    expect(snapshot.source).toBe("v4");
    storage.data.set(sourceKey, JSON.stringify({ ...v4Snapshot(), revision: 50 }));
    expect(() => session.save(snapshot.state)).toThrow("迁移源");
    expect(session.canWrite).toBe(false);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
  });

  it("preserves migration sources through quota failure and can safely retry the same v5 snapshot", async () => {
    const storage = new MemoryStorage();
    const original = JSON.stringify(v4Snapshot());
    storage.data.set(SIM_V4_STORAGE_KEY, original);
    const session = new SimSaveSession(storage, null);
    await session.acquire();
    const state = session.load().state;
    storage.failKey = SIM_STORAGE_KEY;
    expect(() => session.save(state)).toThrow("QuotaExceededError");
    expect(session.canWrite).toBe(true);
    expect(storage.getItem(SIM_V4_STORAGE_KEY)).toBe(original);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    storage.failKey = undefined;
    session.save(state);
    expect(loadSimState(storage).state).toEqual(state);
    expect(storage.getItem(SIM_V4_STORAGE_KEY)).toBe(original);
  });
});
