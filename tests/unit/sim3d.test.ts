import { describe, expect, it } from "vitest";
import {
  PRODUCTS,
  SAFE_DROP_POINTS,
  canUnlockAdvancedUpgrade,
  capacityFor,
  countAt,
  createInitialSimState,
  getCheckoutTotal,
  getObjective,
  reduceSim,
  validateSimState,
  type ProductId,
  type SimCommand,
  type SimState,
} from "../../src/sim3d/domain";
import {
  SIM_BACKUP_KEY,
  SIM_STORAGE_KEY,
  loadSimState,
  saveSimState,
  type StorageLike,
} from "../../src/sim3d/persistence";

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  expect(result.state.revision).toBe(state.revision + 1);
  return result.state;
}

function stockAll(state = createInitialSimState()): SimState {
  for (const productId of ["milk", "bread"] as const) {
    state = act(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
    for (let slot = 0; slot < 4; slot += 1) state = act(state, { type: "STOCK", productId, slot });
    const position = state.crates.find((crate) => crate.productId === productId)!.position;
    state = act(state, { type: "DROP_HELD", position });
  }
  return state;
}

function atCheckout(state = stockAll()): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  for (let i = 0; i < 3; i += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
  return state;
}

function completeSale(state = stockAll()): SimState {
  state = atCheckout(state);
  for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout")) {
    state = act(state, { type: "SCAN", itemId: item.id });
  }
  state = act(state, { type: "PAY", success: true });
  return act(state, { type: "CUSTOMER_ADVANCE" });
}

function expectConserved(state: SimState): void {
  expect(state.items).toHaveLength(8);
  expect(new Set(state.items.map((item) => item.id)).size).toBe(8);
  for (const productId of ["milk", "bread"] as const) {
    const count = ["crate", "hand", "shelf", "basket", "checkout", "sold"] as const;
    expect(count.reduce((sum, kind) => sum + countAt(state, productId, kind), 0)).toBe(4);
  }
}

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  failKey?: string;
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
}

describe("3D S0 conserved physical inventory", () => {
  it("starts with two distinct crates, eight free trial goods and no claimed mastery", () => {
    const state = createInitialSimState();
    expect(validateSimState(state)).toBe(true);
    expectConserved(state);
    expect(state.crates.map((crate) => crate.position)).toEqual(SAFE_DROP_POINTS.slice(0, 2));
    expect(state.cashPence).toBe(0);
    expect(state.inspectedProducts).toEqual([]);
    expect(state).not.toHaveProperty("masteredProducts");
    expect(state).not.toHaveProperty("skills");
    expect(PRODUCTS.milk.pricePence + PRODUCTS.bread.pricePence).toBe(400);
    expect(capacityFor(state)).toBe(4);
    expect(getObjective(state)).toContain("货箱");
    state.items[0]!.location = { kind: "hand" };
    expect(createInitialSimState().items[0]!.location.kind).toBe("crate");
  });

  it("carrying and moving a crate do not relocate or copy its contained items", () => {
    const initial = createInitialSimState();
    let state = act(initial, { type: "PICK_CRATE", crateId: "milk-crate" });
    state = act(state, { type: "SAVE_POSE", pose: { x: 0.5, z: 1.5, yaw: 0.2, pitch: 0.1 } });
    expect(state.items).toEqual(initial.items);
    expect(initial.held.kind).toBe("none");
    expect(reduceSim(state, { type: "PICK_CRATE", crateId: "bread-crate" }).changed).toBe(false);
    expect(reduceSim(state, { type: "DROP_HELD", position: { x: 0, z: 0 } }).state).toBe(state);
    expect(reduceSim(state, { type: "DROP_HELD", position: SAFE_DROP_POINTS[1]! }).changed).toBe(false);
    state = act(state, { type: "DROP_HELD", position: SAFE_DROP_POINTS[2]! });
    expect(state.crates[0]!.position).toEqual(SAFE_DROP_POINTS[2]);
    expect(state.items).toEqual(initial.items);
    expectConserved(state);
  });

  it("keeps the opening objective on the held milk box through inspection, stocking and safe placement", () => {
    let state = act(createInitialSimState(), { type: "PICK_CRATE", crateId: "milk-crate" });
    expect(getObjective(state)).toContain("近看手里的牛奶");
    state = act(state, { type: "INSPECT", productId: "milk" });
    expect(getObjective(state)).toContain("牛奶冰柜");
    expect(getObjective(state)).not.toContain("面包");
    for (let slot = 0; slot < 4; slot += 1) state = act(state, { type: "STOCK", productId: "milk", slot });
    expect(getObjective(state)).toContain("按 G 放下");
    state = act(state, { type: "DROP_HELD", position: SAFE_DROP_POINTS[0]! });
    expect(getObjective(state)).toContain("面包货箱");
  });

  it("recognises whichever product the player actually picked up first", () => {
    let state = act(createInitialSimState(), { type: "PICK_CRATE", crateId: "bread-crate" });
    expect(getObjective(state)).toContain("近看手里的面包");
    state = act(state, { type: "INSPECT", productId: "bread" });
    expect(getObjective(state)).toContain("面包架");
    expect(getObjective(state)).not.toContain("近看牛奶");
  });

  it("allows stocking and opening without treating optional inspection as an English gate", () => {
    const state = stockAll();
    expect(state.inspectedProducts).toEqual([]);
    expect(getObjective(state)).toContain("营业牌");
    expect(act(state, { type: "OPEN_STORE" }).customer.phase).toBe("to-milk");
  });

  it("holds one item and returns it to its crate or exact original shelf slot", () => {
    let state = act(createInitialSimState(), { type: "TAKE_ITEM", itemId: "milk-1" });
    expect(countAt(state, "milk", "hand")).toBe(1);
    expect(countAt(state, "milk", "crate")).toBe(3);
    expect(reduceSim(state, { type: "TAKE_ITEM", itemId: "bread-1" }).changed).toBe(false);
    expect(reduceSim(state, { type: "DROP_HELD", position: SAFE_DROP_POINTS[2]! }).changed).toBe(false);
    state = act(state, { type: "RETURN_ITEM" });
    expect(countAt(state, "milk", "crate")).toBe(4);
    state = act(state, { type: "TAKE_ITEM", itemId: "milk-1" });
    state = act(state, { type: "STOCK", productId: "milk", slot: 2 });
    state = act(state, { type: "TAKE_ITEM", itemId: "milk-1" });
    state = act(state, { type: "RETURN_ITEM" });
    expect(state.items[0]!.location).toEqual({ kind: "shelf", productId: "milk", slot: 2 });
    expectConserved(state);
  });

  it("rejects wrong shelves, occupied/full slots and empty crates without losing stock", () => {
    let state = act(createInitialSimState(), { type: "PICK_CRATE", crateId: "milk-crate" });
    for (const command of [
      { type: "STOCK", productId: "bread", slot: 0 },
      { type: "STOCK", productId: "milk", slot: -1 },
      { type: "STOCK", productId: "milk", slot: 4 },
      { type: "STOCK", productId: "milk", slot: 0.5 },
    ] satisfies SimCommand[]) expect(reduceSim(state, command).state).toBe(state);
    state = act(state, { type: "STOCK", productId: "milk", slot: 0 });
    expect(reduceSim(state, { type: "STOCK", productId: "milk", slot: 0 }).changed).toBe(false);
    for (let slot = 1; slot < 4; slot += 1) state = act(state, { type: "STOCK", productId: "milk", slot });
    expect(countAt(state, "milk", "shelf")).toBe(4);
    expect(countAt(state, "milk", "crate")).toBe(0);
    expect(reduceSim(state, { type: "STOCK", productId: "milk", slot: 3 }).changed).toBe(false);
    expect(reduceSim(state, { type: "STOCK", productId: "bread", slot: 0 }).message).toContain("空");
    expectConserved(state);
  });

  it("inspection records exposure once and never fabricates English success", () => {
    const initial = createInitialSimState();
    const state = act(initial, { type: "INSPECT", productId: "milk" });
    expect(state.inspectedProducts).toEqual(["milk"]);
    expect(state.items).toEqual(initial.items);
    expect(state.cashPence).toBe(initial.cashPence);
    expect(reduceSim(state, { type: "INSPECT", productId: "milk" }).state).toBe(state);
    expect(state).not.toHaveProperty("completedIndependentTaskIds");
  });

  it("checks safe finite poses and makes unchanged pose saves a no-op", () => {
    const state = createInitialSimState();
    expect(reduceSim(state, { type: "SAVE_POSE", pose: state.playerPose }).state).toBe(state);
    for (const patch of [{ x: NaN }, { z: Infinity }, { x: 40 }, { yaw: Infinity }]) {
      expect(reduceSim(state, { type: "SAVE_POSE", pose: { ...state.playerPose, ...patch } }).changed).toBe(false);
    }
    const changed = act(state, { type: "SAVE_POSE", pose: { x: 0, z: 0, yaw: 9 * Math.PI, pitch: 5 } });
    expect(changed.playerPose.pitch).toBe(1.35);
    expect(Math.abs(changed.playerPose.yaw)).toBeLessThanOrEqual(Math.PI);
  });
});

describe("3D customer, scanning and transactional payment", () => {
  it("requires both products on display but never requires English progress to open", () => {
    const initial = createInitialSimState();
    expect(reduceSim(initial, { type: "OPEN_STORE" }).changed).toBe(false);
    let state = act(initial, { type: "TAKE_ITEM", itemId: "milk-1" });
    state = act(state, { type: "STOCK", productId: "milk", slot: 0 });
    expect(reduceSim(state, { type: "OPEN_STORE" }).changed).toBe(false);
    state = act(state, { type: "TAKE_ITEM", itemId: "bread-1" });
    state = act(state, { type: "STOCK", productId: "bread", slot: 0 });
    state = act(state, { type: "OPEN_STORE" });
    expect(state.customer.phase).toBe("to-milk");
    expect(state.inspectedProducts).toEqual([]);
    expect(reduceSim(state, { type: "OPEN_STORE" }).changed).toBe(false);
  });

  it("moves goods atomically from shelf to basket to counter and keeps exactly eight units", () => {
    let state = act(stockAll(), { type: "OPEN_STORE" });
    expect(countAt(state, "milk", "basket")).toBe(0);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(countAt(state, "milk", "shelf")).toBe(3);
    expect(countAt(state, "milk", "basket")).toBe(1);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(countAt(state, "bread", "basket")).toBe(1);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(countAt(state, "milk", "basket")).toBe(0);
    expect(getCheckoutTotal(state)).toBe(400);
    expect(state.customer.phase).toBe("checkout");
    expectConserved(state);
  });

  it("waits for replenishment instead of inventing a missing product", () => {
    let state = createInitialSimState();
    for (const productId of ["milk", "bread"] as const) {
      state = act(state, { type: "TAKE_ITEM", itemId: `${productId}-1` });
      state = act(state, { type: "STOCK", productId, slot: 0 });
    }
    state = act(state, { type: "OPEN_STORE" });
    state = act(state, { type: "TAKE_ITEM", itemId: "milk-1" });
    expect(reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state).toBe(state);
    state = act(state, { type: "RETURN_ITEM" });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    expect(state.customer.phase).toBe("to-bread");
    expectConserved(state);
  });

  it("cannot scan shelf goods, pay early, double-scan or double-charge", () => {
    let state = atCheckout();
    expect(reduceSim(state, { type: "SCAN", itemId: "milk-4" }).changed).toBe(false);
    expect(reduceSim(state, { type: "PAY", success: true }).changed).toBe(false);
    state = act(state, { type: "SCAN", itemId: "milk-1" });
    expect(reduceSim(state, { type: "SCAN", itemId: "milk-1" }).state).toBe(state);
    expect(getCheckoutTotal(state)).toBe(400);
    expect(reduceSim(state, { type: "PAY", success: true }).changed).toBe(false);
    state = act(state, { type: "SCAN", itemId: "bread-1" });
    const beforePay = state;
    expect(reduceSim(state, { type: "PAY", success: false }).state).toBe(beforePay);
    state = act(state, { type: "PAY", success: true });
    expect(state.cashPence).toBe(400);
    expect(state.transactions).toEqual([{ id: "sale-1", customerNumber: 1, itemIds: ["milk-1", "bread-1"], amountPence: 400 }]);
    expect(state.scannedIds).toEqual([]);
    expect(getCheckoutTotal(state)).toBe(0);
    expect(reduceSim(state, { type: "PAY", success: true }).state).toBe(state);
    expect(reduceSim(state, { type: "CANCEL_CUSTOMER" }).changed).toBe(false);
    expect(beforePay.cashPence).toBe(0);
    expect(beforePay.transactions).toHaveLength(0);
    expectConserved(state);
  });

  it.each([0, 1, 2, 3])("cancels at shopping stage %i and returns unpaid goods without money changes", (advances) => {
    let state = act(stockAll(), { type: "OPEN_STORE" });
    for (let i = 0; i < advances; i += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
    if (advances === 3) state = act(state, { type: "SCAN", itemId: "milk-1" });
    state = act(state, { type: "CANCEL_CUSTOMER" });
    expect(state.customer.phase).toBe("leaving");
    expect(state.cashPence).toBe(0);
    expect(state.transactions).toEqual([]);
    expect(state.scannedIds).toEqual([]);
    expect(countAt(state, "milk", "shelf")).toBe(4);
    expect(countAt(state, "bread", "shelf")).toBe(4);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    state = act(state, { type: "NEXT_CUSTOMER" });
    expect(state.customer.number).toBe(2);
    expectConserved(state);
  });

  it("handles a cancellation while a player holds another product", () => {
    let state = atCheckout();
    state = act(state, { type: "TAKE_ITEM", itemId: "milk-2" });
    state = act(state, { type: "CANCEL_CUSTOMER" });
    expect(countAt(state, "milk", "hand")).toBe(1);
    state = act(state, { type: "RETURN_ITEM" });
    expect(countAt(state, "milk", "shelf")).toBe(4);
    expectConserved(state);
  });

  it("never replenishes automatically between customers or after selling all eight goods", () => {
    let state = stockAll();
    for (let customer = 1; customer <= 4; customer += 1) {
      state = completeSale(state);
      expect(state.customer.number).toBe(customer);
      expect(countAt(state, "milk", "sold")).toBe(customer);
      expect(countAt(state, "bread", "sold")).toBe(customer);
      expectConserved(state);
    }
    expect(state.cashPence).toBe(1600);
    expect(reduceSim(state, { type: "NEXT_CUSTOMER" }).changed).toBe(false);
    expect(reduceSim(state, { type: "TAKE_ITEM", itemId: "milk-1" }).changed).toBe(false);
    expect(getObjective(state)).toContain("售完");
  });

  it("ordinary capacity upgrade uses money only, costs exactly once and creates no stock", () => {
    let state = completeSale();
    expect(reduceSim(state, { type: "BUY_UPGRADE" }).changed).toBe(false);
    state = completeSale(state);
    expect(state.cashPence).toBe(800);
    expect(state.inspectedProducts).toEqual([]);
    const items = structuredClone(state.items);
    state = act(state, { type: "BUY_UPGRADE" });
    expect(state.cashPence).toBe(0);
    expect(state.items).toEqual(items);
    expect(capacityFor(state)).toBe(8);
    expect(reduceSim(state, { type: "BUY_UPGRADE" }).changed).toBe(false);
    state = act(state, { type: "TAKE_ITEM", itemId: "milk-3" });
    state = act(state, { type: "STOCK", productId: "milk", slot: 7 });
    expectConserved(state);
  });

  it("advanced automation checks the corresponding task evidence, never a generic count", () => {
    const input = { cashPence: 1200, costPence: 800, requiredTaskIds: ["checkout.payment", "checkout.repair"] };
    expect(canUnlockAdvancedUpgrade({ ...input, completedIndependentTaskIds: ["checkout.payment", "checkout.repair"] })).toBe(true);
    expect(canUnlockAdvancedUpgrade({ ...input, completedIndependentTaskIds: ["stock.milk", "stock.bread", "other.task"] })).toBe(false);
    expect(canUnlockAdvancedUpgrade({ ...input, cashPence: 799, completedIndependentTaskIds: input.requiredTaskIds })).toBe(false);
    expect(canUnlockAdvancedUpgrade({ ...input, requiredTaskIds: [], completedIndependentTaskIds: [] })).toBe(false);
  });
});

describe("3D snapshot structural and economic validation", () => {
  it.each([
    ["old schema", (state: SimState) => { (state as { schemaVersion: number }).schemaVersion = 2 }],
    ["duplicate unit", (state: SimState) => { state.items[1] = structuredClone(state.items[0]!) }],
    ["extra unit", (state: SimState) => { state.items.push(structuredClone(state.items[0]!)) }],
    ["missing unit", (state: SimState) => { state.items.pop() }],
    ["unknown product", (state: SimState) => { state.items[0]!.productId = "juice" as ProductId }],
    ["wrong crate", (state: SimState) => { state.items[0]!.location = { kind: "crate", crateId: "bread-crate" } }],
    ["orphan hand", (state: SimState) => { state.items[0]!.location = { kind: "hand" } }],
    ["duplicate slot", (state: SimState) => { state.items[0]!.location = { kind: "shelf", productId: "milk", slot: 0 }; state.items[1]!.location = { kind: "shelf", productId: "milk", slot: 0 } }],
    ["locked slot", (state: SimState) => { state.items[0]!.location = { kind: "shelf", productId: "milk", slot: 4 } }],
    ["wrong shelf", (state: SimState) => { state.items[0]!.location = { kind: "shelf", productId: "bread", slot: 0 } }],
    ["fabricated cash", (state: SimState) => { state.cashPence = 1 }],
    ["fractional money", (state: SimState) => { state.cashPence = 0.5 }],
    ["free upgrade", (state: SimState) => { state.upgraded = true }],
    ["scan outside checkout", (state: SimState) => { state.scannedIds = ["milk-1"] }],
    ["orphan sale", (state: SimState) => { state.items[0]!.location = { kind: "sold", transactionId: "sale-1" } }],
    ["unexpected basket", (state: SimState) => { state.items[0]!.location = { kind: "basket" } }],
    ["overlapping crates", (state: SimState) => { state.crates[1]!.position = { ...state.crates[0]!.position } }],
    ["unsafe crate", (state: SimState) => { state.crates[0]!.position = { x: 0, z: 0 } }],
    ["infinite pose", (state: SimState) => { state.playerPose.x = Infinity }],
    ["outside pose", (state: SimState) => { state.playerPose.z = -50 }],
    ["negative revision", (state: SimState) => { state.revision = -1 }],
    ["repeated exposure", (state: SimState) => { state.inspectedProducts = ["milk", "milk"] }],
  ])("rejects %s", (_label, mutate) => {
    const state = createInitialSimState();
    mutate(state);
    expect(validateSimState(state)).toBe(false);
  });

  it("rejects null, foreign data and partial snapshots", () => {
    for (const input of [null, [], "hello", {}, { schemaVersion: 3 }, { schemaVersion: 2, cash: 500 }]) expect(validateSimState(input)).toBe(false);
  });

  it("reconciles paid item ownership, unique transaction membership and the exact amount", () => {
    const valid = completeSale();
    expect(validateSimState(valid)).toBe(true);
    for (const mutate of [
      (state: SimState) => { state.transactions[0]!.amountPence += 100; state.cashPence += 100 },
      (state: SimState) => { state.transactions.push(structuredClone(state.transactions[0]!)); state.cashPence *= 2 },
      (state: SimState) => { state.transactions[0]!.itemIds = ["milk-1", "milk-1"] },
      (state: SimState) => { state.items[0]!.location = { kind: "crate", crateId: "milk-crate" } },
      (state: SimState) => { state.transactions[0]!.customerNumber = 2 },
      (state: SimState) => { state.customer.phase = "checkout" },
    ]) {
      const broken = structuredClone(valid);
      mutate(broken);
      expect(validateSimState(broken)).toBe(false);
    }
  });
});

describe("3D isolated local snapshots and recovery", () => {
  it("cold-starts without touching legacy saves and round-trips the whole held world", () => {
    const storage = new MemoryStorage();
    storage.data.set("legacy-2d-save", "do-not-touch");
    expect(loadSimState(storage)).toEqual({ state: createInitialSimState(), source: "new" });
    let state = act(createInitialSimState(), { type: "PICK_CRATE", crateId: "milk-crate" });
    state = act(state, { type: "STOCK", productId: "milk", slot: 0 });
    state = act(state, { type: "SAVE_POSE", pose: { x: 0, z: 2.2, yaw: 0.5, pitch: 0.1 } });
    saveSimState(state, storage);
    expect(loadSimState(storage)).toEqual({ state, source: "primary" });
    expect(storage.data.get("legacy-2d-save")).toBe("do-not-touch");
    expectConserved(loadSimState(storage).state);
  });

  it("round-trips scanned checkout and successful payment without permitting replay", () => {
    const storage = new MemoryStorage();
    let state = atCheckout();
    state = act(state, { type: "SCAN", itemId: "milk-1" });
    state = act(state, { type: "SCAN", itemId: "bread-1" });
    saveSimState(state, storage);
    expect(loadSimState(storage).state).toEqual(state);
    state = act(loadSimState(storage).state, { type: "PAY", success: true });
    saveSimState(state, storage);
    const recovered = loadSimState(storage).state;
    expect(recovered.cashPence).toBe(400);
    expect(reduceSim(recovered, { type: "PAY", success: true }).changed).toBe(false);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toMatchObject({ cashPence: 0, customer: { phase: "checkout" } });
  });

  it("falls back to the previous valid snapshot and does not overwrite it with a corrupt primary", () => {
    const storage = new MemoryStorage();
    const initial = createInitialSimState();
    const observed = act(initial, { type: "INSPECT", productId: "milk" });
    saveSimState(initial, storage);
    saveSimState(observed, storage);
    storage.data.set(SIM_STORAGE_KEY, "{damaged json");
    const result = loadSimState(storage);
    expect(result.source).toBe("backup");
    expect(result.state).toEqual(initial);
    expect(result.warning).toContain("上一份");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe("{damaged json");
    saveSimState(observed, storage);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(initial);
    expect(loadSimState(storage).state).toEqual(observed);
  });

  it("rejects syntactically valid but inconsistent inventories and leaves bad snapshots intact on load", () => {
    const storage = new MemoryStorage();
    const bad = createInitialSimState();
    bad.cashPence = 3000;
    const serialized = JSON.stringify(bad);
    storage.data.set(SIM_STORAGE_KEY, serialized);
    storage.data.set(SIM_BACKUP_KEY, "null");
    const recovered = loadSimState(storage);
    expect(recovered.source).toBe("new");
    expect(recovered.warning).toContain("未被删除");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(serialized);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe("null");
    expect(() => saveSimState(bad, storage)).toThrow("校验失败");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(serialized);
  });

  it("propagates quota errors and preserves a valid recovery snapshot", () => {
    const storage = new MemoryStorage();
    const initial = createInitialSimState();
    saveSimState(initial, storage);
    const changed = act(initial, { type: "INSPECT", productId: "milk" });
    storage.failKey = SIM_STORAGE_KEY;
    expect(() => saveSimState(changed, storage)).toThrow("QuotaExceededError");
    expect(loadSimState(storage).state).toEqual(initial);
    expect(JSON.parse(storage.getItem(SIM_BACKUP_KEY)!)).toEqual(initial);
    storage.failKey = SIM_BACKUP_KEY;
    expect(() => saveSimState(changed, storage)).toThrow("QuotaExceededError");
    expect(loadSimState(storage).state).toEqual(initial);
  });

  it("propagates blocked storage access rather than claiming an available save", () => {
    const storage: StorageLike = {
      getItem: () => { throw new Error("SecurityError") },
      setItem: () => { throw new Error("SecurityError") },
    };
    expect(() => loadSimState(storage)).toThrow("SecurityError");
    expect(() => saveSimState(createInitialSimState(), storage)).toThrow("SecurityError");
  });

  it("does not rotate the backup for identical repeated saves", () => {
    const storage = new MemoryStorage();
    const initial = createInitialSimState();
    const changed = act(initial, { type: "INSPECT", productId: "milk" });
    saveSimState(initial, storage);
    saveSimState(changed, storage);
    const backup = storage.getItem(SIM_BACKUP_KEY);
    saveSimState(changed, storage);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(backup);
  });
});
