import { expect, test, type Page } from "@playwright/test";
import { BUSINESS_DURATION_MS } from "../../src/sim3d/businessTime";
import {
  createFirstDayState, getCheckoutTotal, getDaySummary, reduceSim, validateSimState,
  type PlayerPose, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { customerSpeechFor } from "../../src/sim3d/customerSelection";
import { SIM_STORAGE_KEY } from "../../src/sim3d/persistence";
import { beginNextFixtureCustomer } from "./helpers/sim3d-business-time";
import { completeFixturePayment, payScannedCheckout, readBrowserSnapshot } from "./helpers/sim3d-payment";

// Fixtures enter through the public import UI; no application state or clock is patched in the browser.
// Each test owns a disposable Playwright context, never an existing user's browser or save.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

const checkoutPose: PlayerPose = { x: -2.62, z: -1.06, yaw: Math.PI, pitch: .56 };
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function step(state: SimState, action: SimCommand): SimState {
  const result = reduceSim(state, action);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${action.type}: ${result.message ?? "invalid real timed-day fixture"}`);
  return result.state;
}

function stockedFixture(quantity = 4): SimState {
  let state = step(createFirstDayState(), {
    type: "PURCHASE_STOCK", orderId: "business-time-delivery",
    lines: [{ productId: "milk", quantity }, { productId: "bread", quantity }],
  });
  state = step(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    const crate = state.crates.find((entry) => entry.productId === productId)!;
    state = step(state, { type: "PICK_CRATE", crateId: crate.id });
    for (let slot = 0; slot < quantity; slot += 1) state = step(state, { type: "STOCK", productId, slot });
    state = step(state, { type: "DROP_HELD", position: crate.position });
  }
  return step(state, { type: "SAVE_POSE", pose: checkoutPose });
}

function walkToCheckout(state: SimState): SimState {
  while (["to-milk", "to-bread", "to-checkout"].includes(state.customer.phase)) state = step(state, { type: "CUSTOMER_ADVANCE" });
  return state;
}

function completeFixtureVisit(state: SimState): SimState {
  state = walkToCheckout(state);
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = step(state, { type: "SCAN", itemId: item.id });
  state = completeFixturePayment(state);
  return step(state, { type: "CUSTOMER_ADVANCE" });
}

function threeSalesFixture(): SimState {
  let state = step(stockedFixture(), { type: "OPEN_STORE" });
  for (let visitor = 0; visitor < 3; visitor += 1) {
    if (visitor > 0) state = beginNextFixtureCustomer(state);
    state = completeFixtureVisit(state);
  }
  return state;
}

function checkoutFixture(visitor: 1 | 2 = 1): SimState {
  let state = step(stockedFixture(), { type: "OPEN_STORE" });
  if (visitor === 2) state = beginNextFixtureCustomer(completeFixtureVisit(state));
  return walkToCheckout(state);
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

async function launchFixture(page: Page, fixture: SimState): Promise<void> {
  expect(validateSimState(fixture)).toBe(true);
  await page.goto("/");
  await start(page);
  await page.keyboard.press("b");
  await expect(page.locator("#s3-pause")).toBeVisible();
  await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({
    name: "business-time-real-reducer.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
}

async function openDay(page: Page): Promise<void> {
  if (!(await page.locator("#s3-pause").isVisible())) await page.locator("#s3-open-day").click();
  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-panel-day")).toBeVisible();
}

async function scanOrder(page: Page, state: SimState): Promise<void> {
  await expect(page.locator("#s3-target-label")).toContainText("收银台");
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
    await page.keyboard.press("e");
    await expect(page.locator(`#s3-scan-${item.productId}`)).toHaveText("已扫描");
  }
}

test("business time: the saved appointment brings a fourth real customer after three paid orders", async ({ page }, testInfo) => {
  test.setTimeout(110_000);
  const errors = runtimeErrors(page);
  const fixture = threeSalesFixture();
  expect(fixture.transactions).toHaveLength(3);
  expect(fixture.day.phase).toBe("open");
  expect(fixture.day.targetCustomers).toBeNull();
  expect(fixture.day.nextCustomerAtMs! - fixture.day.elapsedOpenMs).toBeGreaterThanOrEqual(8_000);
  expect(fixture.day.nextCustomerAtMs! - fixture.day.elapsedOpenMs).toBeLessThanOrEqual(12_000);
  await launchFixture(page, fixture);
  await expect(page.locator("#s3-sold")).toHaveText("今日 3 单 · 库存 2 件");
  await expect(page.locator("#s3-pause")).toBeHidden();
  expect((await readBrowserSnapshot(page)).day.nextCustomerAtMs).toBe(fixture.day.nextCustomerAtMs);

  // Real monotonic gameplay time, the renderer and its normal customer route perform this arrival.
  await expect(page.locator("#s3-customer-name")).toContainText("第 4 位顾客", { timeout: 25_000 });
  await expect(page.locator("#s3-pause")).toBeHidden();
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 35_000 });
  const fourth = await readBrowserSnapshot(page);
  expect(fourth.customer.number).toBe(4);
  expect(fourth.transactions).toHaveLength(3);
  expect(fourth.day.nextCustomerAtMs).toBeNull();
  await scanOrder(page, fourth);
  const paid = await payScannedCheckout(page);
  expect(getDaySummary(paid).paidCustomers).toBe(4);
  expect(paid.day.phase).toBe("open");
  await expect(page.locator("#s3-sold")).toHaveText("今日 4 单 · 库存 0 件");
  await page.screenshot({ path: testInfo.outputPath("business-time-fourth-customer.png") });
  expect(errors).toEqual([]);
});

test("business time: 19:00 stops new arrivals without interrupting a received cash order or its change", async ({ page }, testInfo) => {
  test.setTimeout(115_000);
  const errors = runtimeErrors(page);
  let fixture = checkoutFixture(2);
  fixture = step(fixture, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: BUSINESS_DURATION_MS - 15_000 - fixture.day.elapsedOpenMs });
  expect(fixture.payment).toEqual({ method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: false, selectedChange: [] });
  await launchFixture(page, fixture);
  await expect(page.locator("#s3-clock-state")).toHaveText("营业中");
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账");
  await scanOrder(page, fixture);
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash-dialog")).toBeVisible();
  await page.locator("#s3-cash-receive").click();
  await page.locator("#s3-cash-add-50").click();
  const partial = await readBrowserSnapshot(page);
  expect(partial.day).toMatchObject({ phase: "open", closeReason: null });
  expect(partial.payment).toEqual({ method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received: true, selectedChange: [50] });
  await expect(page.locator("#s3-cash-confirm")).toBeDisabled();

  // Ordinary cashier work keeps time running; the business clock itself reaches the closing boundary.
  await expect(page.locator("#s3-business-time")).toHaveText("19:00", { timeout: 30_000 });
  await expect(page.locator("#s3-clock-state")).toHaveText("收尾中");
  await expect(page.locator("#s3-cash-dialog")).toBeVisible();
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.50");
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  const closing = await readBrowserSnapshot(page);
  expect(closing.day).toMatchObject({ phase: "closing", closeReason: "time", elapsedOpenMs: BUSINESS_DURATION_MS, nextCustomerAtMs: null });
  expect(closing.customer).toEqual(partial.customer);
  expect(closing.payment).toEqual(partial.payment);
  expect(closing.scannedIds).toEqual(partial.scannedIds);
  expect(closing.transactions).toEqual(fixture.transactions);
  await page.screenshot({ path: testInfo.outputPath("business-time-closing-cash-order.png") });

  const paid = await payScannedCheckout(page);
  expect(paid.cashPence).toBe(fixture.cashPence + getCheckoutTotal(fixture));
  await expect(page.locator("#s3-panel-day")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#s3-settle-day")).toBeEnabled();
  await expect(page.locator("#s3-day-progress")).toContainText("已收款 2 单");
  const finished = await readBrowserSnapshot(page);
  expect(finished.customer.number).toBe(2);
  expect(finished.day.nextCustomerAtMs).toBeNull();
  expect(finished.transactions).toHaveLength(2);
  await page.locator("#s3-settle-day").click();
  await expect(page.locator("#s3-day-title")).toContainText("日结完成");
  expect((await readBrowserSnapshot(page)).transactions).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("business time: management pauses the clock and reload resumes the saved time without offline progress", async ({ page }) => {
  test.setTimeout(100_000);
  const errors = runtimeErrors(page);
  const fixture = step(checkoutFixture(), { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 180_000 });
  await launchFixture(page, fixture);
  await expect(page.locator("#s3-clock-state")).toHaveText("营业中");
  await openDay(page);
  await expect(page.locator("#s3-clock-state")).toHaveText("管理暂停");
  const paused = await readBrowserSnapshot(page);
  const timeLabel = await page.locator("#s3-business-time").innerText();
  // A deliberate wall-time interval proves a visible management screen does not spend business time.
  await page.waitForTimeout(1_600);
  expect((await readBrowserSnapshot(page)).day.elapsedOpenMs).toBe(paused.day.elapsedOpenMs);
  await expect(page.locator("#s3-business-time")).toHaveText(timeLabel);
  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.waitForTimeout(2_500);
  expect((await readBrowserSnapshot(page)).day.elapsedOpenMs).toBe(paused.day.elapsedOpenMs);
  // Observe the real Start handler's save in the same click turn. Browser/GPU
  // action latency after Start is legitimate active time, not offline progress.
  const startSnapshot = page.locator("#s3-start-button").evaluate((button, storageKey) => new Promise<string | null>((resolve) => {
    button.addEventListener("click", () => {
      queueMicrotask(() => resolve(localStorage.getItem(storageKey)));
    }, { once: true });
  }), SIM_STORAGE_KEY);
  const [restoredRaw] = await Promise.all([startSnapshot, start(page)]);
  expect(restoredRaw).not.toBeNull();
  const restored: unknown = JSON.parse(restoredRaw!);
  expect(validateSimState(restored)).toBe(true);
  expect((restored as SimState).day).toEqual(paused.day);
  await openDay(page);
  const resumed = await readBrowserSnapshot(page);
  expect(resumed.day.elapsedOpenMs).toBeGreaterThanOrEqual(paused.day.elapsedOpenMs);
  expect(resumed.payment).toEqual(paused.payment);
  expect(resumed.transactions).toEqual(paused.transactions);
  await expect(page.locator("#s3-clock-state")).toHaveText("管理暂停");
  const resumedLabel = await page.locator("#s3-business-time").innerText();
  await page.locator("#s3-resume").click();
  await expect(page.locator("#s3-clock-state")).toHaveText("营业中");
  await expect(page.locator("#s3-business-time")).not.toHaveText(resumedLabel, { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test("business time: preparation is untimed and cancelling or confirming an early zero-order close is safe", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = runtimeErrors(page);
  await page.goto("/");
  await start(page);
  await expect(page.locator("#s3-business-time")).toHaveText("08:30");
  await expect(page.locator("#s3-clock-state")).toHaveText("准备中");
  await page.waitForTimeout(1_600);
  await expect(page.locator("#s3-business-time")).toHaveText("08:30");
  await openDay(page);
  await expect(page.locator("#s3-settle-day")).toBeDisabled();
  await page.locator("#s3-close-shop").click();
  await expect(page.locator("#s3-close-confirm")).toBeVisible();
  await page.locator("#s3-close-cancel").click();
  await expect(page.locator("#s3-close-confirm")).toBeHidden();
  expect((await readBrowserSnapshot(page)).day.phase).toBe("preparing");
  await page.locator("#s3-close-shop").click();
  await page.locator("#s3-close-confirm-button").click();
  await expect(page.locator("#s3-close-confirm")).toBeHidden();
  await expect(page.locator("#s3-settle-day")).toBeEnabled();
  await expect(page.locator("#s3-settle-day")).toHaveText("完成日结");
  await page.locator("#s3-settle-day").click();
  const settled = await readBrowserSnapshot(page);
  expect(settled.day.phase).toBe("settled");
  expect(settled.transactions).toEqual([]);
  expect(settled.settlements).toHaveLength(1);
  expect(settled.settlements[0]!.paidCustomers).toBe(0);
  expect(settled.cashPence).toBe(1200);
  await page.locator("#s3-tab-street").click();
  await expect(page.locator("#s3-street-level")).toHaveText("Lv. 1");
  await expect(page.locator("#s3-venue-status-cafe")).toHaveText("暂未开放");
  await page.locator("#s3-tab-day").click();
  await page.locator("#s3-next-day").click();
  await expect(page.locator("#s3-panel-supply")).toBeVisible();
  await expect(page.locator("#s3-business-time")).toHaveText("08:30");
  await expect(page.locator("#s3-sold")).toHaveText("今日 0 单 · 库存 0 件");
  expect((await readBrowserSnapshot(page)).day).toMatchObject({ number: 2, phase: "preparing", elapsedOpenMs: 0, nextCustomerAtMs: null });
  await expect(page.locator("#s3-cash")).toHaveText("£12.00");
  expect(errors).toEqual([]);
});

test("business time: inspecting goods and asking for a slower repetition protect learning time", async ({ page }) => {
  test.setTimeout(110_000);
  const errors = runtimeErrors(page);
  let fixture = checkoutFixture();
  const reply = customerSpeechFor(fixture, "checkout");
  const heldMilk = fixture.items.find((item) => item.productId === "milk" && item.location.kind === "shelf")!;
  fixture = step(fixture, { type: "TAKE_ITEM", itemId: heldMilk.id });
  await launchFixture(page, fixture);
  await page.keyboard.press("f");
  await expect(page.locator("#s3-inspection")).toBeVisible();
  await expect(page.locator("#s3-inspect-word")).toHaveText("milk");
  const inspecting = await readBrowserSnapshot(page);
  await page.waitForTimeout(1_600);
  expect((await readBrowserSnapshot(page)).day.elapsedOpenMs).toBe(inspecting.day.elapsedOpenMs);
  await page.locator("#s3-close-inspect").click();
  await expect(page.locator("#s3-inspection")).toBeHidden();
  await expect(page.locator("#s3-clock-state")).toHaveText("营业中");
  await page.locator("#s3-repeat-customer").click();
  await expect(page.locator("#s3-clock-state")).toHaveText("学习暂停");
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", "/assets/sim3d/audio/repeat-request.wav");
  const learningLabel = await page.locator("#s3-business-time").innerText();
  await page.waitForTimeout(700);
  await expect(page.locator("#s3-business-time")).toHaveText(learningLabel);
  // Protect both halves of the exchange, not only the player's short repeat request.
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", reply.src, { timeout: 12_000 });
  await expect.poll(() => page.locator("#s3-word-audio").evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(.84);
  await expect(page.locator("#s3-customer-line")).toContainText(reply.text);
  await expect(page.locator("#s3-customer-zh")).toContainText("这次慢一点说");
  await expect(page.locator("#s3-customer-audio-status")).toContainText("正在播放慢速");
  await expect(page.locator("#s3-clock-state")).toHaveText("学习暂停");
  // Assert the business clock at the real media-playing state. Avoid tying the
  // test to a fixed remaining clip duration when another WebGL test is sharing
  // the machine and Playwright resumes later than its requested wall-clock wait.
  await expect(page.locator("#s3-business-time")).toHaveText(learningLabel);
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });
  await expect(page.locator("#s3-clock-state")).toHaveText("营业中", { timeout: 20_000 });
  await expect(page.locator("#s3-business-time")).not.toHaveText(learningLabel, { timeout: 5_000 });
  const learned = await readBrowserSnapshot(page);
  expect(learned.payment).toEqual(fixture.payment);
  expect(learned.transactions).toEqual(fixture.transactions);
  expect(errors).toEqual([]);
});
