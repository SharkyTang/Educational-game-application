import { describe, expect, it } from "vitest";
import {
  applyCashDrawerTransaction,
  canMakeExactChange,
  cashDrawerCount,
  cashDrawerPieceCount,
  cashDrawerValuePence,
  createDefaultCashDrawer,
  findExactChange,
  selectedChangeFitsDrawer,
  validateCashDrawerState,
  type CashDrawerState,
} from "../../src/sim3d/cashDrawer";
import { CASH_DENOMINATIONS_PENCE, MAX_CHANGE_PIECES } from "../../src/sim3d/cashPayment";

function emptyDrawer(overrides: Partial<CashDrawerState> = {}): CashDrawerState {
  return { 1: 0, 2: 0, 5: 0, 10: 0, 20: 0, 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0, ...overrides };
}

describe("cash drawer snapshots and totals", () => {
  it("creates independent, finite teaching floats with no starting customer notes", () => {
    const first = createDefaultCashDrawer();
    const second = createDefaultCashDrawer();
    expect(first).toEqual({ 1: 20, 2: 20, 5: 20, 10: 20, 20: 15, 50: 10, 100: 10, 200: 5, 500: 0, 1000: 0 });
    expect(validateCashDrawerState(first)).toBe(true);
    expect(cashDrawerPieceCount(first)).toBe(120);
    expect(cashDrawerValuePence(first)).toBe(3160);
    first[1] = 0;
    expect(second[1]).toBe(20);
  });

  it("requires each denomination exactly once as an own enumerable plain-object field", () => {
    const valid = emptyDrawer();
    expect(Object.keys(valid)).toEqual(CASH_DENOMINATIONS_PENCE.map(String));
    expect(validateCashDrawerState(JSON.parse(JSON.stringify(valid)))).toBe(true);
    expect(validateCashDrawerState({ ...valid, 3: 1 })).toBe(false);
    const { 1: _missing, ...missing } = valid;
    expect(validateCashDrawerState(missing)).toBe(false);
    expect(validateCashDrawerState(Object.assign(Object.create({ 1: 0 }), { ...valid }))).toBe(false);
    expect(validateCashDrawerState(Object.assign(Object.create(null), valid))).toBe(false);
    expect(validateCashDrawerState([])).toBe(false);
    expect(validateCashDrawerState(null)).toBe(false);
    const hidden = { ...valid };
    Object.defineProperty(hidden, "1", { value: 0, enumerable: false });
    expect(validateCashDrawerState(hidden)).toBe(false);
    const accessor = { ...valid };
    Object.defineProperty(accessor, "1", { enumerable: true, get: () => 0 });
    expect(validateCashDrawerState(accessor)).toBe(false);
    expect(validateCashDrawerState(Object.assign({ ...valid }, { [Symbol("hidden")]: 1 }))).toBe(false);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid denomination count %s", (count) => {
    expect(validateCashDrawerState({ ...emptyDrawer(), 20: count })).toBe(false);
  });

  it("queries counts and detects unsafe aggregate totals", () => {
    const drawer = emptyDrawer({ 1: 4, 20: 3, 100: 2 });
    expect(cashDrawerCount(drawer, 20)).toBe(3);
    expect(cashDrawerPieceCount(drawer)).toBe(9);
    expect(cashDrawerValuePence(drawer)).toBe(264);
    expect(() => cashDrawerCount(drawer, 3 as never)).toThrow("面额无效");
    expect(() => cashDrawerPieceCount(emptyDrawer({ 1: Number.MAX_SAFE_INTEGER, 2: 1 }))).toThrow("总枚数");
    expect(() => cashDrawerValuePence(emptyDrawer({ 1000: Number.MAX_SAFE_INTEGER }))).toThrow("总面值");
  });
});

describe("cash drawer availability and exact change", () => {
  it("counts repeated pieces and never spends more than the drawer owns", () => {
    const drawer = emptyDrawer({ 5: 1, 20: 3, 50: 1 });
    expect(selectedChangeFitsDrawer(drawer, [])).toBe(true);
    expect(selectedChangeFitsDrawer(drawer, [50, 20, 20, 20, 5])).toBe(true);
    expect(selectedChangeFitsDrawer(drawer, [50, 20, 20, 20, 5, 5])).toBe(false);
    expect(selectedChangeFitsDrawer(drawer, [100])).toBe(false);
  });

  it("rejects malformed, sparse, extra-field and over-limit selections", () => {
    const drawer = createDefaultCashDrawer();
    const sparse = Array<number>(1);
    const extra = [5] as number[] & { note?: string };
    extra.note = "not serialized";
    const inherited = Object.setPrototypeOf([5], { ...Array.prototype });
    for (const pieces of [[NaN], [Infinity], [-1], [3], sparse, extra, inherited, Array(MAX_CHANGE_PIECES + 1).fill(1)]) {
      expect(selectedChangeFitsDrawer(drawer, pieces)).toBe(false);
    }
    expect(selectedChangeFitsDrawer({ ...drawer, 3: 1 } as CashDrawerState, [])).toBe(false);
  });

  it("finds stable exact change under finite inventory, including a non-greedy alternative", () => {
    expect(findExactChange(emptyDrawer({ 2: 3, 5: 1 }), 6)).toEqual([2, 2, 2]);
    expect(findExactChange(emptyDrawer({ 5: 1, 10: 1, 20: 3, 50: 1 }), 65)).toEqual([50, 10, 5]);
    expect(findExactChange(emptyDrawer({ 20: 3, 50: 1 }), 65)).toBeNull();
    expect(canMakeExactChange(emptyDrawer({ 2: 3, 5: 1 }), 6)).toBe(true);
    expect(canMakeExactChange(emptyDrawer({ 5: 1 }), 6)).toBe(false);
  });

  it("treats zero as payable and excludes pieces already reserved on the learner tray", () => {
    const drawer = emptyDrawer({ 5: 1, 10: 1, 20: 3, 50: 1 });
    expect(findExactChange(drawer, 0)).toEqual([]);
    expect(canMakeExactChange(drawer, 0)).toBe(true);
    expect(findExactChange(drawer, 15, [50, 20, 20, 20])).toEqual([10, 5]);
    expect(findExactChange(drawer, 15, [50, 20, 20, 20, 5])).toBeNull();
    expect(findExactChange(drawer, 0, [5, 5])).toBeNull();
  });

  it("enforces the shared 100-piece interaction ceiling without large allocations", () => {
    const drawer = emptyDrawer({ 1: Number.MAX_SAFE_INTEGER });
    expect(findExactChange(drawer, MAX_CHANGE_PIECES)).toHaveLength(MAX_CHANGE_PIECES);
    expect(findExactChange(drawer, MAX_CHANGE_PIECES + 1)).toBeNull();
    expect(findExactChange(drawer, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(findExactChange(drawer, NaN)).toBeNull();
    expect(canMakeExactChange(drawer, -1)).toBe(false);
  });
});

describe("cash drawer transaction", () => {
  it("atomically adds actual tender pieces, removes change and conserves the expected value", () => {
    const drawer = emptyDrawer({ 5: 2, 10: 2, 50: 2, 100: 1 });
    const before = structuredClone(drawer);
    const next = applyCashDrawerTransaction(drawer, {
      tenderedCash: [500], tenderedPence: 500, changeCash: [50, 10, 5], changePence: 65,
    });
    expect(drawer).toEqual(before);
    expect(next).not.toBe(drawer);
    expect(next).toEqual(emptyDrawer({ 5: 1, 10: 1, 50: 1, 100: 1, 500: 1 }));
    expect(cashDrawerValuePence(next) - cashDrawerValuePence(drawer)).toBe(435);
  });

  it("supports exact tender with zero change", () => {
    const drawer = emptyDrawer();
    expect(applyCashDrawerTransaction(drawer, {
      tenderedCash: [200, 100, 100, 20, 10, 5], tenderedPence: 435, changeCash: [], changePence: 0,
    })).toEqual(emptyDrawer({ 5: 1, 10: 1, 20: 1, 100: 2, 200: 1 }));
  });

  it("rejects mismatched totals, unavailable change and malformed pieces without mutation", () => {
    const drawer = emptyDrawer({ 5: 1, 10: 1, 50: 1 });
    const before = structuredClone(drawer);
    const base = { tenderedCash: [500] as const, tenderedPence: 500, changeCash: [50, 10, 5] as const, changePence: 65 };
    expect(() => applyCashDrawerTransaction(drawer, { ...base, tenderedPence: 501 })).toThrow("明细无效");
    expect(() => applyCashDrawerTransaction(drawer, { ...base, changePence: 64 })).toThrow("明细无效");
    expect(() => applyCashDrawerTransaction(drawer, { ...base, changeCash: [50, 10, 5, 5] })).toThrow("明细无效");
    expect(() => applyCashDrawerTransaction(emptyDrawer(), base)).toThrow("零钱不足");
    expect(() => applyCashDrawerTransaction(drawer, { ...base, tenderedCash: Array(1) } as never)).toThrow("明细无效");
    expect(drawer).toEqual(before);
  });

  it("rejects invalid transaction shape, excessive change and count overflow atomically", () => {
    const drawer = emptyDrawer({ 500: Number.MAX_SAFE_INTEGER });
    const valid = { tenderedCash: [500] as const, tenderedPence: 500, changeCash: [] as const, changePence: 0 };
    expect(() => applyCashDrawerTransaction(drawer, valid)).toThrow("数量超过");
    expect(drawer[500]).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => applyCashDrawerTransaction(emptyDrawer({ 1000: 1 }), {
      tenderedCash: [500], tenderedPence: 500, changeCash: [1000], changePence: 1000,
    })).toThrow("明细无效");
    expect(() => applyCashDrawerTransaction(emptyDrawer(), { ...valid, extra: true } as never)).toThrow("明细无效");
    expect(() => applyCashDrawerTransaction(emptyDrawer(), Object.assign(Object.create(valid), valid))).toThrow("明细无效");
  });
});
