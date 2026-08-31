import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  INITIAL_CAPITAL_PENCE, createFirstDayState, getCheckoutTotal, getDaySummary, reduceSim, validateSimState,
  type PlayerPose, type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { cashChangeDuePence } from "../../src/sim3d/cashPayment";
import { createDefaultShopLayout, transformLayoutPoint, type FurnitureId } from "../../src/sim3d/shopLayout";
import { SHOP_EXPANSION_COST_PENCE } from "../../src/sim3d/shopDevelopment";
import { completeFixturePayment, payScannedCheckout, readBrowserSnapshot } from "./helpers/sim3d-payment";

// Real disposable 3D browser contexts; setup uses audited reducer saves imported through the public UI.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 900 } });

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
const openSignPose: PlayerPose = { x: .62, z: -3.15, yaw: Math.PI, pitch: -.06 };
const originalCounterPose: PlayerPose = { x: -2.62, z: -1.06, yaw: Math.PI, pitch: .56 };

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${command.type}: ${result.message ?? "invalid renovation fixture"}`);
  return result.state;
}

/** Earn real capital; never manufacture a balance which the transaction audit would reject. */
function earnedCapitalFixture(customerSeed?: number): SimState {
  const initial = createFirstDayState();
  if (customerSeed !== undefined) initial.customerSeed = customerSeed;
  let state = step(initial, {
    type: "PURCHASE_STOCK", orderId: "renovation-opening-stock",
    lines: [{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }],
  });
  state = step(state, { type: "RECEIVE_DELIVERY" });
  for (const productId of ["milk", "bread"] as const) {
    const crate = state.crates.find((entry) => entry.productId === productId)!;
    state = step(state, { type: "PICK_CRATE", crateId: crate.id });
    for (let slot = 0; slot < 3; slot += 1) state = step(state, { type: "STOCK", productId, slot });
    state = step(state, { type: "DROP_HELD", position: crate.position });
  }
  for (let visitor = 0; visitor < 3; visitor += 1) {
    state = step(state, { type: visitor === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" });
    while (["to-milk", "to-bread", "to-checkout"].includes(state.customer.phase)) state = step(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = step(state, { type: "SCAN", itemId: item.id });
    state = completeFixturePayment(state);
    state = step(state, { type: "CUSTOMER_ADVANCE" });
  }
  state = step(state, { type: "CLOSE_STORE" });
  state = step(state, { type: "SETTLE_DAY" });
  return step(state, { type: "SAVE_POSE", pose: { x: -1.7, z: 3.15, yaw: 0, pitch: .08 } });
}

/** One unsold carton is stocked on day two so moving the fridge must preserve real merchandise. */
function expandedStockedFixture(customerSeed?: number): SimState {
  let state = step(earnedCapitalFixture(customerSeed), { type: "START_NEXT_DAY" });
  state = step(state, { type: "BUY_SPACE_EXPANSION" });
  state = step(state, { type: "PURCHASE_STOCK", orderId: "renovation-second-day-milk", lines: [{ productId: "milk", quantity: 1 }] });
  state = step(state, { type: "RECEIVE_DELIVERY" });
  const crate = state.crates.find((entry) => entry.productId === "milk")!;
  state = step(state, { type: "PICK_CRATE", crateId: crate.id });
  state = step(state, { type: "STOCK", productId: "milk", slot: 0 });
  state = step(state, { type: "DROP_HELD", position: crate.position });
  // This remains empty floor until the player moves the fridge using the editor below.
  return step(state, { type: "SAVE_POSE", pose: { x: -3.1, z: 6, yaw: Math.PI / 2, pitch: .44 } });
}

function relocatedCounterCashFixture(): SimState {
  // Seed 6 gives the fourth visitor a real cash payment requiring change, without editing money or tender.
  let state = expandedStockedFixture(6);
  const layout = structuredClone(state.renovation.layout);
  const counter = layout.placements.find((placement) => placement.id === "checkout-counter")!;
  Object.assign(counter, { x: -1.7, z: 5.7, rotation: 1 });
  state = step(state, { type: "APPLY_SHOP_LAYOUT", layout });
  state = step(state, { type: "OPEN_STORE" });
  while (["to-milk", "to-bread"].includes(state.customer.phase)) state = step(state, { type: "CUSTOMER_ADVANCE" });
  // Stop before arrival: only the real 3D customer route may advance this visit to checkout.
  expect(state.customer.phase).toBe("to-checkout");
  expect(state.payment?.method).toBe("cash");
  const pose = transformLayoutPoint(layout, "checkout-counter", originalCounterPose);
  return step(state, { type: "SAVE_POSE", pose: { ...pose, yaw: originalCounterPose.yaw + Math.PI / 2 } });
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

async function importFixture(page: Page, state: SimState): Promise<void> {
  expect(validateSimState(state)).toBe(true);
  await openManagement(page);
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({ name: "renovation-audited-save.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(state)) });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
}

async function exportSnapshot(page: Page): Promise<SimState> {
  await openManagement(page);
  if (!(await page.locator("#s3-export").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.locator("#s3-export").click();
  const download = await downloading;
  const path = await download.path();
  expect(path).not.toBeNull();
  const state: unknown = JSON.parse(await readFile(path!, "utf8"));
  expect(validateSimState(state)).toBe(true);
  return state as SimState;
}

async function openLayout(page: Page): Promise<void> {
  if (await page.locator("#s3-pause").isVisible()) await page.locator("#s3-tab-layout").click();
  else await page.keyboard.press("p");
  await expect(page.locator("#s3-layout-map")).toBeVisible();
}

/** Uses SVG's public screen geometry, then a genuine pointer drag; no game state is injected. */
async function dragFurniture(page: Page, id: FurnitureId, destination: { x: number; z: number }): Promise<void> {
  await page.locator("#s3-layout-select").selectOption(id);
  await page.locator("#s3-layout-map").scrollIntoViewIfNeeded();
  const body = page.locator(`[data-layout-fixture="${id}"] .s3-layout-fixture-body`);
  await expect(body).toBeVisible();
  const bounds = await body.boundingBox();
  expect(bounds).not.toBeNull();
  const target = await page.locator("#s3-layout-map").evaluate((element: SVGSVGElement, point) => {
    const position = element.createSVGPoint();
    position.x = point.x; position.y = -point.z;
    const screen = position.matrixTransform(element.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  }, destination);
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator("#s3-layout-x")).toHaveText(`${destination.x.toFixed(3)} m`);
  await expect(page.locator("#s3-layout-z")).toHaveText(`${destination.z.toFixed(3)} m`);
}

test("shop renovation: initial funds, invalid drafts and keep/discard navigation use only real controls", async ({ page }, testInfo) => {
  test.setTimeout(100_000);
  const errors = runtimeErrors(page);
  await page.goto("/");
  await start(page);
  await page.locator("#s3-open-layout").click();
  await expect(page.locator("#s3-layout-map")).toBeVisible();
  await expect(page.locator("#s3-layout-select option")).toHaveCount(11);
  await expect(page.locator("#s3-layout-room")).toContainText("尚未解锁");
  await page.locator("#s3-tab-development").click();
  await expect(page.locator("#s3-buy-space")).toBeDisabled();
  await expect(page.locator("#s3-cash")).toHaveText(money(INITIAL_CAPITAL_PENCE));
  await openLayout(page);
  const baseline = await readBrowserSnapshot(page);

  await page.locator("#s3-layout-select").selectOption("pantry-grains");
  await page.locator('[data-layout-fixture="pantry-grains"]').focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#s3-layout-validation")).toContainText("暂不可应用");
  await expect(page.locator('[data-layout-fixture="pantry-grains"]')).toHaveAttribute("data-valid", "false");
  await expect(page.locator("#s3-layout-apply")).toBeDisabled();
  expect((await readBrowserSnapshot(page)).renovation).toEqual(baseline.renovation);
  await page.locator("#s3-layout-discard").click();
  await expect(page.locator("#s3-layout-x")).toHaveText("-3.025 m");

  await page.locator("#s3-layout-select").selectOption("milk-fridge");
  await page.getByRole("button", { name: "将选中的家具向门口移动0.1米", exact: true }).click();
  await expect(page.locator("#s3-layout-z")).toHaveText("3.965 m");
  await expect(page.locator("#s3-layout-apply")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#s3-layout-exit-confirm")).toBeVisible();
  await page.locator("#s3-layout-exit-keep").click();
  await expect(page.locator("#s3-layout-exit-confirm")).toBeHidden();
  await expect(page.locator("#s3-layout-z")).toHaveText("3.965 m");
  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-layout-exit-confirm")).toBeVisible();
  await page.locator("#s3-layout-exit-discard").click();
  await expect(page.locator("#s3-panel-day")).toBeVisible();
  await openLayout(page);
  await expect(page.locator("#s3-layout-z")).toHaveText("4.065 m");
  await expect(page.locator("#s3-layout-apply")).toBeDisabled();
  const cancelled = await exportSnapshot(page);
  expect(cancelled.renovation).toEqual(baseline.renovation);
  expect(cancelled.cashPence).toBe(baseline.cashPence);
  expect(cancelled.items).toEqual(baseline.items);
  await page.screenshot({ path: testInfo.outputPath("renovation-draft-cancelled.png") });
  expect(errors).toEqual([]);
});

test("shop renovation: one paid expansion updates the settled ledger, opens real floor and survives reload", async ({ page }, testInfo) => {
  test.setTimeout(130_000);
  const errors = runtimeErrors(page);
  const fixture = earnedCapitalFixture();
  expect(fixture.cashPence).toBe(1710);
  expect(fixture.day.phase).toBe("settled");
  await page.goto("/");
  await start(page);
  await importFixture(page, fixture);
  await openManagement(page);
  await page.locator("#s3-tab-development").click();
  await expect(page.locator("#s3-buy-space")).toBeEnabled();
  await page.locator("#s3-buy-space").click();
  await expect(page.locator("#s3-confirm-space")).toBeVisible();
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  await page.locator("#s3-cancel-space").click();
  expect((await readBrowserSnapshot(page)).renovation.layout.expansion).toBe(0);
  await page.locator("#s3-buy-space").click();
  await page.locator("#s3-confirm-space").click();
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence - SHOP_EXPANSION_COST_PENCE));
  await expect(page.locator("#s3-buy-space")).toBeDisabled();
  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-day-expansion")).toHaveText("£15.00");
  await expect(page.locator("#s3-day-investment")).toHaveText("£0.00");
  await expect(page.locator("#s3-day-profit")).toHaveText(money(getDaySummary(fixture).grossProfitPence));
  const expanded = await exportSnapshot(page);
  expect(expanded.renovation.layout.expansion).toBe(1);
  expect(expanded.renovation.expansionDay).toBe(fixture.day.number);
  expect(expanded.renovation.layout.placements).toEqual(fixture.renovation.layout.placements);
  expect(expanded.renovation.layoutRevision).toBe(0);
  expect(expanded.items).toEqual(fixture.items);
  expect(expanded.upgraded).toBe(false);
  expect(expanded.settlements.at(-1)).toMatchObject({
    expansionSpendPence: SHOP_EXPANSION_COST_PENCE,
    closingCashPence: fixture.cashPence - SHOP_EXPANSION_COST_PENCE,
    grossProfitPence: getDaySummary(fixture).grossProfitPence,
  });
  await openLayout(page);
  await expect(page.locator("#s3-layout-room")).toContainText("扩建已完成");
  await page.locator("#s3-resume").click();
  // Walk through the former rear wall: this verifies actual collision/floor expansion, not a badge alone.
  await page.keyboard.down("w");
  await page.waitForTimeout(1600);
  await page.keyboard.up("w");
  const walked = await exportSnapshot(page);
  expect(walked.playerPose.z).toBeGreaterThan(4.7);
  await page.locator("#s3-resume").click();
  await page.screenshot({ path: testInfo.outputPath("renovation-expanded-floor.png") });
  await page.reload();
  await start(page);
  await openLayout(page);
  await expect(page.locator("#s3-layout-room")).toContainText("扩建已完成");
  await page.locator("#s3-tab-development").click();
  await expect(page.locator("#s3-buy-space")).toBeDisabled();
  const restored = await exportSnapshot(page);
  expect(restored.renovation).toEqual(expanded.renovation);
  expect(restored.cashPence).toBe(expanded.cashPence);
  expect(restored.playerPose.z).toBeGreaterThan(4.7);
  expect(getDaySummary(restored).expansionSpendPence).toBe(SHOP_EXPANSION_COST_PENCE);
  expect(errors).toEqual([]);
});

test("shop renovation: shelves, fridge and checkout rotate freely; applied merchandise layout persists and locks during trading", async ({ page }, testInfo) => {
  test.setTimeout(330_000);
  const errors = runtimeErrors(page);
  const fixture = expandedStockedFixture();
  const originalRenovation = structuredClone(fixture.renovation);
  const expandedDefaults = { ...createDefaultShopLayout(), expansion: 1 as const };
  await page.goto("/");
  await start(page);
  // The interaction assertions do not depend on resolution. Use the public low-GPU setting
  // because this check performs many drags while other full 3D suites may be running.
  await openManagement(page);
  await page.getByText("画面与操作", { exact: true }).click();
  await page.locator("#s3-quality").selectOption("low");
  await importFixture(page, fixture);
  await openLayout(page);

  for (const id of ["pantry-grains", "milk-fridge", "checkout-counter"] as const) {
    await dragFurniture(page, id, { x: -1.7, z: 5.7 });
    await expect(page.locator("#s3-layout-apply")).toBeEnabled();
    for (let quarterTurn = 1; quarterTurn <= 4; quarterTurn += 1) {
      await page.locator("#s3-layout-rotate").click();
      await expect(page.locator("#s3-layout-rotation")).toHaveText(`${quarterTurn % 4 * 90}°`);
      await expect(page.locator("#s3-layout-apply")).toBeEnabled();
    }
    if (id === "checkout-counter") await expect(page.locator("#s3-layout-facing")).toContainText("顾客侧");
    expect((await readBrowserSnapshot(page)).renovation).toEqual(originalRenovation);
    await page.locator("#s3-layout-default").click();
    await expect(page.locator("#s3-layout-apply")).toBeDisabled();
  }

  await dragFurniture(page, "milk-fridge", { x: -1.7, z: 5.7 });
  await page.locator("#s3-layout-rotate").click();
  await expect(page.locator("#s3-layout-facing")).toContainText("朝左");
  await page.locator("#s3-layout-apply").click();
  await expect(page.locator("#s3-layout-dirty")).toHaveText("已保存");
  await expect(page.locator("#s3-layout-apply")).toBeDisabled();
  const applied = await exportSnapshot(page);
  expect(applied.renovation.layoutRevision).toBe(1);
  expect(applied.renovation.layout.placements.find((placement) => placement.id === "milk-fridge")).toEqual({ id: "milk-fridge", x: -1.7, z: 5.7, rotation: 1 });
  expect(applied.items).toEqual(fixture.items);
  expect(applied.cashPence).toBe(fixture.cashPence);
  expect(applied.transactions).toEqual(fixture.transactions);
  expect(applied.renovation.layout.placements.filter((placement) => placement.id !== "milk-fridge"))
    .toEqual(expandedDefaults.placements.filter((placement) => placement.id !== "milk-fridge"));
  await page.locator("#s3-resume").click();
  // The saved camera looks at the new location of the real stocked milk, not the former fridge position.
  await expect(page.locator("#s3-target-label")).toContainText(/Milk|牛奶/, { timeout: 15_000 });
  await page.keyboard.press("f");
  await expect(page.locator("#s3-inspection")).toBeVisible();
  await expect(page.locator("#s3-inspect-chinese")).toContainText("牛奶");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("renovation-milk-moved-in-world.png") });
  await page.reload();
  await start(page);
  await openLayout(page);
  await page.locator("#s3-layout-select").selectOption("milk-fridge");
  await expect(page.locator("#s3-layout-x")).toHaveText("-1.700 m");
  await expect(page.locator("#s3-layout-z")).toHaveText("5.700 m");
  await expect(page.locator("#s3-layout-rotation")).toHaveText("90°");
  await page.locator("#s3-layout-default").click();
  await expect(page.locator("#s3-layout-z")).toHaveText("4.065 m");
  expect((await readBrowserSnapshot(page)).renovation).toEqual(applied.renovation);
  await page.locator("#s3-layout-discard").click();
  await expect(page.locator("#s3-layout-z")).toHaveText("5.700 m");
  await page.screenshot({ path: testInfo.outputPath("renovation-restored-layout.png") });

  // Reimport the same audited save at the real door sign, then open using the normal physical interaction.
  await importFixture(page, step(applied, { type: "SAVE_POSE", pose: openSignPose }));
  await expect(page.locator("#s3-target-label")).toContainText("营业牌", { timeout: 15_000 });
  await page.keyboard.press("e");
  await expect(page.locator("#s3-phase")).toContainText("营业中");
  await openLayout(page);
  await expect(page.locator("#s3-layout-lock")).toContainText("营业中");
  await expect(page.locator("#s3-layout-rotate")).toBeDisabled();
  await expect(page.locator("#s3-layout-apply")).toBeDisabled();
  await page.locator("#s3-layout-select").selectOption("milk-fridge");
  await page.locator('[data-layout-fixture="milk-fridge"]').focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("r");
  const trading = await exportSnapshot(page);
  expect(trading.day.phase).toBe("open");
  expect(trading.renovation).toEqual(applied.renovation);
  expect(trading.cashPence).toBe(applied.cashPence);
  expect(errors).toEqual([]);
});

test("shop renovation: a customer reaches the relocated counter and cash is accepted only at its new live position", async ({ page }, testInfo) => {
  test.setTimeout(250_000);
  const errors = runtimeErrors(page);
  const fixture = relocatedCounterCashFixture();
  const movedCounter = fixture.renovation.layout.placements.find((placement) => placement.id === "checkout-counter")!;
  expect(movedCounter).toEqual({ id: "checkout-counter", x: -1.7, z: 5.7, rotation: 1 });
  expect(fixture.customer.phase).toBe("to-checkout");
  await page.goto("/");
  await start(page);
  await openManagement(page);
  await page.getByText("画面与操作", { exact: true }).click();
  await page.locator("#s3-quality").selectOption("low");
  await importFixture(page, step(fixture, { type: "SAVE_POSE", pose: originalCounterPose }));

  // The visitor starts at the actual stocked shelf and must walk the renovated floor to the moved counter.
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 45_000 });
  const arrived = await readBrowserSnapshot(page);
  expect(arrived.customer.phase).toBe("checkout");
  expect(arrived.items.some((item) => item.location.kind === "checkout")).toBe(true);
  expect(arrived.renovation).toEqual(fixture.renovation);
  if (arrived.payment?.method !== "cash") throw new Error("The audited seeded visitor must offer cash");
  const amountPence = getCheckoutTotal(arrived);
  const expectedChange = cashChangeDuePence(arrived.payment, amountPence);
  expect(expectedChange).toBeGreaterThan(0);

  // The original counter site is now empty floor: neither E nor the cash shortcut may operate remotely.
  await expect(page.locator("#s3-target-label")).not.toContainText("收银台");
  await expect(page.locator("#s3-open-cash:enabled:visible")).toHaveCount(0);
  await page.keyboard.press("e");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  const fromOldPosition = await exportSnapshot(page);
  expect(fromOldPosition.scannedIds).toEqual([]);
  expect(fromOldPosition.payment).toEqual(arrived.payment);
  expect(fromOldPosition.cashPence).toBe(arrived.cashPence);
  expect(fromOldPosition.transactions).toEqual(arrived.transactions);

  // Reimport only an audited player-pose change, using the same relative camera position and quarter turn.
  await importFixture(page, step(fromOldPosition, { type: "SAVE_POSE", pose: fixture.playerPose }));
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 20_000 });
  await expect(page.locator("#s3-target-label")).toContainText("收银台");
  await expect(page.locator("#s3-interact")).toBeEnabled();
  const distance = /([\d.]+)\s*m$/.exec(await page.locator("#s3-target-label").innerText());
  expect(distance).not.toBeNull();
  expect(Number(distance![1])).toBeLessThanOrEqual(2.6);
  const checkoutItems = fromOldPosition.items.filter((item) => item.location.kind === "checkout");
  for (const item of checkoutItems) {
    await page.keyboard.press("e");
    await expect(page.locator(`#s3-scan-${item.productId}`)).toHaveText("已扫描");
  }
  await expect(page.locator("#s3-target-action")).toContainText("现金");
  const paid = await payScannedCheckout(page);
  expect(paid.renovation).toEqual(fixture.renovation);
  expect(paid.transactions.at(-1)).toMatchObject({
    customerNumber: arrived.customer.number,
    paymentMethod: "cash",
    amountPence,
    tenderedPence: arrived.payment.tenderedPence,
    changePence: expectedChange,
  });
  expect(paid.transactions.at(-1)!.itemIds).toEqual(checkoutItems.map((item) => item.id));
  await expect(page.locator("#s3-receipt-cash-breakdown")).toHaveText(
    `交付 ${money(arrived.payment.tenderedPence)} · 找零 ${money(expectedChange)} · 本单入账 ${money(amountPence)}`,
  );
  await expect(page.locator("#s3-cash")).toHaveText(money(arrived.cashPence + amountPence));
  await page.keyboard.press("e");
  await page.keyboard.press("e");
  const repeated = await exportSnapshot(page);
  expect(repeated.transactions).toEqual(paid.transactions);
  expect(repeated.cashPence).toBe(paid.cashPence);
  await page.locator("#s3-resume").click();
  await page.screenshot({ path: testInfo.outputPath("renovation-relocated-counter-cash-paid.png") });
  expect(errors).toEqual([]);
});
