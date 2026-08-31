import { describe, expect, it } from "vitest";
import { cashRegisterFeedback, cashRegisterMarkup, denominationLabel, renderCashRegister } from "../../src/sim3d/cashRegister";
import type { CashPaymentState } from "../../src/sim3d/cashPayment";

const payment = (selectedChange: number[] = [], received = true): CashPaymentState => ({
  method: "cash", tenderedPence: 500, received, selectedChange,
});

describe("cash register guidance and accessible controls", () => {
  it("uses pounds and pence consistently without floating point money", () => {
    expect(denominationLabel(5)).toBe("5p");
    expect(denominationLabel(50)).toBe("50p");
    expect(denominationLabel(100)).toBe("£1");
    expect(denominationLabel(500)).toBe("£5");
  });

  it("distinguishes cash not received, too little, too much, and correct change", () => {
    expect(cashRegisterFeedback(payment([], false), 435)).toEqual({ text: "请先收下顾客交来的现金。", tone: "neutral" });
    expect(cashRegisterFeedback(payment([50]), 435).text).toContain("还差 £0.15");
    expect(cashRegisterFeedback(payment([100]), 435)).toEqual({ text: "多了 £0.35，点击托盘里的零钱撤回。", tone: "warning" });
    expect(cashRegisterFeedback(payment([50, 10, 5]), 435).tone).toBe("ready");
    expect(cashRegisterFeedback(payment([20, 20, 20, 5]), 435).tone).toBe("ready");
  });

  it("explains exact payment without asking the player to select zero-value money", () => {
    const exact: CashPaymentState = { method: "cash", tenderedPence: 435, received: true, selectedChange: [] };
    expect(cashRegisterFeedback(exact, 435)).toEqual({ text: "顾客刚好付清，无需找零。确认后完成本单。", tone: "ready" });
  });

  it("explains how to recover when the per-order selection safety cap is reached", () => {
    const feedback = cashRegisterFeedback(payment(Array.from({ length: 100 }, () => 1)), 45);
    expect(feedback.text).toContain("还差 £3.55");
    expect(feedback.text).toContain("100 枚/张上限");
    expect(feedback.text).toContain("撤回或清空");
    expect(feedback.tone).toBe("warning");
    expect(cashRegisterFeedback(payment(Array.from({ length: 100 }, () => 1)), 400).tone).toBe("ready");
  });

  it("has labelled amount fields, native buttons, recovery instructions, and initially locked change", () => {
    const markup = cashRegisterMarkup();
    expect(markup).toContain('aria-labelledby="s3-cash-title"');
    expect(markup).toContain('id="s3-cash-due"');
    expect(markup).toContain('id="s3-cash-tendered"');
    expect(markup).toContain('id="s3-cash-change-due"');
    expect(markup).toContain('id="s3-cash-selected-total"');
    expect(markup).toContain('id="s3-cash-confirm" class="s3-primary-button" type="button" disabled');
    expect(markup).toContain('aria-label="加入 50p 找零" disabled');
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain("暂时离开会保留本单");
    expect(markup).toContain("暂不限制库存");
  });

  it("renders all four amounts and gates receive, change, and confirmation separately", () => {
    const nodes = new Map([...cashRegisterMarkup().matchAll(/id="([^"]+)"/g)].map((match) => [match[1]!, {
      textContent: "", innerHTML: "", disabled: false, hidden: false,
      attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) { this.attributes.set(name, value) },
    }]));
    const root = { querySelector: (selector: string) => nodes.get(selector.slice(1)) } as unknown as HTMLElement;
    renderCashRegister(root, payment([], false), 435);
    expect(nodes.get("s3-cash-due")!.textContent).toBe("£4.35");
    expect(nodes.get("s3-cash-tendered")!.textContent).toBe("£5.00");
    expect(nodes.get("s3-cash-change-due")!.textContent).toBe("£0.65");
    expect(nodes.get("s3-cash-add-50")!.disabled).toBe(true);
    expect(nodes.get("s3-cash-confirm")!.disabled).toBe(true);
    expect(nodes.get("s3-cash-receive")!.hidden).toBe(false);

    renderCashRegister(root, payment([50]), 435);
    expect(nodes.get("s3-cash-receive")!.hidden).toBe(true);
    expect(nodes.get("s3-cash-add-50")!.disabled).toBe(false);
    expect(nodes.get("s3-cash-selected-total")!.textContent).toBe("£0.50");
    expect(nodes.get("s3-cash-tray")!.innerHTML).toContain('data-change-index="0"');
    expect(nodes.get("s3-cash-confirm")!.disabled).toBe(true);

    renderCashRegister(root, payment([50, 10, 5]), 435);
    expect(nodes.get("s3-cash-selected-total")!.textContent).toBe("£0.65");
    expect(nodes.get("s3-cash-confirm")!.disabled).toBe(false);
    expect(nodes.get("s3-cash-feedback")!.attributes.get("data-tone")).toBe("ready");
    expect(nodes.get("s3-cash-step-confirm")!.attributes.get("aria-current")).toBe("step");
    expect(nodes.get("s3-cash-step-receive")!.attributes.get("aria-current")).toBe("false");
  });
});
