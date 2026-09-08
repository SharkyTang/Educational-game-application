import { receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { describe, expect, it, vi } from "vitest";
import { createFirstDayState, reduceSim, validateSimState, type SimCommand, type SimState } from "../../src/sim3d/domain";
import { cashDrawerValuePence } from "../../src/sim3d/cashDrawer";
import { CASH_DENOMINATIONS_PENCE, type CashDenominationPence } from "../../src/sim3d/cashPayment";
import { CashManagementPanel, cashManagementMarkup, parseCashManagementCounts, type CashManagementCommand } from "../../src/sim3d/cashManagementPanel";
import { payScannedCheckout } from "../helpers/sim3dPayment";

/** A small DOM surface; tests run the real panel and real domain commands. */
class ElementDouble extends EventTarget {
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  readonly elements = new Map<string, ElementDouble>();
  readonly attributes = new Map<string, string>();
  readonly focus = vi.fn();
  private markup = "";

  get innerHTML(): string { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    this.elements.clear();
    for (const match of value.matchAll(/<([a-z][a-z\d-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const element = new ElementDouble();
      const attributes = match[2]!;
      for (const attribute of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1]!, attribute[2]!);
      element.hidden = /\bhidden(?:\s|$)/.test(attributes);
      element.disabled = /\bdisabled(?:\s|$)/.test(attributes);
      element.value = element.attributes.get("value") ?? "";
      this.elements.set(match[3]!, element);
    }
  }
  querySelector(selector: string): ElementDouble | null {
    if (!selector.startsWith("#")) return null;
    const direct = this.elements.get(selector.slice(1));
    if (direct) return direct;
    for (const element of this.elements.values()) {
      const nested = element.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  replaceChildren(): void { this.innerHTML = ""; }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click", { cancelable: true })); }
  input(value: string): void { if (!this.disabled) { this.value = value; this.dispatchEvent(new Event("input")); } }
}

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function paid(visitors: 1 | 2 = 1): SimState {
  let state = step(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "cash-panel", lines: [{ productId: "milk", quantity: visitors }, { productId: "bread", quantity: visitors }] });
  state = receiveAllDeliveries(state);
  for (const productId of ["milk", "bread"] as const) {
    const crate = state.crates.find((entry) => entry.productId === productId)!;
    state = step(state, { type: "PICK_CRATE", crateId: crate.id });
    for (let slot = 0; slot < visitors; slot += 1) state = step(state, { type: "STOCK", productId, slot });
    state = step(state, { type: "DROP_HELD", position: crate.position });
  }
  for (let visitor = 0; visitor < visitors; visitor += 1) {
    if (visitor === 0) state = step(state, { type: "OPEN_STORE" });
    else {
      const elapsedMs = state.day.nextCustomerAtMs! - state.day.elapsedOpenMs;
      if (elapsedMs > 0) state = step(state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs });
      state = step(state, { type: "NEXT_CUSTOMER" });
    }
    while (["to-milk", "to-bread", "to-checkout"].includes(state.customer.phase)) state = step(state, { type: "CUSTOMER_ADVANCE" });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = step(state, { type: "SCAN", itemId: item.id });
    state = step(payScannedCheckout(state), { type: "CUSTOMER_ADVANCE" });
  }
  return state;
}

function mount(initial = createFirstDayState()) {
  const host = new ElementDouble();
  let state = initial;
  let writable = true;
  let accepted = true;
  const dispatch = vi.fn<(command: CashManagementCommand) => boolean>((command) => {
    if (!accepted) return false;
    const result = reduceSim(state, command);
    if (!result.changed) return false;
    expect(validateSimState(result.state)).toBe(true);
    state = result.state;
    panel.render(state, writable);
    return true;
  });
  const panel = new CashManagementPanel(host as unknown as HTMLElement, { dispatch });
  const element = (suffix: string): ElementDouble => {
    const result = host.querySelector(`#s3-cash-management-${suffix}`);
    if (!result) throw new Error(`Missing cash panel test element: ${suffix}`);
    return result;
  };
  panel.render(state, writable);
  return {
    panel, host, element, dispatch, state: () => state,
    reject: () => { accepted = false; }, accept: () => { accepted = true; },
    render: (next = state, canWrite = writable) => { state = next; writable = canWrite; panel.render(state, writable); },
    fillCount: (counts = state.cashDrawer) => { for (const denomination of CASH_DENOMINATIONS_PENCE) element(`count-${denomination}`).input(String(counts[denomination])); },
  };
}

function countDraft(): Map<CashDenominationPence, string> {
  return new Map(CASH_DENOMINATIONS_PENCE.map((denomination) => [denomination, "0"]));
}

describe("cash management quantity input", () => {
  it.each(["", "-1", "1.5", "1e2", " 1", "1 ", "NaN", "9007199254740992"])("rejects incomplete or invalid quantity %j", (raw) => {
    const draft = countDraft();
    draft.set(20, raw);
    expect(parseCashManagementCounts(draft)).toEqual({ error: expect.stringContaining("20p") });
  });

  it("rejects a missing denomination and safe counts whose monetary total overflows", () => {
    const draft = countDraft();
    draft.delete(1);
    expect(parseCashManagementCounts(draft)).toHaveProperty("error");
    draft.set(1, "0");
    draft.set(1000, String(Number.MAX_SAFE_INTEGER));
    expect(parseCashManagementCounts(draft)).toEqual({ error: expect.stringContaining("总额") });
  });

  it("accepts zero and computes pence without floating point money", () => {
    const draft = countDraft();
    draft.set(2, "3");
    draft.set(200, "2");
    expect(parseCashManagementCounts(draft)).toMatchObject({ totalPence: 406, drawer: { 2: 3, 200: 2 } });
  });

  it("supplies labelled native inputs and status regions inside the existing pause dialog", () => {
    const markup = cashManagementMarkup();
    expect(markup).not.toContain("<dialog");
    for (const denomination of CASH_DENOMINATIONS_PENCE) {
      for (const kind of ["float", "count"]) {
        expect(markup).toContain(`for="s3-cash-management-${kind}-${denomination}"`);
        expect(markup).toContain(`id="s3-cash-management-${kind}-${denomination}" type="number"`);
      }
    }
    expect(markup).toContain('maxlength="200"');
    expect(markup).toContain('aria-live="polite"');
  });
});

describe("opening float management", () => {
  it("keeps partial edits across renders, rejects overspending, and writes a conserving allocation", () => {
    const view = mount();
    expect(view.element("drawer").textContent).toBe("£31.60");
    view.element("float-200").input("");
    view.render();
    expect(view.element("float-200").value).toBe("");
    expect(view.element("float-save").disabled).toBe(true);
    view.element("float-200").input("6");
    expect(view.element("float-save").disabled).toBe(true);
    expect(view.element("float-reason").textContent).toContain("超过");
    view.element("float-200").input("4");
    expect(view.element("float-preview").textContent).toContain("£29.60");
    expect(view.element("float-save").disabled).toBe(false);
    const before = view.state();
    view.element("float-save").click();
    expect(view.state().cashReservePence).toBe(200);
    expect(cashDrawerValuePence(view.state().cashDrawer) + view.state().cashReservePence).toBe(3160);
    expect(view.state().cashPence).toBe(before.cashPence);
    expect(view.element("reserve").textContent).toBe("£2.00");
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    view.panel.dispose();
  });

  it("retains float inputs when the host cannot commit, and clears drafts only on explicit reset", () => {
    const view = mount();
    view.element("float-100").input("8");
    view.reject();
    view.element("float-save").click();
    expect(view.state().cashReservePence).toBe(0);
    expect(view.element("float-100").value).toBe("8");
    expect(view.element("notice").textContent).toContain("尚未更改");
    view.element("float-reset").click();
    expect(view.element("float-100").value).toBe("10");
    expect(view.element("float-1").focus).toHaveBeenCalled();
    view.panel.dispose();
  });

  it("disables edits with the actual phase or read-only reason", () => {
    const view = mount();
    view.render(view.state(), false);
    expect(view.element("float-1").disabled).toBe(true);
    view.element("float-save").click();
    expect(view.dispatch).not.toHaveBeenCalled();
    view.render(step(view.state(), { type: "CLOSE_STORE" }), true);
    expect(view.element("float-save").disabled).toBe(true);
    expect(view.element("float-reason").textContent).toContain("开店前");
    view.panel.dispose();
  });
});

describe("cash management refund confirmation", () => {
  it.each([{ visitors: 1 as const, reason: "void" as const, channel: "刷卡" }, { visitors: 2 as const, reason: "refund" as const, channel: "现金" }])("requires a second action for $channel, preserves the original, and disables repeated refunds", ({ visitors, reason, channel }) => {
    const initial = paid(visitors);
    const transaction = initial.transactions.at(-1)!;
    const view = mount(initial);
    view.element(`${reason}-${transaction.id}`).click();
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(view.element("refund-confirm").hidden).toBe(false);
    expect(view.element("refund-cancel").focus).toHaveBeenCalled();
    expect(view.element("refund-confirm-description").textContent).toContain(channel);
    expect(view.element("refund-confirm-description").textContent).toContain("£4.00");
    view.element("refund-cancel").click();
    expect(view.state()).toBe(initial);
    expect(view.element(`${reason}-${transaction.id}`).focus).toHaveBeenCalled();
    view.element(`${reason}-${transaction.id}`).click();
    view.element("refund-confirm-button").click();
    expect(view.state().transactions).toEqual(initial.transactions);
    expect(view.state().cashJournal.at(-1)).toMatchObject({ kind: "refund", transactionId: transaction.id, reason: reason === "void" ? "void" : "return" });
    expect(view.state().cashPence).toBe(initial.cashPence - 400);
    expect(cashDrawerValuePence(view.state().cashDrawer)).toBe(cashDrawerValuePence(initial.cashDrawer) - (channel === "现金" ? 400 : 0));
    expect(view.element(`refund-${transaction.id}`).disabled).toBe(true);
    expect(view.element(`void-${transaction.id}`).disabled).toBe(true);
    expect(view.element("refund-confirm").hidden).toBe(true);
    view.element(`refund-${transaction.id}`).click();
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    view.panel.dispose();
  });

  it("keeps the confirmation after a commit failure and cancels it when the state becomes ineligible", () => {
    const view = mount(paid());
    const id = view.state().transactions[0]!.id;
    view.element(`refund-${id}`).click();
    view.reject();
    view.element("refund-confirm-button").click();
    expect(view.element("refund-confirm").hidden).toBe(false);
    expect(view.state().cashJournal).toHaveLength(0);
    view.render(view.state(), false);
    expect(view.element("refund-confirm").hidden).toBe(true);
    expect(view.element(`refund-${id}`).disabled).toBe(true);
    view.panel.dispose();
  });
});

describe("closing cash count", () => {
  it("requires real quantities and a note for a denomination mismatch even when money matches", () => {
    const view = mount(step(createFirstDayState(), { type: "CLOSE_STORE" }));
    expect(view.element("count-1").value).toBe("");
    expect(view.element("count-save").disabled).toBe(true);
    const counts = { ...view.state().cashDrawer, 100: 8, 200: 6 };
    view.fillCount(counts);
    expect(view.element("count-difference").textContent).toContain("总额相同");
    expect(view.element("count-save").disabled).toBe(true);
    view.element("count-note").input("<img src=x onerror=alert(1)> 已换开两枚硬币");
    expect(view.element("count-save").disabled).toBe(false);
    const before = view.state();
    view.element("count-save").click();
    expect(view.state().cashDrawer).toEqual(before.cashDrawer);
    expect(view.state().cashPence).toBe(before.cashPence);
    expect(view.state().cashJournal.at(-1)).toMatchObject({ kind: "count", counts, differencePence: 0 });
    expect(view.element("count-status").textContent).toContain("面额有差异");
    expect(view.element("count-history").innerHTML).toContain("&lt;img");
    expect(view.element("count-history").innerHTML).not.toContain("<img");
    expect(view.element("count-note").value).toContain("已换开");
    view.panel.dispose();
  });

  it("keeps drafts on renders and commit failure, including negative difference and note length", () => {
    const view = mount(step(createFirstDayState(), { type: "CLOSE_STORE" }));
    view.fillCount({ ...view.state().cashDrawer, 100: 9 });
    expect(view.element("count-difference").textContent).toContain("−£1.00");
    view.element("count-note").input("a".repeat(201));
    expect(view.element("count-save").disabled).toBe(true);
    view.element("count-note").input("少一枚 £1，已复点");
    view.render();
    expect(view.element("count-100").value).toBe("9");
    expect(view.element("count-note").value).toBe("少一枚 £1，已复点");
    view.reject();
    view.element("count-save").click();
    expect(view.state().cashJournal).toHaveLength(0);
    expect(view.element("count-100").value).toBe("9");
    view.accept();
    view.element("count-save").click();
    expect(view.element("count-status").textContent).toContain("−£1.00");
    view.panel.dispose();
  });

  it("marks a prior count stale after card refund while preserving unfinished edits", () => {
    const view = mount(step(paid(), { type: "CLOSE_STORE" }));
    view.fillCount();
    view.element("count-save").click();
    expect(view.element("count-status").textContent).toContain("最新盘点");
    view.element("count-2").input("");
    const id = view.state().transactions[0]!.id;
    view.element(`void-${id}`).click();
    view.element("refund-confirm-button").click();
    expect(view.element("count-status").textContent).toContain("请重新盘点");
    expect(view.element("count-2").value).toBe("");
    view.panel.resetDrafts();
    view.render(createFirstDayState());
    expect(view.element("count-1").value).toBe("");
    expect(view.element("float-200").value).toBe("5");
    view.panel.dispose();
  });
});
