import { describe, expect, it } from "vitest";
import { cashRegisterFeedback, cashRegisterMarkup, denominationLabel, renderCashRegister } from "../../src/sim3d/cashRegister";
import { createDefaultCashDrawer, type CashDrawerState } from "../../src/sim3d/cashDrawer";
import { cashPiecesForAmount, type CashPaymentState } from "../../src/sim3d/cashPayment";

const payment = (selectedChange: number[] = [], received = true): CashPaymentState => ({
  method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true, received, selectedChange,
});

const emptyDrawer = (overrides: Partial<CashDrawerState> = {}): CashDrawerState => ({
  1: 0, 2: 0, 5: 0, 10: 0, 20: 0, 50: 0, 100: 0, 200: 0, 500: 0, 1000: 0, ...overrides,
});

function cashRegisterNodes(): { root: HTMLElement; nodes: Map<string, {
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  hidden: boolean;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
}> } {
  const nodes = new Map([...cashRegisterMarkup().matchAll(/id="([^"]+)"/g)].map((match) => [match[1]!, {
    textContent: "", innerHTML: "", disabled: false, hidden: false,
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) { this.attributes.set(name, value) },
  }]));
  return { root: { querySelector: (selector: string) => nodes.get(selector.slice(1)) } as unknown as HTMLElement, nodes };
}

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
    const exact: CashPaymentState = {
      method: "cash", tenderedPence: 435, tenderedCash: cashPiecesForAmount(435), tenderedCashRecorded: true,
      received: true, selectedChange: [],
    };
    expect(cashRegisterFeedback(exact, 435)).toEqual({ text: "顾客刚好付清，无需找零。确认后完成本单。", tone: "ready" });
  });

  it("explains how to recover when the per-order selection safety cap is reached", () => {
    const drawer = emptyDrawer({ 1: 100 });
    const feedback = cashRegisterFeedback(payment(Array.from({ length: 100 }, () => 1)), 45, drawer);
    expect(feedback.text).toContain("还差 £3.55");
    expect(feedback.text).toContain("100 枚/张上限");
    expect(feedback.text).toContain("撤回或清空");
    expect(feedback.tone).toBe("warning");
    expect(cashRegisterFeedback(payment(Array.from({ length: 100 }, () => 1)), 400, drawer).tone).toBe("ready");
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
    expect(markup).toContain('id="s3-cash-stock-50" class="s3-cash-stock">剩余 0');
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain("暂时离开会保留本单");
    expect(markup).toContain("与实体钱箱使用同一库存");
  });

  it("offers two explicit bilingual recovery actions without imitating real cash", () => {
    const markup = cashRegisterMarkup();
    expect(markup).toContain('id="s3-cash-change-shortage"');
    expect(markup).toContain('id="s3-cash-request-exact"');
    expect(markup).toContain("请给刚好金额");
    expect(markup).toContain("Could I have the exact amount, please?");
    expect(markup).toContain('id="s3-cash-switch-card"');
    expect(markup).toContain("可以刷卡吗");
    expect(markup).toContain("Could you pay by card, please?");
    expect(markup).not.toMatch(/<img|svg|emoji/i);
  });

  it("explains that a timed business day does not force unfinished change to end at closing", () => {
    const markup = cashRegisterMarkup();
    expect(markup).toContain("打烊后仍可完成本单");
    expect(markup).not.toContain("这里不计时");
    expect(markup).toContain('id="s3-cash-business-clock"');
    expect(markup).toContain('role="timer" aria-live="off"');
  });

  it("renders all four amounts and gates receive, change, and confirmation separately", () => {
    const { root, nodes } = cashRegisterNodes();
    const drawer = createDefaultCashDrawer();
    renderCashRegister(root, payment([], false), 435, drawer);
    expect(nodes.get("s3-cash-due")!.textContent).toBe("£4.35");
    expect(nodes.get("s3-cash-tendered")!.textContent).toBe("£5.00");
    expect(nodes.get("s3-cash-change-due")!.textContent).toBe("£0.65");
    expect(nodes.get("s3-cash-add-50")!.disabled).toBe(true);
    expect(nodes.get("s3-cash-confirm")!.disabled).toBe(true);
    expect(nodes.get("s3-cash-receive")!.hidden).toBe(false);
    expect(nodes.get("s3-cash-stock-50")!.textContent).toBe("剩余 10");

    renderCashRegister(root, payment([50]), 435, drawer);
    expect(nodes.get("s3-cash-receive")!.hidden).toBe(true);
    expect(nodes.get("s3-cash-add-50")!.disabled).toBe(false);
    expect(nodes.get("s3-cash-stock-50")!.textContent).toBe("剩余 9");
    expect(nodes.get("s3-cash-add-50")!.attributes.get("aria-label")).toBe("加入 50p 找零，剩余 9");
    expect(nodes.get("s3-cash-selected-total")!.textContent).toBe("£0.50");
    expect(nodes.get("s3-cash-tray")!.innerHTML).toContain('data-change-index="0"');
    expect(nodes.get("s3-cash-confirm")!.disabled).toBe(true);

    renderCashRegister(root, payment([50, 10, 5]), 435, drawer);
    expect(nodes.get("s3-cash-selected-total")!.textContent).toBe("£0.65");
    expect(nodes.get("s3-cash-confirm")!.disabled).toBe(false);
    expect(nodes.get("s3-cash-feedback")!.attributes.get("data-tone")).toBe("ready");
    expect(nodes.get("s3-cash-step-confirm")!.attributes.get("aria-current")).toBe("step");
    expect(nodes.get("s3-cash-step-receive")!.attributes.get("aria-current")).toBe("false");
  });

  it("shows finite remaining counts and disables an empty or fully reserved denomination", () => {
    const { root, nodes } = cashRegisterNodes();
    const drawer = emptyDrawer({ 5: 1, 10: 2, 50: 1 });
    renderCashRegister(root, payment([50]), 435, drawer);
    expect(nodes.get("s3-cash-stock-50")!.textContent).toBe("剩余 0");
    expect(nodes.get("s3-cash-add-50")!.disabled).toBe(true);
    expect(nodes.get("s3-cash-stock-20")!.textContent).toBe("剩余 0");
    expect(nodes.get("s3-cash-add-20")!.disabled).toBe(true);
    expect(nodes.get("s3-cash-stock-10")!.textContent).toBe("剩余 2");
    expect(nodes.get("s3-cash-add-10")!.disabled).toBe(false);
  });

  it("shows the recovery area only after received cash when the whole drawer cannot make change", () => {
    const { root, nodes } = cashRegisterNodes();
    const insufficient = emptyDrawer({ 20: 3, 50: 1 });
    renderCashRegister(root, payment([], false), 435, insufficient);
    expect(nodes.get("s3-cash-change-shortage")!.hidden).toBe(true);

    renderCashRegister(root, payment(), 435, insufficient);
    expect(nodes.get("s3-cash-change-shortage")!.hidden).toBe(false);
    expect(nodes.get("s3-cash-feedback")!.textContent).toContain("无法凑出 £0.65");
    expect(nodes.get("s3-cash-feedback")!.attributes.get("data-tone")).toBe("warning");

    const exact = payment([], true);
    exact.tenderedPence = 435;
    exact.tenderedCash = cashPiecesForAmount(435);
    renderCashRegister(root, exact, 435, emptyDrawer());
    expect(nodes.get("s3-cash-change-shortage")!.hidden).toBe(true);
  });

  it("treats a bad partial combination as recoverable when the untouched drawer can make full change", () => {
    const { root, nodes } = cashRegisterNodes();
    const drawer = emptyDrawer({ 5: 1, 10: 1, 20: 1, 50: 1 });
    renderCashRegister(root, payment([20]), 435, drawer);
    expect(nodes.get("s3-cash-change-shortage")!.hidden).toBe(true);
    expect(nodes.get("s3-cash-feedback")!.textContent).toContain("当前选法无法");
    expect(nodes.get("s3-cash-feedback")!.textContent).toContain("撤回或清空");
    expect(nodes.get("s3-cash-feedback")!.attributes.get("data-tone")).toBe("warning");
  });

  it("never confirms a total made from more pieces than the drawer owns", () => {
    const { root, nodes } = cashRegisterNodes();
    const drawer = emptyDrawer({ 5: 1, 10: 1, 50: 1 });
    renderCashRegister(root, payment([50, 10, 5, 5]), 430, drawer);
    expect(nodes.get("s3-cash-confirm")!.disabled).toBe(true);
    expect(nodes.get("s3-cash-feedback")!.textContent).toContain("超过钱箱库存");
  });
});
