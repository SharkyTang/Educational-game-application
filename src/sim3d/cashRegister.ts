import {
  CASH_DENOMINATIONS_PENCE, MAX_CHANGE_PIECES, cashChangeDuePence,
  cashPaymentCanConfirm, selectedChangeTotalPence, type CashPaymentState,
} from "./cashPayment";

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

export function denominationLabel(pence: number): string {
  return pence < 100 ? `${pence}p` : `£${pence / 100}`;
}

/** These are labelled game controls, not reproductions of real banknotes. */
function denominationButton(pence: number): string {
  const label = denominationLabel(pence);
  const kind = pence >= 500 ? "note" : pence >= 100 ? "pound" : pence < 5 ? "copper" : "silver";
  return `<button id="s3-cash-add-${pence}" class="s3-cash-denomination s3-cash-${kind}" type="button" aria-label="加入 ${label} 找零" disabled><strong>${label}</strong><span>${pence >= 500 ? "纸币 · note" : "硬币 · coin"}</span></button>`;
}

export function cashRegisterMarkup(): string {
  return `<dialog id="s3-cash-dialog" class="s3-cash-dialog" aria-labelledby="s3-cash-title" aria-describedby="s3-cash-intro">
    <header class="s3-cash-heading">
      <div><p class="s3-eyebrow">CASH DESK · POUNDS &amp; PENCE</p><h2 id="s3-cash-title">收下现金，找好零钱</h2></div>
      <button id="s3-cash-close" class="s3-secondary-button" type="button">暂时离开 <kbd>Esc</kbd></button>
    </header>
    <p id="s3-cash-intro" class="s3-muted">先核对顾客交来的钱，再点选零钱。选错可以撤回，打烊后仍可完成本单。</p>
    <ol class="s3-cash-steps" aria-label="现金收款步骤"><li id="s3-cash-step-receive" aria-current="step"><span>01</span> 收下现金</li><li id="s3-cash-step-change"><span>02</span> 选好找零</li><li id="s3-cash-step-confirm"><span>03</span> 确认完成</li></ol>
    <div class="s3-cash-layout">
      <section class="s3-cash-bill" aria-label="本单金额与顾客交款">
        <p class="s3-eyebrow">THIS CUSTOMER · 本单</p>
        <p id="s3-cash-customer-name" class="s3-cash-customer"></p>
        <p class="s3-cash-due-label">应付金额 <span>Total</span></p>
        <strong id="s3-cash-due" class="s3-cash-big-amount">£0.00</strong>
        <dl class="s3-cash-amounts"><div><dt>顾客交付 <span>Cash given</span></dt><dd id="s3-cash-tendered">£0.00</dd></div><div class="s3-cash-change-row"><dt>应找零钱 <span>Change due</span></dt><dd id="s3-cash-change-due">£0.00</dd></div></dl>
        <div class="s3-cash-dialogue"><p id="s3-cash-line" lang="en"></p><p id="s3-cash-zh" class="s3-muted"></p><button id="s3-cash-replay" class="s3-text-button" type="button">重听交款金额 <kbd>R</kbd></button><p id="s3-cash-audio-status" class="s3-muted" role="status" aria-live="polite"></p></div>
        <button id="s3-cash-receive" class="s3-primary-button" type="button">收下现金</button>
        <p id="s3-cash-received-note" class="s3-cash-received-note" hidden>现金已暂收。完成找零后，才会计入小店资金。</p>
      </section>
      <section class="s3-cash-drawer" aria-labelledby="s3-cash-drawer-title">
        <div class="s3-cash-section-heading"><h3 id="s3-cash-drawer-title">点选零钱</h3><span>教学钱箱 · 暂不限制库存</span></div>
        <p id="s3-cash-drawer-help" class="s3-muted">先收下现金，再从钱箱中点选面额。</p>
        <div class="s3-cash-denominations" role="group" aria-label="常用找零面额">${CASH_DENOMINATIONS_PENCE.filter((pence) => pence >= 5).map(denominationButton).join("")}</div>
        <details class="s3-cash-small-coins"><summary>小额硬币 · 1p / 2p</summary><div class="s3-cash-denominations" role="group" aria-label="小额找零面额">${CASH_DENOMINATIONS_PENCE.filter((pence) => pence < 5).map(denominationButton).join("")}</div></details>
        <div class="s3-cash-section-heading s3-cash-tray-heading"><h3>找零托盘</h3><button id="s3-cash-reset" class="s3-text-button" type="button" disabled>清空重选</button></div>
        <div id="s3-cash-tray" class="s3-cash-tray" role="group" aria-label="已选零钱，点击可撤回"><p class="s3-cash-empty">还没有放入零钱</p></div>
        <div class="s3-cash-selected"><span>已选零钱 <small>Selected</small></span><strong id="s3-cash-selected-total">£0.00</strong></div>
        <p id="s3-cash-feedback" class="s3-cash-feedback" role="status" aria-live="polite">请先收下现金。</p>
        <button id="s3-cash-confirm" class="s3-primary-button" type="button" disabled>确认找零</button>
      </section>
    </div>
    <p id="s3-cash-business-clock" class="s3-cash-footer" role="timer" aria-live="off"></p>
    <p id="s3-cash-save-note" class="s3-cash-footer">钱箱仅模拟收钱与找零；暂时离开会保留本单。取消订单请返回小店，在暂停菜单中操作。</p>
  </dialog>`;
}

export function cashRegisterFeedback(payment: CashPaymentState, amountPence: number): { text: string; tone: "neutral" | "warning" | "ready" } {
  if (!payment.received) return { text: "请先收下顾客交来的现金。", tone: "neutral" };
  const due = cashChangeDuePence(payment, amountPence);
  const selected = selectedChangeTotalPence(payment.selectedChange);
  if (selected === due) return {
    text: due === 0 ? "顾客刚好付清，无需找零。确认后完成本单。" : "零钱正好！确认后把零钱交给顾客。",
    tone: "ready",
  };
  if (selected > due) return { text: `多了 ${money(selected - due)}，点击托盘里的零钱撤回。`, tone: "warning" };
  if (payment.selectedChange.length >= MAX_CHANGE_PIECES) return {
    text: `还差 ${money(due - selected)}，托盘已达 ${MAX_CHANGE_PIECES} 枚/张上限，请撤回或清空后换用较大面额。`, tone: "warning",
  };
  return { text: `还差 ${money(due - selected)}，继续从钱箱点选零钱。`, tone: "neutral" };
}

/** Rendering only: every cash mutation is validated and saved by the domain reducer. */
export function renderCashRegister(root: HTMLElement, payment: CashPaymentState, amountPence: number): void {
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const text = (id: string, value: string): void => { el(id).textContent = value };
  const due = cashChangeDuePence(payment, amountPence);
  const selected = selectedChangeTotalPence(payment.selectedChange);
  const ready = cashPaymentCanConfirm(payment, amountPence);
  text("s3-cash-due", money(amountPence));
  text("s3-cash-tendered", money(payment.tenderedPence));
  text("s3-cash-change-due", money(due));
  text("s3-cash-selected-total", money(selected));
  text("s3-cash-receive", `收下 ${money(payment.tenderedPence)} 现金`);
  el("s3-cash-receive").hidden = payment.received;
  el("s3-cash-received-note").hidden = !payment.received;
  text("s3-cash-drawer-help", payment.received ? "点击面额加入托盘；点击托盘里的零钱即可撤回。" : "先收下现金，再从钱箱中点选面额。");
  for (const denomination of CASH_DENOMINATIONS_PENCE) {
    el<HTMLButtonElement>(`s3-cash-add-${denomination}`).disabled = !payment.received || payment.selectedChange.length >= MAX_CHANGE_PIECES;
  }
  el<HTMLButtonElement>("s3-cash-reset").disabled = payment.selectedChange.length === 0;
  el<HTMLButtonElement>("s3-cash-confirm").disabled = !ready;
  text("s3-cash-confirm", due === 0 ? "确认收款 · 无需找零" : `确认找零 · ${money(due)}`);
  const feedback = cashRegisterFeedback(payment, amountPence);
  text("s3-cash-feedback", feedback.text);
  el("s3-cash-feedback").setAttribute("data-tone", feedback.tone);
  const trayMarkup = payment.selectedChange.length
    ? payment.selectedChange.map((pence, index) => `<button id="s3-cash-remove-${index}" data-change-index="${index}" class="s3-cash-tray-piece" type="button" aria-label="撤回第 ${index + 1} 枚 ${denominationLabel(pence)} 找零"><strong>${denominationLabel(pence)}</strong><span aria-hidden="true">×</span></button>`).join("")
    : `<p class="s3-cash-empty">${payment.received && due === 0 ? "刚好付清，无需放入零钱" : "还没有放入零钱"}</p>`;
  // Do not recreate focused buttons on unrelated redraws or replays.
  const tray = el("s3-cash-tray");
  if (tray.innerHTML !== trayMarkup) tray.innerHTML = trayMarkup;
  const current = !payment.received ? "receive" : ready ? "confirm" : "change";
  for (const step of ["receive", "change", "confirm"]) {
    el(`s3-cash-step-${step}`).setAttribute("aria-current", step === current ? "step" : "false");
  }
}
