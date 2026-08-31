import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  createFirstDayState, getCheckoutTotal, getDaySummary, reduceSim, validateSimState,
  type PlayerPose, type ProductId, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { cashTenderSpeechFor } from "../../src/sim3d/customerSelection";
import { readBrowserSnapshot as savedSnapshot } from "./helpers/sim3d-payment";

// Each check owns a disposable Playwright context. No user browser or user save is touched.
// Keep the real 3D checks within this file sequential, even in the parallel wider suite.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

const checkoutPose: PlayerPose = { x: -2.62, z: -1.06, yaw: Math.PI, pitch: .56 };
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function step(state: SimState, action: SimCommand): SimState {
  const result = reduceSim(state, action);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${action.type}: ${result.message ?? "invalid real fixture"}`);
  return result.state;
}

function walkToCheckout(state: SimState): SimState {
  while (["to-milk", "to-bread", "to-checkout"].includes(state.customer.phase)) {
    state = step(state, { type: "CUSTOMER_ADVANCE" });
  }
  return state;
}

/** Buy, receive, stock and earn the first sale through the real audited reducer. */
function checkoutFixture(visitor: 1 | 2 = 2, products: readonly ProductId[] = ["milk", "bread"]): SimState {
  let state = step(createFirstDayState(), {
    type: "PURCHASE_STOCK", orderId: "cash-browser-delivery",
    lines: products.map((productId) => ({ productId, quantity: 3 })),
  });
  state = step(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of products) {
    const crate = state.crates.find((entry) => entry.productId === productId)!;
    state = step(state, { type: "PICK_CRATE", crateId: crate.id });
    for (let slot = 0; slot < 3; slot += 1) state = step(state, { type: "STOCK", productId, slot });
    state = step(state, { type: "DROP_HELD", position: crate.position });
  }
  state = walkToCheckout(step(state, { type: "OPEN_STORE" }));
  expect(state.payment).toEqual({ method: "card" });
  if (visitor === 2) {
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
      state = step(state, { type: "SCAN", itemId: item.id });
    }
    state = step(state, { type: "PAY", success: true });
    state = step(state, { type: "CUSTOMER_ADVANCE" });
    state = walkToCheckout(step(state, { type: "NEXT_CUSTOMER" }));
    expect(state.payment?.method).toBe("cash");
  }
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
  if (!(await page.locator("#s3-export").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
}

async function launchFixture(page: Page, fixture: SimState): Promise<void> {
  expect(validateSimState(fixture)).toBe(true);
  await page.goto("/");
  await start(page);
  await openManagement(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({
    name: "cash-payment-real-reducer.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 25_000 });
  await expect(page.locator("#s3-target-label")).toContainText("收银台");
}

/** The public export action also captures the actual current player pose. */
async function exportSnapshot(page: Page): Promise<SimState> {
  await openManagement(page);
  const download = page.waitForEvent("download");
  await page.locator("#s3-export").click();
  const state: unknown = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(validateSimState(state)).toBe(true);
  return state as SimState;
}

async function scanOrder(page: Page, fixture: SimState): Promise<void> {
  for (const item of fixture.items.filter((entry) => entry.location.kind === "checkout")) {
    await page.keyboard.press("e");
    await expect(page.locator(`#s3-scan-${item.productId}`)).toHaveText("已扫描");
    await expect(page.locator("#s3-cash-dialog")).toBeHidden();
    await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  }
}

async function openCash(page: Page): Promise<void> {
  if (!(await page.locator("#s3-cash-dialog").isVisible())) {
    await expect(page.locator("#s3-target-action")).toContainText("现金");
    await page.keyboard.press("e");
  }
  await expect(page.locator("#s3-cash-dialog")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
}

test("cash checkout: real scans, receive, under/over change, undo and one audited payment", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors = runtimeErrors(page);
  const fixture = checkoutFixture();
  const due = getCheckoutTotal(fixture);
  const tenderClip = cashTenderSpeechFor(fixture)!;
  expect(due).toBe(400);
  expect(fixture.payment).toEqual({ method: "cash", tenderedPence: 500, received: false, selectedChange: [] });
  await launchFixture(page, fixture);
  await expect(page.locator("#s3-customer-line")).toContainText(/cash/i);
  await expect(page.locator("#s3-open-cash:enabled:visible")).toHaveCount(0);
  await scanOrder(page, fixture);
  await openCash(page);
  await expect(page.locator("#s3-cash-due")).toHaveText(money(due));
  await expect(page.locator("#s3-cash-tendered")).toHaveText("£5.00");
  await expect(page.locator("#s3-cash-change-due")).toHaveText("£1.00");
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.00");
  await expect(page.locator("#s3-cash-line")).toHaveText(`“${tenderClip.text}”`);
  await expect(page.locator("#s3-cash-zh")).toHaveText(tenderClip.zh);
  await expect(page.locator("#s3-cash-confirm")).toBeDisabled();
  await page.keyboard.press("e");
  expect((await savedSnapshot(page)).payment).toEqual(fixture.payment);

  await page.locator("#s3-cash-receive").click();
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  expect((await savedSnapshot(page)).transactions).toEqual(fixture.transactions);
  await page.locator("#s3-cash-replay").click();
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", tenderClip.src);
  await expect(page.locator("#s3-cash-audio-status")).toContainText("播放结束", { timeout: 12_000 });
  await expect(page.locator("#s3-customer-line")).not.toContainText(/card/i);
  await page.locator("#s3-cash-add-50").click();
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.50");
  await expect(page.locator("#s3-cash-feedback")).toContainText(/还差|少找|不足/);
  await expect(page.locator("#s3-cash-confirm")).toBeDisabled();
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  await page.locator("#s3-cash-add-20").click();
  await page.locator("#s3-cash-add-50").click();
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£1.20");
  await expect(page.locator("#s3-cash-feedback")).toContainText(/多|超过/);
  await expect(page.locator("#s3-cash-confirm")).toBeDisabled();
  await page.locator("#s3-cash-remove-2").click();
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.70");
  await page.locator("#s3-cash-reset").click();
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.00");
  await expect(page.locator('[id^="s3-cash-remove-"]')).toHaveCount(0);
  // £1 is also a valid coin; two 50p pieces must work equally well.
  await page.locator("#s3-cash-add-50").click();
  await page.locator("#s3-cash-add-50").click();
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£1.00");
  await expect(page.locator("#s3-cash-confirm")).toBeEnabled();
  expect((await savedSnapshot(page)).transactions).toEqual(fixture.transactions);
  await page.screenshot({ path: testInfo.outputPath("cash-payment-correct-change.png") });
  await page.locator("#s3-cash-confirm").click();
  await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已收款");
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence + due));
  for (let repeat = 0; repeat < 3; repeat += 1) await page.keyboard.press("e");
  const paid = await exportSnapshot(page);
  expect(paid.transactions).toHaveLength(fixture.transactions.length + 1);
  expect(paid.transactions.at(-1)).toMatchObject({ customerNumber: 2, amountPence: due });
  expect(paid.transactions.at(-1)!.itemIds).toEqual(fixture.items.filter((item) => item.location.kind === "checkout").map((item) => item.id));
  expect(paid.cashPence).toBe(fixture.cashPence + due);
  expect(getDaySummary(paid).revenuePence).toBe(getDaySummary(fixture).revenuePence + due);
  expect(errors).toEqual([]);
});

test("cash checkout: close, Escape and reload retain received cash and selected coins without moving the player", async ({ page }) => {
  test.setTimeout(140_000);
  const errors = runtimeErrors(page);
  const fixture = checkoutFixture();
  await launchFixture(page, fixture);
  await scanOrder(page, fixture);
  await openCash(page);
  await page.locator("#s3-cash-receive").click();
  await page.locator("#s3-cash-add-50").click();
  const partial = await savedSnapshot(page);
  expect(partial.payment).toEqual({ method: "cash", tenderedPence: 500, received: true, selectedChange: [50] });
  await page.locator("#s3-cash-close").click();
  await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  await expect(page.locator("#s3-pause")).toBeHidden();
  await page.locator("#s3-open-cash").click();
  await expect(page.locator("#s3-cash-dialog")).toBeVisible();
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.50");
  await expect(page.locator("#s3-cash-receive:enabled:visible")).toHaveCount(0);
  // Deliberately hold movement/look keys across real simulation frames behind the modal.
  await page.keyboard.down("w");
  await page.keyboard.down("l");
  await page.waitForTimeout(400);
  await page.keyboard.up("l");
  await page.keyboard.up("w");
  await page.keyboard.press("e");
  await page.keyboard.press("e");
  await page.keyboard.press("Escape");
  await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  await expect(page.locator("#s3-pause")).toBeHidden();
  const closed = await exportSnapshot(page);
  expect(closed.payment).toEqual(partial.payment);
  expect(closed.cashPence).toBe(fixture.cashPence);
  expect(closed.transactions).toEqual(fixture.transactions);
  for (const axis of ["x", "z", "yaw", "pitch"] as const) expect(closed.playerPose[axis]).toBeCloseTo(partial.playerPose[axis], 6);
  await page.locator("#s3-resume").click();
  await openCash(page);
  await page.reload();
  await start(page);
  await openCash(page);
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.50");
  await expect(page.locator("#s3-cash-tendered")).toHaveText("£5.00");
  await expect(page.locator("#s3-cash-receive:enabled:visible")).toHaveCount(0);
  await expect(page.locator("#s3-cash-confirm")).toBeDisabled();
  expect((await savedSnapshot(page)).payment).toEqual(partial.payment);
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  await page.locator("#s3-cash-add-50").click();
  await page.locator("#s3-cash-confirm").click();
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence + getCheckoutTotal(fixture)));
  expect((await savedSnapshot(page)).transactions).toHaveLength(fixture.transactions.length + 1);
  expect(errors).toEqual([]);
});

test("cash checkout: cancelling a received partial payment returns goods and never credits the tender", async ({ page }) => {
  test.setTimeout(110_000);
  const errors = runtimeErrors(page);
  const fixture = checkoutFixture();
  const unpaidIds = fixture.items.filter((item) => item.location.kind === "checkout").map((item) => item.id);
  await launchFixture(page, fixture);
  await scanOrder(page, fixture);
  await openCash(page);
  await page.locator("#s3-cash-receive").click();
  await page.locator("#s3-cash-add-50").click();
  await page.locator("#s3-cash-close").click();
  await openManagement(page);
  await expect(page.locator("#s3-cancel-customer")).toBeEnabled();
  await page.locator("#s3-cancel-customer").click();
  await expect(page.locator("#s3-cancel-customer")).toBeDisabled();
  const cancelled = await exportSnapshot(page);
  expect(cancelled.payment).toBeNull();
  expect(cancelled.scannedIds).toEqual([]);
  expect(cancelled.cashPence).toBe(fixture.cashPence);
  expect(cancelled.transactions).toEqual(fixture.transactions);
  expect(cancelled.items).toHaveLength(fixture.items.length);
  expect(cancelled.items.filter((item) => unpaidIds.includes(item.id)).every((item) => ["crate", "shelf"].includes(item.location.kind))).toBe(true);
  expect(getDaySummary(cancelled).revenuePence).toBe(getDaySummary(fixture).revenuePence);
  await page.reload();
  await start(page);
  await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  expect((await savedSnapshot(page)).transactions).toEqual(fixture.transactions);
  expect(errors).toEqual([]);
});

test("cash checkout: exact tender requires receiving the money but no invented change", async ({ page }) => {
  test.setTimeout(100_000);
  const errors = runtimeErrors(page);
  // Bread (£2.40) plus cereal (£2.60) is an honest £5 basket with a £5 tender.
  const fixture = checkoutFixture(2, ["bread", "cereal"]);
  expect(getCheckoutTotal(fixture)).toBe(500);
  expect(fixture.payment).toEqual({ method: "cash", tenderedPence: 500, received: false, selectedChange: [] });
  await launchFixture(page, fixture);
  await scanOrder(page, fixture);
  await openCash(page);
  await expect(page.locator("#s3-cash-change-due")).toHaveText("£0.00");
  await expect(page.locator("#s3-cash-confirm")).toBeDisabled();
  await page.locator("#s3-cash-receive").click();
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.00");
  await expect(page.locator("#s3-cash-confirm")).toBeEnabled();
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  await page.locator("#s3-cash-dialog .s3-cash-small-coins summary").click();
  await page.locator("#s3-cash-add-1").click();
  await expect(page.locator("#s3-cash-confirm")).toBeDisabled();
  await expect(page.locator("#s3-cash-feedback")).toContainText(/多|超过/);
  await page.locator("#s3-cash-reset").click();
  await page.locator("#s3-cash-confirm").click();
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已收款");
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence + 500));
  const paid = await savedSnapshot(page);
  expect(paid.transactions).toHaveLength(fixture.transactions.length + 1);
  expect(paid.transactions.at(-1)!.amountPence).toBe(500);
  expect(errors).toEqual([]);
});

test("cash checkout: a narrow window keeps the full dialog and real money buttons usable", async ({ page }, testInfo) => {
  test.setTimeout(110_000);
  const errors = runtimeErrors(page);
  const fixture = checkoutFixture();
  await launchFixture(page, fixture);
  await page.setViewportSize({ width: 540, height: 700 });
  await scanOrder(page, fixture);
  await openCash(page);
  const dialog = page.locator("#s3-cash-dialog");
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(541);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(701);
  await page.locator("#s3-cash-receive").click();
  await page.locator("#s3-cash-add-50").click();
  await page.locator("#s3-cash-add-50").click();
  await expect(page.locator("#s3-cash-confirm")).toBeEnabled();
  await page.locator("#s3-cash-confirm").scrollIntoViewIfNeeded();
  await expect(page.locator("#s3-cash-confirm")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("cash-payment-narrow.png") });
  await page.locator("#s3-cash-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence + getCheckoutTotal(fixture)));
  expect((await savedSnapshot(page)).transactions).toHaveLength(fixture.transactions.length + 1);
  expect(errors).toEqual([]);
});

test("card checkout: the original first visitor still pays once and the next visitor offers cash", async ({ page }) => {
  test.setTimeout(110_000);
  const errors = runtimeErrors(page);
  const fixture = checkoutFixture(1);
  await launchFixture(page, fixture);
  await expect(page.locator("#s3-customer-line")).toContainText(/card/i);
  await scanOrder(page, fixture);
  await expect(page.locator("#s3-target-action")).toContainText("刷卡收款");
  await expect(page.locator("#s3-open-cash:visible")).toHaveCount(0);
  await page.keyboard.press("e");
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已收款");
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence + getCheckoutTotal(fixture)));
  await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  await page.keyboard.press("e");
  await page.keyboard.press("e");
  expect((await savedSnapshot(page)).transactions).toHaveLength(1);
  await expect(page.locator("#s3-customer-name")).toContainText("第 2 位顾客", { timeout: 20_000 });
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 35_000 });
  await expect(page.locator("#s3-customer-line")).toContainText(/cash/i);
  const next = await savedSnapshot(page);
  expect(next.customer.number).toBe(2);
  expect(next.payment).toEqual({ method: "cash", tenderedPence: 500, received: false, selectedChange: [] });
  expect(next.transactions).toHaveLength(1);
  expect(next.cashPence).toBe(fixture.cashPence + getCheckoutTotal(fixture));
  expect(errors).toEqual([]);
});
