import { describe, expect, it } from "vitest";
import { createFirstDayState, createInitialSimState, reduceSim, validateSimState, type LegacySimState, type SimState } from "../../src/sim3d/domain";
import {
  SIM_BACKUP_KEY, SIM_STORAGE_KEY, SIM_LEGACY_STORAGE_KEY, SIM_LEGACY_BACKUP_KEY, SimSaveConflictError, SimSaveSession,
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

describe("v4 first-day persistence and read-only v3 migration", () => {
  it("starts the new namespace with £12 and empty crates without rewriting unrelated 2D data", () => {
    const storage = new MemoryStorage();
    storage.data.set("english-high-street:save:v2", "legacy-2d-content");
    const before = [...storage.data];
    expect(loadSimState(storage)).toEqual({ state: createFirstDayState(), source: "new" });
    expect([...storage.data]).toEqual(before);
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v4");
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
    expect(migrated.state.schemaVersion).toBe(4);
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

  it("prefers a valid v4 backup over older v3 progress", () => {
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

  it("detects a live S0 writer changing the migration source before the first v4 save", async () => {
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
  });
});
