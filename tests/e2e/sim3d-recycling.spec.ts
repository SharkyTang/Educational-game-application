import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  PRODUCTS, createFirstDayState, getDaySummary, reduceSim, validateSimState, validateV6SimState,
  type PlayerPose, type SimCommand, type SimState, type SimStateV6,
} from "../../src/sim3d/domain";

test.use({ viewport: { width: 1365, height: 860 } });

const stationPose: PlayerPose = { x: 3.5, z: -6.7, yaw: 0, pitch: .10 };
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${command.type}: ${result.message ?? "invalid fixture"}`);
  return result.state;
}

async function openManagement(page: Page): Promise<void> {
  if (!(await page.locator("#s3-pause").isVisible())) await page.keyboard.press("b");
  await expect(page.locator("#s3-pause")).toBeVisible();
}

async function importSnapshot(page: Page, state: SimState | SimStateV6): Promise<void> {
  expect(validateSimState(state) || validateV6SimState(state)).toBe(true);
  await openManagement(page);
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({ name: "recycling-game.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(state)) });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function exportSnapshot(page: Page): Promise<SimState> {
  await openManagement(page);
  if (!(await page.locator("#s3-export").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.locator("#s3-export").click();
  const state: unknown = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(validateSimState(state)).toBe(true);
  return state as SimState;
}

test("empty boxes: real recycling target, one reward, reload, separate ledger and a reusable delivery space", async ({ page }, testInfo) => {
  // Several public save imports recreate the real WebGL scene; keep room for software-rendered CI.
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  let full = step(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "recycling-browser", lines: [{ productId: "milk", quantity: 1 }] });
  full = step(full, { type: "RECEIVE_DELIVERY" });
  const originalPosition = { ...full.crates.find((crate) => crate.id === "milk-crate")!.position };
  full = step(full, { type: "PICK_CRATE", crateId: "milk-crate" });
  full = step(full, { type: "SAVE_POSE", pose: stationPose });
  // Exercise the public v6 JSON migration with a real old shape, not a hidden state bridge.
  const { recyclingRecords: _records, recyclingBatches: _batches, settlements: _settlements, ...oldFields } = full;
  const v6: SimStateV6 = { ...oldFields, schemaVersion: 6, settlements: [] };
  expect(validateV6SimState(v6)).toBe(true);
  await page.goto("/");
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await importSnapshot(page, v6);
  await expect(page.locator("#s3-target-label")).toContainText("空箱回收", { timeout: 15_000 });
  await page.keyboard.press("e");
  await expect(page.locator("#s3-held")).toContainText("剩余 1 件");
  await expect(page.locator("#s3-cash")).toHaveText(money(full.cashPence));
  expect((await exportSnapshot(page)).recyclingRecords).toHaveLength(0);

  // Stock the final product with the actual shelf ray and E handler.
  const atShelf = step(full, { type: "SAVE_POSE", pose: { x: 0, z: 2.72, yaw: 0, pitch: .30 } });
  await importSnapshot(page, atShelf);
  await expect(page.locator("#s3-target-label")).toContainText("牛奶冰柜", { timeout: 15_000 });
  await page.keyboard.press("e");
  await expect(page.locator("#s3-held")).toContainText("空纸箱");
  await expect(page.locator("#s3-guide")).toContainText("回收");
  const empty = await exportSnapshot(page);
  expect(empty.items).toHaveLength(1);
  expect(empty.items[0]!.location.kind).toBe("shelf");
  expect(empty.crates.some((crate) => crate.id === "milk-crate")).toBe(true);
  await writeFile(testInfo.outputPath("recycling-ready.json"), JSON.stringify(step(empty, { type: "SAVE_POSE", pose: stationPose }), null, 2));

  // Recycling requires looking at the physical station. It never happens merely on emptying.
  const facingAway = step(empty, { type: "SAVE_POSE", pose: { ...stationPose, yaw: Math.PI / 2 } });
  await importSnapshot(page, facingAway);
  await expect(page.locator("#s3-target-label")).not.toContainText("空箱回收");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-held")).toContainText("空纸箱");
  await expect(page.locator("#s3-cash")).toHaveText(money(empty.cashPence));
  await importSnapshot(page, step(empty, { type: "SAVE_POSE", pose: stationPose }));
  await expect(page.locator("#s3-target-action")).toContainText("回收空箱 +£0.05", { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("recycling-station.png") });
  await page.keyboard.press("e");
  await expect(page.locator("#s3-held")).toBeHidden();
  await expect(page.locator("#s3-cash")).toHaveText(money(empty.cashPence + 5));
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash")).toHaveText(money(empty.cashPence + 5));
  const recycled = await exportSnapshot(page);
  expect(recycled.crates.some((crate) => crate.id === "milk-crate")).toBe(false);
  expect(recycled.recyclingRecords).toHaveLength(1);
  expect(recycled.items).toEqual(empty.items);
  expect(getDaySummary(recycled)).toMatchObject({ recycledCrates: 1, recyclingIncomePence: 5, revenuePence: 0, grossProfitPence: 0 });
  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-day-recycling")).toHaveText("£0.05");
  await expect(page.locator("#s3-day-recycling-count")).toContainText("今日回收 1 箱");
  await expect(page.locator("#s3-day-revenue")).toHaveText("£0.00");
  await expect(page.locator("#s3-day-profit")).toHaveText("£0.00");

  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-held")).toBeHidden();
  await expect(page.locator("#s3-cash")).toHaveText(money(recycled.cashPence));
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash")).toHaveText(money(recycled.cashPence));

  // A real newly placed order can use the original box's now-free unloading position.
  await openManagement(page);
  await page.locator("#s3-tab-supply").click();
  await page.locator("#s3-quantity-soap").fill("1");
  await page.locator("#s3-purchase").click();
  await expect(page.locator("#s3-pause")).toBeHidden();
  const pending = await exportSnapshot(page);
  await importSnapshot(page, step(pending, { type: "SAVE_POSE", pose: { x: 3, z: -6.9, yaw: Math.PI, pitch: .06 } }));
  await expect(page.locator("#s3-target-action")).toContainText("签收 1 件", { timeout: 15_000 });
  await page.keyboard.press("e");
  await expect(page.locator("#s3-target-action")).toContainText("查看今日进货单");
  const delivered = await exportSnapshot(page);
  expect(delivered.crates.find((crate) => crate.id === "soap-crate")?.position).toEqual(originalPosition);
  expect(delivered.recyclingRecords).toEqual(recycled.recyclingRecords);
  expect(delivered.cashPence).toBe(recycled.cashPence - PRODUCTS.soap.costPence);
  expect(delivered.items).toHaveLength(2);
  expect(errors).toEqual([]);
});
