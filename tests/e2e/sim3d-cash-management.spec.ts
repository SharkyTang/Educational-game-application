import { expect, test, type Page } from "@playwright/test";
import {
  createFirstDayState, getDaySummary, reduceSim, validateSimState,
  type PlayerPose, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { CASH_DENOMINATIONS_PENCE } from "../../src/sim3d/cashPayment";
import { cashDrawerValuePence, type CashDrawerState } from "../../src/sim3d/cashDrawer";
import { beginNextFixtureCustomer } from "./helpers/sim3d-business-time";
import { completeFixturePayment, payScannedCheckout, readBrowserSnapshot } from "./helpers/sim3d-payment";

// Import ordinary reducer histories through the public save UI. Browser actions below
// use the same controls as the player, in a disposable context with no app test bridge.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

const checkoutPose: PlayerPose = { x: -2.62, z: -1.06, yaw: Math.PI, pitch: .56 };
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
const management = (suffix: string): string => `#s3-cash-management-${suffix}`;

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed || !validateSimState(result.state)) {
    throw new Error(`${command.type}: ${result.message ?? "invalid cash-management fixture"}`);
  }
  return result.state;
}

/** Exactly enough real stock for the paid visits; only returned goods can sell again. */
function paidFixture(visitors: 1 | 2): SimState {
  let state = step(createFirstDayState(), {
    type: "PURCHASE_STOCK", orderId: `cash-management-${visitors}-visits`,
    lines: [{ productId: "milk", quantity: visitors }, { productId: "bread", quantity: visitors }],
  });
  state = step(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    const crate = state.crates.find((entry) => entry.productId === productId)!;
    state = step(state, { type: "PICK_CRATE", crateId: crate.id });
    for (let slot = 0; slot < visitors; slot += 1) state = step(state, { type: "STOCK", productId, slot });
    state = step(state, { type: "DROP_HELD", position: crate.position });
  }
  for (let visitor = 0; visitor < visitors; visitor += 1) {
    state = visitor === 0 ? step(state, { type: "OPEN_STORE" }) : beginNextFixtureCustomer(state);
    while (["to-milk", "to-bread", "to-checkout"].includes(state.customer.phase)) {
      state = step(state, { type: "CUSTOMER_ADVANCE" });
    }
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
      state = step(state, { type: "SCAN", itemId: item.id });
    }
    state = step(completeFixturePayment(state), { type: "CUSTOMER_ADVANCE" });
  }
  expect(state.transactions.map((transaction) => transaction.paymentMethod)).toEqual(visitors === 1 ? ["card"] : ["card", "cash"]);
  expect(state.items.every((item) => item.location.kind === "sold")).toBe(true);
  return step(state, { type: "SAVE_POSE", pose: checkoutPose });
}

function runtimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

async function start(page: Page): Promise<void> {
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function openManagement(page: Page): Promise<void> {
  if (!(await page.locator("#s3-pause").isVisible())) await page.keyboard.press("b");
  await expect(page.locator("#s3-pause")).toBeVisible();
}

async function openCashManagement(page: Page): Promise<void> {
  await openManagement(page);
  await page.locator("#s3-tab-cash").click();
  await expect(page.locator(management("drawer"))).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
}

async function launchFixture(page: Page, fixture: SimState): Promise<void> {
  expect(validateSimState(fixture)).toBe(true);
  await page.goto("/");
  await start(page);
  await openManagement(page);
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({
    name: "cash-management-real-reducer.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
}

async function fillCount(page: Page, counts: CashDrawerState): Promise<void> {
  for (const denomination of CASH_DENOMINATIONS_PENCE) {
    await page.locator(management(`count-${denomination}`)).fill(String(counts[denomination]));
  }
}

test("cash management v3: configuring and restoring the opening float conserves money across reload", async ({ page }, testInfo) => {
  test.setTimeout(110_000);
  const errors = runtimeErrors(page);
  await page.goto("/");
  await start(page);
  await openCashManagement(page);
  const initial = await readBrowserSnapshot(page);
  expect(initial.day.phase).toBe("preparing");
  expect(initial.cashReservePence).toBe(0);
  expect(cashDrawerValuePence(initial.cashDrawer)).toBe(3160);

  // Transfer one actual £2 piece to the reserve; shop buying power is unchanged.
  await page.locator(management("float-200")).fill("4");
  await expect(page.locator(management("float-preview"))).toContainText("£29.60");
  await expect(page.locator(management("float-save"))).toBeEnabled();
  await page.locator(management("float-save")).click();
  const configured = await readBrowserSnapshot(page);
  expect(configured.cashDrawer).toEqual({ ...initial.cashDrawer, 200: 4 });
  expect(configured.cashReservePence).toBe(200);
  expect(cashDrawerValuePence(configured.cashDrawer) + configured.cashReservePence)
    .toBe(cashDrawerValuePence(initial.cashDrawer) + initial.cashReservePence);
  expect(configured.cashPence).toBe(initial.cashPence);
  expect(configured.cashDrawerOpening).toEqual(initial.cashDrawerOpening);
  expect(configured.transactions).toEqual(initial.transactions);
  expect(configured.cashJournal).toHaveLength(initial.cashJournal.length + 1);
  expect(configured.cashJournal.at(-1)).toMatchObject({ kind: "float", dayNumber: 1, drawer: configured.cashDrawer, reservePence: 200 });
  await expect(page.locator(management("reserve"))).toContainText("£2.00");

  await page.reload();
  await start(page);
  await openCashManagement(page);
  const restored = await readBrowserSnapshot(page);
  expect(restored.cashDrawer).toEqual(configured.cashDrawer);
  expect(restored.cashReservePence).toBe(configured.cashReservePence);
  expect(restored.cashJournal).toEqual(configured.cashJournal);
  await expect(page.locator(management("float-200"))).toHaveValue("4");
  await page.locator(management("float-200")).fill("6");
  await expect(page.locator(management("float-save"))).toBeDisabled();
  expect((await readBrowserSnapshot(page)).cashJournal).toEqual(configured.cashJournal);
  await page.locator(management("float-200")).fill("5");
  await page.locator(management("float-save")).click();
  const returned = await readBrowserSnapshot(page);
  expect(returned.cashDrawer).toEqual(initial.cashDrawer);
  expect(returned.cashReservePence).toBe(0);
  expect(returned.cashPence).toBe(initial.cashPence);
  expect(returned.cashJournal).toHaveLength(configured.cashJournal.length + 1);

  await page.setViewportSize({ width: 430, height: 800 });
  const dialog = page.locator("#s3-pause");
  await page.locator(management("title")).scrollIntoViewIfNeeded();
  const dimensions = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, viewport: window.innerWidth,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  const saveFloat = page.locator(management("float-save"));
  await expect(saveFloat).not.toBeInViewport();
  await saveFloat.scrollIntoViewIfNeeded();
  await expect(saveFloat).toBeInViewport();
  await saveFloat.click({ trial: true });
  await page.screenshot({ path: testInfo.outputPath("cash-management-narrow-scroll.png") });
  expect(errors).toEqual([]);
});

test("cash management v3: a cash return refunds once to cash and the same returned goods can sell again", async ({ page }, testInfo) => {
  test.setTimeout(160_000);
  const errors = runtimeErrors(page);
  const fixture = paidFixture(2);
  const transaction = fixture.transactions.at(-1)!;
  expect(transaction.paymentMethod).toBe("cash");
  expect(transaction.amountPence).toBe(400);
  await launchFixture(page, fixture);
  await openCashManagement(page);
  await expect(page.locator(management(`refund-${transaction.id}`))).toBeEnabled();
  await page.locator(management(`refund-${transaction.id}`)).click();
  await expect(page.locator(management("refund-confirm"))).toBeVisible();
  await expect(page.locator(management("refund-confirm-description"))).toContainText("现金");
  await expect(page.locator(management("refund-confirm-description"))).toContainText("£4.00");
  // Cancelling the ordinary confirmation must not return stock or debit funds.
  await page.locator(management("refund-cancel")).click();
  expect((await readBrowserSnapshot(page)).cashJournal).toEqual(fixture.cashJournal);
  await page.locator(management(`refund-${transaction.id}`)).click();
  await page.locator(management("refund-confirm-button")).click();
  await expect(page.locator(management("refund-confirm"))).toBeHidden();
  const refunded = await readBrowserSnapshot(page);
  const record = refunded.cashJournal.at(-1)!;
  expect(record).toMatchObject({ kind: "refund", transactionId: transaction.id, reason: "return", paymentMethod: "cash", amountPence: 400 });
  if (record.kind !== "refund") throw new Error("Missing cash refund journal entry");
  expect(record.returnedCash.reduce((total, piece) => total + piece, 0)).toBe(transaction.amountPence);
  expect(cashDrawerValuePence(refunded.cashDrawer)).toBe(cashDrawerValuePence(fixture.cashDrawer) - transaction.amountPence);
  expect(refunded.cashPence).toBe(fixture.cashPence - transaction.amountPence);
  expect(refunded.cashReservePence).toBe(fixture.cashReservePence);
  expect(refunded.transactions).toEqual(fixture.transactions);
  expect(refunded.items.filter((item) => transaction.itemIds.includes(item.id)).every((item) => item.location.kind === "shelf")).toBe(true);
  expect(getDaySummary(refunded)).toMatchObject({
    revenuePence: getDaySummary(fixture).revenuePence,
    refundCount: 1, refundPence: transaction.amountPence,
    netRevenuePence: getDaySummary(fixture).revenuePence - transaction.amountPence,
  });
  await expect(page.locator(management(`refund-${transaction.id}`))).toBeDisabled();
  await expect(page.locator(management(`void-${transaction.id}`))).toBeDisabled();
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已退款");
  await expect(page.locator("#s3-receipt-help")).toContainText("原现金渠道退还 £4.00");
  await expect(page.locator("#s3-receipt-help")).toContainText("本单净额 £0.00");
  await page.keyboard.press("Enter");
  expect((await readBrowserSnapshot(page)).cashJournal).toEqual(refunded.cashJournal);
  await page.screenshot({ path: testInfo.outputPath("cash-management-refunded-stock.png") });

  await page.locator("#s3-resume").click();
  await expect(page.locator("#s3-customer-name")).toContainText("第 3 位顾客", { timeout: 25_000 });
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 35_000 });
  const nextCheckout = await readBrowserSnapshot(page);
  expect(nextCheckout.items.filter((item) => item.location.kind === "checkout").map((item) => item.id).sort())
    .toEqual([...transaction.itemIds].sort());
  await expect(page.locator("#s3-target-label")).toContainText("收银台");
  for (const item of nextCheckout.items.filter((entry) => entry.location.kind === "checkout")) {
    await page.keyboard.press("e");
    await expect(page.locator(`#s3-scan-${item.productId}`)).toHaveText("已扫描");
  }
  const resold = await payScannedCheckout(page);
  expect([...resold.transactions.at(-1)!.itemIds].sort()).toEqual([...transaction.itemIds].sort());
  expect(resold.cashJournal).toEqual(refunded.cashJournal);
  expect(resold.cashPence).toBe(fixture.cashPence);
  expect(validateSimState(resold)).toBe(true);
  expect(errors).toEqual([]);
});

test("cash management v3: voiding a card sale uses its original channel without taking drawer cash", async ({ page }) => {
  test.setTimeout(105_000);
  const errors = runtimeErrors(page);
  const fixture = paidFixture(1);
  const transaction = fixture.transactions[0]!;
  await launchFixture(page, fixture);
  await openCashManagement(page);
  await page.locator(management(`void-${transaction.id}`)).click();
  await expect(page.locator(management("refund-confirm-description"))).toContainText(/刷卡|银行卡/);
  await page.locator(management("refund-confirm-button")).click();
  const refunded = await readBrowserSnapshot(page);
  expect(refunded.cashJournal.at(-1)).toMatchObject({
    kind: "refund", transactionId: transaction.id, reason: "void", paymentMethod: "card", amountPence: transaction.amountPence, returnedCash: [],
  });
  expect(refunded.cashDrawer).toEqual(fixture.cashDrawer);
  expect(refunded.cashReservePence).toBe(fixture.cashReservePence);
  expect(refunded.cashPence).toBe(fixture.cashPence - transaction.amountPence);
  expect(refunded.transactions).toEqual(fixture.transactions);
  expect(getDaySummary(refunded)).toMatchObject({ revenuePence: transaction.amountPence, refundPence: transaction.amountPence, netRevenuePence: 0 });
  expect(refunded.items.every((item) => item.location.kind === "shelf")).toBe(true);
  await expect(page.locator(management(`void-${transaction.id}`))).toBeDisabled();
  await expect(page.locator(management(`refund-${transaction.id}`))).toBeDisabled();
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已撤销");
  await expect(page.locator("#s3-receipt-help")).toContainText("原刷卡渠道退还 £4.00");
  await expect(page.locator("#s3-receipt-help")).toContainText("本单净额 £0.00");
  // Keep the clock paused so persistence is checked before the next real arrival.
  await page.reload();
  await start(page);
  await openCashManagement(page);
  const restored = await readBrowserSnapshot(page);
  expect(restored.cashJournal).toEqual(refunded.cashJournal);
  expect(restored.cashDrawer).toEqual(refunded.cashDrawer);
  expect(restored.cashPence).toBe(refunded.cashPence);
  expect(errors).toEqual([]);
});

test("cash management v3: closing count requires a discrepancy note, survives reload and becomes stale after a card refund", async ({ page }, testInfo) => {
  test.setTimeout(155_000);
  const errors = runtimeErrors(page);
  const fixture = step(paidFixture(2), { type: "CLOSE_STORE" });
  await launchFixture(page, fixture);
  await openManagement(page);
  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-day-to-cash")).toContainText("打烊钱箱盘点");
  await page.locator("#s3-day-to-cash").click();
  await expect(page.locator(management("count-save"))).toBeDisabled();
  const counts = { ...fixture.cashDrawer, 100: fixture.cashDrawer[100] - 1 };
  expect(counts[100]).toBeGreaterThanOrEqual(0);
  await fillCount(page, counts);
  await expect(page.locator(management("count-difference"))).toContainText(/[-−]£1\.00/);
  await expect(page.locator(management("count-save"))).toBeDisabled();
  await page.locator(management("count-note")).fill("   ");
  await expect(page.locator(management("count-save"))).toBeDisabled();
  expect((await readBrowserSnapshot(page)).cashJournal).toEqual(fixture.cashJournal);
  const note = "少一枚 £1 硬币，已记录并准备复点。";
  await page.locator(management("count-note")).fill(note);
  await expect(page.locator(management("count-save"))).toBeEnabled();
  await page.locator(management("count-save")).click();
  const counted = await readBrowserSnapshot(page);
  expect(counted.cashJournal.at(-1)).toMatchObject({
    kind: "count", dayNumber: fixture.day.number, expected: fixture.cashDrawer, counts,
    expectedPence: cashDrawerValuePence(fixture.cashDrawer), countedPence: cashDrawerValuePence(counts), differencePence: -100, note,
  });
  // A count records the observation; it must not silently write off stock or money.
  expect(counted.cashDrawer).toEqual(fixture.cashDrawer);
  expect(counted.cashPence).toBe(fixture.cashPence);
  expect(counted.cashReservePence).toBe(fixture.cashReservePence);
  expect(counted.transactions).toEqual(fixture.transactions);
  await expect(page.locator(management("count-history"))).toContainText(note);
  await page.screenshot({ path: testInfo.outputPath("cash-management-closing-discrepancy.png") });

  await page.reload();
  await start(page);
  await openCashManagement(page);
  await expect(page.locator(management("count-history"))).toContainText(note);
  expect((await readBrowserSnapshot(page)).cashJournal).toEqual(counted.cashJournal);

  // Even a card refund changes the reconciled business day while leaving its
  // physical drawer unchanged; that earlier count must be visibly marked stale.
  const cardSale = fixture.transactions[0]!;
  expect(cardSale.paymentMethod).toBe("card");
  await page.locator(management(`void-${cardSale.id}`)).click();
  await page.locator(management("refund-confirm-button")).click();
  await expect(page.locator(management("count-status"))).toContainText("请重新盘点");
  const afterRefund = await readBrowserSnapshot(page);
  expect(afterRefund.cashDrawer).toEqual(counted.cashDrawer);
  expect(afterRefund.cashPence).toBe(counted.cashPence - cardSale.amountPence);
  expect(afterRefund.cashJournal.filter((event) => event.kind === "count")).toHaveLength(1);
  await fillCount(page, afterRefund.cashDrawer);
  await page.locator(management("count-note")).fill("");
  await expect(page.locator(management("count-save"))).toBeEnabled();
  await page.locator(management("count-save")).click();
  await expect(page.locator(management("count-status"))).toContainText("最新盘点");
  const recounted = await readBrowserSnapshot(page);
  expect(recounted.cashJournal.filter((event) => event.kind === "count")).toHaveLength(2);
  expect(recounted.cashJournal.at(-1)).toMatchObject({ kind: "count", differencePence: 0, note: "", counts: afterRefund.cashDrawer });
  await expect(page.locator(management("count-history"))).toContainText(note);
  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-settle-day")).toBeEnabled();
  await page.locator("#s3-settle-day").click();
  await expect(page.locator("#s3-day-title")).toContainText("日结完成");
  const settled = await readBrowserSnapshot(page);
  expect(settled.day.phase).toBe("settled");
  expect(settled.cashJournal).toEqual(recounted.cashJournal);
  expect(settled.cashDrawer).toEqual(recounted.cashDrawer);
  expect(settled.cashPence).toBe(recounted.cashPence);
  expect(errors).toEqual([]);
});
