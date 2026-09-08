import { expect, type Page } from "@playwright/test";
import { getShopLayoutObstacles, WORLD_BOUNDS, type PlayerPose, type Position, type SimState } from "../../../src/sim3d/domain";
import { layoutColliders, layoutRoute, shopBounds } from "../../../src/sim3d/shopLayout";
import { equipmentPlacementBounds } from "../../../src/sim3d/equipmentLayout";
import { CUSTOMER_DOORSTEP, CUSTOMER_STREET_BOUNDS } from "../../../src/sim3d/customerJourney";
import type { LayoutCollider } from "../../../src/sim3d/productLayout";
import { workstationInteractionPoint, workstationServicePoint } from "../../../src/sim3d/workstation";
import { readBrowserSnapshot } from "./sim3d-payment";

export type ComputerApp = "supply" | "day" | "cash" | "upgrade" | "development" | "equipment" | "layout" | "street";

/** Pause/export-style observations of a disposable test context; never modify the running game. */
export async function openSettings(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await page.locator("#s3-pause").isVisible()
      && await page.getByText("存档与试玩管理", { exact: true }).isVisible()) return;
    await page.keyboard.press("Escape");
  }
  await expect(page.getByText("存档与试玩管理", { exact: true })).toBeVisible();
}

interface PlayerJourney { area?: "indoor" | "street" }

function playerRoute(from: Position, target: Position, obstacles: LayoutCollider[], state: SimState, journey: PlayerJourney, radius = .25): Position[] | null {
  // The real player radius is .24. Leave 1 cm at routed corners so a drag's
  // whole-pixel yaw rounding cannot strand the test against the exact boundary.
  const indoor = { ...shopBounds(state.renovation.layout.expansion), minZ: -6 };
  // Players can cross the street to neighbours; customers only use the near pavement.
  const street = { ...CUSTOMER_STREET_BOUNDS, minZ: WORLD_BOUNDS.minZ };
  const inside = (p: Position): boolean => p.x >= indoor.minX + radius && p.x <= indoor.maxX - radius
    && p.z >= indoor.minZ + radius && p.z <= indoor.maxZ - radius;
  journey.area ??= inside(from) ? "indoor" : "street";
  const destinationArea = inside(target) ? "indoor" : "street";
  const firstBounds = journey.area === "indoor" ? indoor : street;
  const secondBounds = destinationArea === "indoor" ? indoor : street;
  if (firstBounds === secondBounds) return layoutRoute(from, target, obstacles, firstBounds, radius);
  // The doorway is a handoff between overlapping navigation areas. Once the
  // real walk reaches it, validate a route in the destination area instead of
  // turning back to its exact centre on every low-frame-rate movement step.
  if (Math.hypot(from.x - CUSTOMER_DOORSTEP.x, from.z - CUSTOMER_DOORSTEP.z) < .28) {
    const onward = layoutRoute(from, target, obstacles, secondBounds, radius);
    if (onward) { journey.area = destinationArea; return onward }
  }
  const first = layoutRoute(from, CUSTOMER_DOORSTEP, obstacles, firstBounds, radius);
  const second = layoutRoute(CUSTOMER_DOORSTEP, target, obstacles, secondBounds, radius);
  return first && second ? [...first, ...second] : null;
}

export async function resumeScene(page: Page): Promise<void> {
  if (await page.locator("#s3-pause").isVisible()) {
    const exit = page.getByRole("button", { name: "退出电脑", exact: true });
    if (await exit.isVisible()) await exit.click();
    else await page.locator("#s3-resume").click();
  }
  await expect(page.locator("#s3-pause")).toBeHidden();
  await page.locator("#s3-canvas").focus();
  if (await page.evaluate(() => document.pointerLockElement !== null)) await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
}

async function observePose(page: Page): Promise<SimState> {
  // Navigation calls this only while playing with a free cursor. The normal
  // Esc boundary saves the real pose synchronously; another Esc resumes it.
  // Avoid reopening/selecting UI controls for every short walking segment.
  await page.keyboard.press("Escape");
  await expect(page.locator("#s3-pause")).toBeVisible();
  const state = await readBrowserSnapshot(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#s3-pause")).toBeHidden();
  return state;
}

/** Rotate through the normal drag-look listener, accounting for the user's saved sensitivity. */
async function look(page: Page, from: PlayerPose, yaw: number, pitch: number): Promise<void> {
  const bounds = await page.locator("#s3-canvas").boundingBox();
  if (!bounds) throw new Error("No visible game canvas");
  const sensitivity = await page.locator("#s3-sensitivity").inputValue().catch(() => "1");
  const factor = .0023 * Number(sensitivity || 1);
  let dx = Math.atan2(Math.sin(yaw - from.yaw), Math.cos(yaw - from.yaw)) / factor;
  let dy = (pitch - from.pitch) / factor;
  while (Math.abs(dx) > .01 || Math.abs(dy) > .01) {
    // Use the available canvas width: a desktop half-turn should not require
    // eight separate drags. Keep the endpoint inside even at 390 px wide.
    const maxX = bounds.width * .43;
    const maxY = Math.min(150, bounds.height * .2);
    const x = Math.max(-maxX, Math.min(maxX, dx));
    const y = Math.max(-maxY, Math.min(maxY, dy));
    await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .52);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .55 + x, bounds.y + bounds.height * .52 + y, { steps: 2 });
    await page.mouse.up();
    dx -= x; dy -= y;
  }
}

/** Walk to a reachable point with ordinary movement, recalculating from the saved real pose. */
export async function walkTo(page: Page, target: Position): Promise<void> {
  await resumeScene(page);
  const journey: PlayerJourney = {};
  for (let attempt = 0; attempt < 55; attempt += 1) {
    const state = await observePose(page);
    const pose = state.playerPose;
    if (Math.hypot(pose.x - target.x, pose.z - target.z) < .28) return;
    const layout = state.renovation.layout;
    const equipment = layout.equipment.flatMap((placement) => {
      const instance = state.equipment.instances.find((candidate) => candidate.id === placement.instanceId);
      return instance ? [equipmentPlacementBounds(instance, placement)] : [];
    });
    const obstacles = [...layoutColliders(layout), ...equipment, ...getShopLayoutObstacles(state)];
    // A real step can settle within the extra centimetre, while still outside
    // the collider. In that case route from the true .24 m player envelope.
    const route = playerRoute(pose, target, obstacles, state, journey)
      ?? playerRoute(pose, target, obstacles, state, journey, .24);
    if (!route) throw new Error(`No player route to ${JSON.stringify(target)} from ${JSON.stringify(pose)}`);
    const waypoint = route.find((point) => Math.hypot(pose.x - point.x, pose.z - point.z) > .08) ?? target;
    const distance = Math.hypot(pose.x - waypoint.x, pose.z - waypoint.z);
    await look(page, pose, Math.atan2(waypoint.x - pose.x, waypoint.z - pose.z), 0);
    const speed = state.held.kind === "crate" ? 2.2 : 2.8;
    const duration = Math.max(0, Math.min(500, (distance / speed * .7 - .08) * 1000));
    await page.keyboard.down("KeyW");
    if (duration > 0) await page.waitForTimeout(duration);
    await page.keyboard.up("KeyW");
  }
  throw new Error(`Player did not reach ${JSON.stringify(target)} through normal movement`);
}

export async function openComputer(page: Page, app?: ComputerApp): Promise<void> {
  const desktop = page.locator("#s3-computer-desktop");
  if (await page.locator("#s3-pause.s3-computer").isVisible()) {
    if (app && await page.locator(`#s3-panel-${app}`).isVisible()) return;
    if (!(await desktop.isVisible())) await page.locator("#s3-computer-back").click();
  }
  if (!(await desktop.isVisible())) {
    await resumeScene(page);
    const initial = await observePose(page);
    await walkTo(page, workstationServicePoint(initial.renovation.layout.workstation));
    const state = await observePose(page);
    const point = workstationInteractionPoint(state.renovation.layout.workstation);
    await look(page, state.playerPose, Math.atan2(point.x - state.playerPose.x, point.z - state.playerPose.z),
      Math.atan2(1.65 - point.y, Math.hypot(point.x - state.playerPose.x, point.z - state.playerPose.z)));
    await expect(page.locator("#s3-target-label")).toContainText("电脑", { timeout: 5000 });
    await page.keyboard.press("KeyE");
    await expect(desktop).toBeVisible();
  }
  if (app) {
    const parent = app === "cash" ? "day" : app === "development" ? "upgrade" : app;
    await page.locator(`#s3-computer-${parent}`).click();
    if (app !== parent) await page.locator(`#s3-tab-${app}`).click();
    await expect(page.locator(`#s3-panel-${app}`)).toBeVisible();
  }
}

export async function facePoint(page: Page, point: Position & { y?: number }): Promise<void> {
  const state = await observePose(page);
  await look(page, state.playerPose, Math.atan2(point.x - state.playerPose.x, point.z - state.playerPose.z),
    Math.atan2(1.65 - (point.y ?? 1.15), Math.hypot(point.x - state.playerPose.x, point.z - state.playerPose.z)));
}
