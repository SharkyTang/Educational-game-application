import { expect, test, type Page } from "@playwright/test";
import {
  createFirstDayState,
  getDaySummary,
  PRODUCTS,
  reduceSim,
  validateSimState,
  type SimCommand,
  type SimState,
} from "../../src/sim3d/domain";
import { EQUIPMENT_COMMERCE_CATALOG } from "../../src/sim3d/equipmentCommerce";
import { productInStoreCapacity } from "../../src/sim3d/equipmentStock";
import {
  SECOND_SHOP_EXPANSION_COST_PENCE,
  SHOP_EXPANSION_COST_PENCE,
  getShopAchievements,
} from "../../src/sim3d/shopDevelopment";
import { shopBounds } from "../../src/sim3d/shopLayout";
import { completeFixturePayment, readBrowserSnapshot } from "./helpers/sim3d-payment";

// The fixture is created only through the public reducer. The test then buys,
// places and expands through the same controls a player uses.
test.describe.configure({ mode: "default" });
test.use({ viewport: { width: 1365, height: 900 } });

const EQUIPMENT_ID = "wall-shelf-narrow" as const;
const PRODUCT_ID = "cereal" as const;
const INSTANCE_ID = "shop-equipment-1";
// Visitors 3–21 are cards for this deterministic seed; visitor 2 is the
// mandatory first cash lesson and pays the exact £5 bread+cereal basket.
const FIXTURE_CUSTOMER_SEED = 1_897_164;
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed || !validateSimState(result.state)) {
    throw new Error(`${command.type}: ${result.message ?? "invalid equipment-store fixture"}`);
  }
  return result.state;
}

/** Earn enough through seven normal trading days for £15 + £6 + £30. */
function firstExpansionWithEarnedCapital(): SimState {
  let state = createFirstDayState();
  state.customerSeed = FIXTURE_CUSTOMER_SEED;
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    if (dayIndex > 0) state = step(state, { type: "START_NEXT_DAY" });
    state = step(state, {
      type: "PURCHASE_STOCK",
      orderId: `equipment-growth-day-${state.day.number}`,
      lines: [{ productId: "bread", quantity: 3 }, { productId: "cereal", quantity: 3 }],
    });
    state = step(state, { type: "RECEIVE_DELIVERY" });
    for (const productId of ["bread", "cereal"] as const) {
      const crate = state.crates.find((candidate) => candidate.productId === productId)!;
      state = step(state, { type: "PICK_CRATE", crateId: crate.id });
      for (let slot = 0; slot < 3; slot += 1) state = step(state, { type: "STOCK", productId, slot });
      state = step(state, { type: "DROP_HELD", position: crate.position });
    }
    for (let visitor = 0; visitor < 3; visitor += 1) {
      state = step(state, { type: visitor === 0 ? "OPEN_STORE" : "NEXT_CUSTOMER" });
      while (["to-milk", "to-bread", "to-checkout"].includes(state.customer.phase)) {
        state = step(state, { type: "CUSTOMER_ADVANCE" });
      }
      for (const item of state.items.filter((candidate) => candidate.location.kind === "checkout")) {
        state = step(state, { type: "SCAN", itemId: item.id });
      }
      state = completeFixturePayment(state);
      state = step(state, { type: "CUSTOMER_ADVANCE" });
    }
    state = step(state, { type: "CLOSE_STORE" });
    state = step(state, { type: "SETTLE_DAY" });
  }
  expect(state.cashPence).toBe(5610);
  state = step(state, { type: "BUY_SPACE_EXPANSION" });
  expect(state.renovation.layout.expansion).toBe(1);
  expect(state.cashPence).toBe(4110);
  return state;
}

function runtimeErrors(page: Page): string[] {
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

async function openManagement(page: Page): Promise<void> {
  if (!(await page.locator("#s3-pause").isVisible())) await page.keyboard.press("b");
  await expect(page.locator("#s3-pause")).toBeVisible();
}

async function importFixture(page: Page, state: SimState): Promise<void> {
  expect(validateSimState(state)).toBe(true);
  await openManagement(page);
  if (!(await page.locator("#s3-import").isVisible())) {
    await page.getByText("存档与试玩管理", { exact: true }).click();
  }
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({
    name: "equipment-growth-audited-save.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(state)),
  });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
}

test("equipment growth: buy, place and persist a real shelf before the £30 second extension", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors = runtimeErrors(page);
  const fixture = firstExpansionWithEarnedCapital();
  const equipmentPrice = EQUIPMENT_COMMERCE_CATALOG[EQUIPMENT_ID].pricePence;
  const equipmentCapacity = EQUIPMENT_COMMERCE_CATALOG[EQUIPMENT_ID].capacity;

  await page.goto("/");
  await start(page);
  await importFixture(page, fixture);
  await openManagement(page);

  await page.locator("#s3-tab-equipment").click();
  await expect(page.locator("#s3-panel-equipment")).toBeVisible();
  await expect(page.locator("#s3-equipment-title")).toHaveText("设备商店与仓库");
  await expect(page.locator(".s3-equipment-card")).toHaveCount(6);
  await expect(page.locator("#s3-equipment-owned")).toHaveText("0");
  await expect(page.locator("#s3-equipment-warehouse-count")).toHaveText("0");

  await page.locator(`#s3-equipment-product-${EQUIPMENT_ID}`).selectOption(PRODUCT_ID);
  await expect(page.locator(`#s3-equipment-balance-${EQUIPMENT_ID}`)).toHaveText(`购买后 ${money(fixture.cashPence - equipmentPrice)}`);
  await page.locator(`#s3-equipment-buy-${EQUIPMENT_ID}`).click();
  await expect(page.locator(`#s3-equipment-confirmation-${EQUIPMENT_ID}`)).toBeVisible();
  await expect(page.locator(`#s3-equipment-confirm-copy-${EQUIPMENT_ID}`)).toContainText("设备先存入仓库，不赠送商品");
  await page.locator(`#s3-equipment-confirm-${EQUIPMENT_ID}`).click();

  await expect(page.locator("#s3-equipment-cash")).toHaveText(money(fixture.cashPence - equipmentPrice));
  await expect(page.locator("#s3-equipment-owned")).toHaveText("1");
  await expect(page.locator("#s3-equipment-active")).toHaveText("0");
  await expect(page.locator("#s3-equipment-warehouse-count")).toHaveText("1");
  await expect(page.locator("#s3-equipment-warehouse-list")).toContainText("仓库待摆");
  await expect(page.locator("#s3-equipment-warehouse-list")).toContainText(PRODUCTS[PRODUCT_ID].nameZh);

  const purchased = await readBrowserSnapshot(page);
  expect(purchased.equipment.instances).toEqual([{
    id: INSTANCE_ID,
    assetId: EQUIPMENT_ID,
    productId: PRODUCT_ID,
    purchasedDay: fixture.day.number,
  }]);
  expect(purchased.renovation.layout.equipment).toEqual([]);
  expect(productInStoreCapacity(false, purchased.equipment, purchased.renovation.layout.equipment, PRODUCT_ID)).toBe(4);

  await page.locator("#s3-equipment-to-layout").click();
  await expect(page.locator("#s3-layout-map")).toBeVisible();
  await page.locator("#s3-layout-select").selectOption(INSTANCE_ID);
  await expect(page.locator("#s3-layout-equipment-toggle")).toHaveText("从仓库摆入店内");
  await page.locator("#s3-layout-equipment-toggle").click();
  await expect(page.locator(`[data-layout-fixture="${INSTANCE_ID}"]`)).toBeVisible();
  await expect(page.locator("#s3-layout-equipment-toggle")).toHaveText("收回设备仓库");
  await expect(page.locator("#s3-layout-validation")).toContainText("位置可用");
  await expect(page.locator("#s3-layout-apply")).toBeEnabled();
  await page.locator("#s3-layout-apply").click();
  await expect(page.locator("#s3-layout-dirty")).toHaveText("已保存");

  await page.locator("#s3-tab-equipment").click();
  await expect(page.locator("#s3-equipment-active")).toHaveText("1");
  await expect(page.locator("#s3-equipment-warehouse-count")).toHaveText("0");
  await expect(page.locator("#s3-equipment-warehouse-list")).toContainText("店内使用");

  const placed = await readBrowserSnapshot(page);
  expect(placed.renovation.layout.equipment).toHaveLength(1);
  expect(placed.renovation.layout.equipment[0]).toMatchObject({ instanceId: INSTANCE_ID });
  expect(productInStoreCapacity(false, placed.equipment, placed.renovation.layout.equipment, PRODUCT_ID))
    .toBe(4 + equipmentCapacity);
  expect(placed.items).toEqual(fixture.items);
  expect(placed.transactions).toEqual(fixture.transactions);

  await page.locator("#s3-tab-development").click();
  await expect(page.locator("#s3-growth-area")).toHaveText("83.0 m²");
  await expect(page.locator("#s3-growth-stage")).toContainText("小卖铺扩建 1 / 3");
  await expect(page.locator("#s3-extension-title")).toContainText("第二次扩建");
  await expect(page.locator("#s3-extension-price")).toHaveText("£30.00 · 一次性");
  await expect(page.locator("#s3-buy-space")).toHaveText("£30.00 · 查看第 2 次扩建");
  await page.locator("#s3-buy-space").click();
  await expect(page.locator("#s3-extension-confirm")).toBeVisible();
  await expect(page.locator("#s3-extension-confirm-cost")).toContainText("由 83.0 m² 增至 103.4 m²");
  await page.locator("#s3-confirm-space").click();

  const expectedCash = fixture.cashPence - equipmentPrice - SECOND_SHOP_EXPANSION_COST_PENCE;
  await expect(page.locator("#s3-cash")).toHaveText(money(expectedCash));
  await expect(page.locator("#s3-growth-area")).toHaveText("103.4 m²");
  await expect(page.locator("#s3-growth-stage")).toContainText("小卖铺扩建 2 / 3");
  await expect(page.locator("#s3-buy-space")).toBeDisabled();
  await expect(page.locator("#s3-buy-space")).toHaveText("本版两次扩建已完成");
  await expect(page.locator("#s3-achievement-second-extension")).toHaveAttribute("aria-label", /已达成/);

  await page.locator("#s3-tab-day").click();
  await expect(page.locator("#s3-day-expansion")).toHaveText(money(SHOP_EXPANSION_COST_PENCE + SECOND_SHOP_EXPANSION_COST_PENCE));
  await expect(page.locator("#s3-day-equipment")).toHaveText(money(equipmentPrice));
  const completed = await readBrowserSnapshot(page);
  expect(completed.cashPence).toBe(expectedCash);
  expect(completed.renovation.layout.expansion).toBe(2);
  expect(completed.renovation.expansionDay).toBe(fixture.day.number);
  expect(completed.renovation.secondExpansionDay).toBe(fixture.day.number);
  expect(completed.renovation.layout.equipment).toEqual(placed.renovation.layout.equipment);
  expect(shopBounds(completed.renovation.layout.expansion).maxZ).toBeCloseTo(10.6);
  expect(getShopAchievements(completed).find((achievement) => achievement.id === "second-extension"))
    .toMatchObject({ current: 1, completed: true });
  expect(getDaySummary(completed)).toMatchObject({
    expansionSpendPence: SHOP_EXPANSION_COST_PENCE + SECOND_SHOP_EXPANSION_COST_PENCE,
    equipmentSpendPence: equipmentPrice,
    closingCashPence: expectedCash,
  });

  await page.screenshot({ path: testInfo.outputPath("equipment-placed-and-second-extension.png") });
  await page.reload();
  await start(page);
  await openManagement(page);
  await page.locator("#s3-tab-equipment").click();
  await expect(page.locator("#s3-equipment-active")).toHaveText("1");
  await expect(page.locator("#s3-equipment-warehouse-list")).toContainText("店内使用");
  await page.locator("#s3-tab-development").click();
  await expect(page.locator("#s3-growth-area")).toHaveText("103.4 m²");
  const restored = await readBrowserSnapshot(page);
  expect(restored.renovation).toEqual(completed.renovation);
  expect(restored.equipment).toEqual(completed.equipment);
  expect(restored.cashPence).toBe(expectedCash);
  expect(errors).toEqual([]);
});
