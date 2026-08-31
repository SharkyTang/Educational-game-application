import { CASH_DENOMINATIONS_PENCE, cashPaymentCanConfirm, type PaymentState } from "./cashPayment";
import { renderCashRegister } from "./cashRegister";
import type { CustomerSpeechClip } from "./customerSelection";

export type CashRegisterCommand =
  | { type: "RECEIVE_CASH" }
  | { type: "ADD_CHANGE"; denominationPence: number }
  | { type: "REMOVE_CHANGE"; index: number }
  | { type: "CLEAR_CHANGE" }
  | { type: "CONFIRM_CASH" };

interface RegisterSnapshot {
  payment: PaymentState | null;
  amountPence: number;
  atCheckout: boolean;
  canWrite: boolean;
  customerName: string;
  clip: CustomerSpeechClip | null;
  warning: string;
}

interface RegisterHost {
  read(): RegisterSnapshot;
  /** The same live target and distance rules as interacting with the 3D counter. */
  canOpen(): boolean;
  dispatch(command: CashRegisterCommand): boolean;
  onOpen(): void;
  onClose(): void;
  speak(clip: CustomerSpeechClip, rate: number): void;
}

/** Owns DOM and focus only. Money, pending tender and selected coins live in the save. */
export class CashRegisterController {
  private readonly dialog: HTMLDialogElement;

  constructor(private readonly root: HTMLElement, private readonly host: RegisterHost, signal: AbortSignal) {
    this.dialog = this.el<HTMLDialogElement>("s3-cash-dialog");
    const click = (id: string, action: () => void): void => { this.el(id).addEventListener("click", action, { signal }) };
    click("s3-cash-close", () => this.close());
    click("s3-cash-replay", () => this.replay());
    click("s3-cash-receive", () => {
      if (this.act({ type: "RECEIVE_CASH" })) {
        const state = this.host.read();
        this.el(cashPaymentCanConfirm(state.payment, state.amountPence) ? "s3-cash-confirm" : "s3-cash-add-50").focus();
      }
    });
    click("s3-cash-reset", () => this.act({ type: "CLEAR_CHANGE" }));
    click("s3-cash-confirm", () => this.act({ type: "CONFIRM_CASH" }));
    for (const denominationPence of CASH_DENOMINATIONS_PENCE) click(`s3-cash-add-${denominationPence}`, () => this.act({ type: "ADD_CHANGE", denominationPence }));
    this.el("s3-cash-tray").addEventListener("click", (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-change-index]");
      if (!button || !this.el("s3-cash-tray").contains(button)) return;
      const index = Number(button.dataset.changeIndex);
      if (this.act({ type: "REMOVE_CHANGE", index }) && this.isOpen) {
        const payment = this.host.read().payment;
        const next = payment?.method === "cash" ? Math.min(index, payment.selectedChange.length - 1) : -1;
        this.el(next >= 0 ? `s3-cash-remove-${next}` : "s3-cash-add-50").focus();
      }
    }, { signal });
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close() }, { signal });
    window.addEventListener("keydown", (event) => {
      if (!this.isOpen || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.code === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); this.close();
      } else if (event.code === "KeyR") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) this.replay(event.shiftKey ? .84 : 1);
      } else if (["KeyE", "KeyF", "KeyG", "KeyB", "KeyU", "KeyM"].includes(event.code)) {
        // Never let a background shop hotkey commit or navigate during cash counting.
        event.preventDefault(); event.stopImmediatePropagation();
      }
      // Tab and Enter remain native, accessible dialog/button interactions.
    }, { capture: true, signal });
  }

  get isOpen(): boolean { return this.dialog.open }

  open(): boolean {
    if (this.isOpen) return true;
    const state = this.host.read();
    if (!this.host.canOpen() || !state.atCheckout || !state.canWrite || state.payment?.method !== "cash") return false;
    this.host.onOpen();
    this.dialog.showModal();
    this.render();
    this.el(!state.payment.received ? "s3-cash-receive"
      : cashPaymentCanConfirm(state.payment, state.amountPence) ? "s3-cash-confirm" : "s3-cash-add-50").focus();
    return true;
  }

  close(): void {
    if (!this.isOpen) return;
    this.dialog.close();
    this.host.onClose();
  }

  replay(rate = 1): void {
    if (!this.isOpen || !this.host.read().canWrite) return;
    const clip = this.host.read().clip;
    if (clip) this.host.speak(clip, rate);
  }

  render(): void {
    if (!this.isOpen) return;
    const state = this.host.read();
    if (!state.canWrite || !state.atCheckout || state.payment?.method !== "cash") { this.close(); return }
    renderCashRegister(this.root, state.payment, state.amountPence);
    this.el("s3-cash-customer-name").textContent = state.customerName;
    this.el("s3-cash-line").textContent = state.clip ? `“${state.clip.text}”` : "";
    this.el("s3-cash-zh").textContent = state.clip?.zh ?? "";
    const note = this.el("s3-cash-save-note");
    note.textContent = state.warning || "钱箱仅模拟收钱与找零；暂时离开会保留本单。取消订单请返回小店，在暂停菜单中操作。";
    note.setAttribute("data-error", state.warning ? "true" : "false");
  }

  private act(command: CashRegisterCommand): boolean {
    if (!this.isOpen || !this.host.read().canWrite) return false;
    const changed = this.host.dispatch(command);
    this.render();
    return changed;
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T { return this.root.querySelector<T>(`#${id}`)! }
}
