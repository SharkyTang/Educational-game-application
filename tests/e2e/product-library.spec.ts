import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCT_ASSET_IDS, PRODUCT_ASSETS } from "../../src/sim3d/product-library/catalog";

// Every test uses a disposable Playwright context. No existing browser or game save is touched.
test.use({ viewport: { width: 1440, height: 1000 } });

function monitorRuntime(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

async function openLibrary(page: Page, id = "milk"): Promise<void> {
  await page.goto(`/?assets=1&product=${id}`);
  await expect(page.locator("#pl-model-state")).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
  await expect(page.locator("#pl-model-state")).toHaveAttribute("data-product-id", id);
}

test("product library: all 30 real models are selectable with measured geometry and honest integration/audio status", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = monitorRuntime(page);
  await openLibrary(page);
  await expect(page.locator("#pl-total")).toHaveText("30");
  await expect(page.locator("#pl-active")).toHaveText("30");
  await expect(page.locator("#pl-pending")).toHaveText("0");
  await expect(page.locator("#pl-shop-supply")).toHaveAttribute("href", "/");
  await expect(page.locator("#pl-product-list [data-product-id]")).toHaveCount(30);
  await expect(page.locator("#pl-product-list .pl-item-thumbnail")).toHaveCount(30);
  for (const id of PRODUCT_ASSET_IDS) {
    await page.locator(`[data-product-id="${id}"]`).filter({ has: page.locator(".pl-item-name") }).click();
    await expect(page.locator(`#pl-product-list [data-product-id="${id}"] img`)).toHaveAttribute("src", PRODUCT_ASSETS[id].thumbnailUrl);
    await expect.poll(() => page.locator(`#pl-product-list [data-product-id="${id}"] img`).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.locator("#pl-model-state")).toHaveAttribute("data-product-id", id);
    await expect(page.locator("#pl-model-state")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await expect(page.locator("#pl-product-name")).toHaveText(PRODUCT_ASSETS[id].nameZh);
    await expect(page.locator("#pl-product-id")).toHaveText(id);
    await expect(page.locator("#pl-bounds")).toHaveText(/\d+\.\d+ × \d+\.\d+ × \d+\.\d+/);
    expect(Number(await page.locator("#pl-mesh-count").textContent())).toBeGreaterThan(0);
    expect(Number((await page.locator("#pl-triangle-count").textContent())!.replaceAll(",", ""))).toBeGreaterThan(0);
    await expect(page.locator("#pl-download-glb")).toBeEnabled();
    await expect(page.locator("#pl-gameplay-status")).toHaveText(PRODUCT_ASSETS[id].gameplay === "active" ? "已接入游戏" : "素材就绪 · 待接入");
    await expect(page.locator("#pl-audio-status")).toHaveText(PRODUCT_ASSETS[id].audio ? "已配音 · 单词与短语" : "待配音 · 暂无音频");
  }
  await page.locator("#pl-rotate-left").click();
  await page.locator("#pl-rotate-right").click();
  await page.getByRole("button", { name: "放大模型", exact: true }).click();
  await page.locator("#pl-reset-view").click();
  await expect(page.locator("#pl-preview-error")).toBeHidden();
  expect(errors).toEqual([]);
});

test("product library: category and bilingual search, empty state, deep links, and clipboard fallback work", async ({ page }) => {
  const errors = monitorRuntime(page);
  await openLibrary(page, "orange-juice");
  await page.locator('[data-category="produce"]').click();
  await expect(page.locator("#pl-product-list [data-product-id]")).toHaveCount(8);
  await page.locator("#pl-search").fill("黄瓜");
  await expect(page.locator("#pl-product-list [data-product-id]")).toHaveCount(1);
  await expect(page.locator("#pl-product-id")).toHaveText("cucumber");
  await page.locator("#pl-search").fill("missing-product");
  await expect(page.locator("#pl-empty")).toBeVisible();
  await expect(page.locator("#pl-product-list [data-product-id]")).toHaveCount(0);
  await page.locator("#pl-clear-filters").click();
  await expect(page.locator("#pl-product-list [data-product-id]")).toHaveCount(30);
  await page.locator("#pl-search").fill("ORANGE-JUICE");
  await expect(page.locator("#pl-product-id")).toHaveText("orange-juice");
  await expect(page).toHaveURL(/product=orange-juice/);
  await page.locator("#pl-search").fill("shampoo");
  await expect(page.locator("#pl-product-id")).toHaveText("shampoo");
  await page.getByText("查看调用示例", { exact: true }).click();
  await expect(page.locator("#pl-code")).toContainText('createProductAsset(scene, "shampoo"');
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("Test clipboard denial")) } });
  });
  await page.locator("#pl-copy-code").click();
  await expect(page.locator("#pl-copy-fallback")).toBeVisible();
  await expect(page.locator("#pl-copy-text")).toHaveValue(/createProductAsset\(scene, "shampoo"/);
  await page.locator("#pl-copy-id").click();
  await expect(page.locator("#pl-copy-text")).toHaveValue("shampoo");
  await page.reload();
  await expect(page.locator("#pl-product-id")).toHaveText("shampoo");
  await expect(page.locator("#pl-model-state")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("product library: exports a complete JSON catalogue and only the selected product in GLB", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = monitorRuntime(page);
  await openLibrary(page, "cola");
  const manifestEvent = page.waitForEvent("download");
  await page.locator("#pl-download-manifest").click();
  const manifestDownload = await manifestEvent;
  expect(manifestDownload.suggestedFilename()).toBe("corner-shop-product-library.json");
  const manifest = JSON.parse(await readFile((await manifestDownload.path())!, "utf8"));
  expect(manifest.products).toHaveLength(30);
  expect(manifest.products.filter((product: { gameplay: string }) => product.gameplay === "active")).toHaveLength(30);
  expect(manifest.units).toBe("metres");
  const modelEvent = page.waitForEvent("download");
  await page.locator("#pl-download-glb").click();
  const modelDownload = await modelEvent;
  expect(modelDownload.suggestedFilename()).toBe("corner-shop-cola.glb");
  const glb = await readFile((await modelDownload.path())!);
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  expect(glb.readUInt32LE(4)).toBe(2);
  expect(glb.readUInt32LE(8)).toBe(glb.length);
  expect(glb.readUInt32LE(16)).toBe(0x4e4f534a);
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
  expect(gltf.meshes.length).toBeGreaterThan(0);
  expect(gltf.cameras ?? []).toHaveLength(0);
  expect(gltf.nodes.some((node: { name?: string }) => node.name?.includes("library-cola"))).toBe(true);
  expect(gltf.nodes.some((node: { name?: string }) => /plinth|camera|soft-fill|library-key|library-rim/.test(node.name ?? ""))).toBe(false);
  await expect(page.locator("#pl-notice")).toContainText("GLB 已下载");
  expect(errors).toEqual([]);
});

test("product library: narrow view remains scrollable and returns to the game menu without touching saves", async ({ page }) => {
  test.setTimeout(75_000);
  const errors = monitorRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openLibrary(page, "tissues");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator("#pl-product-name")).toHaveText("抽纸");
  await page.locator("#pl-download-glb").scrollIntoViewIfNeeded();
  await expect(page.locator("#pl-download-glb")).toBeVisible();
  await page.locator("#pl-search").fill("bread");
  await expect(page.locator("#pl-product-name")).toHaveText("面包");
  await page.locator("#pl-back-game").click();
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 40_000 });
  await expect(page.locator("#s3-start-capital")).toHaveText("£12.00");
  expect(errors).toEqual([]);
});

test("product library: export every model and its real canvas preview for the reusable asset collection", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = monitorRuntime(page);
  const outputDirectory = path.resolve("tmp/product-library-exports");
  await mkdir(outputDirectory, { recursive: true });
  await openLibrary(page);
  const manifestEvent = page.waitForEvent("download");
  await page.locator("#pl-download-manifest").click();
  const manifestDownload = await manifestEvent;
  const manifestPath = path.join(outputDirectory, "catalog.json");
  await manifestDownload.saveAs(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest.products).toHaveLength(PRODUCT_ASSET_IDS.length);
  for (const id of PRODUCT_ASSET_IDS) {
    await page.locator(`#pl-product-list [data-product-id="${id}"]`).click();
    await expect(page.locator("#pl-model-state")).toHaveAttribute("data-product-id", id);
    await expect(page.locator("#pl-model-state")).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await page.locator("#pl-reset-view").click();
    await page.locator("#pl-canvas").screenshot({
      path: path.join(outputDirectory, `${id}.png`),
      style: ".product-library-app .pl-stage-heading, .product-library-app .pl-stage-bottom { visibility: hidden !important; }",
    });
    const downloadEvent = page.waitForEvent("download", { timeout: 20_000 });
    await page.locator("#pl-download-glb").click();
    const download = await downloadEvent;
    const filename = path.join(outputDirectory, `${id}.glb`);
    await download.saveAs(filename);
    await expect(page.locator("#pl-notice")).toContainText(`${PRODUCT_ASSETS[id].nameZh} GLB 已下载`);
    const glb = await readFile(filename);
    expect(glb.readUInt32LE(0), id).toBe(0x46546c67);
    expect(glb.readUInt32LE(4), id).toBe(2);
    expect(glb.readUInt32LE(8), id).toBe(glb.length);
    expect(glb.readUInt32LE(16), id).toBe(0x4e4f534a);
    const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));
    expect(gltf.meshes.length, id).toBeGreaterThan(0);
    expect(gltf.cameras ?? [], id).toHaveLength(0);
    expect(gltf.nodes.some((node: { name?: string }) => node.name?.includes(`library-${id}`)), id).toBe(true);
    expect(gltf.nodes.some((node: { name?: string }) => /plinth|camera|soft-fill|library-key|library-rim/.test(node.name ?? "")), id).toBe(false);
    expect(gltf.extensions?.KHR_lights_punctual, id).toBeUndefined();
    for (const image of gltf.images ?? []) {
      expect(image.uri ?? "", id).not.toMatch(/^https?:\/\//);
      expect(typeof image.bufferView === "number" || image.uri?.startsWith("data:"), id).toBe(true);
    }
    await expect(page.locator("#pl-download-glb")).toBeEnabled();
  }
  expect(errors).toEqual([]);
});
