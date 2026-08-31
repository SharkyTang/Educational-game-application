import { expect, type Page } from "@playwright/test";
import { CASH_DENOMINATIONS_PENCE } from "../../../src/sim3d/cashPayment";
import {
  getCheckoutTotal, reduceSim, validateSimState, type SimCommand, type SimState,
} from "../../../src/sim3d/domain";
import { SIM_STORAGE_KEY } from "../../../src/sim3d/persistence";

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function changePieces(amountPence: number): number[] {
  if (!Number.isSafeInteger(amountPence) || amountPence < 0) throw new Error("The fixture has an invalid change amount");
  const pieces: number[] = [];
  let remaining = amountPence;
  for (const denomination of [...CASH_DENOMINATIONS_PENCE].reverse()) {
    while (remaining >= denomination) {
      pieces.push(denomination);
      remaining -= denomination;
    }
  }
  if (remaining !== 0) throw new Error("The fixture change cannot be represented by available denominations");
  return pieces;
}

function step(state: SimState, action: SimCommand): SimState {
  const result = reduceSim(state, action);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${action.type}: ${result.message ?? "invalid payment fixture"}`);
  return result.state;
}

/** Preserve the real visitor's payment choice while constructing an audited fixture. */
export function completeFixturePayment(state: SimState): SimState {
  const payment = state.payment;
  if (!payment) throw new Error("The fixture has no active payment");
  if (payment.method === "card") return step(state, { type: "PAY", success: true });
  const pieces = changePieces(payment.tenderedPence - getCheckoutTotal(state));
  if (!payment.received) state = step(state, { type: "RECEIVE_CASH" });
  if (payment.selectedChange.length > 0) state = step(state, { type: "CLEAR_CHANGE" });
  for (const denominationPence of pieces) state = step(state, { type: "ADD_CHANGE", denominationPence });
  return step(state, { type: "CONFIRM_CASH" });
}

/** Observe only this disposable context's ordinary autosave, without an app test bridge. */
export async function readBrowserSnapshot(page: Page): Promise<SimState> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), SIM_STORAGE_KEY);
  expect(raw).not.toBeNull();
  const state: unknown = JSON.parse(raw!);
  expect(validateSimState(state)).toBe(true);
  return state as SimState;
}

/** Scan first in the caller; this helper completes payment through genuine UI actions. */
export async function payScannedCheckout(page: Page): Promise<SimState> {
  const before = await readBrowserSnapshot(page);
  const amount = getCheckoutTotal(before);
  expect(before.customer.phase).toBe("checkout");
  expect(before.payment).not.toBeNull();
  expect(before.items.filter((item) => item.location.kind === "checkout").every((item) => before.scannedIds.includes(item.id))).toBe(true);
  await page.keyboard.press("e");
  if (before.payment?.method === "cash") {
    await expect(page.locator("#s3-cash-dialog")).toBeVisible();
    await expect(page.locator("#s3-cash-due")).toHaveText(money(amount));
    await expect(page.locator("#s3-cash-tendered")).toHaveText(money(before.payment.tenderedPence));
    if (!before.payment.received) await page.locator("#s3-cash-receive").click();
    if (before.payment.selectedChange.length > 0) await page.locator("#s3-cash-reset").click();
    const change = before.payment.tenderedPence - amount;
    await expect(page.locator("#s3-cash-change-due")).toHaveText(money(change));
    for (const denomination of changePieces(change)) {
      if (denomination < 5 && !(await page.locator(`#s3-cash-add-${denomination}`).isVisible())) {
        await page.locator("#s3-cash-dialog .s3-cash-small-coins summary").click();
      }
      await page.locator(`#s3-cash-add-${denomination}`).click();
    }
    await expect(page.locator("#s3-cash-selected-total")).toHaveText(money(change));
    await expect(page.locator("#s3-cash-confirm")).toBeEnabled();
    await expect(page.locator("#s3-cash")).toHaveText(money(before.cashPence));
    expect((await readBrowserSnapshot(page)).transactions).toEqual(before.transactions);
    await page.locator("#s3-cash-confirm").click();
    await expect(page.locator("#s3-cash-dialog")).toBeHidden();
  }
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已收款");
  await expect(page.locator("#s3-cash")).toHaveText(money(before.cashPence + amount));
  const paid = await readBrowserSnapshot(page);
  expect(paid.transactions).toHaveLength(before.transactions.length + 1);
  expect(paid.transactions.at(-1)).toMatchObject({ customerNumber: before.customer.number, amountPence: amount });
  return paid;
}
