import { CASH_DENOMINATIONS_PENCE, cashPaymentCanConfirm, type PaymentState } from "./cashPayment";
import { renderCashRegister } from "./cashRegister";
import { canMakeExactChange, selectedChangeFitsDrawer, type CashDrawerState } from "./cashDrawer";
import type { CustomerSpeechClip } from "./customerSelection";
import { CashVisualViewport } from "./cashVisualViewport";
import { cashVisualPickCommand, deriveCashVisualState } from "./cashVisualState";

export type CashRegisterCommand =
  | { type: "RECEIVE_CASH" }
  | { type: "ADD_CHANGE"; denominationPence: number }
  | { type: "REMOVE_CHANGE"; index: number }
  | { type: "CLEAR_CHANGE" }
  | { type: "CONFIRM_CASH" }
  | { type: "REQUEST_EXACT_CASH" }
  | { type: "SWITCH_CASH_TO_CARD" };

interface RegisterSnapshot {
  payment: PaymentState | null;
  amountPence: number;
  drawer: CashDrawerState;
  atCheckout: boolean;
  canWrite: boolean;
  reducedMotion?: boolean;
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
  onDrawerChange?(open: boolean): void;
  speak(clip: CustomerSpeechClip, rate: number): void;
}

/** Owns DOM and focus only. Money, pending tender and selected coins live in the save. */
export class CashRegisterController {
  private readonly dialog: HTMLDialogElement;
  private visual: CashVisualViewport | null = null;
  private drawerOpen = true;

  constructor(private readonly root: HTMLElement, private readonly host: RegisterHost, signal: AbortSignal) {
    this.dialog = this.el<HTMLDialogElement>("s3-cash-dialog");
    signal.addEventListener("abort", () => { this.visual?.dispose(); this.visual = null; }, { once: true });
    const click = (id: string, action: () => void): void => { this.el(id).addEventListener("click", action, { signal }) };
    click("s3-cash-close", () => this.close());
    click("s3-cash-replay", () => this.replay());
    click("s3-cash-receive", () => {
      if (this.act({ type: "RECEIVE_CASH" })) {
        const state = this.host.read();
        this.focusNextControl(state);
      }
    });
    click("s3-cash-reset", () => {
      if (this.act({ type: "CLEAR_CHANGE" }) && this.isOpen) this.focusNextControl(this.host.read());
    });
    click("s3-cash-confirm", () => this.act({ type: "CONFIRM_CASH" }));
    click("s3-cash-request-exact", () => {
      if (this.act({ type: "REQUEST_EXACT_CASH" }) && this.isOpen) {
        this.el("s3-cash-receive").focus();
        this.replay();
      }
    });
    click("s3-cash-switch-card", () => this.act({ type: "SWITCH_CASH_TO_CARD" }));
    for (const denominationPence of CASH_DENOMINATIONS_PENCE) click(`s3-cash-add-${denominationPence}`, () => {
      if (this.act({ type: "ADD_CHANGE", denominationPence }) && this.isOpen
        && this.el<HTMLButtonElement>(`s3-cash-add-${denominationPence}`).disabled) {
        this.focusNextControl(this.host.read());
      }
    });
    this.el("s3-cash-tray").addEventListener("click", (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-change-index]");
      if (!button || !this.el("s3-cash-tray").contains(button)) return;
      const index = Number(button.dataset.changeIndex);
      if (this.act({ type: "REMOVE_CHANGE", index }) && this.isOpen) {
        const payment = this.host.read().payment;
        const next = payment?.method === "cash" ? Math.min(index, payment.selectedChange.length - 1) : -1;
        if (next >= 0) this.el(`s3-cash-remove-${next}`).focus();
        else this.focusNextControl(this.host.read());
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
    this.drawerOpen = true;
    const visualHost = this.root.querySelector<HTMLElement>("#s3-cash-visual-host");
    if (visualHost) {
      this.visual ??= new CashVisualViewport(visualHost, {
        onPick: (pick) => {
          const command = cashVisualPickCommand(this.visualSnapshot(this.host.read()), pick);
          if (!command || !this.act(command)) return false;
          return true;
        },
        onUnavailable: () => this.render(),
        onDrawerChange: (open) => {
          if (!this.isOpen || !this.host.read().canWrite) return;
          this.drawerOpen = open;
          this.host.onDrawerChange?.(open);
          this.render();
        },
      });
      this.visual.show(this.visualSnapshot(state));
    }
    this.host.onDrawerChange?.(true);
    this.render();
    this.focusNextControl(state);
    return true;
  }

  close(): void {
    if (!this.isOpen) return;
    this.visual?.hide();
    this.host.onDrawerChange?.(false);
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
    renderCashRegister(this.root, state.payment, state.amountPence, state.drawer);
    this.visual?.update(this.visualSnapshot(state));
    const drawerClosed = this.visual?.available === true && !this.drawerOpen;
    for (const id of ["s3-cash-reset", "s3-cash-confirm",
      ...CASH_DENOMINATIONS_PENCE.map((piece) => `s3-cash-add-${piece}`)]) {
      const button = this.el<HTMLButtonElement>(id);
      button.disabled = button.disabled || drawerClosed;
    }
    for (const [index] of state.payment.selectedChange.entries()) this.el<HTMLButtonElement>(`s3-cash-remove-${index}`).disabled = drawerClosed;
    // These three controls otherwise remain enabled across redraws.
    this.el<HTMLButtonElement>("s3-cash-receive").disabled = drawerClosed;
    this.el<HTMLButtonElement>("s3-cash-request-exact").disabled = drawerClosed;
    this.el<HTMLButtonElement>("s3-cash-switch-card").disabled = drawerClosed;
    this.el("s3-cash-customer-name").textContent = state.customerName;
    this.el("s3-cash-line").textContent = state.clip ? `“${state.clip.text}”` : "";
    this.el("s3-cash-zh").textContent = state.clip?.zh ?? "";
    const note = this.el("s3-cash-save-note");
    note.textContent = state.warning || (drawerClosed ? "钱箱已合上，请打开后继续；本单现金与找零均保留。"
      : "钱箱会按面额记录收钱与找零；暂时离开会保留本单。取消订单请返回小店，在暂停菜单中操作。");
    note.setAttribute("data-error", state.warning ? "true" : "false");
  }

  private act(command: CashRegisterCommand): boolean {
    if (!this.isOpen || !this.host.read().canWrite || (this.visual?.available && !this.drawerOpen)) return false;
    const changed = this.host.dispatch(command);
    this.render();
    return changed;
  }

  private visualSnapshot(state: RegisterSnapshot) {
    return deriveCashVisualState({ payment: state.payment, cashDrawer: state.drawer, amountPence: state.amountPence,
      checkout: state.atCheckout, open: this.drawerOpen || !this.visual?.available,
      canInteract: this.isOpen && state.canWrite && state.atCheckout, reducedMotion: state.reducedMotion === true });
  }

  private nextControlId(state: RegisterSnapshot): string {
    const payment = state.payment;
    if (payment?.method !== "cash" || !payment.received) return "s3-cash-receive";
    if (cashPaymentCanConfirm(payment, state.amountPence) && selectedChangeFitsDrawer(state.drawer, payment.selectedChange)) {
      return "s3-cash-confirm";
    }
    const due = payment.tenderedPence - state.amountPence;
    if (due > 0 && !canMakeExactChange(state.drawer, due)) return "s3-cash-request-exact";
    // Prefer a visible common denomination. Small coins live in a collapsed
    // <details>, so they are considered only when no common button is usable.
    const commonFocusOrder = [50, ...CASH_DENOMINATIONS_PENCE.filter((piece) => piece >= 5 && piece !== 50)] as const;
    const denomination = [...commonFocusOrder, ...CASH_DENOMINATIONS_PENCE.filter((piece) => piece < 5)]
      .find((piece) => {
        const button = this.el<HTMLButtonElement>(`s3-cash-add-${piece}`);
        return !button.disabled && !button.hidden;
      });
    return denomination === undefined ? "s3-cash-reset" : `s3-cash-add-${denomination}`;
  }

  private focusNextControl(state: RegisterSnapshot): void {
    const id = this.nextControlId(state);
    const denomination = /^s3-cash-add-(\d+)$/.exec(id)?.[1];
    if (denomination !== undefined && Number(denomination) < 5) {
      const smallCoins = this.root.querySelector<HTMLDetailsElement>(".s3-cash-small-coins");
      if (smallCoins) smallCoins.open = true;
    }
    this.el(id).focus();
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T { return this.root.querySelector<T>(`#${id}`)! }
}
