import { expect, test, type Page } from "@playwright/test";
import {
  createFirstDayState, reduceSim, validateSimState, validateV14SimState,
  type SimCommand, type SimState, type SimStateV14,
} from "../../src/sim3d/domain";
import { cashDrawerValuePence } from "../../src/sim3d/cashDrawer";
import { getBusinessClock } from "../../src/sim3d/businessTime";
import { WORKSTATION_ID, workstationServicePoint } from "../../src/sim3d/workstation";
import { asV14BusinessSnapshot } from "../helpers/sim3dDelivery";
import { openComputer, openSettings, resumeScene, walkTo } from "./helpers/sim3d-computer";
import { receiveFixtureDeliveries } from "./helpers/sim3d-delivery";
import { completeFixturePayment, readBrowserSnapshot } from "./helpers/sim3d-payment";

test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${command.type}: ${result.message ?? "invalid computer fixture"}`);
  return result.state;
}

/** Audited old-format data is imported through ordinary controls in an isolated browser context. */
function legacyAfternoonFixture(): SimStateV14 {
  let state = createFirstDayState();
  state = step(state, { type: "CONFIGURE_CASH_FLOAT", drawer: { ...state.cashDrawer, 1: state.cashDrawer[1] - 1 } });
  state = step(state, { type: "PURCHASE_STOCK", orderId: "computer-migration-soap", lines: [{ productId: "soap", quantity: 1 }] });
  state = receiveFixtureDeliveries(state);
  state = step(state, { type: "PICK_CRATE", crateId: "soap-crate" });
  state = step(state, { type: "STOCK", productId: "soap", slot: 0 });
  state = step(state, { type: "DROP_HELD", position: state.crates.find((crate) => crate.id === "soap-crate")!.position });
  state = step(state, { type: "OPEN_STORE" });
  while (state.customer.phase !== "checkout") state = step(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout")) state = step(state, { type: "SCAN", itemId: item.id });
  state = step(completeFixturePayment(state), { type: "CUSTOMER_ADVANCE" });
  state = step(state, { type: "REFUND_TRANSACTION", transactionId: state.transactions[0]!.id, reason: "return" });
  state = step(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 4_000 });
  state = step(state, { type: "NEXT_CUSTOMER" });
  if (state.payment?.method !== "cash") throw new Error("The second audited customer must exercise the real cash drawer");
  while (state.customer.phase !== "checkout") state = step(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout")) state = step(state, { type: "SCAN", itemId: item.id });
  state = step(completeFixturePayment(state), { type: "CUSTOMER_ADVANCE" });
  state = step(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 360_000 - state.day.elapsedOpenMs });
  // Early closing leaves an exact, stable 14:00 face while the physical computer is exercised.
  state = step(state, { type: "CLOSE_STORE" });
  state = step(state, { type: "RECORD_CASH_COUNT", counts: { ...state.cashDrawer }, note: "旧电脑迁移前实盘" });
  const previous = asV14BusinessSnapshot(state);
  if (!validateV14SimState(previous)) throw new Error("The public-import fixture must satisfy the strict v14 validator");
  return previous;
}

async function start(page: Page): Promise<void> {
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function importFixture(page: Page, state: SimState | SimStateV14): Promise<void> {
  expect(state.schemaVersion === 14 ? validateV14SimState(state) : validateSimState(state)).toBe(true);
  await openSettings(page);
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const choosing = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await choosing).setFiles({ name: `computer-public-import-v${state.schemaVersion}.json`,
    mimeType: "application/json", buffer: Buffer.from(JSON.stringify(state)) });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
}

test("computer migration: publicly imported v14 retains 14:00 and the audited cash ledger, with a reachable physical computer", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const previous = legacyAfternoonFixture();
  expect(previous.day.elapsedOpenMs).toBe(210_000);
  expect(previous.cashJournal.map((entry) => entry.kind)).toEqual(["float", "refund", "count"]);
  await page.goto("/");
  await start(page);
  await importFixture(page, previous);
  await expect(page.locator("#s3-business-time")).toHaveText("14:00");
  await openSettings(page);
  const migrated = await readBrowserSnapshot(page);
  expect(migrated.schemaVersion).toBe(15);
  expect(migrated.day.elapsedOpenMs).toBe(360_000);
  expect(getBusinessClock(migrated.day).timeLabel).toBe("14:00");
  expect(migrated.cashPence).toBe(previous.cashPence);
  expect(migrated.cashReservePence).toBe(previous.cashReservePence);
  expect(migrated.cashDrawer).toEqual(previous.cashDrawer);
  expect(migrated.cashDrawerOpening).toEqual(previous.cashDrawerOpening);
  expect(migrated.cashDrawerTransactionStart).toBe(previous.cashDrawerTransactionStart);
  expect(migrated.cashJournal).toEqual(previous.cashJournal);
  expect(migrated.transactions).toEqual(previous.transactions);
  expect(migrated.items).toEqual(previous.items);
  expect(migrated.renovation.layout.placements).toEqual(previous.renovation.layout.placements);
  expect(migrated.delivery.phase).toBe("idle");
  await walkTo(page, workstationServicePoint(migrated.renovation.layout.workstation));
  await openComputer(page, "cash");
  await expect(page.locator("#s3-cash-management-drawer")).toHaveText(money(cashDrawerValuePence(previous.cashDrawer)));
  await expect(page.locator("#s3-cash-management-reserve")).toHaveText(money(previous.cashReservePence));
  await expect(page.locator("#s3-cash-management-count-history")).toContainText("旧电脑迁移前实盘");
  await resumeScene(page);
  await expect(page.locator("#s3-business-time")).toHaveText("14:00");
  expect(errors).toEqual([]);
});

test("computer at 390px: moving and rotating the real desk preserves access to every application, scrolling and exit", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 740 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const initial = createFirstDayState();
  const fixture = step(initial, { type: "APPLY_SHOP_LAYOUT", layout: { ...initial.renovation.layout,
    workstation: { x: -1.1, z: 1.6, rotation: 0 } } });
  const expected = step(fixture, { type: "APPLY_SHOP_LAYOUT", layout: { ...fixture.renovation.layout,
    workstation: { x: -1, z: 1.6, rotation: 1 } } });
  await page.goto("/");
  await start(page);
  await importFixture(page, fixture);
  await walkTo(page, workstationServicePoint(fixture.renovation.layout.workstation));
  await openComputer(page, "layout");
  await page.locator("#s3-layout-select").selectOption(WORKSTATION_ID);
  await page.locator('[data-layout-move="right"]').click();
  await page.locator("#s3-layout-rotate").click();
  await expect(page.locator("#s3-layout-x")).toHaveText("-1.000 m");
  await expect(page.locator("#s3-layout-rotation")).toHaveText("90°");
  await expect(page.locator("#s3-layout-apply")).toBeEnabled();
  await page.locator("#s3-layout-apply").click();
  const moved = await readBrowserSnapshot(page);
  expect(moved.renovation.layout.workstation).toEqual(expected.renovation.layout.workstation);
  expect(moved.renovation.layout.placements).toEqual(fixture.renovation.layout.placements);
  expect(moved.cashPence).toBe(fixture.cashPence);
  await resumeScene(page);
  await walkTo(page, workstationServicePoint(expected.renovation.layout.workstation));
  await openComputer(page);
  expect((await readBrowserSnapshot(page)).renovation.layout.workstation).toEqual(expected.renovation.layout.workstation);
  await expect(page.locator(".s3-desktop-icon")).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath("computer-desktop-390.png") });
  for (const app of ["supply", "day", "upgrade", "equipment", "layout", "street"] as const) {
    await openComputer(page, app);
    await expect(page.locator(`#s3-panel-${app}`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#s3-computer-desktop")).toBeVisible();
  }
  await openComputer(page, "development");
  await expect(page.locator("#s3-panel-development")).toBeVisible();
  await openComputer(page, "cash");
  const dialog = page.locator("#s3-pause");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const bounds = (await dialog.boundingBox())!;
  // Keep the wheel over the dialog padding, outside nested fields or product lists.
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 20_000);
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true);
  await expect(page.locator("#s3-cash-management-count-reset")).toBeInViewport();
  await page.mouse.wheel(0, -20_000);
  await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator("#s3-pause-title")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("computer-cash-app-390.png") });
  await resumeScene(page);
  await expect(dialog).toBeHidden();
  await expect(page.locator("#s3-hud")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("computer-moved-and-rotated-390.png") });
  expect(errors).toEqual([]);
});
