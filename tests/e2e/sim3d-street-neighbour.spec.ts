import { openSettings, openComputer } from "./helpers/sim3d-computer";
import { expect, test, type Page } from "@playwright/test";
import { createFirstDayState, getDaySummary, reduceSim, validateSimState, type SimState } from "../../src/sim3d/domain";
import { streetNeighbourForDay } from "../../src/sim3d/streetNeighbourContent";
import { readBrowserSnapshot } from "./helpers/sim3d-payment";

// Exercise the public save import, real first-person ray target and visible
// dialogue. The browser context is disposable and no scene internals are used.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });

const CUSTOMER_SEED = 31;

function streetFixture(): SimState {
  const initial = { ...createFirstDayState(), customerSeed: CUSTOMER_SEED };
  const neighbour = streetNeighbourForDay({ customerSeed: CUSTOMER_SEED, dayNumber: initial.day.number });
  if (neighbour.id !== "sam") throw new Error("The audited street fixture must select Sam and Patch");
  // Start outside interaction range, on the clear pavement north of Sam, and
  // face south. A short real W walk brings the player into the 2.6 m ray range.
  const result = reduceSim(initial, {
    type: "SAVE_POSE",
    pose: { x: neighbour.position.x, z: neighbour.position.z + 3.15, yaw: Math.PI, pitch: .18 },
  });
  if (!result.changed || !validateSimState(result.state)) throw new Error("Invalid street-neighbour fixture");
  return result.state;
}

function monitorRuntime(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
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
  await openSettings(page);
  await expect(page.locator("#s3-pause")).toBeVisible();
  await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({
    name: "street-neighbour-real-flow.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
}

test("street neighbour: walk into range, chat and give £1 once through the real page", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = monitorRuntime(page);
  const fixture = streetFixture();
  await launchFixture(page, fixture);

  await expect(page.locator("#s3-cash")).toHaveText("£12.00");
  await expect(page.locator("#s3-target-label")).not.toContainText("Sam");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(450);
  await page.keyboard.up("KeyW");
  await expect(page.locator("#s3-target-label")).toContainText("Sam & Patch", { timeout: 10_000 });
  await expect(page.locator("#s3-target-action")).toContainText("打个招呼");

  await page.keyboard.press("KeyE");
  await expect(page.locator("#s3-neighbour-dialog")).toBeVisible();
  await expect(page.locator("#s3-neighbour-title")).toHaveText("Sam");
  await expect(page.locator("#s3-neighbour-dog-name")).toContainText("Patch");
  await expect(page.locator("#s3-neighbour-line")).not.toHaveText("");

  const consentLine = await page.locator("#s3-neighbour-line").textContent();
  await page.locator("#s3-neighbour-chat").click();
  await expect(page.locator("#s3-neighbour-line")).not.toHaveText(consentLine ?? "");
  await page.locator("#s3-neighbour-give-one").click();

  await expect(page.locator("#s3-cash")).toHaveText("£11.00");
  await expect(page.locator("#s3-neighbour-support-status")).toContainText("今天已给 Sam £1.00");
  await expect(page.locator("#s3-neighbour-support-status")).toContainText("仍可继续聊天");
  await expect(page.locator("#s3-neighbour-give-one")).toBeDisabled();
  await expect(page.locator("#s3-neighbour-give-two")).toBeDisabled();

  const thanksLine = await page.locator("#s3-neighbour-line").textContent();
  await page.locator("#s3-neighbour-needs").click();
  await expect(page.locator("#s3-neighbour-dialog")).toBeVisible();
  await expect(page.locator("#s3-neighbour-line")).not.toHaveText(thanksLine ?? "");

  const saved = await readBrowserSnapshot(page);
  expect(saved.cashPence).toBe(1100);
  expect(saved.streetSupportRecords).toEqual([{
    id: "street-support-1-sam", dayNumber: 1, neighbourId: "sam", amountPence: 100,
  }]);
  expect(getDaySummary(saved)).toMatchObject({ communitySupportCount: 1, communityCashPence: 100, closingCashPence: 1100 });

  await page.locator("#s3-neighbour-close").click();
  await expect(page.locator("#s3-neighbour-dialog")).toBeHidden();
  await openComputer(page, "day");
  await expect(page.locator("#s3-panel-day")).toBeVisible();
  await expect(page.locator("#s3-day-community")).toHaveText("£1.00");
  await expect(page.locator("#s3-day-cash")).toHaveText("£11.00");
  expect(errors).toEqual([]);
});
