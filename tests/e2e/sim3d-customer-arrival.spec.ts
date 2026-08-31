import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PRODUCTS, createFirstDayState, reduceSim, validateSimState, type SimCommand, type SimState } from "../../src/sim3d/domain";
import { customerProfileFor, customerSpeechFor } from "../../src/sim3d/customerSelection";

// Exercise real render time and normal controls in a disposable browser. The
// only state fixture is before opening; snapshots come from Download save.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 }, screenshot: "only-on-failure" });

const STREET_GUIDE = "顾客正从街上走来 · 留出店门";

function command(state: SimState, action: SimCommand): SimState {
  const result = reduceSim(state, action);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`Invalid arrival fixture action ${action.type}: ${result.message ?? ""}`);
  return result.state;
}

function beforeOpeningFixture(seed: number): SimState {
  let state = command({ ...createFirstDayState(), customerSeed: seed }, {
    type: "PURCHASE_STOCK", orderId: `arrival-stock-${seed}`,
    lines: [{ productId: "milk", quantity: 2 }, { productId: "bread", quantity: 2 }],
  });
  state = command(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    const crate = state.crates.find((entry) => entry.productId === productId)!;
    state = command(state, { type: "PICK_CRATE", crateId: crate.id });
    for (let slot = 0; slot < 2; slot += 1) state = command(state, { type: "STOCK", productId, slot });
    state = command(state, { type: "DROP_HELD", position: crate.position });
  }
  // Outdoors facing the physical sign, within its 2.6 m interaction range.
  // Stay south of the street path and out of the doorway; no NPC is blocked.
  return command(state, { type: "SAVE_POSE", pose: { x: .62, z: -6.85, yaw: 0, pitch: -.033 } });
}

function monitorRuntime(page: Page): string[] {
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

async function pause(page: Page): Promise<void> {
  if (!(await page.locator("#s3-pause").isVisible())) await page.keyboard.press("KeyB");
  await expect(page.locator("#s3-pause")).toBeVisible();
}

async function resume(page: Page): Promise<void> {
  await page.locator("#s3-resume").click();
  await expect(page.locator("#s3-pause")).toBeHidden();
}

async function importFixture(page: Page, fixture: SimState): Promise<void> {
  await pause(page);
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({
    name: "customer-arrival-before-opening.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
}

/** The user-visible export is our only browser-state sampling interface. Leaves the game paused. */
async function exportSnapshot(page: Page): Promise<SimState> {
  await pause(page);
  if (!(await page.locator("#s3-export").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#s3-export").click();
  const filename = await (await downloadEvent).path();
  if (!filename) throw new Error("The arrival save did not finish downloading");
  const snapshot: unknown = JSON.parse(await readFile(filename, "utf8"));
  if (!validateSimState(snapshot)) throw new Error("Customer arrival produced an invalid exported save");
  return snapshot;
}

async function streetDistance(page: Page): Promise<number> {
  const guide = await page.locator("#s3-guide").innerText();
  // Leaving the street must not accidentally count as approaching the player.
  if (!guide.includes(STREET_GUIDE)) return Number.POSITIVE_INFINITY;
  const match = guide.match(/·\s*(\d+(?:\.\d+)?)\s*m\s*$/);
  if (!match) throw new Error(`Missing public street distance: ${guide}`);
  return Number(match[1]);
}

function expectSameVisit(actual: SimState, expected: SimState): void {
  expect(actual.customerSeed).toBe(expected.customerSeed);
  expect(actual.customer.number).toBe(expected.customer.number);
  expect(actual.customer.shoppingList).toEqual(expected.customer.shoppingList);
  expect(customerProfileFor(actual)).toEqual(customerProfileFor(expected));
  expect(actual.payment).toEqual(expected.payment);
  expect(actual.cashPence).toBe(expected.cashPence);
  expect(actual.transactions).toEqual(expected.transactions);
  expect(actual.items.map((item) => item.id).sort()).toEqual(expected.items.map((item) => item.id).sort());
}

for (const arrival of [
  { side: "left", seed: 0, direction: "← 向左", look: "KeyJ", lookBack: "KeyL" },
  { side: "right", seed: 1, direction: "向右 →", look: "KeyL", lookBack: "KeyJ" },
] as const) {
  test(`3D customer arrival: walks from the ${arrival.side} street, enters before greeting, and keeps the visit through pause and reload`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors = monitorRuntime(page);
    const fixture = beforeOpeningFixture(arrival.seed);
    expect(fixture.customer.phase).toBe("outside");
    expect(fixture.customer.shoppingList).toEqual([]);
    expect(fixture.day.phase).toBe("preparing");
    expect(fixture.day.elapsedOpenMs).toBe(0);
    expect(fixture.payment).toBeNull();
    const profile = customerProfileFor(fixture);
    const greeting = customerSpeechFor(fixture, "greeting");

    await page.goto("/");
    await start(page);
    await importFixture(page, fixture);
    await pause(page);
    await page.getByText("画面与操作", { exact: true }).click();
    await page.locator("#s3-quality").selectOption("low");
    await resume(page);
    await expect(page.locator("#s3-target-label")).toContainText("营业牌");
    await expect(page.locator("#s3-target-action")).toContainText("开门营业");
    await page.keyboard.press("KeyE");

    const guide = page.locator("#s3-guide");
    const title = page.locator("#s3-receipt-title");
    const audio = page.locator("#s3-word-audio");
    await expect(guide).toContainText(STREET_GUIDE);
    await expect(guide).toContainText(arrival.direction);
    await expect(title).toHaveText("顾客正从街上走来");
    const initialDistance = await streetDistance(page);
    expect(initialDistance).toBeGreaterThan(12);
    expect(initialDistance).toBeLessThan(22);
    await expect(audio).not.toHaveAttribute("src", greeting.src);
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);

    // Turn with the player's ordinary look keys to capture the far-street actor.
    await page.keyboard.press(arrival.look, { delay: 850 });
    await page.screenshot({ path: testInfo.outputPath(`customer-${arrival.side}-on-street.png`) });
    await expect.poll(() => streetDistance(page), { timeout: 8_000, intervals: [200, 400] }).toBeLessThan(initialDistance - 2);
    const nearerDistance = await streetDistance(page);
    const onStreet = await exportSnapshot(page);
    expect(onStreet.customer.phase).toBe("to-milk");
    expect(onStreet.payment).not.toBeNull();
    expect(onStreet.items.every((item) => item.location.kind === "shelf")).toBe(true);
    expect(onStreet.customer.shoppingList).toHaveLength(2);
    expect(customerProfileFor(onStreet)).toEqual(profile);
    const customerName = `${profile.name} · 第 ${onStreet.customer.number} 位顾客`;
    const orderText = `购物清单：${onStreet.customer.shoppingList.map((id) => PRODUCTS[id].nameZh).join("、")}`;
    await expect(page.locator("#s3-customer-name")).toHaveText(customerName);
    await expect(page.locator("#s3-customer-order")).toHaveText(orderText);
    await expect(audio).not.toHaveAttribute("src", greeting.src);
    const frozenGuide = await guide.textContent();
    // A deliberate real-time pause, not a clock mock or an arrival shortcut.
    await page.waitForTimeout(650);
    const stillPaused = await exportSnapshot(page);
    expect(stillPaused.customer).toEqual(onStreet.customer);
    expect(stillPaused.items).toEqual(onStreet.items);
    expect(stillPaused.day.elapsedOpenMs).toBe(onStreet.day.elapsedOpenMs);
    expectSameVisit(stillPaused, onStreet);
    expect(await guide.textContent()).toBe(frozenGuide);

    await resume(page);
    const resumedDistance = await streetDistance(page);
    await expect.poll(() => streetDistance(page), { timeout: 5_000, intervals: [200, 400] }).toBeLessThan(resumedDistance - .5);
    await expect(title).toHaveText("顾客正从街上走来");
    await page.reload();
    await start(page);
    await expect(title).toHaveText("顾客正从街上走来");
    await expect(guide).toContainText(STREET_GUIDE);
    await expect(page.locator("#s3-customer-name")).toHaveText(customerName);
    await expect(page.locator("#s3-customer-order")).toHaveText(orderText);
    await expect(audio).not.toHaveAttribute("src", greeting.src);
    const restored = await exportSnapshot(page);
    expectSameVisit(restored, onStreet);
    expect(restored.customer.phase).toBe("to-milk");
    expect(restored.items.every((item) => item.location.kind === "shelf")).toBe(true);
    // The save preserves visit identity, not an exact animation-frame position.
    await resume(page);
    await page.keyboard.press(arrival.lookBack, { delay: 850 });

    // Wait for the real walk across the entrance before the automatic greeting.
    await expect(title).toHaveText("顾客进店了", { timeout: 45_000 });
    await expect(guide).toContainText("顾客正在购物 · 留出通道");
    await expect(audio).toHaveAttribute("src", greeting.src);
    await expect(page.locator("#s3-customer-name")).toHaveText(customerName);
    await page.screenshot({ path: testInfo.outputPath(`customer-${arrival.side}-entered.png`) });
    await expect(title).toHaveText("顾客想结账", { timeout: 45_000 });
    await expect(page.locator("#s3-customer-name")).toHaveText(customerName);
    await expect(page.locator("#s3-customer-order")).toHaveText(orderText);
    for (const id of onStreet.customer.shoppingList) await expect(page.locator(`#s3-receipt-line-${id}`)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`customer-${arrival.side}-checkout.png`) });
    const checkout = await exportSnapshot(page);
    expectSameVisit(checkout, onStreet);
    expect(checkout.customer.phase).toBe("checkout");
    expect(checkout.items.filter((item) => item.location.kind === "checkout").map((item) => item.productId).sort())
      .toEqual([...onStreet.customer.shoppingList].sort());
    expect(checkout.scannedIds).toEqual([]);
    expect(checkout.day.elapsedOpenMs).toBeGreaterThan(restored.day.elapsedOpenMs);
    await testInfo.attach("customer-arrival-observations", {
      body: Buffer.from(JSON.stringify({ arrival, profile, initialDistance, nearerDistance, resumedDistance, onStreet, stillPaused, restored, checkout }, null, 2)),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  });
}
