import { describe, expect, it } from "vitest";
import { CASH_DENOMINATIONS_PENCE, MAX_CHANGE_PIECES, type CashPaymentState } from "../../src/sim3d/cashPayment";
import { createDefaultCashDrawer } from "../../src/sim3d/cashDrawer";
import {
  MAX_VISIBLE_CASH_STACK_PIECES, cashVisualPickCommand, deriveCashVisualState,
  type CashVisualInput, type CashVisualPick,
} from "../../src/sim3d/cashVisualState";

function input(overrides: Partial<CashVisualInput> = {}): CashVisualInput {
  return {
    payment: { method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true,
      received: false, selectedChange: [] },
    cashDrawer: createDefaultCashDrawer(), amountPence: 435, checkout: true, open: true, canInteract: true,
    ...overrides,
  };
}
function received(selectedChange: number[] = [], overrides: Partial<CashPaymentState> = {}): CashPaymentState {
  return { method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true,
    received: true, selectedChange, ...overrides };
}
const picks: CashVisualPick[] = [{ kind: "receive" }, { kind: "add", denominationPence: 50 }, { kind: "remove", index: 0 }];

describe("cash v4 immutable visible drawer projection", () => {
  it("shows all ten denomination slots with exact count labels and bounded representative stacks", () => {
    const snapshot = deriveCashVisualState(input());
    expect(snapshot.drawer.map((slot) => slot.denominationPence)).toEqual(CASH_DENOMINATIONS_PENCE);
    expect(snapshot.drawer).toHaveLength(10);
    const drawer = createDefaultCashDrawer();
    for (const slot of snapshot.drawer) {
      expect(slot.drawerCount).toBe(drawer[slot.denominationPence]);
      expect(slot.actualCount).toBe(drawer[slot.denominationPence]);
      expect(slot.reservedCount).toBe(0);
      expect(slot.stackCount).toBe(Math.min(slot.actualCount, MAX_VISIBLE_CASH_STACK_PIECES));
      expect(slot.kind).toBe(slot.denominationPence >= 500 ? "note" : "coin");
      expect(slot.canAdd).toBe(false);
    }
  });

  it("shows offered tender before receipt without adding its note to spendable drawer inventory", () => {
    const snapshot = deriveCashVisualState(input());
    expect(snapshot).toMatchObject({ stage: "awaiting", canReceive: true, tenderedPence: 500,
      amountPence: 435, changeDuePence: 65, selectedChangePence: 0, tender: [500], tenderSource: "recorded" });
    expect(snapshot.drawer.find((slot) => slot.denominationPence === 500)).toMatchObject({ drawerCount: 0, actualCount: 0, stackCount: 0, canAdd: false });
    expect(cashVisualPickCommand(snapshot, { kind: "receive" })).toEqual({ type: "RECEIVE_CASH" });
    expect(cashVisualPickCommand(snapshot, { kind: "add", denominationPence: 50 })).toBeNull();
  });

  it("deducts tray reservations from visible drawer counts, while even received tender stays separate", () => {
    const snapshot = deriveCashVisualState(input({ payment: received([50, 10, 5]) }));
    expect(snapshot).toMatchObject({ stage: "received", canReceive: false, selectedChangePence: 65 });
    expect(snapshot.drawer.find((slot) => slot.denominationPence === 50)).toMatchObject({ drawerCount: 10, reservedCount: 1, actualCount: 9, stackCount: 6, canAdd: true });
    expect(snapshot.drawer.find((slot) => slot.denominationPence === 500)).toMatchObject({ drawerCount: 0, reservedCount: 0, actualCount: 0, canAdd: false });
    expect(snapshot.change).toEqual([
      { denominationPence: 50, index: 0, canRemove: true },
      { denominationPence: 10, index: 1, canRemove: true },
      { denominationPence: 5, index: 2, canRemove: true },
    ]);
    expect(cashVisualPickCommand(snapshot, { kind: "receive" })).toBeNull();
    expect(cashVisualPickCommand(snapshot, { kind: "add", denominationPence: 500 })).toBeNull();
    expect(cashVisualPickCommand(snapshot, { kind: "add", denominationPence: 20 })).toEqual({ type: "ADD_CHANGE", denominationPence: 20 });
    expect(cashVisualPickCommand(snapshot, { kind: "remove", index: 1 })).toEqual({ type: "REMOVE_CHANGE", index: 1 });
  });

  it("labels legacy-derived tender honestly and preserves its canonical pieces", () => {
    const snapshot = deriveCashVisualState(input({ payment: received([], { tenderedCashRecorded: false }) }));
    expect(snapshot.tender).toEqual([500]);
    expect(snapshot.tenderSource).toBe("derived");
    expect(snapshot.tenderSourceLabel).toContain("旧版未记录面额");
    expect(snapshot.tenderSourceLabel).toContain("推导");
    const actual = deriveCashVisualState(input({ payment: received([], { tenderedCash: [200, 200, 100] }) }));
    expect(actual.tender).toEqual([200, 200, 100]);
    expect(actual.tenderSource).toBe("recorded");
    expect(actual.tenderStacks.find((stack) => stack.denominationPence === 200)).toMatchObject({ actualCount: 2, stackCount: 2, indices: [0, 1], visibleIndices: [0, 1] });
  });

  it("keeps 100 old tray pieces correctable while showing only a bounded stack and nonnegative stock", () => {
    const original = input({ payment: received(Array(MAX_CHANGE_PIECES).fill(1), { tenderedCashRecorded: false }) });
    const snapshot = deriveCashVisualState(original);
    expect(snapshot.change).toHaveLength(100);
    expect(snapshot.changeStacks).toEqual([{ denominationPence: 1, kind: "coin", actualCount: 100, stackCount: 6,
      indices: Array.from({ length: 100 }, (_, index) => index), visibleIndices: [94, 95, 96, 97, 98, 99] }]);
    expect(snapshot.drawer.find((slot) => slot.denominationPence === 1)).toMatchObject({ drawerCount: 20, reservedCount: 100, actualCount: 0, stackCount: 0, canAdd: false });
    expect(snapshot.drawer.every((slot) => !slot.canAdd)).toBe(true);
    expect(cashVisualPickCommand(snapshot, { kind: "remove", index: 99 })).toEqual({ type: "REMOVE_CHANGE", index: 99 });
    expect(cashVisualPickCommand(snapshot, { kind: "add", denominationPence: 20 })).toBeNull();
    expect((original.payment as CashPaymentState).selectedChange).toHaveLength(100);
  });

  it("bounds large recorded tender stacks without pretending the rendered sample is the complete amount", () => {
    const snapshot = deriveCashVisualState(input({ amountPence: 100,
      payment: received([], { tenderedPence: 100, tenderedCash: Array(100).fill(1) }) }));
    expect(snapshot.tender).toHaveLength(100);
    expect(snapshot.tenderStacks[0]).toMatchObject({ actualCount: 100, stackCount: 6, visibleIndices: [94, 95, 96, 97, 98, 99] });
    expect(snapshot.tenderedPence).toBe(100);
    expect(snapshot.changeDuePence).toBe(0);
    expect(snapshot.drawer.find((slot) => slot.denominationPence === 1)!.actualCount).toBe(20);
  });

  it("keeps incorrect change totals and duplicate-piece indices instead of silently correcting the learner", () => {
    const snapshot = deriveCashVisualState(input({ payment: received([50, 20, 20]) }));
    expect(snapshot.selectedChangePence).toBe(90);
    expect(snapshot.changeDuePence).toBe(65);
    expect(snapshot.change.map((piece) => piece.index)).toEqual([0, 1, 2]);
    expect(snapshot.changeStacks.find((stack) => stack.denominationPence === 20)).toMatchObject({ indices: [1, 2] });
    expect(cashVisualPickCommand(snapshot, { kind: "remove", index: 2 })).toEqual({ type: "REMOVE_CHANGE", index: 2 });
    expect(cashVisualPickCommand(snapshot, { kind: "add", denominationPence: 50 })).toEqual({ type: "ADD_CHANGE", denominationPence: 50 });
  });

  it("does not alias or mutate payment, drawer, grouped tender or original change arrays", () => {
    const original = input({ payment: received([50, 10, 5]) });
    const before = structuredClone(original);
    const snapshot = deriveCashVisualState(original);
    snapshot.tender.push(1);
    snapshot.tenderStacks[0]!.indices.push(44);
    snapshot.change[0]!.index = 44;
    snapshot.changeStacks[0]!.visibleIndices.push(44);
    snapshot.drawer[0]!.actualCount = 999;
    expect(original).toEqual(before);
  });
});

describe("cash v4 physical pick gates", () => {
  it.each([
    { open: false }, { canInteract: false }, { checkout: false }, { payment: null }, { payment: { method: "card" } as const },
  ])("rejects every physical action when the current host is unavailable: %j", (override) => {
    const snapshot = deriveCashVisualState(input({ payment: received([50]), ...override }));
    expect(snapshot.canInteract).toBe(false);
    expect(snapshot.canReceive).toBe(false);
    expect(snapshot.drawer.every((slot) => !slot.canAdd)).toBe(true);
    expect(snapshot.change.every((piece) => !piece.canRemove)).toBe(true);
    for (const pick of picks) expect(cashVisualPickCommand(snapshot, pick)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("fails closed for an invalid total %s", (amountPence) => {
    const snapshot = deriveCashVisualState(input({ amountPence }));
    expect(snapshot.stage).toBe("idle");
    expect(snapshot.amountPence).toBe(0);
    expect(snapshot.tenderSource).toBe("none");
    for (const pick of picks) expect(cashVisualPickCommand(snapshot, pick)).toBeNull();
  });

  it("fails closed for invalid inventory totals or counterfeit derived tender", () => {
    const badDrawer = { ...createDefaultCashDrawer(), 1000: Number.MAX_SAFE_INTEGER };
    const snapshot = deriveCashVisualState(input({ cashDrawer: badDrawer, payment: received([50]) }));
    expect(snapshot.canInteract).toBe(false);
    expect(snapshot.drawer.every((slot) => slot.actualCount === 0 && !slot.canAdd)).toBe(true);
    for (const pick of picks) expect(cashVisualPickCommand(snapshot, pick)).toBeNull();
    const counterfeit = deriveCashVisualState(input({ payment: received([], { tenderedCashRecorded: false, tenderedCash: [200, 200, 100] }) }));
    expect(counterfeit.stage).toBe("idle");
    expect(counterfeit.tenderSource).toBe("none");
  });

  it.each([-1, 0.5, 3, Number.NaN, Number.MAX_SAFE_INTEGER])("rejects an invalid removal index %s", (index) => {
    const snapshot = deriveCashVisualState(input({ payment: received([50, 10, 5]) }));
    expect(cashVisualPickCommand(snapshot, { kind: "remove", index })).toBeNull();
  });

  it.each([0, -1, 2.5, 25, 250, Number.NaN])("rejects an unsupported denomination %s", (denominationPence) => {
    const snapshot = deriveCashVisualState(input({ payment: received([50]) }));
    expect(cashVisualPickCommand(snapshot, { kind: "add", denominationPence })).toBeNull();
  });

  it("recomputes exhausted stacks and removal indices after the host changes its current tray", () => {
    const original = input({ payment: received(Array(10).fill(50)) });
    const exhausted = deriveCashVisualState(original);
    expect(cashVisualPickCommand(exhausted, { kind: "add", denominationPence: 50 })).toBeNull();
    const refreshed = deriveCashVisualState({ ...original, payment: received(Array(9).fill(50)) });
    expect(cashVisualPickCommand(refreshed, { kind: "add", denominationPence: 50 })).toEqual({ type: "ADD_CHANGE", denominationPence: 50 });
    expect(cashVisualPickCommand(refreshed, { kind: "remove", index: 9 })).toBeNull();
    expect(refreshed.changeStacks[0]!.visibleIndices).toEqual([3, 4, 5, 6, 7, 8]);
  });
});
