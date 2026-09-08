import { expect, test, type Page } from "@playwright/test";
import { Camera, Matrix, NullEngine, Scene, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import {
  createFirstDayState, getCheckoutTotal, reduceSim, validateSimState,
  type SimCommand, type SimState,
} from "../../src/sim3d/domain";
import { CashDrawerVisual } from "../../src/sim3d/cashDrawerVisual";
import { deriveCashVisualState, type CashVisualPick } from "../../src/sim3d/cashVisualState";
import { beginNextFixtureCustomer } from "./helpers/sim3d-business-time";
import { receiveFixtureDeliveries } from "./helpers/sim3d-delivery";
import { completeFixturePayment, readBrowserSnapshot } from "./helpers/sim3d-payment";

// Real pointer clicks are the acceptance boundary here. Text/button assertions alone
// cannot prove that the displayed tender, coin stacks and change tray are operable.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 860 } });
const visualCanvas = "#s3-cash-visual-canvas";
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed || !validateSimState(result.state)) {
    throw new Error(`${command.type}: ${result.message ?? "invalid real cash-visual fixture"}`);
  }
  return result.state;
}

/** A normal paid first visitor, followed by a fully scanned second cash visitor. */
function cashFixture(): SimState {
  let state = step(createFirstDayState(), {
    type: "PURCHASE_STOCK", orderId: "cash-visual-two-visits",
    lines: [{ productId: "milk", quantity: 2 }, { productId: "bread", quantity: 2 }],
  });
  state = receiveFixtureDeliveries(state);
  for (const productId of ["milk", "bread"] as const) {
    const crate = state.crates.find((entry) => entry.productId === productId)!;
    state = step(state, { type: "PICK_CRATE", crateId: crate.id });
    for (let slot = 0; slot < 2; slot += 1) state = step(state, { type: "STOCK", productId, slot });
    state = step(state, { type: "DROP_HELD", position: crate.position });
  }
  for (let visitor = 0; visitor < 2; visitor += 1) {
    state = visitor === 0 ? step(state, { type: "OPEN_STORE" }) : beginNextFixtureCustomer(state);
    while (["to-milk", "to-bread", "to-checkout"].includes(state.customer.phase)) {
      state = step(state, { type: "CUSTOMER_ADVANCE" });
    }
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) {
      state = step(state, { type: "SCAN", itemId: item.id });
    }
    if (visitor === 0) state = step(completeFixturePayment(state), { type: "CUSTOMER_ADVANCE" });
  }
  expect(state.payment).toEqual({ method: "cash", tenderedPence: 500, tenderedCash: [500],
    tenderedCashRecorded: true, received: false, selectedChange: [] });
  expect(getCheckoutTotal(state)).toBe(400);
  return step(state, { type: "SAVE_POSE", pose: { x: -2.62, z: -1.06, yaw: Math.PI, pitch: .56 } });
}

async function start(page: Page): Promise<void> {
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function launchFixture(page: Page, fixture: SimState): Promise<void> {
  expect(validateSimState(fixture)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await start(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#s3-pause")).toBeVisible();
  if (!(await page.locator("#s3-import").isVisible())) await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({ name: "cash-visual-real-reducer.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)) });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
  await expect(page.locator("#s3-target-action")).toContainText("现金", { timeout: 25_000 });
}

async function openCash(page: Page): Promise<void> {
  await page.keyboard.press("e");
  await expect(page.locator("#s3-cash-dialog")).toBeVisible();
  await expect(page.locator("#s3-cash-visual-host")).toHaveAttribute("data-renderer", "ready");
  await expect(page.locator(visualCanvas)).toBeVisible();
  await expect(page.locator("#s3-cash-visual-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
}

/**
 * Compute a screen point OFFLINE using only public renderer inputs and its normal
 * camera layout. No browser scene/mesh bridge is read or modified. An actual ray
 * must hit a real cash-piece surface with the intended guarded action, not a label
 * or compartment floor. Changes in geometry/camera deliberately fail this contract.
 */
function projectCashPiece(state: SimState, action: CashVisualPick, width: number, height: number): { x: number; y: number } {
  const engine = new NullEngine({ renderWidth: Math.round(width), renderHeight: Math.round(height),
    textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
  engine.createCanvas = ((canvasWidth: number, canvasHeight: number) => ({
    width: canvasWidth, height: canvasHeight, remove() {}, getContext: () => ({
      fillRect() {}, strokeRect() {}, fillText() {}, clearRect() {}, drawImage() {},
      fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "center", textBaseline: "middle",
    }),
  })) as unknown as NullEngine["createCanvas"];
  const scene = new Scene(engine);
  let visual: CashDrawerVisual | undefined;
  try {
    const camera = new UniversalCamera("offline-cash-camera", new Vector3(.18, 1.9, 1.61), scene);
    camera.setTarget(new Vector3(.18, 0, .19));
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.minZ = .01; camera.maxZ = 6;
    const aspect = Math.max(.5, engine.getRenderWidth() / engine.getRenderHeight());
    const halfHeight = Math.max(.37, .52 / aspect);
    camera.orthoLeft = -halfHeight * aspect; camera.orthoRight = halfHeight * aspect;
    camera.orthoTop = halfHeight; camera.orthoBottom = -halfHeight;
    scene.activeCamera = camera;
    visual = new CashDrawerVisual(scene, new TransformNode("offline-cash-root", scene), { name: "offline", reducedMotion: true,
      changePosition: { x: .46, y: -.02, z: .42 } });
    visual.update(deriveCashVisualState({ payment: state.payment, cashDrawer: state.cashDrawer,
      amountPence: getCheckoutTotal(state), checkout: true, open: true, canInteract: true }));
    for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
    scene.setTransformMatrix(camera.getViewMatrix(true), camera.getProjectionMatrix(true));
    const surfaces = scene.meshes.filter((mesh) => mesh.isEnabled() && mesh.name.endsWith("-print")
      && mesh.metadata?.kind === "cash-piece-surface" && JSON.stringify(visual!.pick(mesh)) === JSON.stringify(action));
    // The highest/last visible piece is physically reachable; lower stack samples
    // may be covered by that piece and must not be selected through it.
    for (const surface of surfaces.reverse()) {
      const centre = surface.getBoundingInfo().boundingBox.centerWorld;
      const screen = Vector3.Project(centre, Matrix.Identity(), scene.getTransformMatrix(),
        camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
      // Match the live viewport: non-actionable housing/tray geometry still
      // occludes money, even when its meshes are intentionally non-pickable.
      const hit = scene.pick(screen.x, screen.y,
        (mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0)?.pickedMesh;
      if (!hit || hit.metadata?.kind !== "cash-piece-surface"
        || JSON.stringify(visual.pick(hit)) !== JSON.stringify(action)) continue;
      return { x: screen.x / engine.getRenderWidth() * width, y: screen.y / engine.getRenderHeight() * height };
    }
    throw new Error(`No visible real 3D cash surface for ${JSON.stringify(action)} at ${width} × ${height}`);
  } finally { visual?.dispose(); scene.dispose(); engine.dispose(); }
}

async function clickCashPiece(page: Page, action: CashVisualPick): Promise<void> {
  const canvas = page.locator(visualCanvas);
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toBeInViewport();
  // Let normal resize/paint observers settle after scrolling or a narrow resize.
  await canvas.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const position = projectCashPiece(await readBrowserSnapshot(page), action, bounds!.width, bounds!.height);
  expect(position.x).toBeGreaterThan(0); expect(position.x).toBeLessThan(bounds!.width);
  expect(position.y).toBeGreaterThan(0); expect(position.y).toBeLessThan(bounds!.height);
  await canvas.click({ position });
}

function unchangedMoney(actual: SimState, expected: SimState): void {
  expect(actual.cashPence).toBe(expected.cashPence);
  expect(actual.cashDrawer).toEqual(expected.cashDrawer);
  expect(actual.cashJournal).toEqual(expected.cashJournal);
  expect(actual.transactions).toEqual(expected.transactions);
}

async function finishCash(page: Page, fixture: SimState): Promise<void> {
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£1.00");
  await expect(page.locator("#s3-cash-confirm")).toBeEnabled();
  await page.locator("#s3-cash-confirm").click();
  await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已收款");
  const paid = await readBrowserSnapshot(page);
  expect(paid.transactions).toHaveLength(fixture.transactions.length + 1);
  expect(paid.transactions.at(-1)).toMatchObject({ amountPence: 400, paymentMethod: "cash", tenderedPence: 500, changePence: 100 });
  expect(paid.cashPence).toBe(fixture.cashPence + 400);
  expect(paid.cashDrawer).toEqual({ ...fixture.cashDrawer, 50: fixture.cashDrawer[50] - 2, 500: fixture.cashDrawer[500] + 1 });
}

test("cash visual v4: real canvas tender, drawer coins and tray undo share one ledger and survive closing", async ({ page }, testInfo) => {
  test.setTimeout(110_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = cashFixture();
  await launchFixture(page, fixture);
  await page.screenshot({ path: testInfo.outputPath("cash-v4-real-counter.png") });
  await openCash(page);
  await expect(page.locator("#s3-cash-tendered")).toHaveText("£5.00");
  await expect(page.locator("#s3-cash-visual-source")).toHaveText("顾客交款面额（已记录）");
  await clickCashPiece(page, { kind: "receive" });
  await expect(page.locator("#s3-cash-received-note")).toBeVisible();
  expect((await readBrowserSnapshot(page)).payment).toMatchObject({ received: true, selectedChange: [] });
  unchangedMoney(await readBrowserSnapshot(page), fixture);
  await clickCashPiece(page, { kind: "add", denominationPence: 50 });
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.50");
  await expect(page.locator("#s3-cash-stock-50")).toHaveText(`剩余 ${fixture.cashDrawer[50] - 1}`);
  await page.locator(visualCanvas).screenshot({ path: testInfo.outputPath("cash-v4-tender-and-selected-50p.png") });
  await clickCashPiece(page, { kind: "remove", index: 0 });
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.00");
  await expect(page.locator("#s3-cash-stock-50")).toHaveText(`剩余 ${fixture.cashDrawer[50]}`);
  await clickCashPiece(page, { kind: "add", denominationPence: 50 });
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.50");
  const reserved = await readBrowserSnapshot(page);
  await page.locator("#s3-cash-visual-toggle").click();
  await expect(page.locator("#s3-cash-visual-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#s3-cash-visual-status")).toContainText("钱箱已合上");
  await expect(page.locator("#s3-cash-add-50")).toBeDisabled();
  await expect(page.locator("#s3-cash-remove-0")).toBeDisabled();
  expect((await readBrowserSnapshot(page)).payment).toEqual(reserved.payment);
  unchangedMoney(await readBrowserSnapshot(page), fixture);
  await page.locator("#s3-cash-visual-toggle").click();
  await expect(page.locator("#s3-cash-visual-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.50");
  await page.locator("#s3-cash-close").click();
  await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  await openCash(page);
  expect((await readBrowserSnapshot(page)).payment).toEqual(reserved.payment);
  await clickCashPiece(page, { kind: "add", denominationPence: 50 });
  unchangedMoney(await readBrowserSnapshot(page), fixture);
  await finishCash(page, fixture);
  expect(errors).toEqual([]);
});

test("cash visual v4: narrow-screen WebGL loss preserves a 3D selection and accessible buttons finish payment", async ({ page }, testInfo) => {
  test.setTimeout(110_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = step(cashFixture(), { type: "RECEIVE_CASH" });
  await launchFixture(page, fixture);
  await page.setViewportSize({ width: 430, height: 800 });
  await openCash(page);
  await clickCashPiece(page, { kind: "add", denominationPence: 50 });
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£0.50");
  const reserved = await readBrowserSnapshot(page);
  const dialog = page.locator("#s3-cash-dialog");
  const dimensions = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, viewport: innerWidth,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  await page.locator(visualCanvas).screenshot({ path: testInfo.outputPath("cash-v4-narrow-real-canvas.png") });
  await page.locator("#s3-cash-visual-toggle").click();
  await expect(page.locator("#s3-cash-visual-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#s3-cash-add-50")).toBeDisabled();
  await expect(page.locator("#s3-cash-remove-0")).toBeDisabled();
  await expect(page.locator("#s3-cash-reset")).toBeDisabled();
  expect((await readBrowserSnapshot(page)).payment).toEqual(reserved.payment);
  // Fault injection targets the browser's actual WebGL context, not application
  // state or a renderer factory. Losing the CLOSED visual must immediately undo
  // its disabled-control gate. The main shop canvas is intentionally untouched.
  const lost = await page.locator(visualCanvas).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const extension = context?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    return true;
  });
  expect(lost, "Chromium must expose WEBGL_lose_context to exercise actual fallback").toBe(true);
  await expect(page.locator("#s3-cash-visual-host")).toHaveAttribute("data-renderer", "fallback");
  await expect(page.locator(visualCanvas)).toBeHidden();
  await expect(page.locator("#s3-cash-visual-status")).toContainText("现金和找零已保留");
  await expect(page.locator("#s3-cash-visual-toggle")).toBeDisabled();
  // No money action or modal reopen is allowed to trigger this recovery redraw.
  await expect(page.locator("#s3-cash-add-50")).toBeEnabled();
  await expect(page.locator("#s3-cash-remove-0")).toBeEnabled();
  await expect(page.locator("#s3-cash-reset")).toBeEnabled();
  expect((await readBrowserSnapshot(page)).payment).toEqual(reserved.payment);
  unchangedMoney(await readBrowserSnapshot(page), fixture);
  const add = page.locator("#s3-cash-add-50");
  await add.scrollIntoViewIfNeeded();
  await expect(add).toBeInViewport();
  await expect(add).toBeEnabled();
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#s3-cash-selected-total")).toHaveText("£1.00");
  await expect(page.locator("#s3-cash")).toHaveText(money(fixture.cashPence));
  await page.locator("#s3-cash-confirm").scrollIntoViewIfNeeded();
  await expect(page.locator("#s3-cash-confirm")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("cash-v4-narrow-fallback-controls.png") });
  await finishCash(page, fixture);
  expect(errors).toEqual([]);
});
