import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CASH_DENOMINATIONS_PENCE, type CashPaymentState } from "../../src/sim3d/cashPayment";
import { cashRegisterMarkup } from "../../src/sim3d/cashRegister";
import { CashRegisterController, type CashRegisterCommand } from "../../src/sim3d/cashRegisterController";
import type { CustomerSpeechClip } from "../../src/sim3d/customerSelection";

type RegisterHost = ConstructorParameters<typeof CashRegisterController>[1];
type RegisterSnapshot = ReturnType<RegisterHost["read"]>;

/** Only the DOM surface used by the controller and its real renderer, not a second controller. */
class ElementDouble extends EventTarget {
  textContent = "";
  hidden = false;
  disabled = false;
  open = false;
  parentElement: ElementDouble | null = null;
  readonly dataset: { changeIndex?: string } = {};
  readonly elements = new Map<string, ElementDouble>();
  readonly attributes = new Map<string, string>();
  readonly focus = vi.fn();
  readonly showModal = vi.fn(() => { this.open = true });
  readonly close = vi.fn(() => { this.open = false });
  private markup = "";

  constructor(readonly tagName = "DIV") { super() }

  get innerHTML(): string { return this.markup }
  set innerHTML(markup: string) {
    this.markup = markup;
    this.elements.clear();
    for (const match of markup.matchAll(/<([a-z][a-z\d-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const element = new ElementDouble(match[1]!.toUpperCase());
      const attributes = match[2]!;
      element.parentElement = this;
      for (const attribute of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1]!, attribute[2]!);
      element.hidden = /\bhidden(?:\s|$)/.test(attributes);
      element.disabled = /\bdisabled(?:\s|$)/.test(attributes);
      this.elements.set(match[3]!, element);
    }
  }

  querySelector(selector: string): ElementDouble | null {
    const direct = this.elements.get(selector.slice(1));
    if (direct) return direct;
    for (const element of this.elements.values()) {
      const nested = element.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "data-change-index") this.dataset.changeIndex = value;
  }

  closest(selector: string): ElementDouble | null {
    if (selector === "button[data-change-index]" && this.tagName === "BUTTON" && this.dataset.changeIndex !== undefined) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  contains(element: ElementDouble): boolean {
    return element === this || (element.parentElement !== null && this.contains(element.parentElement));
  }

  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click", { cancelable: true })) }
}

const TENDER_CLIP: CustomerSpeechClip = {
  id: "tender-cash-five-pounds", text: "Here's five pounds.", zh: "给你五英镑。",
  src: "/assets/sim3d/audio/customers/female/tender-cash-five-pounds.wav",
};
const cash = (selectedChange: number[] = [], received = true, tenderedPence = 500): CashPaymentState => ({
  method: "cash", tenderedPence, received, selectedChange,
});

let windowDouble: EventTarget;
let controllers: AbortController[];

beforeEach(() => {
  windowDouble = new EventTarget();
  controllers = [];
  vi.stubGlobal("window", windowDouble);
});

afterEach(() => {
  controllers.forEach((controller) => controller.abort());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(patch: Partial<RegisterSnapshot> = {}) {
  const root = new ElementDouble();
  root.innerHTML = cashRegisterMarkup();
  let snapshot: RegisterSnapshot = {
    payment: cash([], false), amountPence: 435, atCheckout: true, canWrite: true,
    customerName: "Clara", clip: TENDER_CLIP, warning: "", ...patch,
  };
  const host = {
    read: vi.fn(() => snapshot), canOpen: vi.fn(() => true),
    dispatch: vi.fn<(command: CashRegisterCommand) => boolean>(() => false),
    onOpen: vi.fn(), onClose: vi.fn(), speak: vi.fn<(clip: CustomerSpeechClip, rate: number) => void>(),
  } satisfies RegisterHost;
  const abort = new AbortController();
  controllers.push(abort);
  const controller = new CashRegisterController(root as unknown as HTMLElement, host, abort.signal);
  const element = (id: string): ElementDouble => {
    const found = root.querySelector(`#${id}`);
    if (!found) throw new Error(`Missing fixture control: ${id}`);
    return found;
  };
  return {
    controller, host, abort, element, snapshot: () => snapshot,
    update: (next: Partial<RegisterSnapshot>): void => { snapshot = { ...snapshot, ...next } },
    trayClick: (target: ElementDouble | null): void => {
      // EventTarget has no browser bubbling; dispatch the delegated event at the tray.
      const event = new Event("click", { cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      element("s3-cash-tray").dispatchEvent(event);
    },
  };
}

function key(code: string, patch: Partial<KeyboardEvent> = {}): Event {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    code, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...patch,
  });
  windowDouble.dispatchEvent(event);
  return event;
}

describe("cash register modal opening and read-only boundaries", () => {
  it.each([
    { label: "the counter is out of reach or is not the live interaction target", patch: {}, canOpen: false },
    { label: "the customer is not checking out", patch: { atCheckout: false } },
    { label: "the save is read-only", patch: { canWrite: false } },
    { label: "the visitor is paying by card", patch: { payment: { method: "card" as const } } },
    { label: "there is no pending payment", patch: { payment: null } },
  ])("does not open when $label", ({ patch, canOpen = true }) => {
    const view = mount(patch);
    view.host.canOpen.mockReturnValue(canOpen);
    const before = structuredClone(view.snapshot());
    expect(view.controller.open()).toBe(false);
    expect(view.controller.isOpen).toBe(false);
    expect(view.element("s3-cash-dialog").showModal).not.toHaveBeenCalled();
    expect(view.host.onOpen).not.toHaveBeenCalled();
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.snapshot()).toEqual(before);
  });

  it.each([
    { label: "unreceived tender", payment: cash([], false), focus: "s3-cash-receive" },
    { label: "unfinished change", payment: cash([50]), focus: "s3-cash-add-50" },
    { label: "correct selected change", payment: cash([50, 10, 5]), focus: "s3-cash-confirm" },
    { label: "an exact received amount", payment: cash([], true, 435), focus: "s3-cash-confirm" },
  ])("opens and focuses the next action for $label", ({ payment, focus }) => {
    const view = mount({ payment });
    expect(view.controller.open()).toBe(true);
    expect(view.controller.isOpen).toBe(true);
    expect(view.host.canOpen).toHaveBeenCalledOnce();
    expect(view.host.onOpen).toHaveBeenCalledOnce();
    expect(view.element("s3-cash-dialog").showModal).toHaveBeenCalledOnce();
    expect(view.element(focus).focus).toHaveBeenCalledOnce();
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.controller.open()).toBe(true);
    expect(view.host.onOpen).toHaveBeenCalledOnce();
    expect(view.element("s3-cash-dialog").showModal).toHaveBeenCalledOnce();
  });

  it("checks the host's live interaction gate again after leaving the register", () => {
    const view = mount();
    expect(view.controller.open()).toBe(true);
    view.controller.close();
    view.host.canOpen.mockReturnValue(false);
    expect(view.controller.open()).toBe(false);
    expect(view.host.canOpen).toHaveBeenCalledTimes(2);
    expect(view.host.onOpen).toHaveBeenCalledOnce();
  });

  it("renders the host's current customer, matching tender subtitle, and persistence warning", () => {
    const view = mount();
    view.controller.open();
    expect(view.element("s3-cash-customer-name").textContent).toBe("Clara");
    expect(view.element("s3-cash-line").textContent).toBe("“Here's five pounds.”");
    expect(view.element("s3-cash-zh").textContent).toBe("给你五英镑。");
    expect(view.element("s3-cash-save-note").textContent).toContain("暂时离开会保留本单");
    expect(view.element("s3-cash-save-note").attributes.get("data-error")).toBe("false");
    view.update({ customerName: "Oliver", clip: null, warning: "尚未写入存档，请勿关闭页面。" });
    view.controller.render();
    expect(view.element("s3-cash-customer-name").textContent).toBe("Oliver");
    expect(view.element("s3-cash-line").textContent).toBe("");
    expect(view.element("s3-cash-zh").textContent).toBe("");
    expect(view.element("s3-cash-save-note").textContent).toBe("尚未写入存档，请勿关闭页面。");
    expect(view.element("s3-cash-save-note").attributes.get("data-error")).toBe("true");
  });
});

describe("closing the register preserves the unfinished host-owned transaction", () => {
  it.each(["close", "Escape", "cancel", "leave-button"] as const)("closes through %s without cancelling or committing cash", (reason) => {
    const view = mount({ payment: cash([50]) });
    const before = structuredClone(view.snapshot());
    view.controller.open();
    if (reason === "close") view.controller.close();
    else if (reason === "Escape") expect(key("Escape").defaultPrevented).toBe(true);
    else if (reason === "cancel") {
      const cancel = new Event("cancel", { cancelable: true });
      view.element("s3-cash-dialog").dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(true);
    } else view.element("s3-cash-close").click();
    expect(view.controller.isOpen).toBe(false);
    expect(view.host.onClose).toHaveBeenCalledOnce();
    expect(view.element("s3-cash-dialog").close).toHaveBeenCalledOnce();
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.snapshot()).toEqual(before);
    view.controller.close();
    expect(view.host.onClose).toHaveBeenCalledOnce();
    expect(view.controller.open()).toBe(true);
    expect(view.element("s3-cash-selected-total").textContent).toBe("£0.50");
    expect(view.element("s3-cash-receive").hidden).toBe(true);
    expect(view.element("s3-cash-tray").innerHTML).toContain('data-change-index="0"');
    expect(view.snapshot()).toEqual(before);
  });
});

describe("cash actions forward commands and render only the host's accepted result", () => {
  it.each([false, true])("forwards receipt and focuses the next control (exact amount: %s)", (exact) => {
    const tenderedPence = exact ? 435 : 500;
    const view = mount({ payment: cash([], false, tenderedPence) });
    view.controller.open();
    view.host.dispatch.mockImplementationOnce(() => { view.update({ payment: cash([], true, tenderedPence) }); return true });
    view.element("s3-cash-receive").click();
    expect(view.host.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "RECEIVE_CASH" });
    expect(view.element("s3-cash-receive").hidden).toBe(true);
    expect(view.element(exact ? "s3-cash-confirm" : "s3-cash-add-50").focus).toHaveBeenCalledOnce();
    expect(view.controller.isOpen).toBe(true);
  });

  it.each(CASH_DENOMINATIONS_PENCE)("forwards the %ip coin/note without locally changing the selection", (denominationPence) => {
    const view = mount({ payment: cash() });
    const before = structuredClone(view.snapshot());
    view.controller.open();
    view.element(`s3-cash-add-${denominationPence}`).click();
    expect(view.host.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "ADD_CHANGE", denominationPence });
    expect(view.snapshot()).toEqual(before);
    expect(view.element("s3-cash-selected-total").textContent).toBe("£0.00");
  });

  it("refreshes the selected amount from an accepted command and forwards clear-selection", () => {
    const view = mount({ payment: cash() });
    view.controller.open();
    view.host.dispatch.mockImplementationOnce(() => { view.update({ payment: cash([50]) }); return true });
    view.element("s3-cash-add-50").click();
    expect(view.element("s3-cash-selected-total").textContent).toBe("£0.50");
    view.host.dispatch.mockImplementationOnce(() => { view.update({ payment: cash() }); return true });
    view.element("s3-cash-reset").click();
    expect(view.host.dispatch.mock.calls).toEqual([[{ type: "ADD_CHANGE", denominationPence: 50 }], [{ type: "CLEAR_CHANGE" }]]);
    expect(view.element("s3-cash-selected-total").textContent).toBe("£0.00");
    expect(view.element("s3-cash-reset").disabled).toBe(true);
  });

  it.each([
    { selected: [50, 10, 5], index: 1, remaining: [50, 5], focus: "s3-cash-remove-1" },
    { selected: [50, 10, 5], index: 2, remaining: [50, 10], focus: "s3-cash-remove-1" },
    { selected: [50], index: 0, remaining: [], focus: "s3-cash-add-50" },
  ])("delegates nested tray clicks and restores focus after removing index $index from $selected", ({ selected, index, remaining, focus }) => {
    const view = mount({ payment: cash(selected) });
    view.controller.open();
    view.element(focus).focus.mockClear();
    const button = view.element(`s3-cash-remove-${index}`);
    const label = new ElementDouble("STRONG");
    label.parentElement = button;
    view.host.dispatch.mockImplementationOnce(() => { view.update({ payment: cash(remaining) }); return true });
    view.trayClick(label);
    expect(view.host.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "REMOVE_CHANGE", index });
    expect(view.snapshot().payment).toEqual(cash(remaining));
    expect(view.element(focus).focus).toHaveBeenCalledOnce();
  });

  it("ignores tray clicks without a matching in-tray removal button", () => {
    const view = mount({ payment: cash([50]) });
    view.controller.open();
    const foreign = new ElementDouble("BUTTON");
    foreign.setAttribute("data-change-index", "0");
    for (const target of [null, view.element("s3-cash-tray"), foreign]) view.trayClick(target);
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.snapshot().payment).toEqual(cash([50]));
  });

  it("keeps a rejected receipt unreceived and displays the host's warning without advancing focus", () => {
    const view = mount();
    view.controller.open();
    view.host.dispatch.mockImplementationOnce(() => { view.update({ warning: "请先扫描全部商品。" }); return false });
    view.element("s3-cash-receive").click();
    expect(view.host.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "RECEIVE_CASH" });
    expect(view.snapshot().payment).toEqual(cash([], false));
    expect(view.element("s3-cash-receive").hidden).toBe(false);
    expect(view.element("s3-cash-add-50").focus).not.toHaveBeenCalled();
    expect(view.element("s3-cash-save-note").textContent).toBe("请先扫描全部商品。");
    expect(view.controller.isOpen).toBe(true);
  });

  it("confirms once, closes after the host completes checkout, and ignores a stale second click", () => {
    const view = mount({ payment: cash([50, 10, 5]) });
    view.controller.open();
    view.host.dispatch.mockImplementationOnce(() => { view.update({ payment: null, atCheckout: false }); return true });
    view.element("s3-cash-confirm").click();
    expect(view.host.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "CONFIRM_CASH" });
    expect(view.controller.isOpen).toBe(false);
    expect(view.host.onClose).toHaveBeenCalledOnce();
    view.element("s3-cash-confirm").click();
    expect(view.host.dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "write ownership was lost", patch: { canWrite: false } },
    { label: "the visitor left checkout", patch: { atCheckout: false } },
    { label: "the cash payment was cleared", patch: { payment: null } },
    { label: "a different card payment is active", patch: { payment: { method: "card" as const } } },
  ])("closes on redraw when $label", ({ patch }) => {
    const view = mount({ payment: cash([50]) });
    view.controller.open();
    view.update(patch);
    view.controller.render();
    expect(view.controller.isOpen).toBe(false);
    expect(view.host.onClose).toHaveBeenCalledOnce();
    expect(view.host.dispatch).not.toHaveBeenCalled();
  });

  it("also closes when a rejected command reports lost write ownership", () => {
    const view = mount({ payment: cash() });
    view.controller.open();
    view.host.dispatch.mockImplementationOnce(() => { view.update({ canWrite: false }); return false });
    view.element("s3-cash-add-50").click();
    expect(view.host.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "ADD_CHANGE", denominationPence: 50 });
    expect(view.controller.isOpen).toBe(false);
    expect(view.host.onClose).toHaveBeenCalledOnce();
  });

  it.each(["closed", "read-only"] as const)("does not forward clicks when the register is %s", (reason) => {
    const view = mount({ payment: cash([50, 10, 5]) });
    view.controller.open();
    if (reason === "closed") view.controller.close();
    else view.update({ canWrite: false });
    for (const id of ["s3-cash-receive", "s3-cash-add-50", "s3-cash-reset", "s3-cash-confirm"]) view.element(id).click();
    view.trayClick(view.element("s3-cash-remove-0"));
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.snapshot().payment).toEqual(cash([50, 10, 5]));
  });
});

describe("register replay and keyboard isolation", () => {
  it("uses the current clip for the replay button, R and slower Shift+R", () => {
    const view = mount();
    view.controller.open();
    view.element("s3-cash-replay").click();
    expect(key("KeyR").defaultPrevented).toBe(true);
    const secondClip = { ...TENDER_CLIP, src: "/assets/sim3d/audio/customers/male/tender-cash-five-pounds.wav" };
    view.update({ clip: secondClip });
    expect(key("KeyR", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(view.host.speak.mock.calls).toEqual([[TENDER_CLIP, 1], [TENDER_CLIP, 1], [secondClip, .84]]);
    expect(view.host.dispatch).not.toHaveBeenCalled();
  });

  it("swallows repeated R without replaying or letting background hotkeys run", () => {
    const view = mount();
    const background = vi.fn();
    windowDouble.addEventListener("keydown", background);
    view.controller.open();
    expect(key("KeyR", { repeat: true }).defaultPrevented).toBe(true);
    expect(view.host.speak).not.toHaveBeenCalled();
    expect(background).not.toHaveBeenCalled();
  });

  it.each(["closed", "read-only", "no-clip"] as const)("does not replay while %s", (reason) => {
    const view = mount();
    view.controller.open();
    if (reason === "closed") view.controller.close();
    else if (reason === "read-only") view.update({ canWrite: false });
    else view.update({ clip: null });
    view.element("s3-cash-replay").click();
    key("KeyR");
    expect(view.host.speak).not.toHaveBeenCalled();
  });

  it.each(["KeyE", "KeyF", "KeyG", "KeyB", "KeyU", "KeyM"])("blocks background %s hotkeys while cash is being counted", (code) => {
    const listen = vi.spyOn(windowDouble, "addEventListener");
    const view = mount({ payment: cash([50]) });
    expect(listen).toHaveBeenCalledWith("keydown", expect.any(Function), { capture: true, signal: view.abort.signal });
    const background = vi.fn();
    windowDouble.addEventListener("keydown", background);
    view.controller.open();
    expect(key(code).defaultPrevented).toBe(true);
    expect(key(code, { repeat: true }).defaultPrevented).toBe(true);
    expect(background).not.toHaveBeenCalled();
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.host.speak).not.toHaveBeenCalled();
    expect(view.controller.isOpen).toBe(true);
    expect(view.snapshot().payment).toEqual(cash([50]));
  });

  it("does not let the register Escape also open a background game menu", () => {
    const view = mount();
    const background = vi.fn();
    windowDouble.addEventListener("keydown", background);
    view.controller.open();
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(background).not.toHaveBeenCalled();
    expect(view.host.onClose).toHaveBeenCalledOnce();
  });

  it.each(["Tab", "Enter", "Space"])("leaves native %s dialog/button interactions available", (code) => {
    const view = mount();
    const background = vi.fn();
    windowDouble.addEventListener("keydown", background);
    view.controller.open();
    expect(key(code).defaultPrevented).toBe(false);
    expect(background).toHaveBeenCalledOnce();
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.controller.isOpen).toBe(true);
  });

  it.each(["ctrlKey", "metaKey", "altKey", "isComposing"] as const)("does not steal browser/editing shortcuts while %s is active", (modifier) => {
    const view = mount();
    const background = vi.fn();
    windowDouble.addEventListener("keydown", background);
    view.controller.open();
    expect(key("KeyR", { [modifier]: true }).defaultPrevented).toBe(false);
    expect(background).toHaveBeenCalledOnce();
    expect(view.host.speak).not.toHaveBeenCalled();
    expect(view.controller.isOpen).toBe(true);
  });

  it("leaves game key handling untouched while closed", () => {
    const view = mount();
    const background = vi.fn();
    windowDouble.addEventListener("keydown", background);
    for (const code of ["Escape", "KeyR", "KeyE", "KeyF", "KeyG", "KeyB", "KeyU", "KeyM"]) {
      expect(key(code).defaultPrevented).toBe(false);
    }
    expect(background).toHaveBeenCalledTimes(8);
    expect(view.host.speak).not.toHaveBeenCalled();
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.host.onClose).not.toHaveBeenCalled();
  });

  it("removes button and key listeners when its host aborts the controller lifetime", () => {
    const view = mount({ payment: cash([50]) });
    view.controller.open();
    view.abort.abort();
    view.element("s3-cash-reset").click();
    view.element("s3-cash-replay").click();
    view.element("s3-cash-close").click();
    expect(key("KeyR").defaultPrevented).toBe(false);
    expect(key("KeyE").defaultPrevented).toBe(false);
    expect(view.host.dispatch).not.toHaveBeenCalled();
    expect(view.host.speak).not.toHaveBeenCalled();
    expect(view.host.onClose).not.toHaveBeenCalled();
  });
});
