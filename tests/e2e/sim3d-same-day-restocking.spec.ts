import { expect, test, type Page } from "@playwright/test";
import { BUSINESS_DURATION_MS } from "../../src/sim3d/businessTime";
import { PRODUCTS, type Position, type SimState } from "../../src/sim3d/domain";
import { PRODUCT_DISPLAYS, crateDimensions } from "../../src/sim3d/productLayout";
import { CHECKOUT_CLERK_POINT, furnitureForProduct, transformLayoutPoint } from "../../src/sim3d/shopLayout";
import { facePoint, openComputer, walkTo } from "./helpers/sim3d-computer";
import { payScannedCheckout, readBrowserSnapshot } from "./helpers/sim3d-payment";

// A fresh disposable browser context, with no imported fixture, state bridge,
// artificial clock advancement or direct application/storage writes. Every
// purchase, receipt, carried box, stocked item and sale uses the real controls.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

const PRODUCT_ID = "soap" as const;
const INITIAL_CASH = 1200;
const COST = PRODUCTS[PRODUCT_ID].costPence;
const PRICE = PRODUCTS[PRODUCT_ID].pricePence;
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function expectLedger(state: SimState, bought: number, sold: number, orders: number): void {
  expect(state.day.number).toBe(1);
  expect(state.day.phase).not.toBe("closing");
  expect(state.day.phase).not.toBe("settled");
  expect(state.settlements).toEqual([]);
  expect(state.cashPence).toBe(INITIAL_CASH - bought * COST + sold * PRICE);
  expect(state.items).toHaveLength(bought);
  expect(state.items.every((item) => item.productId === PRODUCT_ID)).toBe(true);
  expect(state.purchases).toHaveLength(orders);
  expect(new Set(state.purchases.map((order) => order.id)).size).toBe(orders);
  expect(state.purchases.every((order) => order.dayNumber === 1)).toBe(true);
  expect(state.purchases.reduce((total, order) => total + order.amountPence, 0)).toBe(bought * COST);
  expect(new Set(state.purchases.flatMap((order) => order.itemIds)).size).toBe(bought);
  expect(state.transactions).toHaveLength(sold);
  expect(new Set(state.transactions.map((sale) => sale.id)).size).toBe(sold);
  expect(new Set(state.transactions.flatMap((sale) => sale.itemIds)).size).toBe(sold);
  expect(state.transactions.every((sale) => sale.itemIds.length === 1 && sale.amountPence === PRICE)).toBe(true);
  expect(state.transactions.reduce((total, sale) => total + sale.amountPence, 0)).toBe(sold * PRICE);
  expect(state.items.filter((item) => item.location.kind === "sold")).toHaveLength(sold);
  expect(state.recyclingRecords).toEqual([]);
  expect(state.streetSupportRecords).toEqual([]);
  expect(state.upgraded).toBe(false);
}

async function stockReceivedBox(page: Page, quantity: number, originalBay: Position): Promise<void> {
  const received = await readBrowserSnapshot(page);
  const crate = received.crates.find((entry) => entry.productId === PRODUCT_ID);
  expect(crate).toBeDefined();
  expect(crate!.position).toEqual(originalBay);
  // Stand on the pavement south of the current box, beyond its collider and
  // north of the truck lane. This same point makes G choose its original bay.
  const boxApproach = { x: crate!.position.x, z: crate!.position.z - 1.2 };
  await walkTo(page, boxApproach);
  await facePoint(page, { ...crate!.position, y: crateDimensions(PRODUCT_ID).height / 2 });
  await expect(page.locator("#s3-target-label")).toContainText(`${PRODUCTS[PRODUCT_ID].nameZh}货箱`);
  await expect(page.locator("#s3-target-action")).toContainText("抱起货箱");
  await page.keyboard.press("e");
  await expect.poll(async () => (await readBrowserSnapshot(page)).held).toEqual({ kind: "crate", crateId: crate!.id });

  const carrying = await readBrowserSnapshot(page);
  const layout = carrying.renovation.layout;
  const furniture = furnitureForProduct(PRODUCT_ID);
  const display = PRODUCT_DISPLAYS[PRODUCT_ID];
  await walkTo(page, transformLayoutPoint(layout, furniture, display.approach));
  await facePoint(page, transformLayoutPoint(layout, furniture, display.slots[0]!));
  await expect(page.locator("#s3-target-label")).toContainText(PRODUCTS[PRODUCT_ID].nameZh);
  for (let remaining = quantity - 1; remaining >= 0; remaining -= 1) {
    await expect(page.locator("#s3-target-action")).toContainText("摆放一件");
    await page.keyboard.press("e");
    // A customer may pick up the newly shelved soap while the player is still
    // carrying the box. Count the box contents, not a fleeting shelf animation.
    await expect.poll(async () => (await readBrowserSnapshot(page)).items
      .filter((item) => item.location.kind === "crate" && item.location.crateId === crate!.id).length).toBe(remaining);
  }
  await expect(page.locator("#s3-held")).toContainText("空纸箱");
  await walkTo(page, boxApproach);
  await page.keyboard.press("g");
  await expect.poll(async () => (await readBrowserSnapshot(page)).held.kind).toBe("none");
  const dropped = await readBrowserSnapshot(page);
  expect(dropped.crates.find((entry) => entry.id === crate!.id)?.position).toEqual(originalBay);
  expect(dropped.recyclingRecords).toEqual([]);
}

async function standAtCheckout(page: Page): Promise<void> {
  const layout = (await readBrowserSnapshot(page)).renovation.layout;
  // Use the counter's validated clerk service point. The old imported north-edge
  // camera spot overlaps the pantry's walking envelope and is not a route target.
  await walkTo(page, transformLayoutPoint(layout, "checkout-counter", CHECKOUT_CLERK_POINT));
  await facePoint(page, transformLayoutPoint(layout, "checkout-counter", { x: -2.2, z: -2.2, y: .94 }));
  await expect(page.locator("#s3-target-label")).toContainText("收银台");
}

test("same-day restocking: £12 funds three real soap deliveries and four customers without ending day one", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto("/");
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await expect(page.locator("#s3-start-capital")).toHaveText("£12.00");
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
  const initial = await readBrowserSnapshot(page);
  expectLedger(initial, 0, 0, 0);
  expect(initial.day.phase).toBe("preparing");

  let bought = 0;
  let sold = 0;
  let originalBay: Position | undefined;
  const completedRounds: SimState[] = [];
  for (const [roundIndex, quantity] of [1, 1, 2].entries()) {
    await test.step(`Day 1: buy ${quantity} soap, receive order ${roundIndex + 1}, and sell it`, async () => {
      await openComputer(page, "supply");
      const beforeOrder = await readBrowserSnapshot(page);
      expectLedger(beforeOrder, bought, sold, roundIndex);
      expect(beforeOrder.day.phase).toBe(roundIndex === 0 ? "preparing" : "open");
      expect(beforeOrder.items.every((item) => item.location.kind === "sold")).toBe(true);
      await expect(page.locator("#s3-quantity-soap")).toHaveValue("0");
      await page.locator("#s3-quantity-soap").fill(String(quantity));
      await expect(page.locator("#s3-supply-total")).toHaveText(`−${money(quantity * COST)}`);
      await expect(page.locator("#s3-supply-after")).toHaveText(money(beforeOrder.cashPence - quantity * COST));
      await expect(page.locator("#s3-purchase")).toBeEnabled();
      await page.locator("#s3-purchase").click();
      await expect(page.locator("#s3-pause")).toBeHidden();
      bought += quantity;
      const ordered = await readBrowserSnapshot(page);
      expectLedger(ordered, bought, sold, roundIndex + 1);
      const order = ordered.purchases.at(-1)!;
      expect(order).toMatchObject({ dayNumber: 1, receivedDay: null, lines: [{ productId: PRODUCT_ID, quantity }] });
      expect(ordered.items.filter((item) => item.location.kind === "delivery")).toHaveLength(quantity);
      expect(ordered.purchases.slice(0, -1)).toEqual(beforeOrder.purchases);

      await walkTo(page, { x: 3, z: -7 });
      await facePoint(page, { x: 3, z: -9.1, y: 1.2 });
      await expect.poll(async () => {
        const delivery = (await readBrowserSnapshot(page)).delivery;
        return { phase: delivery.phase, orderId: delivery.orderId };
      }, { timeout: 35_000 }).toEqual({ phase: "ready", orderId: order.id });
      await expect(page.locator("#s3-target-label")).toContainText("配送");
      await expect(page.locator("#s3-target-action")).toContainText(`签收本单 ${quantity} 件`);
      await page.keyboard.press("e");
      await expect.poll(async () => (await readBrowserSnapshot(page)).purchases.at(-1)?.receivedDay).toBe(1);
      const received = await readBrowserSnapshot(page);
      expectLedger(received, bought, sold, roundIndex + 1);
      expect(received.items.filter((item) => item.location.kind === "crate")).toHaveLength(quantity);
      expect(received.items.some((item) => item.location.kind === "delivery")).toBe(false);
      expect(received.purchases.every((purchase) => purchase.receivedDay === 1)).toBe(true);
      originalBay ??= { ...received.crates.find((crate) => crate.productId === PRODUCT_ID)!.position };
      // A second E at the departing van cannot sign the same paid order twice.
      await page.keyboard.press("e");
      await expect(page.locator("#s3-pause")).toBeHidden();
      expect((await readBrowserSnapshot(page)).items).toEqual(received.items);
      await expect(page.locator("#s3-cash")).toHaveText(money(received.cashPence));

      await stockReceivedBox(page, quantity, originalBay);
      if (roundIndex === 0) {
        await openComputer(page, "day");
        await expect(page.locator("#s3-computer-open-shop")).toBeEnabled();
        await page.locator("#s3-computer-open-shop").click();
        await expect(page.locator("#s3-pause")).toBeHidden();
        await expect(page.locator("#s3-clock-state")).toHaveText("营业中");
      }
      await standAtCheckout(page);
      for (let visitor = 0; visitor < quantity; visitor += 1) {
        const customerNumber = sold + 1;
        await expect(page.locator("#s3-customer-name")).toContainText(`第 ${customerNumber} 位顾客`, { timeout: 35_000 });
        await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 65_000 });
        const checkout = await readBrowserSnapshot(page);
        expect(checkout.customer.number).toBe(customerNumber);
        expect(checkout.customer.shoppingList).toEqual([PRODUCT_ID]);
        expect(checkout.items.filter((item) => item.location.kind === "checkout")).toHaveLength(1);
        await expect(page.locator("#s3-target-label")).toContainText("收银台");
        await page.keyboard.press("e");
        await expect(page.locator("#s3-scan-soap")).toHaveText("已扫描");
        const paid = await payScannedCheckout(page);
        sold += 1;
        expectLedger(paid, bought, sold, roundIndex + 1);
        expect(paid.day.phase).toBe("open");
        await page.keyboard.press("e");
        expect((await readBrowserSnapshot(page)).transactions).toEqual(paid.transactions);
        await expect(page.locator("#s3-cash")).toHaveText(money(paid.cashPence));
        // Let the real shopper finish leaving. There is no clock injection or
        // command that jumps this customer out of the scene.
        await expect.poll(async () => (await readBrowserSnapshot(page)).customer.phase, { timeout: 45_000 }).toBe("complete");
      }
      const completed = await readBrowserSnapshot(page);
      expectLedger(completed, bought, sold, roundIndex + 1);
      expect(completed.day.phase).toBe("open");
      expect(completed.items.every((item) => item.location.kind === "sold")).toBe(true);
      expect(completed.renovation).toEqual(initial.renovation);
      completedRounds.push(completed);
      await page.screenshot({ path: testInfo.outputPath(`same-day-round-${roundIndex + 1}.png`) });
    });
  }

  expect(sold).toBe(4);
  expect(bought).toBe(4);
  await openComputer(page, "day");
  await expect(page.locator("#s3-day-title")).toContainText("第 1 天");
  await expect(page.locator("#s3-day-progress")).toContainText("已收款 4 单");
  await expect(page.locator("#s3-day-revenue")).toHaveText("£5.40");
  await expect(page.locator("#s3-day-procurement")).toHaveText("£2.80");
  await expect(page.locator("#s3-day-profit")).toHaveText("£2.60");
  await expect(page.locator("#s3-day-cash")).toHaveText("£14.60");
  const final = await readBrowserSnapshot(page);
  expectLedger(final, 4, 4, 3);
  expect(final.day).toMatchObject({ number: 1, phase: "open", targetCustomers: null, closeReason: null });
  expect(final.day.elapsedOpenMs).toBeLessThan(BUSINESS_DURATION_MS);
  expect(final.purchases.map((order) => order.lines)).toEqual([1, 1, 2].map((quantity) => [{ productId: PRODUCT_ID, quantity }]));
  expect(final.transactions.map((sale) => sale.customerNumber)).toEqual([1, 2, 3, 4]);
  await testInfo.attach("same-day-restocking-audit", {
    body: Buffer.from(JSON.stringify({ initial, completedRounds, final }, null, 2)), contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath("same-day-four-customers-ledger.png") });
  expect(errors).toEqual([]);
});
