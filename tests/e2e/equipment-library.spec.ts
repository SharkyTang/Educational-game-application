import { expect, test, type Download, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { EQUIPMENT_ASSET_IDS, EQUIPMENT_ASSETS, type EquipmentAssetId } from "../../src/sim3d/equipment-library/catalog";

// All interactions use a disposable context and the public UI, never a game/save bridge.
test.use({ viewport: { width: 1440, height: 1050 } });

function monitorRuntime(page: Page, checkThumbnailResponses = true): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    // The final export test bootstraps the PNGs. Actual thumbnail availability is
    // strictly verified by the first test after those generated files are installed.
    const thumbnail = /\/assets\/sim3d\/equipment\/[^/]+\.png(?:\?|$)/.test(response.url());
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400 && (checkThumbnailResponses || !thumbnail)) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

async function openEquipment(page: Page, id: EquipmentAssetId = "self-checkout-compact"): Promise<void> {
  await page.goto(`/?assets=equipment&equipment=${id}`);
  await expect(page.locator("#el-model-state")).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
  await expect(page.locator("#el-model-state")).toHaveAttribute("data-equipment-id", id);
}

async function downloadFromUi(page: Page, selector: string, filename: string): Promise<Download> {
  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20_000, predicate: (event) => event.suggestedFilename() === filename }),
      page.locator(selector).click(),
    ]);
    return download;
  } catch (error) {
    const id = await page.locator("#el-equipment-id").textContent({ timeout: 1000 }).catch(() => "页面已离开");
    const notice = await page.locator("#el-notice").textContent({ timeout: 1000 }).catch(() => "无页面提示");
    throw new Error(`设备 ${id} 下载 ${filename} 失败；页面提示：${notice}；${error instanceof Error ? error.message : String(error)}`);
  }
}

interface GltfNode {
  name?: string;
  mesh?: number;
  extras?: { equipmentId?: string; assetType?: string; baseAnchored?: boolean; placementSlots?: unknown[] };
}
interface ExportedGltf {
  meshes: unknown[];
  nodes: GltfNode[];
  cameras?: unknown[];
  images?: { uri?: string; bufferView?: number }[];
  extensions?: { KHR_lights_punctual?: unknown };
}

function verifyGlb(glb: Buffer, id: EquipmentAssetId): ExportedGltf {
  expect(glb.readUInt32LE(0), id).toBe(0x46546c67);
  expect(glb.readUInt32LE(4), id).toBe(2);
  expect(glb.readUInt32LE(8), id).toBe(glb.length);
  expect(glb.readUInt32LE(16), id).toBe(0x4e4f534a);
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as ExportedGltf;
  expect(gltf.meshes.length, id).toBeGreaterThan(0);
  expect(gltf.cameras ?? [], id).toHaveLength(0);
  expect(gltf.extensions?.KHR_lights_punctual, id).toBeUndefined();
  expect(gltf.nodes.some((node) => /equipment-library-(plinth|camera|fill|key|rim)|equipment-placement-markers|equipment-slot-marker-/.test(node.name ?? "")), id).toBe(false);
  const root = gltf.nodes.find((node) => node.extras?.equipmentId === id);
  expect(root?.extras?.assetType, id).toBe("equipment");
  expect(root?.extras?.baseAnchored, id).toBe(true);
  expect(root?.extras?.placementSlots, id).toHaveLength(EQUIPMENT_ASSETS[id].capacity);
  for (const image of gltf.images ?? []) {
    expect(image.uri ?? "", id).not.toMatch(/^https?:\/\//);
    expect(typeof image.bufferView === "number" || image.uri?.startsWith("data:"), id).toBe(true);
  }
  return gltf;
}

test("equipment library: all 12 real models and thumbnails show actual dimensions, capacity and geometry", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = monitorRuntime(page);
  await openEquipment(page);
  await expect(page.locator("#el-total")).toHaveText("12");
  await expect(page.locator("#el-integrated")).toHaveText("00");
  await expect(page.locator("#el-equipment-list [data-equipment-id]")).toHaveCount(12);
  for (const id of EQUIPMENT_ASSET_IDS) {
    const asset = EQUIPMENT_ASSETS[id];
    const item = page.locator(`#el-equipment-list [data-equipment-id="${id}"]`);
    await item.click();
    await expect(item.locator("img")).toHaveAttribute("src", asset.thumbnailUrl);
    await expect.poll(() => item.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.locator("#el-model-state")).toHaveAttribute("data-equipment-id", id);
    await expect(page.locator("#el-model-state")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await expect(page.locator("#el-equipment-name")).toHaveText(asset.nameZh);
    await expect(page.locator("#el-equipment-id")).toHaveText(id);
    await expect(page.locator("#el-gameplay-status")).toHaveText("素材就绪 · 未接入经营");
    await expect(page.locator("#el-bounds")).toHaveText(/\d+\.\d+ × \d+\.\d+ × \d+\.\d+/);
    await expect(page.locator("#el-footprint")).toContainText("m²");
    await expect(page.locator("#el-slot-count")).toHaveText(String(asset.capacity));
    await expect(page.locator("#el-capacity-label")).toHaveText(asset.capacityLabel);
    await expect(page.locator("#el-slot-size")).toContainText(" × ");
    expect(Number(await page.locator("#el-mesh-count").textContent()), id).toBeGreaterThan(0);
    expect(Number((await page.locator("#el-triangle-count").textContent())!.replaceAll(",", "")), id).toBeGreaterThan(0);
    await expect(page.locator("#el-download-glb")).toBeEnabled();
    if (asset.category === "checkout") await expect(page.locator("#el-integration-note")).toContainText("不执行真实结算或收款");
  }
  expect(errors).toEqual([]);
});

test("equipment library: three categories, bilingual search, empty state, deep link and manual copy fallback", async ({ page }) => {
  const errors = monitorRuntime(page);
  await openEquipment(page, "island-chiller");
  for (const [category, count] of [["checkout", 2], ["refrigeration", 3], ["display", 7]] as const) {
    await page.locator(`[data-el-category="${category}"]`).click();
    await expect(page.locator("#el-equipment-list [data-equipment-id]")).toHaveCount(count);
  }
  await page.locator("#el-search").fill("玻璃面包");
  await expect(page.locator("#el-equipment-id")).toHaveText("bakery-glass");
  await page.locator("#el-search").fill("GONDOLA");
  await expect(page.locator("#el-equipment-list [data-equipment-id]")).toHaveCount(2);
  await page.locator("#el-search").fill("missing-equipment");
  await expect(page.locator("#el-empty")).toBeVisible();
  await page.locator("#el-clear-filters").click();
  await expect(page.locator("#el-equipment-list [data-equipment-id]")).toHaveCount(12);
  await page.locator("#el-search").fill("CHEST-CHILLER-WIDE");
  await expect(page.locator("#el-equipment-id")).toHaveText("chest-chiller-wide");
  await expect(page).toHaveURL(/assets=equipment&equipment=chest-chiller-wide/);
  await page.getByText("查看调用示例", { exact: true }).click();
  await expect(page.locator("#el-code")).toContainText('createEquipmentAsset(scene, "chest-chiller-wide"');
  await expect(page.locator("#el-code")).toContainText("equipmentSlotWorldPosition");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("Test clipboard denial")) } });
  });
  await page.locator("#el-copy-code").click();
  await expect(page.locator("#el-copy-fallback")).toBeVisible();
  await expect(page.locator("#el-copy-text")).toHaveValue(/createEquipmentAsset\(scene, "chest-chiller-wide"/);
  await page.locator("#el-copy-id").click();
  await expect(page.locator("#el-copy-text")).toHaveValue("chest-chiller-wide");
  await page.reload();
  await expect(page.locator("#el-model-state")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(page.locator("#el-equipment-id")).toHaveText("chest-chiller-wide");
  expect(errors).toEqual([]);
});

test("equipment library: slot envelopes toggle, selection stays coherent, and GLB excludes markers and display scenery", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = monitorRuntime(page);
  await openEquipment(page, "chest-chiller-compact");
  await expect(page.locator("#el-show-slots")).not.toBeChecked();
  await expect(page.locator("#el-slot-preview-status")).toHaveAttribute("data-visible-count", "0");
  await page.locator("#el-show-slots").check();
  await expect(page.locator("#el-slot-preview-status")).toHaveAttribute("data-visible-count", "24");
  await page.locator("#el-slot-details-summary").click();
  await expect(page.locator("#el-slot-table tr")).toHaveCount(24);
  await page.locator('#el-equipment-list [data-equipment-id="wall-shelf-wide"]').click();
  await page.locator('#el-equipment-list [data-equipment-id="self-checkout-bagging"]').click();
  await page.locator('#el-equipment-list [data-equipment-id="island-chiller"]').click();
  await expect(page.locator("#el-model-state")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(page.locator("#el-model-state")).toHaveAttribute("data-equipment-id", "island-chiller");
  await expect(page.locator("#el-slot-preview-status")).toHaveAttribute("data-visible-count", "72");
  await expect(page.locator("#el-slot-table tr")).toHaveCount(72);
  const meshes = await page.locator("#el-mesh-count").textContent();
  await page.locator("#el-rotate-left").click();
  await page.locator("#el-rotate-right").click();
  await page.getByRole("button", { name: "放大设备", exact: true }).click();
  await page.locator("#el-reset-view").click();
  const model = await downloadFromUi(page, "#el-download-glb", "corner-shop-island-chiller.glb");
  const gltf = verifyGlb(await readFile((await model.path())!), "island-chiller");
  expect(gltf.nodes.filter((node) => typeof node.mesh === "number")).toHaveLength(Number(meshes));
  await page.locator("#el-show-slots").uncheck();
  await expect(page.locator("#el-slot-preview-status")).toHaveAttribute("data-visible-count", "0");
  await expect(page.locator("#el-mesh-count")).toHaveText(meshes!);
  const manifestDownload = await downloadFromUi(page, "#el-download-manifest", "corner-shop-equipment-library.json");
  const manifest = JSON.parse(await readFile((await manifestDownload.path())!, "utf8"));
  expect(manifest.equipment).toHaveLength(12);
  expect(manifest.units).toBe("metres");
  expect(manifest.equipment.every((entry: { gameplay: string }) => entry.gameplay === "library-only")).toBe(true);
  expect(errors).toEqual([]);
});

test("equipment library: 390px view scrolls without overflow and navigates to the original product library", async ({ page }) => {
  test.setTimeout(75_000);
  const errors = monitorRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openEquipment(page, "gondola-tall");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator("#el-download-glb").scrollIntoViewIfNeeded();
  await expect(page.locator("#el-download-glb")).toBeVisible();
  await page.locator("#el-show-slots").check();
  await expect(page.locator("#el-slot-preview-status")).toHaveAttribute("data-visible-count", "48");
  await page.locator("#el-products-link").click();
  await expect(page.locator("#pl-model-state")).toHaveAttribute("data-state", "ready", { timeout: 40_000 });
  await expect(page.locator("#pl-product-list [data-product-id]")).toHaveCount(30);
  await page.locator("#pl-equipment-library").click();
  await expect(page.locator("#el-model-state")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(page.locator("#el-equipment-list [data-equipment-id]")).toHaveCount(12);
  expect(errors).toEqual([]);
});

test("equipment library: export all 12 GLBs, clean real model PNGs and the JSON manifest", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = monitorRuntime(page, false);
  const outputDirectory = path.resolve("tmp/equipment-library-exports");
  await mkdir(outputDirectory, { recursive: true });
  await openEquipment(page);
  const manifest = await downloadFromUi(page, "#el-download-manifest", "corner-shop-equipment-library.json");
  await manifest.saveAs(path.join(outputDirectory, "catalog.json"));
  expect(JSON.parse(await readFile(path.join(outputDirectory, "catalog.json"), "utf8")).equipment).toHaveLength(12);
  for (const id of EQUIPMENT_ASSET_IDS) {
    await page.locator(`#el-equipment-list [data-equipment-id="${id}"]`).click();
    await expect(page.locator("#el-model-state")).toHaveAttribute("data-equipment-id", id);
    await expect(page.locator("#el-model-state")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await page.locator("#el-show-slots").uncheck();
    await page.locator("#el-reset-view").click();
    await page.locator("#el-canvas").screenshot({
      path: path.join(outputDirectory, `${id}.png`),
      style: ".equipment-library-app .el-stage-heading, .equipment-library-app .el-stage-bottom { visibility: hidden !important; }",
    });
    const download = await downloadFromUi(page, "#el-download-glb", `corner-shop-${id}.glb`);
    const filename = path.join(outputDirectory, `${id}.glb`);
    await download.saveAs(filename);
    verifyGlb(await readFile(filename), id);
    await expect(page.locator("#el-notice")).toContainText(`${EQUIPMENT_ASSETS[id].nameZh} GLB 已下载`);
    await expect(page.locator("#el-download-glb")).toBeEnabled();
  }
  expect(errors).toEqual([]);
});
