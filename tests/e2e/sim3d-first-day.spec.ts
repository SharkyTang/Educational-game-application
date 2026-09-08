import { openSettings, openComputer, resumeScene, walkTo } from "./helpers/sim3d-computer";
import { receiveFixtureDeliveries } from "./helpers/sim3d-delivery";
import { expect, test, type Page } from "@playwright/test";
import { createFirstDayState, reduceSim, validateSimState, type SimCommand, type SimState } from "../../src/sim3d/domain";
import { customerProfileFor, customerSpeechFor } from "../../src/sim3d/customerSelection";
import { completeFixturePayment, payScannedCheckout, readBrowserSnapshot } from "./helpers/sim3d-payment";
import { beginNextFixtureCustomer } from "./helpers/sim3d-business-time";

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
  let state = command(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "e2e-first-delivery", lines: [{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }] });
  state = receiveFixtureDeliveries(state);
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
    state = guest === 0 ? command(state, { type: "OPEN_STORE" }) : beginNextFixtureCustomer(state);
    for (let stop = 0; stop < 3; stop += 1) state = command(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = command(state, { type: "SCAN", itemId: item.id });
    state = completeFixturePayment(state);
    state = command(state, { type: "CUSTOMER_ADVANCE" });
  }
  return command(state, { type: "CLOSE_STORE" });
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
  await openSettings(page);
  await expect(page.locator("#s3-pause")).toBeVisible();
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
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
  await openComputer(page, "supply");
  await expect(page.locator("#s3-panel-supply")).toBeVisible();
  await expect(page.locator("#s3-purchase")).toBeDisabled();
  await expect(page.locator("#s3-quantity-milk")).toHaveValue("0");
  await expect(page.locator("#s3-quantity-bread")).toHaveValue("0");
  await page.locator("#s3-quantity-milk").fill("6");
  await page.locator("#s3-quantity-bread").fill("6");
  await expect(page.locator("#s3-supply-total")).toHaveText("−£13.80");
  await expect(page.locator("#s3-supply-error")).toContainText("资金不足");
  await expect(page.locator("#s3-purchase")).toBeDisabled();
  await page.locator("#s3-quantity-milk").fill("3");
  await page.locator("#s3-quantity-bread").fill("3");
  await expect(page.locator("#s3-supply-total")).toHaveText("−£6.90");
  await expect(page.locator("#s3-supply-after")).toHaveText("£5.10");
  await page.locator("#s3-purchase").click();
  await expect(page.locator("#s3-pause")).toBeHidden();
  await expect(page.locator("#s3-cash")).toHaveText("£5.10");
  await expect(page.locator("#s3-sold")).toContainText("库存 6 件");
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  // Return to the real computer after purchase without forcing a click through a locked cursor.
  await openComputer(page, "upgrade");
  await expect(page.locator("#s3-panel-upgrade")).toBeVisible();
  await expect(page.locator("#s3-upgrade")).toBeDisabled();
  await expect(page.locator("#s3-upgrade-status")).toContainText("还差 £2.90");
  await resumeScene(page);
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await expect(page.locator("#s3-drag-hint")).toContainText("鼠标可点击");
  await openComputer(page, "upgrade");
  await expect(page.locator("#s3-panel-upgrade")).toBeVisible();
  await expect(page.locator("#s3-cash")).toHaveText("£5.10");
  expect(errors).toEqual([]);
});

test("3D order delivery: paid goods survive reload, require the real van and are received once without a remote procurement shortcut", async ({ page }) => {
  test.setTimeout(100_000);
  const errors = monitorRuntime(page);
  await startFresh(page);
  let pending = command(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "street-delivery", lines: [{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }] });
  pending = command(pending, { type: "SAVE_POSE", pose: { x: 3, z: -6.9, yaw: Math.PI, pitch: .06 } });
  await importFixture(page, pending);
  await expect(page.locator("#s3-cash")).toHaveText("£5.10");
  await expect(page.locator("#s3-target-action")).toContainText("签收本单 6 件", { timeout: 20_000 });
  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-target-action")).toContainText("签收本单 6 件", { timeout: 20_000 });
  await page.keyboard.press("e");
  await expect(page.locator("#s3-delivery-hud")).toContainText("本单已签收");
  await expect(page.locator("#s3-cash")).toHaveText("£5.10");
  await expect(page.locator("#s3-sold")).toContainText("库存 6 件");
  await expect(page.locator("#s3-shelf-stock")).toHaveText("货架 0 种 · 0 件");
  await expect(page.locator("#s3-crate-stock")).toHaveText("箱内 6 件");
  const received = await readBrowserSnapshot(page);
  expect(received.purchases).toHaveLength(1);
  expect(received.purchases[0]).toMatchObject({ id: "street-delivery", receivedDay: 1 });
  expect(received.items).toHaveLength(6);
  expect(received.items.every((item) => item.location.kind === "crate")).toBe(true);
  // E at the signed-for van must neither reopen management nor duplicate goods.
  await page.keyboard.press("e");
  await page.keyboard.press("b");
  await expect(page.locator("#s3-pause")).toBeHidden();
  await expect(page.locator("#s3-panel-supply")).toBeHidden();
  const repeated = await readBrowserSnapshot(page);
  expect(repeated.items).toEqual(received.items);
  expect(repeated.purchases).toEqual(received.purchases);
  expect(repeated.cashPence).toBe(received.cashPence);
  // Return along the south side of both full cartons. The fixed recycling
  // station blocks the shorter route north of the eastern receiving bay.
  await walkTo(page, { x: 0, z: -7.2 });
  await openComputer(page, "supply");
  await expect(page.locator("#s3-panel-supply")).toBeVisible();
  await expect(page.locator("#s3-supply-inventory-milk")).toHaveText("现货 3 · 架上 0");
  await expect(page.locator("#s3-supply-inventory-bread")).toHaveText("现货 3 · 架上 0");
  await expect(page.locator("#s3-quantity-milk")).toHaveValue("0");
  await expect(page.locator("#s3-quantity-bread")).toHaveValue("0");
  await expect(page.locator("#s3-cash")).toHaveText("£5.10");
  await resumeScene(page);
  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-pause")).toBeHidden();
  const restored = await readBrowserSnapshot(page);
  expect(restored.purchases).toEqual(received.purchases);
  expect(restored.items).toEqual(received.items);
  await expect.poll(async () => (await readBrowserSnapshot(page)).delivery.phase, { timeout: 10_000 }).toBe("idle");
  await expect(page.locator("#s3-cash")).toHaveText("£5.10");
  await expect(page.locator("#s3-sold")).toContainText("库存 6 件");
  expect(errors).toEqual([]);
});

test("3D high street: venues show separate level and achievement gates, with honest preparation status after qualification", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = monitorRuntime(page);
  await startFresh(page);
  await openComputer(page, "street");
  await expect(page.locator("#s3-panel-street")).toBeVisible();
  await expect(page.locator("#s3-street-level")).toHaveText("Lv. 1");
  for (const venue of ["cafe", "restaurant", "supermarket"]) {
    await page.locator(`#s3-venue-${venue}`).click();
    await expect(page.locator(`#s3-venue-detail-${venue}`)).toBeVisible();
    await expect(page.locator(`#s3-venue-detail-status-${venue}`)).toHaveText("暂未开放");
  }
  await resumeScene(page);
  await importFixture(page, completedDayFixture());
  await expect(page.locator("#s3-pause")).toBeHidden();
  await openComputer(page, "day");
  await openComputer(page, "street");
  await expect(page.locator("#s3-street-level")).toHaveText("Lv. 2");
  // Enough sales alone do not satisfy the separate first-settlement achievement.
  await expect(page.locator("#s3-venue-status-cafe")).toHaveText("暂未开放");
  await openComputer(page, "day");
  await page.locator("#s3-settle-day").click();
  await openComputer(page, "street");
  await expect(page.locator("#s3-venue-status-cafe")).toHaveText("条件已达成·筹备中");
  await expect(page.locator("#s3-venue-status-restaurant")).toHaveText("暂未开放");
  await expect(page.locator("#s3-venue-status-supermarket")).toHaveText("暂未开放");
  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
  await page.locator("#s3-start-button").click();
  await openComputer(page, "street");
  await expect(page.locator("#s3-venue-status-cafe")).toHaveText("条件已达成·筹备中");
  await expect(page.locator("#s3-street-record")).toContainText("完成日结 1 天");
  expect(errors).toEqual([]);
});

test("3D first day: a real arriving customer speaks locally, supports replay and slower repetition, and can be paid", async ({ page }) => {
  test.setTimeout(100_000);
  const errors = monitorRuntime(page);
  const fixture = approachingCheckoutFixture();
  const clip = customerSpeechFor(fixture, "checkout");
  const thanks = customerSpeechFor(fixture, "thanks");
  await startFresh(page);
  await importFixture(page, fixture);
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 25_000 });
  await expect(page.locator("#s3-customer-name")).toContainText(customerProfileFor(fixture).name);
  await expect(page.locator("#s3-customer-line")).toContainText(clip.text);
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", clip.src);
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
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", clip.src, { timeout: 12_000 });
  await expect.poll(() => page.locator("#s3-word-audio").evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(0.84);
  await expect(page.locator("#s3-customer-zh")).toContainText("这次慢一点说");
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });

  // Interrupt the player's repeat request with R: replay must restore matching
  // customer subtitles, not leave the cancelled request caption on screen.
  await page.locator("#s3-repeat-customer").click();
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", "/assets/sim3d/audio/repeat-request.wav");
  await page.keyboard.press("r");
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", clip.src);
  await expect(page.locator("#s3-customer-line")).toHaveText(`“${clip.text}”`);
  await expect(page.locator("#s3-customer-zh")).toHaveText(clip.zh);
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
  await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", thanks.src);
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash")).toHaveText("£9.10");
  await expect(page.locator("#s3-shelf-stock")).toHaveText("货架 2 种 · 4 件");
  expect(errors).toEqual([]);
});

test("3D customer variety: three real visitors rotate models and voices, keep their line after refresh, and can close for the day", async ({ page }) => {
  test.setTimeout(210_000);
  const errors = monitorRuntime(page);
  let fixture: SimState = { ...stockedFixture(), customerSeed: 31 };
  fixture = command(fixture, { type: "SAVE_POSE", pose: { x: -2.62, z: -1.06, yaw: Math.PI, pitch: .56 } });
  fixture = command(fixture, { type: "OPEN_STORE" });
  await startFresh(page);
  await importFixture(page, fixture);
  const names = new Set<string>();
  const voices = new Set<string>();
  const checkoutLines = new Set<string>();
  const paymentMethods = new Set<string>();

  for (let number = 1; number <= 3; number += 1) {
    const visit = {
      customerSeed: fixture.customerSeed,
      customer: { number, contentVersion: fixture.customer.contentVersion },
    };
    const profile = customerProfileFor(visit);
    const greeting = customerSpeechFor(visit, "greeting");
    const thanks = customerSpeechFor(visit, "thanks");
    names.add(profile.name);
    voices.add(profile.voice);
    await expect(page.locator("#s3-customer-name")).toHaveText(`${profile.name} · 第 ${number} 位顾客`, { timeout: 25_000 });
    await expect(page.locator("#s3-customer-line")).toHaveText(`“${greeting.text}”`);
    // The new visitor first walks along the street; the greeting is not an
    // arrival timer and must wait for the actual doorway crossing.
    await expect(page.locator("#s3-receipt-title")).toHaveText("顾客正从街上走来");
    await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", greeting.src, { timeout: 30_000 });

    // The renderer, not the fixture, walks each visitor through both shelves.
    await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 35_000 });
    const atCheckout = await readBrowserSnapshot(page);
    expect(atCheckout.customer.number).toBe(number);
    expect(atCheckout.payment).not.toBeNull();
    const checkout = customerSpeechFor(atCheckout, "checkout");
    checkoutLines.add(checkout.id);
    paymentMethods.add(atCheckout.payment!.method);
    await expect(page.locator("#s3-customer-line")).toHaveText(`“${checkout.text}”`);
    await expect(page.locator("#s3-customer-zh")).toHaveText(checkout.zh);
    await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", checkout.src);

    if (number === 2) {
      await page.reload();
      await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
      await page.locator("#s3-start-button").click();
      await expect(page.locator("#s3-customer-name")).toHaveText(`${profile.name} · 第 ${number} 位顾客`);
      await expect(page.locator("#s3-customer-line")).toHaveText(`“${checkout.text}”`);
      await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", checkout.src);
      await page.keyboard.press("r");
      await expect(page.locator("#s3-word-audio")).toHaveAttribute("src", checkout.src);
      expect((await readBrowserSnapshot(page)).payment).toEqual(atCheckout.payment);
    }

    await expect(page.locator("#s3-target-label")).toContainText("收银台");
    await page.keyboard.press("e");
    await expect(page.locator("#s3-scan-milk")).toHaveText("已扫描");
    await page.keyboard.press("e");
    await expect(page.locator("#s3-scan-bread")).toHaveText("已扫描");
    // Observe the real media event before paying. The payment helper also checks
    // the saved ledger; by the time it returns, the next visitor may be greeting.
    // Capture the receipt, subtitle and selected voice together while thanks plays.
    const thanksPlayback = page.locator("#s3-word-audio").evaluate((element, expectedSrc) => new Promise((resolve) => {
      const onPlaying = (): void => {
        if (element.getAttribute("src") !== expectedSrc) return;
        element.removeEventListener("playing", onPlaying);
        resolve({
          src: element.getAttribute("src"),
          title: document.querySelector("#s3-receipt-title")?.textContent,
          line: document.querySelector("#s3-customer-line")?.textContent,
          customer: document.querySelector("#s3-customer-name")?.textContent,
        });
      };
      element.addEventListener("playing", onPlaying);
    }), thanks.src);
    await Promise.all([
      payScannedCheckout(page),
      expect(thanksPlayback).resolves.toEqual({
        src: thanks.src,
        title: "本单已收款",
        line: `“${thanks.text}”`,
        customer: `${profile.name} · 第 ${number} 位顾客`,
      }),
    ]);
    await expect(page.locator("#s3-cash")).toHaveText(`£${((510 + number * 400) / 100).toFixed(2)}`);
  }

  expect(names.size).toBe(3);
  expect(voices).toEqual(new Set(["female", "male"]));
  expect(checkoutLines.size).toBe(3);
  expect(paymentMethods).toEqual(new Set(["card", "cash"]));
  // Three sales no longer end a day: explicitly close through the public confirmation.
  await expect(page.locator("#s3-pause")).toBeHidden();
  await openComputer(page, "day");
  await expect(page.locator("#s3-settle-day")).toBeDisabled();
  await page.locator("#s3-close-shop").click();
  await expect(page.locator("#s3-close-confirm")).toBeVisible();
  await page.locator("#s3-close-confirm-button").click();
  if (!(await page.locator("#s3-settle-day").isEnabled())) {
    await resumeScene(page);
    await expect.poll(async () => (await readBrowserSnapshot(page)).customer.phase, { timeout: 30_000 }).toBe("complete");
    await expect(page.locator("#s3-pause")).toBeHidden();
    await openComputer(page, "day");
  }
  await expect(page.locator("#s3-day-progress")).toContainText("已收款 3 单");
  await expect(page.locator("#s3-day-cash")).toHaveText("£17.10");
  await expect(page.locator("#s3-settle-day")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("3D first day: a reducer-completed day settles, expands for £8 and persists the next day without new capital", async ({ page }) => {
  test.setTimeout(75_000);
  const errors = monitorRuntime(page);
  await startFresh(page);
  // Separate from the real arrival/payment check above: this fixture saves time
  // while still deriving all three paid orders from the public domain reducer.
  await importFixture(page, completedDayFixture());
  await expect(page.locator("#s3-pause")).toBeHidden();
  await openComputer(page, "day");
  await expect(page.locator("#s3-panel-day")).toBeVisible();
  await expect(page.locator("#s3-day-progress")).toContainText("已收款 3 单");
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
  await openComputer(page, "day");
  await expect(page.locator("#s3-day-investment")).toHaveText("£8.00");
  await page.locator("#s3-next-day").click();
  await expect(page.locator("#s3-panel-supply")).toBeVisible();
  await expect(page.locator("#s3-supply-cash")).toHaveText("£9.10");
  await openComputer(page, "day");
  await expect(page.locator("#s3-day-title")).toContainText("第 2 天");
  await expect(page.locator("#s3-day-revenue")).toHaveText("£0.00");
  await expect(page.locator("#s3-day-investment")).toHaveText("£0.00");
  await expect(page.locator("#s3-day-inventory")).toHaveText("0 件 / £0.00");

  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
  await expect(page.locator("#s3-start-note")).toContainText("第 2 天");
  await expect(page.locator("#s3-start-capital")).toHaveText("£9.10");
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-sold")).toHaveText("今日 0 单 · 库存 0 件");
  await expect(page.locator("#s3-shelf-stock")).toHaveText("货架 0 种 · 0 件");
  await openComputer(page, "upgrade");
  await expect(page.locator("#s3-upgrade")).toBeDisabled();
  await expect(page.locator("#s3-upgrade")).toContainText("已扩容");
  expect(errors).toEqual([]);
});
