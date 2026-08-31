import { describe, expect, it } from "vitest";
import {
  CASH_DENOMINATIONS_PENCE, MAX_CHANGE_PIECES, cashChangeDuePence, cashPaymentCanConfirm,
  createPaymentForVisit, isCashDenomination, selectedChangeTotalPence, validatePaymentState,
  type CashPaymentState,
} from "../../src/sim3d/cashPayment";

function cash(overrides: Partial<CashPaymentState> = {}): CashPaymentState {
  return { method: "cash", tenderedPence: 500, received: true, selectedChange: [], ...overrides };
}

describe("cash payment scenario selection", () => {
  it.each([0, 31, 77, 0xffffffff])("introduces card first and the smallest sufficient note second for seed %i", (customerSeed) => {
    expect(createPaymentForVisit({ customerSeed, customerNumber: 1, amountPence: 435 })).toEqual({ method: "card" });
    expect(createPaymentForVisit({ customerSeed, customerNumber: 2, amountPence: 435 })).toEqual(cash({ received: false }));
    expect(createPaymentForVisit({ customerSeed, customerNumber: 2, amountPence: 160 })).toEqual(cash({ received: false }));
    expect(createPaymentForVisit({ customerSeed, customerNumber: 2, amountPence: 95 })).toEqual(cash({ received: false }));
    expect(createPaymentForVisit({ customerSeed, customerNumber: 2, amountPence: 865 })).toEqual(cash({ tenderedPence: 1000, received: false }));
    expect(createPaymentForVisit({ customerSeed, customerNumber: 2, amountPence: 431 })).toEqual(cash({ received: false }));
  });

  it("keeps each visit deterministic across repeated calls, seed fallback and serialization", () => {
    for (let customerNumber = 1; customerNumber <= 200; customerNumber += 1) {
      const input = { customerSeed: 239, customerNumber, amountPence: 435 };
      const payment = createPaymentForVisit(input);
      expect(createPaymentForVisit(input)).toEqual(payment);
      expect(JSON.parse(JSON.stringify(payment))).toEqual(payment);
      expect(createPaymentForVisit({ customerNumber, amountPence: 435 })).toEqual(createPaymentForVisit({ ...input, customerSeed: 31 }));
    }
  });

  it("mixes both methods and cash tenders without tying the method to the basket total", () => {
    const schedules = new Set<string>();
    const seenTenders = new Set<number>();
    for (const customerSeed of [0, 31, 77, 239, 0xffffffff]) {
      const methods: string[] = [];
      for (let customerNumber = 3; customerNumber <= 202; customerNumber += 1) {
        const payment = createPaymentForVisit({ customerSeed, customerNumber, amountPence: 435 });
        methods.push(payment.method);
        expect(createPaymentForVisit({ customerSeed, customerNumber, amountPence: 800 }).method).toBe(payment.method);
        if (payment.method === "cash") seenTenders.add(payment.tenderedPence);
      }
      expect(new Set(methods)).toEqual(new Set(["card", "cash"]));
      schedules.add(methods.join("|"));
    }
    expect(schedules.size).toBe(5);
    expect(seenTenders).toEqual(new Set([435, 500, 1000]));
  });

  it("never offers insufficient notes and handles large valid visit numbers or totals in constant space", () => {
    for (const amountPence of [1, 5, 435, 500, 501, 995, 1000, 1001, Number.MAX_SAFE_INTEGER]) {
      for (let customerNumber = 2; customerNumber <= 100; customerNumber += 1) {
        const payment = createPaymentForVisit({ customerSeed: 22, customerNumber, amountPence });
        expect(validatePaymentState(payment, amountPence)).toBe(true);
        if (payment.method === "cash") {
          expect(payment.tenderedPence).toBeGreaterThanOrEqual(amountPence);
          expect([amountPence, 500, 1000]).toContain(payment.tenderedPence);
        }
      }
    }
    expect(validatePaymentState(createPaymentForVisit({ customerNumber: Number.MAX_SAFE_INTEGER, amountPence: 435 }), 435)).toBe(true);
  });

  it.each([0, -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid amount or visit number %s", (value) => {
    expect(() => createPaymentForVisit({ customerNumber: value, amountPence: 435 })).toThrow();
    expect(() => createPaymentForVisit({ customerNumber: 1, amountPence: value })).toThrow();
  });

  it.each([-1, .5, NaN, Infinity, 0x1_0000_0000])("rejects invalid seed %s", (customerSeed) => {
    expect(() => createPaymentForVisit({ customerSeed, customerNumber: 1, amountPence: 435 })).toThrow();
  });
});

describe("cash denominations, confirmation and snapshot validation", () => {
  it("uses integer pence, including optional 1p and 2p denominations", () => {
    expect(CASH_DENOMINATIONS_PENCE).toEqual([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]);
    for (const denomination of CASH_DENOMINATIONS_PENCE) expect(isCashDenomination(denomination)).toBe(true);
    for (const invalid of [0, -5, .5, 3, 25, 2000, NaN, Infinity, "50", null]) expect(isCashDenomination(invalid)).toBe(false);
    expect(selectedChangeTotalPence([50, 10, 5])).toBe(65);
    expect(cashChangeDuePence(cash(), 435)).toBe(65);
  });

  it.each([[50, 10, 5], [20, 20, 20, 5], [50, 5, 5, 5], [50, 10, 2, 2, 1]])("accepts a correct 65p combination %j without requiring a greedy solution", (...selectedChange) => {
    const payment = cash({ selectedChange });
    expect(validatePaymentState(payment, 435)).toBe(true);
    expect(cashPaymentCanConfirm(payment, 435)).toBe(true);
  });

  it("accepts exact cash only after receiving it and requires no change pieces", () => {
    const payment = cash({ tenderedPence: 435, received: false });
    expect(validatePaymentState(payment, 435)).toBe(true);
    expect(cashPaymentCanConfirm(payment, 435)).toBe(false);
    expect(cashPaymentCanConfirm({ ...payment, received: true }, 435)).toBe(true);
    expect(cashPaymentCanConfirm({ ...payment, received: true, selectedChange: [1] }, 435)).toBe(false);
  });

  it("allows incorrect selections to be saved for correction, but never authorizes them to settle", () => {
    for (const selectedChange of [[], [50], [50, 20], [1000]]) {
      const payment = cash({ selectedChange });
      expect(validatePaymentState(payment, 435)).toBe(true);
      expect(cashPaymentCanConfirm(payment, 435)).toBe(false);
    }
    expect(cashPaymentCanConfirm({ method: "card" }, 435)).toBe(false);
    expect(cashPaymentCanConfirm(null, 435)).toBe(false);
  });

  it("enforces a bounded selection without mutating the caller's array", () => {
    expect(MAX_CHANGE_PIECES).toBe(100);
    const selectedChange = Array.from({ length: MAX_CHANGE_PIECES }, () => 1);
    const payment = cash({ selectedChange });
    expect(validatePaymentState(payment, 400)).toBe(true);
    expect(cashPaymentCanConfirm(payment, 400)).toBe(true);
    expect(selectedChangeTotalPence(selectedChange)).toBe(100);
    expect(selectedChange).toHaveLength(MAX_CHANGE_PIECES);
    expect(validatePaymentState(cash({ selectedChange: [...selectedChange, 1] }), 400)).toBe(false);
    expect(() => selectedChangeTotalPence([...selectedChange, 1])).toThrow("数量无效");
  });

  it.each([
    null, {}, [], { method: "unknown" }, { method: "card", tenderedPence: 500 },
    cash({ tenderedPence: 434 }), cash({ tenderedPence: 501 }), cash({ tenderedPence: .5 }),
    cash({ tenderedPence: NaN }), cash({ tenderedPence: Infinity }),
    { ...cash(), received: "true" }, { ...cash(), selectedChange: "65" },
    cash({ received: false, selectedChange: [50] }), cash({ selectedChange: [NaN] }),
    cash({ selectedChange: Array<number>(1) }),
    cash({ selectedChange: [Infinity] }), cash({ selectedChange: [-1] }), cash({ selectedChange: [.5] }),
    cash({ selectedChange: [3] }), { ...cash(), arbitraryField: true },
  ])("rejects malformed payment snapshots %j", (payment) => {
    expect(validatePaymentState(payment, 435)).toBe(false);
  });

  it.each([0, -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects payment validation with invalid expected amount %s", (amountPence) => {
    expect(validatePaymentState({ method: "card" }, amountPence)).toBe(false);
    expect(validatePaymentState(cash(), amountPence)).toBe(false);
    expect(() => cashChangeDuePence(cash(), amountPence)).toThrow("交款额无效");
  });
});
