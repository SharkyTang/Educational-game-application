import { expect, test } from "@playwright/test";
import { openComputer, openSettings, resumeScene, walkTo, facePoint } from "./helpers/sim3d-computer";
import { readBrowserSnapshot } from "./helpers/sim3d-payment";

test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

test("shop computer: only the physical monitor opens six applications and Escape returns through desktop to the world", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  for (const key of ["b", "u", "p", "m"]) {
    await page.keyboard.press(key);
    await expect(page.locator("#s3-pause")).toBeHidden();
  }
  await openSettings(page);
  await expect(page.locator("#s3-computer-desktop")).toBeHidden();
  await page.keyboard.press("b");
  await expect(page.locator("#s3-panel-supply")).toBeHidden();
  const beforeDrag = (await readBrowserSnapshot(page)).playerPose;
  await resumeScene(page);
  const canvas = (await page.locator("#s3-canvas").boundingBox())!;
  await page.mouse.move(canvas.width / 2, canvas.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.width / 2 + 140, canvas.height / 2, { steps: 3 });
  await page.mouse.up();
  await openSettings(page);
  expect((await readBrowserSnapshot(page)).playerPose.yaw - beforeDrag.yaw).toBeCloseTo(.322, 2);
  await openComputer(page);
  await expect(page.locator(".s3-desktop-icon")).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath("shop-computer-desktop.png") });
  for (const app of ["supply", "day", "upgrade", "equipment", "layout", "street"] as const) {
    await openComputer(page, app);
    await expect(page.locator(`#s3-panel-${app}`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#s3-computer-desktop")).toBeVisible();
  }
  await openComputer(page, "day");
  await page.locator("#s3-tab-cash").click();
  await expect(page.locator("#s3-panel-cash")).toBeVisible();
  await openComputer(page, "upgrade");
  await page.locator("#s3-tab-development").click();
  await expect(page.locator("#s3-panel-development")).toBeVisible();
  await resumeScene(page);
  await page.screenshot({ path: testInfo.outputPath("physical-shop-computer.png") });
  expect(errors).toEqual([]);
});

test("order delivery: two paid orders arrive separately, pause at the computer and retain the current trip after reload", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await openComputer(page, "supply");
  await page.locator("#s3-quantity-soap").fill("1");
  await page.locator("#s3-purchase").click();
  await expect(page.locator("#s3-pause")).toBeHidden();
  await expect(page.locator("#s3-cash")).toHaveText("£11.30");
  await openComputer(page, "supply");
  const paused = await readBrowserSnapshot(page);
  await page.waitForTimeout(500);
  expect((await readBrowserSnapshot(page)).delivery).toEqual(paused.delivery);
  await page.locator("#s3-quantity-soap").fill("1");
  await page.locator("#s3-purchase").click();
  await expect(page.locator("#s3-cash")).toHaveText("£10.60");
  await walkTo(page, { x: 3, z: -7 });
  await facePoint(page, { x: 3, z: -9.1, y: 1.2 });
  await expect(page.locator("#s3-target-label")).toContainText("配送", { timeout: 25_000 });
  await page.keyboard.press("e");
  await expect.poll(async () => (await readBrowserSnapshot(page)).purchases.filter((order) => order.receivedDay !== null).length).toBe(1);
  const first = await readBrowserSnapshot(page);
  expect(first.items.filter((item) => item.location.kind === "crate")).toHaveLength(1);
  expect(first.items.filter((item) => item.location.kind === "delivery")).toHaveLength(1);
  await openSettings(page);
  await page.reload();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect.poll(async () => (await readBrowserSnapshot(page)).delivery.phase, { timeout: 30_000 }).toBe("ready");
  await facePoint(page, { x: 3, z: -9.1, y: 1.2 });
  await expect(page.locator("#s3-target-label")).toContainText("配送");
  await page.keyboard.press("e");
  await expect.poll(async () => (await readBrowserSnapshot(page)).purchases.filter((order) => order.receivedDay !== null).length).toBe(2);
  expect((await readBrowserSnapshot(page)).items.filter((item) => item.location.kind === "crate")).toHaveLength(2);
  await expect(page.locator("#s3-cash")).toHaveText("£10.60");
});
