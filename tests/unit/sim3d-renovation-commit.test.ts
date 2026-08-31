import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFirstDayState, getDaySummary, reduceSim, validateSimState,
  type PlayerPose, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import {
  SIM_BACKUP_KEY, SIM_STORAGE_KEY, SimSaveSession, saveSimState, type StorageLike,
} from "../../src/sim3d/persistence";
import { SHOP_EXPANSION_COST_PENCE } from "../../src/sim3d/shopDevelopment";
import { validateShopLayout, type ShopLayout } from "../../src/sim3d/shopLayout";
import { payScannedCheckout } from "../helpers/sim3dPayment";

// Exercise App's real commit boundary without constructing WebGL or a browser UI.
vi.mock("../../src/sim3d/world", () => ({ ShopWorld: class {} }));
import { App3D } from "../../src/sim3d/App3D";

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  readonly writes: string[] = [];
  readonly failedWrites: string[] = [];
  failKey: string | null = null;

  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void {
    if (key === this.failKey) {
      this.failedWrites.push(key);
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    }
    this.data.set(key, value);
    this.writes.push(key);
  }
}

interface AppHarness {
  state: SimState;
  saveSession: SimSaveSession;
  mode: "paused" | "readonly";
  saveError: string;
  lastSaveText: string;
  writerWarning: string;
  world: { setState: ReturnType<typeof vi.fn>; getPose: () => PlayerPose };
  advanceBusinessTime: ReturnType<typeof vi.fn>;
  renderState: ReturnType<typeof vi.fn>;
  renderSaveStatus: ReturnType<typeof vi.fn>;
  syncCustomerCue: ReturnType<typeof vi.fn>;
  playInteractionSound: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  enterReadOnly: ReturnType<typeof vi.fn>;
  dispatch(command: SimCommand): boolean;
  persist(snapshot?: SimState): boolean;
}

const sessions: SimSaveSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.release()));
});

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

/** Buy and sell real stock, complete card/cash payments, then close the timed day. */
function earned(): SimState {
  let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "renovation-commit-stock", pairs: 3 });
  state = act(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    const crateId = state.crates.find((crate) => crate.productId === productId)!.id;
    state = act(state, { type: "PICK_CRATE", crateId });
    for (let slot = 0; slot < 3; slot += 1) state = act(state, { type: "STOCK", productId, slot });
    state = act(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.id === crateId)!.position });
  }
  for (let order = 0; order < 3; order += 1) {
    state = act(state, { type: order === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" });
    while (state.customer.phase !== "checkout") state = act(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
      state = act(state, { type: "SCAN", itemId: item.id });
    }
    state = payScannedCheckout(state);
    state = act(state, { type: "CUSTOMER_ADVANCE" });
  }
  state = act(act(state, { type: "CLOSE_STORE" }), { type: "SETTLE_DAY" });
  expect(state.cashPence).toBe(1710);
  return state;
}

function movedMilk(state: SimState, rotation: 1 | 3 = 1): ShopLayout {
  const layout = structuredClone(state.renovation.layout);
  Object.assign(layout.placements.find((placement) => placement.id === "milk-fridge")!, { x: 0, z: 1, rotation });
  expect(validateShopLayout(layout).valid).toBe(true);
  return layout;
}

async function harness(): Promise<{ app: AppHarness; storage: MemoryStorage }> {
  const storage = new MemoryStorage();
  saveSimState(createFirstDayState(), storage);
  saveSimState(earned(), storage);
  storage.writes.length = 0;
  const saveSession = new SimSaveSession(storage, null);
  sessions.push(saveSession);
  expect(await saveSession.acquire()).toBe(true);
  const state = saveSession.load().state;
  const app = Object.create(App3D.prototype) as AppHarness;
  Object.assign(app, {
    state, saveSession, mode: "paused", ready: true, saveError: "", lastSaveText: "", writerWarning: "",
    world: { setState: vi.fn(), getPose: () => ({ ...state.playerPose }) },
    advanceBusinessTime: vi.fn(), renderState: vi.fn(), renderSaveStatus: vi.fn(),
    syncCustomerCue: vi.fn(), playInteractionSound: vi.fn(), notify: vi.fn(),
    // Only read-only presentation is omitted; session conflict detection/release is real.
    enterReadOnly: vi.fn((message: string) => {
      void saveSession.release();
      app.mode = "readonly";
      app.writerWarning = message;
    }),
  });
  return { app, storage };
}

function expectUncommitted(app: AppHarness, before: SimState, original: SimState): void {
  expect(app.state).toBe(before);
  expect(app.state).toEqual(original);
  expect(app.world.setState).not.toHaveBeenCalled();
  expect(app.renderState).not.toHaveBeenCalled();
  expect(app.syncCustomerCue).not.toHaveBeenCalled();
  expect(app.playInteractionSound).not.toHaveBeenCalled();
  expect(app.notify).not.toHaveBeenCalled();
}

const quotaCases = [
  { label: "primary", key: SIM_STORAGE_KEY },
  { label: "backup", key: SIM_BACKUP_KEY },
];

describe("App renovation commits wait for a durable complete snapshot", () => {
  it.each(quotaCases)("keeps the old layout on $label write failure and commits the same draft once on retry", async ({ key }) => {
    const { app, storage } = await harness();
    const before = app.state;
    const original = structuredClone(before);
    const previousRaw = storage.getItem(SIM_STORAGE_KEY);
    const previousBackup = storage.getItem(SIM_BACKUP_KEY);
    const layout = movedMilk(before);
    const draft = structuredClone(layout);
    const command: SimCommand = { type: "APPLY_SHOP_LAYOUT", layout };
    storage.failKey = key;

    expect(app.dispatch(command)).toBe(false);
    expectUncommitted(app, before, original);
    expect(layout).toEqual(draft);
    expect(storage.failedWrites).toEqual([key]);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(previousRaw);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(key === SIM_BACKUP_KEY ? previousBackup : previousRaw);
    expect(app.saveSession.canWrite).toBe(true);
    expect(app.saveError).toContain("尚未保存");
    expect(app.lastSaveText).toBe("尚未保存");

    storage.failKey = null;
    expect(app.dispatch(command)).toBe(true);
    const committed = app.state;
    expect(committed.renovation.layout).toEqual(draft);
    expect(committed.renovation.layoutRevision).toBe(before.renovation.layoutRevision + 1);
    expect(committed.cashPence).toBe(before.cashPence);
    expect(committed.items).toEqual(before.items);
    expect(committed.transactions).toEqual(before.transactions);
    expect(committed.revision).toBe(before.revision + 1);
    expect(app.saveError).toBe("");
    expect(JSON.parse(storage.getItem(SIM_STORAGE_KEY)!)).toEqual(committed);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(previousRaw);
    expect(app.world.setState).toHaveBeenCalledExactlyOnceWith(committed);
    expect(app.renderState).toHaveBeenCalledTimes(1);

    expect(app.dispatch(command)).toBe(false);
    expect(app.state).toBe(committed);
    expect(storage.writes.filter((written) => written === SIM_STORAGE_KEY)).toHaveLength(1);
    expect(app.world.setState).toHaveBeenCalledTimes(1);
    expect(app.renderState).toHaveBeenCalledTimes(1);
  });

  it.each(quotaCases)("does not spend expansion money on $label write failure and charges exactly once after retry", async ({ key }) => {
    const { app, storage } = await harness();
    const before = app.state;
    const original = structuredClone(before);
    const previousRaw = storage.getItem(SIM_STORAGE_KEY);
    const previousBackup = storage.getItem(SIM_BACKUP_KEY);
    const command: SimCommand = { type: "BUY_SPACE_EXPANSION" };
    storage.failKey = key;

    expect(app.dispatch(command)).toBe(false);
    expectUncommitted(app, before, original);
    expect(app.state.cashPence).toBe(1710);
    expect(app.state.renovation.layout.expansion).toBe(0);
    expect(getDaySummary(app.state).expansionSpendPence).toBe(0);
    expect(storage.failedWrites).toEqual([key]);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(previousRaw);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(key === SIM_BACKUP_KEY ? previousBackup : previousRaw);
    expect(app.saveSession.canWrite).toBe(true);
    expect(app.saveError).toContain("尚未保存");

    storage.failKey = null;
    expect(app.dispatch(command)).toBe(true);
    const committed = app.state;
    expect(committed.cashPence).toBe(before.cashPence - SHOP_EXPANSION_COST_PENCE);
    expect(committed.renovation).toMatchObject({ layout: { expansion: 1 }, expansionDay: before.day.number, layoutRevision: 0 });
    expect(committed.items).toEqual(before.items);
    expect(committed.transactions).toEqual(before.transactions);
    expect(committed.settlements.at(-1)).toMatchObject({ expansionSpendPence: 1500, closingCashPence: 210, grossProfitPence: 510 });
    expect(committed.revision).toBe(before.revision + 1);
    expect(app.saveError).toBe("");
    expect(JSON.parse(storage.getItem(SIM_STORAGE_KEY)!)).toEqual(committed);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(previousRaw);
    expect(app.world.setState).toHaveBeenCalledExactlyOnceWith(committed);
    expect(app.renderState).toHaveBeenCalledTimes(1);

    expect(app.dispatch(command)).toBe(false);
    expect(app.state).toBe(committed);
    expect(app.state.cashPence).toBe(210);
    expect(storage.writes.filter((written) => written === SIM_STORAGE_KEY)).toHaveLength(1);
    expect(app.world.setState).toHaveBeenCalledTimes(1);
    expect(app.renderState).toHaveBeenCalledTimes(1);
  });

  it.each(["before dispatch", "after the first CAS check"])("retains the local layout when another real session saves %s", async (timing) => {
    const { app, storage } = await harness();
    const before = app.state;
    const original = structuredClone(before);
    const command: SimCommand = { type: "APPLY_SHOP_LAYOUT", layout: movedMilk(before) };
    const otherSession = new SimSaveSession(storage, null);
    sessions.push(otherSession);
    expect(await otherSession.acquire()).toBe(true);
    const external = act(otherSession.load().state, { type: "APPLY_SHOP_LAYOUT", layout: movedMilk(before, 3) });
    if (timing === "before dispatch") otherSession.save(external);
    else app.advanceBusinessTime.mockImplementationOnce(() => otherSession.save(external));

    expect(app.dispatch(command)).toBe(false);
    expectUncommitted(app, before, original);
    expect(app.mode).toBe("readonly");
    expect(app.enterReadOnly).toHaveBeenCalledTimes(1);
    expect(app.saveSession.canWrite).toBe(false);
    expect(JSON.parse(storage.getItem(SIM_STORAGE_KEY)!)).toEqual(external);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(JSON.stringify(before));
    expect(storage.writes.filter((written) => written === SIM_STORAGE_KEY)).toHaveLength(1);
  });
});
