import { describe, expect, it } from "vitest";

import {
  buyerTask,
  customers,
  previewCards,
  products,
} from "../../src/content/dayOne";
import { gradeSlots } from "../../src/domain/rules";
import { createInitialState } from "../../src/state/createInitialState";

describe("day-one content shape", () => {
  it("contains exactly four previews, one buyer task, and three customers", () => {
    expect(previewCards).toHaveLength(4);
    expect(new Set(previewCards.map((card) => card.id)).size).toBe(4);

    expect(buyerTask.id).toMatch(/^day1\.buyer\./);
    expect(buyerTask.expectedSemanticOrder).toHaveLength(4);
    expect(buyerTask.hints).toHaveLength(3);

    expect(customers).toHaveLength(3);
    expect(new Set(customers.map((customer) => customer.id)).size).toBe(3);
    expect(customers.every((customer) => customer.id.startsWith("day1.seller."))).toBe(
      true,
    );
  });

  it("gives every task a valid product and exactly one correct order option", () => {
    expect(products[buyerTask.productId]).toBeDefined();
    expect(buyerTask.quantity).toBeGreaterThan(0);

    for (const customer of customers) {
      const product = products[customer.productId];
      expect(product).toBeDefined();
      if (!product) {
        throw new Error(`Missing product definition for ${customer.productId}`);
      }

      expect(customer.quantity).toBeGreaterThan(0);
      expect(customer.shelfId).toBe(product.shelfId);
      expect(customer.expectedOrder).toEqual({
        productId: customer.productId,
        quantity: customer.quantity,
      });

      const correctOrderOptions = customer.orderOptions.filter(
        (option) =>
          option.slots !== undefined &&
          gradeSlots(customer.expectedOrder, option.slots).correct,
      );
      expect(correctOrderOptions, customer.id).toHaveLength(1);

      if (customer.checkout) {
        const correctCheckoutOptions = customer.checkout.options.filter(
          (option) =>
            option.slots !== undefined &&
            gradeSlots(customer.checkout!.expectedSlots, option.slots).correct,
        );
        expect(correctCheckoutOptions, `${customer.id} checkout`).toHaveLength(1);
      }
    }
  });
});

describe("day-one inventory", () => {
  it("can fulfil all three customers from initial stock plus the buyer restock", () => {
    const initial = createInitialState();
    const available = { ...initial.shelfInventory };
    available[buyerTask.productId] =
      (available[buyerTask.productId] ?? 0) + buyerTask.quantity;

    const required = customers.reduce<Record<string, number>>(
      (totals, customer) => ({
        ...totals,
        [customer.productId]:
          (totals[customer.productId] ?? 0) + customer.quantity,
      }),
      {},
    );

    for (const [productId, quantity] of Object.entries(required)) {
      expect(available[productId], productId).toBeGreaterThanOrEqual(quantity);
    }

    const procurementProduct = products[buyerTask.productId];
    expect(procurementProduct).toBeDefined();
    if (!procurementProduct) {
      throw new Error(
        `Missing product definition for ${buyerTask.productId}`,
      );
    }

    const procurementCost = procurementProduct.costPence * buyerTask.quantity;
    expect(procurementCost).toBeLessThanOrEqual(initial.cashPence);
  });
});

describe("communication repair content", () => {
  it("contains one explicit repair branch with a repetition prompt", () => {
    const repairCustomers = customers.filter(
      (customer) => customer.repairScenario === true,
    );

    expect(repairCustomers).toHaveLength(1);
    const repairCustomer = repairCustomers[0];
    expect(repairCustomer).toBeDefined();
    if (!repairCustomer) {
      throw new Error("Missing repair customer");
    }

    expect(repairCustomer.simplifiedPrompt).not.toBe(repairCustomer.prompt);
    expect(repairCustomer.hints).toHaveLength(3);
    expect(repairCustomer.hints.join(" ")).toMatch(
      /Could you say that again/i,
    );
  });
});
