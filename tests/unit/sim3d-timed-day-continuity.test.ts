import { describe, expect, it } from "vitest";
import {
  INITIAL_CAPITAL_PENCE, PRODUCTS, canSettleDay, canStartCustomer, capacityFor, countAt, createFirstDayState,
  getCheckoutTotal, getDaySummary, getDeliverySummary, reduceSim, validateSimState,
  type ProductId, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { BUSINESS_DURATION_MS } from "../../src/sim3d/businessTime";
import { findExactChange } from "../../src/sim3d/cashDrawer";
import { loadSimState, parseImportedSimState, saveSimState, type StorageLike } from "../../src/sim3d/persistence";

const SHOP_PRODUCTS = ["milk", "bread"] as const;

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

/** A separate test ledger observes commands, not the game's day-summary calculations. */
class ContinuityRun {
  state: SimState = { ...createFirstDayState(), customerSeed: 31 };
  readonly storage = new MemoryStorage();
  readonly purchasedIds = new Set<string>();
  readonly soldIds = new Set<string>();
  readonly saleIds = new Set<string>();
  readonly paymentMethods = new Set<string>();
  expectedCash = INITIAL_CAPITAL_PENCE;
  purchaseSpend = 0;
  revenue = 0;
  cancellations = 0;
  checkpoints = 0;
  private orderNumber = 0;

  step(command: SimCommand): void {
    const before = this.state;
    const original = structuredClone(before);
    const checkout = before.items.filter((item) => item.location.kind === "checkout");
    const result = reduceSim(before, command);
    expect(result.changed, `day ${before.day.number} ${command.type}: ${result.message ?? ""}`).toBe(true);
    expect(before).toEqual(original);
    expect(result.state.revision).toBe(before.revision + 1);
    this.state = result.state;

    if (command.type === "PURCHASE_STOCK") {
      const lines = command.lines ?? SHOP_PRODUCTS.map((productId) => ({ productId, quantity: command.pairs! }));
      const expectedCost = lines.reduce((total, line) => total + PRODUCTS[line.productId].costPence * line.quantity, 0);
      this.expectedCash -= expectedCost;
      this.purchaseSpend += expectedCost;
      for (const { productId, quantity } of lines) for (let unit = 1; unit <= quantity; unit += 1) {
        const id = `${productId}-purchase-${command.orderId}-${unit}`;
        expect(this.purchasedIds.has(id)).toBe(false);
        this.purchasedIds.add(id);
      }
    } else if (command.type === "PAY" || command.type === "CONFIRM_CASH") {
      expect(checkout.map((item) => item.productId).sort()).toEqual(["bread", "milk"]);
      const saleId = `sale-${before.customer.number}`;
      expect(this.saleIds.has(saleId)).toBe(false);
      this.saleIds.add(saleId);
      for (const item of checkout) {
        expect(this.soldIds.has(item.id)).toBe(false);
        this.soldIds.add(item.id);
      }
      const expectedRevenue = PRODUCTS.milk.pricePence + PRODUCTS.bread.pricePence;
      this.expectedCash += expectedRevenue;
      this.revenue += expectedRevenue;
      this.paymentMethods.add(command.type === "PAY" ? "card" : "cash");
    } else if (command.type === "CANCEL_CUSTOMER") {
      this.cancellations += 1;
    }
    this.checkpoint();
  }

  reject(command: SimCommand): void {
    const before = structuredClone(this.state);
    const result = reduceSim(this.state, command);
    expect(result.changed, command.type).toBe(false);
    expect(result.state).toBe(this.state);
    expect(this.state).toEqual(before);
    this.checkpoint();
  }

  checkpoint(): void {
    expect(validateSimState(this.state)).toBe(true);
    expect(this.state.cashPence).toBe(this.expectedCash);
    expect(this.state.cashPence).toBe(INITIAL_CAPITAL_PENCE + this.revenue - this.purchaseSpend);
    expect(this.state.items.map((item) => item.id).sort()).toEqual([...this.purchasedIds].sort());
    expect(this.state.items.filter((item) => item.location.kind === "sold").map((item) => item.id).sort()).toEqual([...this.soldIds].sort());
    expect(this.state.transactions.map((sale) => sale.id).sort()).toEqual([...this.saleIds].sort());
    expect(getDaySummary(this.state).remainingStockUnits).toBe(this.purchasedIds.size - this.soldIds.size);
    const snapshot = structuredClone(this.state);
    saveSimState(snapshot, this.storage);
    const loaded = loadSimState(this.storage);
    expect(loaded.source).toBe("primary");
    expect(loaded.state).toEqual(snapshot);
    expect(parseImportedSimState(JSON.stringify(snapshot))).toEqual(snapshot);
    this.state = loaded.state;
    this.checkpoints += 1;
  }

  order(quantity: 1 | 2): void {
    this.orderNumber += 1;
    const command = { type: "PURCHASE_STOCK", orderId: `continuity-${this.orderNumber}`,
      lines: SHOP_PRODUCTS.map((productId) => ({ productId, quantity })) } satisfies SimCommand;
    this.step(command);
    this.reject(command);
  }

  receive(): void {
    this.step({ type: "ADVANCE_DELIVERY_TIME", elapsedMs: 12_000, blocked: false });
    const orderId = this.state.delivery.orderId!;
    this.step({ type: "RECEIVE_DELIVERY", orderId });
    this.reject({ type: "RECEIVE_DELIVERY", orderId });
    this.step({ type: "ADVANCE_DELIVERY_TIME", elapsedMs: 4_000, blocked: false });
  }

  readyShelves(): void {
    if (SHOP_PRODUCTS.some((productId) => countAt(this.state, productId, "shelf") + countAt(this.state, productId, "crate") === 0)) {
      this.order(2);
      this.receive();
    }
    for (const productId of SHOP_PRODUCTS) {
      if (countAt(this.state, productId, "shelf") > 0) continue;
      const slot = Array.from({ length: capacityFor(this.state) }, (_, index) => index).find((candidate) =>
        !this.state.items.some((item) => item.location.kind === "shelf" && item.productId === productId && item.location.slot === candidate));
      expect(slot).toBeDefined();
      this.step({ type: "PICK_CRATE", crateId: `${productId}-crate` });
      this.step({ type: "STOCK", productId: productId as ProductId, slot: slot! });
      const crate = this.state.crates.find((entry) => entry.productId === productId)!;
      this.step({ type: "DROP_HELD", position: crate.position });
    }
    expect(canStartCustomer(this.state)).toBe(true);
  }

  arrive(): void {
    this.readyShelves();
    if (this.state.day.phase === "open") {
      const appointment = this.state.day.nextCustomerAtMs;
      expect(appointment).not.toBeNull();
      const elapsedMs = appointment! - this.state.day.elapsedOpenMs;
      if (elapsedMs > 0) this.step({ type: "ADVANCE_BUSINESS_TIME", elapsedMs });
    }
    this.step({ type: this.state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
    for (let stage = 0; stage < 3; stage += 1) {
      this.step({ type: "ADVANCE_BUSINESS_TIME", elapsedMs: 1_750.25 });
      this.step({ type: "CUSTOMER_ADVANCE" });
    }
    expect(this.state.customer.phase).toBe("checkout");
    for (const item of this.state.items.filter((entry) => entry.location.kind === "checkout")) this.step({ type: "SCAN", itemId: item.id });
  }

  pay(): void {
    const payment = this.state.payment;
    if (!payment) throw new Error("Expected an active saved payment");
    const amountPence = getCheckoutTotal(this.state);
    if (payment.method === "card") {
      this.step({ type: "PAY", success: true });
      this.reject({ type: "PAY", success: true });
    } else {
      this.step({ type: "RECEIVE_CASH" });
      this.reject({ type: "RECEIVE_CASH" });
      const changePence = payment.tenderedPence - amountPence;
      const changeCash = findExactChange(this.state.cashDrawer, changePence);
      if (changeCash === null) {
        this.step({ type: "REQUEST_EXACT_CASH" });
        this.step({ type: "RECEIVE_CASH" });
        this.reject({ type: "RECEIVE_CASH" });
      } else {
        for (const denominationPence of changeCash) this.step({ type: "ADD_CHANGE", denominationPence });
      }
      this.step({ type: "CONFIRM_CASH" });
      this.reject({ type: "CONFIRM_CASH" });
    }
    this.step({ type: "CUSTOMER_ADVANCE" });
  }

  cancel(): void {
    if (this.state.payment?.method === "cash") {
      this.step({ type: "RECEIVE_CASH" });
      // A tentative, even incorrect, change selection must disappear without a sale.
      this.step({ type: "ADD_CHANGE", denominationPence: 1 });
    }
    this.step({ type: "CANCEL_CUSTOMER" });
    this.reject({ type: "CANCEL_CUSTOMER" });
    this.step({ type: "CUSTOMER_ADVANCE" });
  }

  close(reason: "manual" | "time"): void {
    if (reason === "time") this.step({ type: "ADVANCE_BUSINESS_TIME", elapsedMs: BUSINESS_DURATION_MS - this.state.day.elapsedOpenMs });
    else this.step({ type: "CLOSE_STORE" });
    expect(this.state.day).toMatchObject({ phase: "closing", closeReason: reason, nextCustomerAtMs: null });
    this.reject({ type: "CLOSE_STORE" });
    this.reject({ type: "NEXT_CUSTOMER" });
    this.reject({ type: "ADVANCE_BUSINESS_TIME", elapsedMs: 700 });
  }

  settle(expectedSales: number): void {
    expect(canSettleDay(this.state)).toBe(true);
    const cash = this.state.cashPence;
    const inventory = structuredClone(this.state.items);
    this.step({ type: "SETTLE_DAY" });
    expect(this.state.cashPence).toBe(cash);
    expect(this.state.items).toEqual(inventory);
    expect(this.state.settlements.at(-1)).toMatchObject({ paidCustomers: expectedSales, targetCustomers: null, closingCashPence: cash });
    this.reject({ type: "SETTLE_DAY" });
  }

  tomorrow(): void {
    const previous = structuredClone(this.state);
    this.step({ type: "START_NEXT_DAY" });
    expect(this.state.day).toMatchObject({ number: previous.day.number + 1, phase: "preparing", elapsedOpenMs: 0, closeReason: null, nextCustomerAtMs: null });
    expect(this.state.day.openingCashPence).toBe(previous.cashPence);
    expect(this.state.items).toEqual(previous.items);
    expect(this.state.settlements).toEqual(previous.settlements);
    expect(this.state.payment).toBeNull();
  }
}

describe("bounded multi-day timed-business continuity", () => {
  it("preserves one auditable six-day save through mixed payments, cancellations, late deliveries and zero-sale days", () => {
    const run = new ContinuityRun();
    run.checkpoint();

    // Day 1: no opening, orders or income. An early zero-sale close must not mint capital.
    run.close("manual");
    run.settle(0);
    run.tomorrow();

    // Day 2: five completed sales and one cancellation, with repeated in-day restocking.
    for (const action of ["pay", "cancel", "pay", "pay", "pay", "pay"] as const) {
      run.arrive();
      if (action === "pay") run.pay();
      else run.cancel();
    }
    expect(run.state.day.phase).toBe("open");
    expect(getDaySummary(run.state).paidCustomers).toBe(5);
    expect(run.state.purchases.filter((purchase) => purchase.dayNumber === 2).length).toBeGreaterThan(1);
    expect(getDaySummary(run.state).remainingStockUnits).toBeGreaterThan(0);
    run.close("manual");
    run.settle(5);
    run.tomorrow();

    // Day 3: close at the deadline while a customer and a paid delivery are unfinished.
    run.arrive();
    run.pay();
    run.arrive();
    run.cancel();
    run.arrive();
    run.order(1);
    run.close("time");
    expect(canSettleDay(run.state)).toBe(false);
    run.reject({ type: "SETTLE_DAY" });
    run.pay();
    expect(getDeliverySummary(run.state).pendingOrders).toBe(1);
    run.reject({ type: "SETTLE_DAY" });
    run.receive();
    run.settle(2);
    run.tomorrow();

    // Day 4: an opened day with one cancelled checkout, but still no recorded sale.
    run.arrive();
    run.close("manual");
    run.cancel();
    run.settle(0);
    run.tomorrow();

    // Day 5: the fourth sale remains valid, then a normal 19:00 close.
    for (let visit = 0; visit < 4; visit += 1) {
      run.arrive();
      run.pay();
    }
    run.close("time");
    run.settle(4);
    run.tomorrow();

    // Day 6: one more checkout demonstrates continued operation after both kinds of closure.
    run.arrive();
    run.pay();
    run.close("manual");
    run.settle(1);

    expect(run.state.day.number).toBe(6);
    expect(run.state.settlements.map((day) => day.paidCustomers)).toEqual([0, 5, 2, 0, 4, 1]);
    expect(run.saleIds.size).toBe(12);
    expect(run.soldIds.size).toBe(24);
    expect(run.cancellations).toBe(3);
    expect([...run.paymentMethods].sort()).toEqual(["card", "cash"]);
    expect(run.revenue).toBe(4_800);
    expect(run.state.settlements.reduce((total, day) => total + day.revenuePence, 0)).toBe(run.revenue);
    expect(run.state.settlements.reduce((total, day) => total + day.procurementPence, 0)).toBe(run.purchaseSpend);
    expect(run.checkpoints).toBeGreaterThan(200);
    expect(run.checkpoints).toBeLessThan(700);
  }, 20_000);
});
