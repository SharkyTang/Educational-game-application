import { describe, expect, it, vi } from "vitest";
import { createDefaultCashDrawer } from "../../src/sim3d/cashDrawer";
import { deriveCashVisualState, type CashVisualPick } from "../../src/sim3d/cashVisualState";
import { CashVisualViewport, cashVisualBalance, cashVisualInstructions, type CashVisualRuntimeFactory } from "../../src/sim3d/cashVisualViewport";

class ElementDouble extends EventTarget {
  textContent = "";
  hidden = false;
  disabled = false;
  private readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click")) }
}
class HostDouble extends ElementDouble {
  readonly elements = new Map<string, ElementDouble>();
  private markup = "";
  set innerHTML(value: string) {
    this.markup = value;
    this.elements.clear();
    for (const match of value.matchAll(/id="([^"]+)"/g)) this.elements.set(match[1]!, new ElementDouble());
  }
  get innerHTML(): string { return this.markup }
  querySelector(selector: string): ElementDouble | null { return this.elements.get(selector.slice(1)) ?? null }
  replaceChildren(): void { this.elements.clear(); this.markup = "" }
  control(suffix: string): ElementDouble { return this.elements.get(`s3-cash-visual-${suffix}`)! }
}

function snapshot(received = false, open = true) {
  return deriveCashVisualState({ payment: { method: "cash", tenderedPence: 500, tenderedCash: [500],
    tenderedCashRecorded: true, received, selectedChange: received ? [50] : [] },
  cashDrawer: createDefaultCashDrawer(), amountPence: 400, checkout: true, open, canInteract: true });
}

function setup(factoryOverride?: CashVisualRuntimeFactory) {
  const host = new HostDouble();
  const callbacks = { onPick: vi.fn(() => true), onDrawerChange: vi.fn(), onUnavailable: vi.fn() };
  const runtimes: Array<{ update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; pick: (pick: CashVisualPick) => void; fail: () => void }> = [];
  const factory = vi.fn<CashVisualRuntimeFactory>((_canvas, pick, fail) => {
    const runtime = { update: vi.fn(), dispose: vi.fn(), pick, fail };
    runtimes.push(runtime);
    return runtime;
  });
  const viewport = new CashVisualViewport(host as unknown as HTMLElement, callbacks, factoryOverride ?? factory);
  return { host, callbacks, viewport, factory, runtimes };
}

describe("cash visual viewport lifecycle and non-financial controls", () => {
  it("keeps due, selected and under/over totals readable beside the 3D controls", () => {
    const current = snapshot(true);
    expect(cashVisualBalance(current)).toBe("应找 £1.00 · 已选 £0.50 · 还差 £0.50");
    expect(cashVisualBalance({ ...current, selectedChangePence: 100 })).toContain("金额正好");
    expect(cashVisualBalance({ ...current, selectedChangePence: 150 })).toContain("多了 £0.50");
    expect(cashVisualBalance(snapshot())).toContain("等待收下现金");
    const view = setup();
    view.viewport.show(current);
    expect(view.host.control("balance").textContent).toBe(cashVisualBalance(current));
    view.viewport.dispose();
  });
  it("notifies the controller once so a closed drawer cannot strand fallback controls", () => {
    const view = setup();
    view.viewport.show(snapshot(true, false));
    view.runtimes[0]!.fail();
    view.runtimes[0]!.fail();
    expect(view.viewport.available).toBe(false);
    expect(view.callbacks.onUnavailable).toHaveBeenCalledTimes(1);
    view.viewport.dispose();
  });
  it("allocates only when shown and updates the one live view from the given state", () => {
    const view = setup();
    const initial = snapshot();
    const before = structuredClone(initial);
    expect(view.factory).not.toHaveBeenCalled();
    view.viewport.show(initial);
    view.viewport.update(snapshot(true));
    expect(view.factory).toHaveBeenCalledTimes(1);
    expect(view.runtimes[0]!.update).toHaveBeenCalledTimes(2);
    expect(view.viewport.available).toBe(true);
    expect(view.host.getAttribute("data-renderer")).toBe("ready");
    expect(view.host.control("canvas").hidden).toBe(false);
    expect(initial).toEqual(before);
    expect(view.callbacks.onPick).not.toHaveBeenCalled();
    view.viewport.dispose();
  });

  it("resolves receive, add and remove only against the latest visible snapshot", () => {
    const view = setup();
    view.viewport.show(snapshot());
    const runtime = view.runtimes[0]!;
    runtime.pick({ kind: "add", denominationPence: 50 });
    expect(view.callbacks.onPick).not.toHaveBeenCalled();
    runtime.pick({ kind: "receive" });
    expect(view.callbacks.onPick).toHaveBeenLastCalledWith({ kind: "receive" });
    view.viewport.update(snapshot(true));
    view.callbacks.onPick.mockClear();
    runtime.pick({ kind: "receive" });
    runtime.pick({ kind: "remove", index: 99 });
    runtime.pick({ kind: "add", denominationPence: 999 });
    expect(view.callbacks.onPick).not.toHaveBeenCalled();
    runtime.pick({ kind: "add", denominationPence: 50 });
    runtime.pick({ kind: "remove", index: 0 });
    expect(view.callbacks.onPick).toHaveBeenCalledTimes(2);
    view.viewport.update(snapshot(true, false));
    runtime.pick({ kind: "add", denominationPence: 50 });
    expect(view.callbacks.onPick).toHaveBeenCalledTimes(2);
    view.viewport.dispose();
  });

  it("opening and closing the drawer request only a visual change, never a financial command", () => {
    const view = setup();
    view.viewport.show(snapshot(true));
    view.host.control("toggle").click();
    expect(view.callbacks.onDrawerChange).toHaveBeenLastCalledWith(false);
    expect(view.callbacks.onPick).not.toHaveBeenCalled();
    view.viewport.update(snapshot(true, false));
    expect(view.host.control("toggle").getAttribute("aria-expanded")).toBe("false");
    expect(view.host.control("toggle").textContent).toBe("打开钱箱");
    expect(view.host.control("status").textContent).toContain("暂收款和找零托盘会保留");
    view.host.control("toggle").click();
    expect(view.callbacks.onDrawerChange).toHaveBeenLastCalledWith(true);
    view.viewport.dispose();
  });

  it("hiding releases WebGL and old picks cannot mutate a subsequently reopened payment", () => {
    const view = setup();
    view.viewport.show(snapshot());
    const previous = view.runtimes[0]!;
    view.viewport.hide();
    view.viewport.hide();
    expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(view.viewport.available).toBe(false);
    view.viewport.show(snapshot(true));
    previous.pick({ kind: "add", denominationPence: 50 });
    previous.fail();
    expect(view.callbacks.onPick).not.toHaveBeenCalled();
    expect(view.viewport.available).toBe(true);
    expect(view.runtimes[1]!.dispose).not.toHaveBeenCalled();
    view.viewport.dispose();
  });

  it("creation failure leaves an explicit ordinary-button fallback without issuing commands", () => {
    const view = setup(() => { throw new Error("WebGL unavailable") });
    view.viewport.show(snapshot(true));
    expect(view.host.getAttribute("data-renderer")).toBe("fallback");
    expect(view.host.control("canvas").hidden).toBe(true);
    expect(view.host.control("status").textContent).toContain("面额按钮继续");
    expect(view.host.control("toggle").disabled).toBe(true);
    expect(view.callbacks.onPick).not.toHaveBeenCalled();
    expect(view.viewport.available).toBe(false);
    view.viewport.dispose();
  });

  it("runtime loss releases its resources and can recover on a deliberate reopen", () => {
    const view = setup();
    view.viewport.show(snapshot(true));
    view.runtimes[0]!.fail();
    expect(view.runtimes[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(view.host.control("status").textContent).toContain("现金和找零已保留");
    view.runtimes[0]!.pick({ kind: "remove", index: 0 });
    expect(view.callbacks.onPick).not.toHaveBeenCalled();
    view.viewport.hide();
    view.viewport.show(snapshot(true));
    expect(view.factory).toHaveBeenCalledTimes(2);
    expect(view.viewport.available).toBe(true);
    view.viewport.dispose();
  });

  it("a rendering error switches to fallback rather than dispatching or losing a tray", () => {
    const view = setup();
    const state = snapshot(true);
    view.viewport.show(state);
    view.runtimes[0]!.update.mockImplementation(() => { throw new Error("render failure") });
    view.viewport.update(state);
    expect(view.runtimes[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(view.host.getAttribute("data-renderer")).toBe("fallback");
    expect(state.change).toHaveLength(1);
    expect(view.callbacks.onPick).not.toHaveBeenCalled();
    view.viewport.dispose();
  });

  it("labels historical inferred tender honestly and removes that label for a non-cash visit", () => {
    const view = setup();
    const state = snapshot();
    state.tenderSource = "derived";
    state.tenderSourceLabel = "旧版未记录面额，以下按金额推导示意";
    view.viewport.show(state);
    expect(view.host.control("source").textContent).toContain("推导示意");
    const idle = deriveCashVisualState({ payment: null, cashDrawer: createDefaultCashDrawer(),
      amountPence: 0, checkout: false, canInteract: false, open: false });
    view.viewport.update(idle);
    expect(view.host.control("source").hidden).toBe(true);
    view.viewport.dispose();
  });

  it("disposes listeners and DOM once and never reopens after destruction", () => {
    const view = setup();
    view.viewport.show(snapshot());
    const toggle = view.host.control("toggle");
    view.viewport.dispose();
    view.viewport.dispose();
    view.viewport.show(snapshot());
    toggle.click();
    expect(view.runtimes[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(view.factory).toHaveBeenCalledTimes(1);
    expect(view.callbacks.onDrawerChange).not.toHaveBeenCalled();
    expect(view.host.innerHTML).toBe("");
  });

  it("explains the receive and selected-change stages without claiming tender is already in the drawer", () => {
    expect(cashVisualInstructions(snapshot())).toContain("顾客交款区");
    expect(cashVisualInstructions(snapshot(true))).toContain("完成交易后才入钱箱");
  });
});
