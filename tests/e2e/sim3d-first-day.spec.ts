import { expect, test, type Page } from "@playwright/test";
import { createFirstDayState, reduceSim, validateSimState, type SimCommand, type SimState } from "../../src/sim3d/domain";

// Keep these real 3D browser checks sequential even when the wider suite is parallel.
// Every test gets Playwright's disposable context; no existing user browser is used.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

function command(state: SimState, action: SimCommand): SimState {
  const result = reduceSim(state, action);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`Invalid real fixture action ${action.type}: ${result.message ?? ""}`);
  return result.state;
}

function stockedFixture(): SimState {
  let state = command(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "e2e-first-delivery", pairs: 3 });
  for (const productId of ["milk", "bread"] as const) {
    state = command(state, { type: "PICK_CRATE", crateId: `${productId}-crate` });
    for (let slot = 0; slot < 3; slot += 1) state = command(state, { type: "STOCK", productId, slot });
    state = command(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.productId === productId)!.position });
  }
  return state;
}

function approachingCheckoutFixture(): SimState {
  let state = command(stockedFixture(), { type: "OPEN_STORE" });
  state = command(state, { type: "CUSTOMER_ADVANCE" });
  state = command(state, { type: "CUSTOMER_ADVANCE" });
  // Counter body is centred at (-2.2, -2.2), top y≈1.0; the player's eye is 1.65 m.
  // Stand safely north of it and look down its clear left edge, away from sale goods.
  return command(state, { type: "SAVE_POSE", pose: { x: -2.62, z: -1.06, yaw: Math.PI, pitch: 0.56 } });
}

function completedDayFixture(): SimState {
  let state = stockedFixture();
  for (let guest = 0; guest < 3; guest += 1) {
    state = command(state, { type: guest === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" });
    for (let stop = 0; stop < 3; stop += 1) state = command(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = command(state, { type: "SCAN", itemId: item.id });
    state = command(state, { type: "PAY", success: true });
    state = command(state, { type: "CUSTOMER_ADVANCE" });
  }
  return state;
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
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
  await expect(page.locator("#s3-start-capital")).toHaveText("£12.00");
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function importFixture(page: Page, fixture: SimState): Promise<void> {
  expect(validateSimState(fixture)).toBe(true);
  await page.keyboard.press("b");
  await expect(page.locator("#s3-pause")).toBeVisible();
  await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({ name: "real-reducer-fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await expect(page.locator("#s3-import-summary")).toContainText("完整首日存档");
  await page.locator("#s3-import-confirm-button").click();
  await expect(page.locator("#s3-start")).toBeVisible();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

test("3D first day: procurement quotes, insufficient funds and upgrades are reachable without trapping the mouse", async ({ page }) => {
  test.setTimeout(75_000);
  const errors = monitorRuntime(page);
  await startFresh(page);
  await page.keyboard.press("b");
  await expect(page.locator("#s3-panel-supply")).toBeVisible();
  await page.locator("#s3-buy-six").click();
  await expect(page.locator("#s3-supply-total")).toHaveText("−£13.80");
  await expect(page.locator("#s3-supply-error")).toContainText("资金不足");
  await expect(page.locator("#s3-purchase")).toBeDisabled();
  await page.locator("#s3-buy-three").click();
  await expect(page.locator("#s3-supply-total")).toHaveText("−£6.90");
  await expect(page.locator("#s3-supply-after")).toHaveText("£5.10");
  await page.locator("#s3-purchase").click();
  await expect(page.locator("#s3-pause")).toBeHidden();
  await expect(page.locator("#s3-cash")).toHaveText("£5.10");
  await expect(page.locator("#s3-sold")).toContainText("库存 6 件");
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  // This is a normal DOM click after purchase, not a forced click through a locked cursor.
  await page.locator("#s3-open-upgrade").click();
  await expect(page.locator("#s3-panel-upgrade")).toBeVisible();
  await expect(page.locator("#s3-upgrade")).toBeDisabled();
  await expect(page.locator("#s3-upgrade-status")).toContainText("还差 £2.90");
  await page.locator("#s3-resume").click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await expect(page.locator("#s3-drag-hint")).toContainText("鼠标可点击");
  await page.keyboard.press("u");
  await expect(page.locator("#s3-panel-upgrade")).toBeVisible();
  await expect(page.locator("#s3-cash")).toHaveText("£5.10");
  expect(errors).toEqual([]);
});

test("3D first day: a real arriving customer speaks locally, supports replay and slower repetition, and can be paid", async ({ page }) => {
  test.setTimeout(100_000);
  const errors = monitorRuntime(page);
  await startFresh(page);
  await importFixture(page, approachingCheckoutFixture());
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 25_000 });
  await expect(page.locator("#s3-customer-line")).toContainText("Can I pay by card, please?");
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", "/assets/sim3d/audio/card.wav");
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });

  await page.keyboard.press("r");
  await expect(page.locator("#s3-customer-audio-status")).toContainText("正在播放", { timeout: 5_000 });
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });
  await page.locator("#s3-read-customer").click();
  await expect(page.locator("#s3-customer-audio-status")).toContainText("正在播放", { timeout: 5_000 });
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });

  await page.locator("#s3-repeat-customer").click();
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", "/assets/sim3d/audio/repeat-request.wav");
  await expect(page.locator("#s3-customer-line")).toContainText("Could you say that again, please?");
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", "/assets/sim3d/audio/card.wav", { timeout: 12_000 });
  await expect.poll(() => page.locator("#s3-word-audio").evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(0.84);
  await expect(page.locator("#s3-customer-zh")).toContainText("这次慢一点说");
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });

  // Interrupt the player's repeat request with R: replay must restore matching
  // customer subtitles, not leave the cancelled request caption on screen.
  await page.locator("#s3-repeat-customer").click();
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", "/assets/sim3d/audio/repeat-request.wav");
  await page.keyboard.press("r");
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", "/assets/sim3d/audio/card.wav");
  await expect(page.locator("#s3-customer-line")).toHaveText("“Can I pay by card, please?”");
  await expect(page.locator("#s3-customer-zh")).toHaveText("请问可以刷卡吗？");
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });

  await expect(page.locator("#s3-target-label")).toContainText("收银台");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-scan-milk")).toHaveText("已扫描");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-scan-bread")).toHaveText("已扫描");
  await expect(page.locator("#s3-target-action")).toContainText("刷卡收款");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash")).toHaveText("£9.10");
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已收款");
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", "/assets/sim3d/audio/thanks.wav");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash")).toHaveText("£9.10");
  await expect(page.locator("#s3-milk-stock")).toHaveText("牛奶 2 / 4");
  await expect(page.locator("#s3-bread-stock")).toHaveText("面包 2 / 4");
  expect(errors).toEqual([]);
});

test("3D first day: a reducer-completed day settles, expands for £8 and persists the next day without new capital", async ({ page }) => {
  test.setTimeout(75_000);
  const errors = monitorRuntime(page);
  await startFresh(page);
  // Separate from the real arrival/payment check above: this fixture saves time
  // while still deriving all three paid orders from the public domain reducer.
  await importFixture(page, completedDayFixture());
  await expect(page.locator("#s3-pause")).toBeVisible({ timeout: 12_000 });
  await expect(page.locator("#s3-panel-day")).toBeVisible();
  await expect(page.locator("#s3-day-progress")).toContainText("已收款 3 / 3 单");
  await expect(page.locator("#s3-day-revenue")).toHaveText("£12.00");
  await expect(page.locator("#s3-day-procurement")).toHaveText("£6.90");
  await expect(page.locator("#s3-day-cogs")).toHaveText("£6.90");
  await expect(page.locator("#s3-day-profit")).toHaveText("£5.10");
  await expect(page.locator("#s3-day-cash")).toHaveText("£17.10");
  await page.locator("#s3-settle-day").click();
  await expect(page.locator("#s3-day-title")).toContainText("日结完成");
  await expect(page.locator("#s3-day-cash")).toHaveText("£17.10");
  await page.locator("#s3-day-to-upgrade").click();
  await expect(page.locator("#s3-upgrade")).toBeEnabled();
  await page.locator("#s3-upgrade").click();
  await expect(page.locator("#s3-upgrade")).toBeDisabled();
  await expect(page.locator("#s3-capacity-now")).toHaveText("8");
  await expect(page.locator("#s3-cash")).toHaveText("£9.10");
  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-day-investment")).toHaveText("£8.00");
  await page.locator("#s3-next-day").click();
  await expect(page.locator("#s3-panel-supply")).toBeVisible();
  await expect(page.locator("#s3-supply-cash")).toHaveText("£9.10");
  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-day-title")).toContainText("第 2 天");
  await expect(page.locator("#s3-day-revenue")).toHaveText("£0.00");
  await expect(page.locator("#s3-day-investment")).toHaveText("£0.00");
  await expect(page.locator("#s3-day-inventory")).toHaveText("0 件 / £0.00");

  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
  await expect(page.locator("#s3-start-note")).toContainText("第 2 天");
  await expect(page.locator("#s3-start-capital")).toHaveText("£9.10");
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-sold")).toHaveText("今日 0 / 3 单 · 库存 0 件");
  await expect(page.locator("#s3-milk-stock")).toHaveText("牛奶 0 / 8");
  await expect(page.locator("#s3-bread-stock")).toHaveText("面包 0 / 8");
  await page.keyboard.press("u");
  await expect(page.locator("#s3-upgrade")).toBeDisabled();
  await expect(page.locator("#s3-upgrade")).toContainText("已扩容");
  expect(errors).toEqual([]);
});
