import { describe, expect, it } from "vitest";
import {
  createFirstDayState, getDaySummary, migrateV10SimState, reduceSim,
  validateSimState, validateV10SimState, type SimCommand, type SimState, type SimStateV10,
} from "../../src/sim3d/domain";
import { streetNeighbourForDay } from "../../src/sim3d/streetNeighbourContent";
import {
  SIM_BACKUP_KEY, SIM_STORAGE_KEY, SIM_V10_BACKUP_KEY, SIM_V10_STORAGE_KEY, SIM_WRITER_LOCK,
  SimSaveSession, loadSimState, parseImportedSimState, saveSimState, type StorageLike,
} from "../../src/sim3d/persistence";

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

function rejected(state: SimState, command: SimCommand): string {
  const before = structuredClone(state);
  const result = reduceSim(state, command);
  expect(result.changed, command.type).toBe(false);
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
  return result.message ?? "";
}

function asV10(state: SimState): SimStateV10 {
  const { streetSupportRecords: _support, customer, settlements, ...base } = structuredClone(state);
  if (_support.length) throw new Error("v10 fixtures cannot contain community support");
  const { contentVersion: _content, ...oldCustomer } = customer;
  const previous: SimStateV10 = {
    ...base,
    schemaVersion: 10,
    customer: oldCustomer,
    settlements: settlements.map(({ communitySupportCount: _count, communityCashPence: _cash, ...record }) => record),
  };
  expect(validateV10SimState(previous)).toBe(true);
  return previous;
}

describe("v11 community cash-support ledger", () => {
  it("selects one stable neighbour per day and alternates the two neighbours across days", () => {
    const input = { customerSeed: 0x12345678, dayNumber: 1 };
    const dayOne = streetNeighbourForDay(input).id;
    expect(streetNeighbourForDay(structuredClone(input)).id).toBe(dayOne);
    expect(streetNeighbourForDay({ ...input, dayNumber: 2 }).id).not.toBe(dayOne);
    expect(new Set([dayOne, streetNeighbourForDay({ ...input, dayNumber: 2 }).id])).toEqual(new Set(["sam", "ellis"]));
  });

  it("deducts exactly once from real shop cash and reports community spending separately", () => {
    let state = createFirstDayState(); state.customerSeed = 1234;
    const neighbourId = streetNeighbourForDay({ customerSeed: state.customerSeed, dayNumber: state.day.number }).id;
    state = act(state, { type: "SUPPORT_STREET_NEIGHBOUR", neighbourId, amountPence: 200 });

    expect(state.cashPence).toBe(1000);
    expect(state.streetSupportRecords).toEqual([{
      id: `street-support-1-${neighbourId}`, dayNumber: 1, neighbourId, amountPence: 200,
    }]);
    expect(getDaySummary(state)).toMatchObject({
      communitySupportCount: 1, communityCashPence: 200, revenuePence: 0, grossProfitPence: 0, closingCashPence: 1000,
    });
    expect(rejected(state, { type: "SUPPORT_STREET_NEIGHBOUR", neighbourId, amountPence: 100 })).toContain("不会重复扣款");
    expect(state.cashPence).toBe(1000);
  });

  it("rejects the absent neighbour, unsupported amounts, insufficient funds and post-settlement writes", () => {
    let state = createFirstDayState(); state.customerSeed = 9;
    const neighbourId = streetNeighbourForDay({ customerSeed: state.customerSeed, dayNumber: state.day.number }).id;
    const absent = neighbourId === "sam" ? "ellis" : "sam";
    expect(rejected(state, { type: "SUPPORT_STREET_NEIGHBOUR", neighbourId: absent, amountPence: 100 })).toContain("今天不在");
    expect(rejected(state, { type: "SUPPORT_STREET_NEIGHBOUR", neighbourId, amountPence: 300 as 100 })).toContain("£1 或 £2");

    state = act(state, { type: "PURCHASE_STOCK", orderId: "leave-less-than-two", lines: [
      { productId: "coffee", quantity: 4 }, { productId: "water", quantity: 1 },
    ] });
    expect(state.cashPence).toBe(155);
    expect(rejected(state, { type: "SUPPORT_STREET_NEIGHBOUR", neighbourId, amountPence: 200 })).toContain("资金不足");

    state = act(state, { type: "RECEIVE_DELIVERY" });
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "SETTLE_DAY" });
    expect(rejected(state, { type: "SUPPORT_STREET_NEIGHBOUR", neighbourId, amountPence: 100 })).toContain("已经日结");
  });

  it("audits each settled day and rejects forged cash, ids, neighbours or summary totals", () => {
    let state = createFirstDayState(); state.customerSeed = 88;
    const firstId = streetNeighbourForDay({ customerSeed: state.customerSeed, dayNumber: state.day.number }).id;
    state = act(state, { type: "SUPPORT_STREET_NEIGHBOUR", neighbourId: firstId, amountPence: 100 });
    state = act(act(state, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
    expect(state.settlements[0]).toMatchObject({ communitySupportCount: 1, communityCashPence: 100, closingCashPence: 1100 });

    state = act(state, { type: "START_NEXT_DAY" });
    const secondId = streetNeighbourForDay({ customerSeed: state.customerSeed, dayNumber: state.day.number }).id;
    expect(secondId).not.toBe(firstId);
    state = act(state, { type: "SUPPORT_STREET_NEIGHBOUR", neighbourId: secondId, amountPence: 200 });
    expect(state.cashPence).toBe(900);
    expect(getDaySummary(state)).toMatchObject({ communitySupportCount: 1, communityCashPence: 200, closingCashPence: 900 });

    for (const mutate of [
      (copy: SimState) => { copy.cashPence += 100 },
      (copy: SimState) => { copy.streetSupportRecords[0]!.id = "street-support-forged" },
      (copy: SimState) => { copy.streetSupportRecords[0]!.neighbourId = copy.streetSupportRecords[0]!.neighbourId === "sam" ? "ellis" : "sam" },
      (copy: SimState) => { copy.settlements[0]!.communityCashPence = 0 },
    ]) {
      const corrupt = structuredClone(state); mutate(corrupt);
      expect(validateSimState(corrupt)).toBe(false);
    }
  });
});

describe("read-only v10 to v11 migration", () => {
  it("uses a new key, retains the writer lock and migrates v10 without changing cash or the old source", () => {
    expect(SIM_STORAGE_KEY).toBe("english-high-street:sim3d:v11");
    expect(SIM_BACKUP_KEY).toBe("english-high-street:sim3d:v11:backup");
    expect(SIM_V10_STORAGE_KEY).toBe("english-high-street:sim3d:v10");
    expect(SIM_V10_BACKUP_KEY).toBe("english-high-street:sim3d:v10:backup");
    expect(SIM_WRITER_LOCK).toBe("english-high-street:sim3d:v4:writer");

    const old = asV10(createFirstDayState());
    const raw = JSON.stringify(old); const storage = new MemoryStorage();
    storage.data.set(SIM_V10_STORAGE_KEY, raw);
    const loaded = loadSimState(storage);
    expect(loaded.source).toBe("v10");
    expect(loaded.state).toMatchObject({ schemaVersion: 11, cashPence: old.cashPence, streetSupportRecords: [],
      customer: { ...old.customer, contentVersion: 1 } });
    expect(loaded.state.settlements).toEqual([]);
    expect(storage.getItem(SIM_V10_STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    expect(parseImportedSimState(raw)).toEqual(loaded.state);
    saveSimState(loaded.state, storage);
    expect(storage.getItem(SIM_V10_STORAGE_KEY)).toBe(raw);
  });

  it("preserves the old active visitor on content v1 and upgrades only a newly begun visitor", () => {
    let current = createFirstDayState(); current.customerSeed = 77;
    current = act(current, { type: "PURCHASE_STOCK", orderId: "content-migration", lines: [{ productId: "water", quantity: 2 }] });
    current = act(current, { type: "RECEIVE_DELIVERY" });
    current = act(current, { type: "PICK_CRATE", crateId: "water-crate" });
    current = act(current, { type: "STOCK", productId: "water", slot: 0 });
    current = act(current, { type: "DROP_HELD", position: current.crates.find((crate) => crate.productId === "water")!.position });
    const migratedOutside = migrateV10SimState(asV10(current));
    expect(migratedOutside.customer.contentVersion).toBe(1);
    expect(act(migratedOutside, { type: "OPEN_STORE" }).customer.contentVersion).toBe(2);
    current = act(current, { type: "OPEN_STORE" });

    let migrated = migrateV10SimState(asV10(current));
    expect(migrated.customer.contentVersion).toBe(1);
    migrated = act(migrated, { type: "CANCEL_CUSTOMER" });
    expect(migrated.customer.contentVersion).toBe(1);
    migrated = act(migrated, { type: "CUSTOMER_ADVANCE" });
    expect(migrated.customer.contentVersion).toBe(1);
    migrated = act(migrated, { type: "NEXT_CUSTOMER" });
    expect(migrated.customer.contentVersion).toBe(2);

  });

  it("adds zero community columns to settled v10 history and refuses tampered migration sources", () => {
    let state = createFirstDayState();
    state = act(act(state, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
    const old = asV10(state); const before = structuredClone(old);
    const migrated = migrateV10SimState(old);
    expect(old).toEqual(before);
    expect(migrated.settlements[0]).toMatchObject({ communitySupportCount: 0, communityCashPence: 0 });
    expect(migrated.cashPence).toBe(old.cashPence);
    expect(validateSimState(migrated)).toBe(true);

    const corrupt = structuredClone(old); corrupt.cashPence += 1;
    expect(validateV10SimState(corrupt)).toBe(false);
    expect(() => migrateV10SimState(corrupt)).toThrow("校验失败");
    expect(() => parseImportedSimState(JSON.stringify(corrupt))).toThrow("校验未通过");
  });

  it("uses a valid v10 backup before older schemas and detects a v10 writer changing the migration source", async () => {
    const old = asV10(createFirstDayState()); const raw = JSON.stringify(old);
    const storage = new MemoryStorage();
    storage.data.set(SIM_STORAGE_KEY, "{broken-v11");
    storage.data.set(SIM_BACKUP_KEY, "null");
    storage.data.set(SIM_V10_STORAGE_KEY, "{broken-v10");
    storage.data.set(SIM_V10_BACKUP_KEY, raw);
    storage.data.set("english-high-street:sim3d:v9", "retained older source");
    const before = [...storage.data];
    const restored = loadSimState(storage);
    expect(restored).toMatchObject({ source: "v10-backup", state: { schemaVersion: 11, cashPence: old.cashPence } });
    expect(restored.warning).toContain("当前社区存档不可恢复");
    expect([...storage.data]).toEqual(before);

    const cleanStorage = new MemoryStorage(); cleanStorage.data.set(SIM_V10_STORAGE_KEY, raw);
    const session = new SimSaveSession(cleanStorage, null);
    expect(await session.acquire()).toBe(true);
    const migrated = session.load();
    expect(migrated.source).toBe("v10");
    cleanStorage.data.set(SIM_V10_STORAGE_KEY, JSON.stringify({ ...old, revision: old.revision + 1 }));
    expect(() => session.save(migrated.state)).toThrow("迁移源");
    expect(session.canWrite).toBe(false);
    expect(cleanStorage.getItem(SIM_STORAGE_KEY)).toBeNull();
    await session.release();
  });
});
