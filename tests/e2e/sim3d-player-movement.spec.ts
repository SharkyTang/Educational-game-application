import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createFirstDayState, reduceSim, validateSimState, type PlayerPose, type SimState } from "../../src/sim3d/domain";

// Use a disposable browser and only the game's normal import/export controls to
// sample positions. No localStorage, scene internals or test-only game methods.
test.describe.configure({ mode: "default" });
test.use({
  viewport: { width: 1365, height: 860 },
  // Canvas screencasts and per-action DOM snapshots can hold up the input
  // response after keyup, inflating host-side timing without any movement.
  // Keep action traces and failure screenshots, but omit those two
  // timing-sensitive collectors for this real-time movement measurement.
  trace: { mode: "retain-on-failure", screenshots: false, snapshots: false },
});

type Direction = "KeyW" | "KeyS";
type SprintKey = "ShiftLeft" | "ShiftRight";
interface MovementSample {
  seconds: number;
  distance: number;
  speed: number;
  before: PlayerPose;
  after: PlayerPose;
}

function movementFixture(): SimState {
  // A legitimate pending order resumes with the delivery van already parked
  // beside the shop. With a brand-new empty save it would drive across this
  // route during the benchmark and correctly stop the player's movement.
  const purchased = reduceSim(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "player-movement-delivery", pairs: 1 });
  if (!purchased.changed || !validateSimState(purchased.state)) throw new Error("Invalid player movement delivery fixture");
  // Face south along the empty doorway/street centreline. Moving out and back
  // keeps every measurement clear of the counter, crates, van and world edge.
  const result = reduceSim(purchased.state, {
    type: "SAVE_POSE", pose: { x: 0, z: -3.5, yaw: Math.PI, pitch: 0 },
  });
  if (!result.changed || !validateSimState(result.state)) throw new Error("Invalid player movement fixture");
  return result.state;
}

function monitorRuntime(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

async function pause(page: Page): Promise<void> {
  if (!(await page.locator("#s3-pause").isVisible())) await page.keyboard.press("KeyB");
  await expect(page.locator("#s3-pause")).toBeVisible();
}

async function resume(page: Page): Promise<void> {
  await page.locator("#s3-resume").click();
  await expect(page.locator("#s3-pause")).toBeHidden();
}

async function importFixture(page: Page): Promise<void> {
  await pause(page);
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({
    name: "player-movement-fixture.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(movementFixture())),
  });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function exportPose(page: Page, returnToGame = true): Promise<PlayerPose> {
  await pause(page);
  if (!(await page.locator("#s3-export").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#s3-export").click();
  const filename = await (await downloadEvent).path();
  if (!filename) throw new Error("The game's exported save did not finish downloading");
  const state: unknown = JSON.parse(await readFile(filename, "utf8"));
  if (!validateSimState(state)) throw new Error("Player movement produced an invalid exported save");
  if (returnToGame) await resume(page);
  return { ...state.playerPose };
}

async function move(page: Page, before: PlayerPose, direction: Direction, milliseconds: number, sprint?: SprintKey): Promise<MovementSample> {
  if (sprint) await page.keyboard.down(sprint);
  const started = performance.now();
  try {
    await page.keyboard.down(direction);
    // This interval is the measured key hold, not a wait for page readiness.
    await page.waitForTimeout(milliseconds);
  } finally {
    await page.keyboard.up(direction);
  }
  const seconds = (performance.now() - started) / 1000;
  if (sprint) await page.keyboard.up(sprint);
  const after = await exportPose(page);
  const distance = (after.z - before.z) * (direction === "KeyW" ? -1 : 1);
  expect(after.x).toBeCloseTo(before.x, 2);
  return { seconds, distance, speed: distance / seconds, before, after };
}

function expectStationary(before: PlayerPose, after: PlayerPose): void {
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.025);
  expect(after.yaw).toBeCloseTo(before.yaw, 3);
  expect(after.pitch).toBeCloseTo(before.pitch, 3);
}

test("3D player movement: faster walking, held left/right Shift sprint, release and pause are reflected in real saved positions", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = monitorRuntime(page);
  await page.goto("/");
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await expect(page.locator(".s3-start-controls")).toContainText(/Shift/i);
  await expect(page.locator(".s3-start-controls")).toContainText(/按住|长按/);
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
  await importFixture(page);

  await pause(page);
  await page.getByText("看看怎么操作", { exact: true }).click();
  await expect(page.locator(".s3-controls-list")).toBeVisible();
  await expect(page.locator(".s3-controls-list")).toContainText(/Shift/i);
  await expect(page.locator(".s3-controls-list")).toContainText(/按住|长按/);
  // Select the public low-quality option to reduce software-GPU variance. The
  // physics still uses real render-frame time, with no clock or render mocks.
  await page.getByText("画面与操作", { exact: true }).click();
  await page.locator("#s3-quality").selectOption("low");
  const initial = await exportPose(page);
  expect(initial.x).toBeCloseTo(0, 3);
  expect(initial.z).toBeCloseTo(-3.5, 3);

  const walk = await move(page, initial, "KeyW", 800);
  const sprintLeft = await move(page, walk.after, "KeyW", 800, "ShiftLeft");
  const walkAfterRelease = await move(page, sprintLeft.after, "KeyS", 800);
  const sprintRight = await move(page, walkAfterRelease.after, "KeyS", 1200, "ShiftRight");
  await test.info().attach("player-movement-measurements", {
    body: Buffer.from(JSON.stringify({ walk, sprintLeft, walkAfterRelease, sprintRight }, null, 2)),
    contentType: "application/json",
  });

  // Allow the existing short initial key-tap step and real-frame scheduling.
  // These bounds still reject the old 1.85 m/s pace and ignored/sticky Shift.
  for (const sample of [walk, walkAfterRelease]) {
    expect(sample.speed).toBeGreaterThan(2.2);
    expect(sample.speed).toBeLessThan(3.7);
  }
  for (const sample of [sprintLeft, sprintRight]) {
    expect(sample.speed).toBeGreaterThan(3.9);
    expect(sample.speed).toBeLessThan(6.4);
    expect(sample.speed / walk.speed).toBeGreaterThan(1.45);
    expect(sample.speed / walk.speed).toBeLessThan(2.2);
  }
  expect(walkAfterRelease.speed / walk.speed).toBeGreaterThan(0.75);
  expect(walkAfterRelease.speed / walk.speed).toBeLessThan(1.25);
  expect(sprintRight.seconds).toBeGreaterThanOrEqual(1.2);
  expect(sprintRight.speed / sprintLeft.speed).toBeGreaterThan(0.8);
  expect(sprintRight.speed / sprintLeft.speed).toBeLessThan(1.2);

  // Shift modifies directional movement; on its own it must not move at all.
  await page.keyboard.down("ShiftLeft");
  await page.waitForTimeout(350);
  await page.keyboard.up("ShiftLeft");
  const afterShiftOnly = await exportPose(page);
  expectStationary(sprintRight.after, afterShiftOnly);

  // Pause while both movement and sprint are physically held. Release only
  // the direction in the menu; keep Left Shift held through every UI action.
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(300);
  await pause(page);
  await page.keyboard.up("KeyW");
  const pausedWithShiftHeld = await exportPose(page, false);
  // Use one held Shift here: Playwright models Shift as one modifier, so an
  // overlapping Right Shift up would falsely clear the still-held Left Shift.
  // Independent Right Shift sprinting is already measured above.
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyW");
  expectStationary(pausedWithShiftHeld, await exportPose(page, false));
  await resume(page);
  await page.waitForTimeout(500);
  const resumedWithShiftHeld = await exportPose(page);
  expectStationary(pausedWithShiftHeld, resumedWithShiftHeld);
  // A fresh W must still have shiftKey=true without another Shift keydown.
  // Omit move()'s sprint argument to preserve the actual held modifier across
  // pause/export/resume, rather than recreating it inside game internals.
  const sprintAfterPause = await move(page, resumedWithShiftHeld, "KeyW", 800);
  await page.keyboard.up("ShiftLeft");
  const walkAfterPauseRelease = await move(page, sprintAfterPause.after, "KeyW", 800);
  await test.info().attach("player-movement-held-shift-measurements", {
    body: Buffer.from(JSON.stringify({ pausedWithShiftHeld, resumedWithShiftHeld, sprintAfterPause, walkAfterPauseRelease }, null, 2)),
    contentType: "application/json",
  });
  expect(sprintAfterPause.speed).toBeGreaterThan(3.9);
  expect(sprintAfterPause.speed).toBeLessThan(6.4);
  expect(walkAfterPauseRelease.speed).toBeGreaterThan(2.2);
  expect(walkAfterPauseRelease.speed).toBeLessThan(3.7);
  expect(sprintAfterPause.speed / walkAfterPauseRelease.speed).toBeGreaterThan(1.45);
  expect(sprintAfterPause.speed / walkAfterPauseRelease.speed).toBeLessThan(2.2);
  expect(errors).toEqual([]);
});
