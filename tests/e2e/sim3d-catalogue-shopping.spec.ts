import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  PRODUCTS, PRODUCT_IDS, createFirstDayState, reduceSim, validateSimState,
  type ProductId, type PurchaseLine, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { completeFixturePayment, payScannedCheckout } from "./helpers/sim3d-payment";
import { beginNextFixtureCustomer } from "./helpers/sim3d-business-time";

test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function step(state: SimState, action: SimCommand): SimState {
  const result = reduceSim(state, action);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${action.type}: ${result.message ?? "invalid fixture"}`);
  return result.state;
}

function monitorRuntime(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

async function startFresh(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function openSupply(page: Page): Promise<void> {
  if (!(await page.locator("#s3-pause").isVisible())) await page.keyboard.press("b");
  await page.locator("#s3-tab-supply").click();
  await expect(page.locator("#s3-panel-supply")).toBeVisible();
}

async function importSnapshot(page: Page, state: SimState): Promise<void> {
  expect(validateSimState(state)).toBe(true);
  await openSupply(page);
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({ name: "catalogue-game-fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(state)) });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function exportSnapshot(page: Page): Promise<SimState> {
  await openSupply(page);
  if (!(await page.locator("#s3-export").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.locator("#s3-export").click();
  const state: unknown = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(validateSimState(state)).toBe(true);
  return state as SimState;
}

function stockLines(state: SimState, lines: readonly PurchaseLine[], orderId: string): SimState {
  state = step(state, { type: "PURCHASE_STOCK", orderId, lines });
  state = step(state, { type: "RECEIVE_DELIVERY" });
  for (const line of lines) {
    const crate = state.crates.find((entry) => entry.productId === line.productId)!;
    state = step(state, { type: "PICK_CRATE", crateId: crate.id });
    for (let slot = 0; slot < line.quantity; slot++) state = step(state, { type: "STOCK", productId: line.productId, slot });
    state = step(state, { type: "DROP_HELD", position: crate.position });
  }
  return state;
}

/** Earn the opening balance through real audited sales, never by editing cash. */
function allProductsFixture(): SimState {
  let state = createFirstDayState();
  const totalCost = PRODUCT_IDS.reduce((sum, id) => sum + PRODUCTS[id].costPence, 0);
  for (let day = 1; state.cashPence < totalCost && day <= 30; day++) {
    state = stockLines(state, [{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }], `catalogue-capital-${day}`);
    for (let visitor = 0; visitor < 3; visitor++) {
      state = visitor === 0 ? step(state, { type: "OPEN_STORE" }) : beginNextFixtureCustomer(state);
      while (["to-milk", "to-bread", "to-checkout"].includes(state.customer.phase)) state = step(state, { type: "CUSTOMER_ADVANCE" });
      for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = step(state, { type: "SCAN", itemId: item.id });
      state = completeFixturePayment(state);
      state = step(state, { type: "CUSTOMER_ADVANCE" });
    }
    state = step(state, { type: "CLOSE_STORE" });
    state = step(state, { type: "SETTLE_DAY" });
    state = step(state, { type: "START_NEXT_DAY" });
  }
  if (state.cashPence < totalCost) throw new Error("Could not earn enough cash for the full catalogue fixture");
  return stockLines(state, PRODUCT_IDS.map((productId) => ({ productId, quantity: 1 })), "all-30-selected-products");
}

test("custom procurement: the empty cart, category/search and quantities purchase only the selected products", async ({ page }) => {
  test.setTimeout(170_000);
  const errors = monitorRuntime(page);
  await startFresh(page);
  await openSupply(page);
  await expect(page.locator('[id^="s3-supply-product-"]:visible')).toHaveCount(30);
  await expect(page.locator("#s3-purchase")).toBeDisabled();
  await expect.poll(() => page.locator('input[id^="s3-quantity-"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)))
    .toEqual(PRODUCT_IDS.map(() => "0"));

  await page.locator("#s3-supply-category").selectOption("household");
  await expect(page.locator('[id^="s3-supply-product-"]:visible')).toHaveCount(3);
  await page.locator("#s3-quantity-soap").fill("1.5");
  await expect(page.locator("#s3-purchase")).toBeDisabled();
  await page.locator("#s3-quantity-soap").fill("2");
  await page.locator("#s3-supply-category").selectOption("drinks");
  await page.locator("#s3-supply-search").fill("COLA");
  await expect(page.locator('[id^="s3-supply-product-"]:visible')).toHaveCount(1);
  await page.locator("#s3-quantity-cola").fill("3");
  await page.locator("#s3-supply-search").fill("unknown-product");
  await expect(page.locator('[id^="s3-supply-product-"]:visible')).toHaveCount(0);
  await page.locator("#s3-supply-search").fill("");
  await page.locator("#s3-supply-category").selectOption("all");
  await page.locator("#s3-supply-selected-only").check();
  await expect(page.locator('[id^="s3-supply-product-"]:visible')).toHaveCount(2);
  await expect(page.locator("#s3-quantity-soap")).toHaveValue("2");
  await expect(page.locator("#s3-quantity-cola")).toHaveValue("3");
  const spend = PRODUCTS.soap.costPence * 2 + PRODUCTS.cola.costPence * 3;
  await expect(page.locator("#s3-supply-total")).toHaveText(`−${money(spend)}`);
  await expect(page.locator("#s3-supply-after")).toHaveText(money(1200 - spend));
  await page.locator("#s3-purchase").click();
  await expect(page.locator("#s3-pause")).toBeHidden();
  await expect(page.locator("#s3-cash")).toHaveText(money(1200 - spend));
  await expect(page.locator("#s3-sold")).toContainText("库存 5 件");

  await openSupply(page);
  await expect(page.locator("#s3-quantity-soap")).toHaveValue("0");
  await expect(page.locator("#s3-quantity-cola")).toHaveValue("0");
  await expect(page.locator("#s3-purchase")).toBeDisabled();
  const saved = await exportSnapshot(page);
  expect(saved.items.filter((item) => item.productId === "soap")).toHaveLength(2);
  expect(saved.items.filter((item) => item.productId === "cola")).toHaveLength(3);
  expect(saved.items.every((item) => item.location.kind === "delivery")).toBe(true);
  expect(saved.items.some((item) => item.productId === "milk" || item.productId === "bread")).toBe(false);
  expect(saved.purchases).toHaveLength(1);
  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-cash")).toHaveText(money(1200 - spend));
  await expect(page.locator("#s3-sold")).toContainText("库存 5 件");

  // Continue the order actually placed above, using only the public save import
  // to position the player; the real van and E handler perform the receipt.
  const atVan = step(saved, { type: "SAVE_POSE", pose: { x: 3, z: -6.9, yaw: Math.PI, pitch: .06 } });
  await importSnapshot(page, atVan);
  await expect(page.locator("#s3-target-action")).toContainText("签收 5 件", { timeout: 15_000 });
  await page.keyboard.press("e");
  await expect(page.locator("#s3-target-action")).toContainText("查看今日进货单");
  await expect(page.locator("#s3-cash")).toHaveText(money(1200 - spend));
  const received = await exportSnapshot(page);
  expect(received.items).toHaveLength(5);
  expect(received.items.every((item) => item.location.kind === "crate")).toBe(true);
  expect(received.purchases[0]!.receivedDay).toBe(received.day.number);

  const colaCrate = received.crates.find((crate) => crate.productId === "cola")!;
  const atCrate = step(received, { type: "SAVE_POSE", pose: { x: colaCrate.position.x, z: colaCrate.position.z - 1.2, yaw: 0, pitch: .89 } });
  await importSnapshot(page, atCrate);
  await expect(page.locator("#s3-target-label")).toContainText("可乐", { timeout: 12_000 });
  await page.keyboard.press("f");
  await expect(page.locator("#s3-inspect-word")).toHaveText("cola");
  await expect(page.locator("#s3-inspect-chinese")).toHaveText("可乐");
  await expect(page.locator("#s3-inspect-phrase")).toHaveText("a can of cola");
  await page.keyboard.press("f");
  await expect(page.locator("#s3-cash")).toHaveText(money(1200 - spend));
  expect(errors).toEqual([]);
});

test("single-product shop: a real visitor buys the chosen new SKU and resumes a scanned order without charging twice", async ({ page }) => {
  test.setTimeout(125_000);
  const errors = monitorRuntime(page);
  const productId: ProductId = "soap";
  let fixture = stockLines(createFirstDayState(), [{ productId, quantity: 3 }], "soap-only-shop");
  fixture = step(fixture, { type: "OPEN_STORE" });
  fixture = step(fixture, { type: "SAVE_POSE", pose: { x: -2.62, z: -1.06, yaw: Math.PI, pitch: .56 } });
  await startFresh(page);
  await importSnapshot(page, fixture);
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 40_000 });
  await expect(page.locator("#s3-receipt-line-soap")).toBeVisible();
  await expect(page.locator("#s3-receipt-line-milk")).toBeHidden();
  await expect(page.locator("#s3-receipt-line-bread")).toBeHidden();
  await expect(page.locator("#s3-target-label")).toContainText("收银台");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-scan-soap")).toHaveText("已扫描");
  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-scan-soap")).toHaveText("已扫描");
  await expect(page.locator("#s3-receipt-line-milk")).toBeHidden();
  await payScannedCheckout(page);
  const expectedCash = fixture.cashPence + PRODUCTS.soap.pricePence;
  await expect(page.locator("#s3-cash")).toHaveText(money(expectedCash));
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已收款");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash")).toHaveText(money(expectedCash));
  const saved = await exportSnapshot(page);
  expect(saved.transactions).toHaveLength(1);
  expect(saved.transactions[0]!.itemIds).toHaveLength(1);
  expect(saved.transactions[0]!.amountPence).toBe(PRODUCTS.soap.pricePence);
  expect(saved.items.filter((item) => item.location.kind === "sold").map((item) => item.productId)).toEqual(["soap"]);
  expect(errors).toEqual([]);
});

test("full catalogue: all 30 purchased models coexist on real shelves and survive save/reload", async ({ page }, testInfo) => {
  test.setTimeout(140_000);
  const errors = monitorRuntime(page);
  const fixture = allProductsFixture();
  expect(fixture.items.filter((item) => item.location.kind === "shelf")).toHaveLength(30);
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(testInfo.outputPath("all-products-game.json"), JSON.stringify(fixture, null, 2));
  await startFresh(page);
  await importSnapshot(page, fixture);
  await expect(page.locator("#s3-sold")).toContainText("库存 30 件");
  await openSupply(page);
  await expect(page.locator('[id^="s3-supply-product-"]:visible')).toHaveCount(30);
  await expect(page.locator('[id^="s3-supply-product-"]')).toContainText(PRODUCT_IDS.map((id) => PRODUCTS[id].nameZh));
  await expect(page.locator('[id^="s3-supply-inventory-"]')).toHaveText(PRODUCT_IDS.map(() => "现货 1 · 架上 1"));
  await expect(page.locator('[id^="s3-supply-pending-"]')).toHaveText(PRODUCT_IDS.map(() => "待收 0"));
  await expect.poll(() => page.locator('input[id^="s3-quantity-"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)))
    .toEqual(PRODUCT_IDS.map(() => "0"));
  const saved = await exportSnapshot(page);
  expect(saved.cashPence).toBe(fixture.cashPence);
  expect(saved.items.filter((item) => item.location.kind === "shelf").map((item) => item.productId).sort()).toEqual([...PRODUCT_IDS].sort());
  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-sold")).toContainText("库存 30 件");
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  expect(errors).toEqual([]);
});
