import { expect, test, type Page } from "@playwright/test";

const STORE_DESIGN_SIZE = { width: 1120, height: 720 } as const;

interface WorldPoint {
  x: number;
  y: number;
}

/*
 * StoreScene renders a 1120 x 720 world into a responsive Phaser canvas. These
 * points are derived from project(), SHELF_BOUNDS, COUNTER_BOUNDS, and
 * CUSTOMER_QUEUE in StoreScene.ts. Fixtures use their hit-zone centres; after
 * an order is accepted the current customer hit-zone is disabled so the centre
 * of the counter remains unambiguous.
 *
 * The browser-space helper below applies the scene's contain-scale and centring,
 * so these are stable across desktop viewport sizes rather than raw page pixels.
 */
const STORE_HIT_POINTS = {
  chiller: { x: 592.8, y: 160.6 },
  snacks: { x: 665.6, y: 302.6 },
  counter: { x: 675.8, y: 399.8 },
  firstCustomer: { x: 666.6, y: 428.5 },
  followingCustomer: { x: 605.1, y: 422.2 },
} satisfies Record<string, WorldPoint>;

async function clickStoreWorldPoint(page: Page, point: WorldPoint): Promise<void> {
  const canvas = page.locator("#phaser-store canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("aria-label", /warm isometric British corner shop/i);

  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("The Phaser store canvas has no browser-space bounding box.");
  }

  const zoom = Math.min(
    box.width / STORE_DESIGN_SIZE.width,
    box.height / STORE_DESIGN_SIZE.height,
  );
  const designOffsetX = (box.width - STORE_DESIGN_SIZE.width * zoom) / 2;
  const designOffsetY = (box.height - STORE_DESIGN_SIZE.height * zoom) / 2;

  await page.mouse.click(
    box.x + designOffsetX + point.x * zoom,
    box.y + designOffsetY + point.y * zoom,
  );
}

async function clickStoreUntil(
  page: Page,
  points: WorldPoint[],
  assertion: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    for (const point of points) {
      await clickStoreWorldPoint(page, point);
      try {
        await assertion();
        return;
      } catch {
        // Customers walk into the queue, so retry the source-derived queue points.
      }
    }
    await assertion();
  }).toPass({ timeout: 8_000, intervals: [250] });
}

async function openCustomer(page: Page, name: string): Promise<void> {
  await expect(page.locator("#objective-title")).toContainText(name);
  await clickStoreUntil(
    page,
    [STORE_HIT_POINTS.firstCustomer, STORE_HIT_POINTS.followingCustomer],
    async () => {
      await expect(page.locator("#interaction-panel")).toBeVisible({ timeout: 150 });
      await expect(page.locator("#interaction-panel h2")).toHaveText(name, {
        timeout: 150,
      });
    },
  );
}

async function pickUpAndReturnToCounter(
  page: Page,
  shelf: WorldPoint,
  checkoutExpected: boolean,
): Promise<void> {
  await page.locator("#close-after-order").click();
  await clickStoreUntil(page, [shelf], async () => {
    await expect(page.locator("#objective-title")).toHaveText("把商品带回收银台", {
      timeout: 150,
    });
  });

  await clickStoreUntil(page, [STORE_HIT_POINTS.counter], async () => {
    if (checkoutExpected) {
      await expect(page.locator("#interaction-panel h2")).toHaveText(
        "确认结账信息",
        { timeout: 150 },
      );
    } else {
      await expect(page.locator("#hud-progress")).toHaveText("2 / 3 顾客", {
        timeout: 150,
      });
    }
  });
}

test("completes Day 1, unlocks the dual-gate upgrade, and resumes the saved completion", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  await page.goto("/");

  // Landing -> support mode.
  await expect(page.getByTestId("screen-landing")).toBeVisible();
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("screen-onboarding")).toBeVisible();
  await page.locator('input[name="support-mode"][value="practical"]').check();
  await expect(
    page.locator('input[name="support-mode"][value="practical"]'),
  ).toBeChecked();
  await page.getByTestId("start-preview").click();

  // View all four previews before the buyer task is enabled.
  await expect(page.getByTestId("screen-preview")).toBeVisible();
  await expect(page.getByTestId("continue-to-buyer")).toBeDisabled();
  for (const previewId of ["request", "checkout", "payment", "repeat"]) {
    const cardButton = page.getByTestId(`preview-preview.${previewId}`);
    await cardButton.click();
    await expect(cardButton).toHaveText("已看过");
  }
  await expect(page.getByTestId("continue-to-buyer")).toBeEnabled();
  await page.getByTestId("continue-to-buyer").click();

  // Build the correct buyer phrase and confirm the procurement transaction.
  await expect(page.getByTestId("screen-buyer")).toBeVisible();
  for (const chipId of ["chip-start", "chip-four", "chip-water", "chip-please"]) {
    await page.locator(`[data-chip-id="${chipId}"]`).click();
  }
  await expect(page.getByTestId("selected-phrase")).toContainText(
    "I'd like four bottles of water please.",
  );
  await page.getByTestId("check-phrase").click();
  await expect(page.getByTestId("confirm-procurement")).toBeVisible();
  await page.getByTestId("confirm-procurement").click();

  // Put the delivery in the highlighted chiller.
  await expect(page.getByTestId("screen-store")).toBeVisible();
  await expect(page.locator("#hud-progress")).toHaveText("补货");
  await expect(page.getByTestId("cash-balance")).toHaveText("£1.00");
  await clickStoreUntil(page, [STORE_HIT_POINTS.chiller], async () => {
    await expect(page.locator("#objective-title")).toContainText("Oliver", {
      timeout: 150,
    });
  });

  // Customer 1: understand milk correctly, collect it, and complete the sale.
  await openCustomer(page, "Oliver");
  await page.locator('[data-order-option="milk-one"]').click();
  await pickUpAndReturnToCounter(page, STORE_HIT_POINTS.chiller, false);
  await expect(page.locator("#objective-title")).toContainText("Amara");

  // Customer 2: understand crisps and confirm all checkout details correctly.
  await openCustomer(page, "Amara");
  await page.locator('[data-order-option="crisps-one"]').click();
  await pickUpAndReturnToCounter(page, STORE_HIT_POINTS.snacks, true);
  await page.locator('[data-checkout-option="checkout-correct"]').click();
  await expect(page.locator("#hud-progress")).toHaveText("3 / 3 顾客");
  await expect(page.locator("#objective-title")).toContainText("George");

  // Customer 3: deliberately misunderstand, then repair by asking for repetition.
  await openCustomer(page, "George");
  await page.locator('[data-order-option="water-three"]').click();
  await expect(page.locator("#interaction-panel h2")).toHaveText("出现了误会");
  await page.locator('[data-repair-intent="request_repeat"]').click();
  await expect(page.getByTestId("repair-request-repeat")).toBeVisible();
  await expect(page.locator("#interaction-panel")).toContainText(
    "修复成功：你没有继续猜",
  );
  await page.locator('[data-order-option="water-two"]').click();
  await pickUpAndReturnToCounter(page, STORE_HIT_POINTS.chiller, true);
  await page.locator('[data-checkout-option="checkout-correct"]').click();

  // Settlement proves the repaired sale still clears both upgrade gates.
  await expect(page.getByTestId("screen-settlement")).toBeVisible();
  await expect(page.getByTestId("settlement-cash")).toHaveText("£6.20");
  await expect(page.getByTestId("skill-state-buyer.request_item_quantity")).toHaveText(
    /独立完成/,
  );
  await expect(
    page.getByTestId("skill-state-seller.understand_item_quantity"),
  ).toHaveText(/独立完成/);
  await expect(
    page.getByTestId("skill-state-seller.checkout_details").locator(".level-pill"),
  ).toHaveAttribute("data-level", "variant");
  await expect(page.getByTestId("skill-state-repair.request_repetition")).toHaveText(
    /独立完成/,
  );

  await page.getByTestId("view-upgrade").click();
  await expect(page.getByTestId("screen-upgrade")).toBeVisible();
  await expect(page.getByTestId("buy-upgrade")).toBeEnabled();
  await expect(page.getByTestId("screen-upgrade")).toContainText("资金 £6.20 / £5.00");
  await expect(page.getByTestId("screen-upgrade")).toContainText(
    "独立英语技能 4 / 3",
  );
  await page.getByTestId("buy-upgrade").click();
  await expect(page.getByTestId("cash-after-upgrade")).toHaveText("£1.20");
  await page.getByTestId("finish-mvp").click();
  await expect(page.getByTestId("screen-complete")).toBeVisible();

  // The completed state is saved; a refresh returns to landing with a resumable save.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("english-high-street-mvp:fallback");
        if (raw === null) return null;
        const save = JSON.parse(raw) as {
          phase?: string;
          upgradePurchased?: boolean;
          transactions?: unknown[];
        };
        return {
          phase: save.phase,
          upgradePurchased: save.upgradePurchased,
          transactionCount: save.transactions?.length,
        };
      }),
    )
    .toEqual({ phase: "complete", upgradePurchased: true, transactionCount: 4 });

  await page.reload();
  await expect(page.getByTestId("screen-landing")).toBeVisible();
  await expect(page.getByTestId("continue-game")).toBeVisible();
  await expect(page.getByText("找到本机存档")).toBeVisible();
  await page.getByTestId("continue-game").click();
  await expect(page.getByTestId("screen-complete")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});
