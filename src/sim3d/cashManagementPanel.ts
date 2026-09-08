import {
  getCashCountStatus, getCashManagementSummary, getRefundOffer,
  type SimCommand, type SimState,
} from "./domain";
import { CASH_DENOMINATIONS_PENCE, type CashDenominationPence } from "./cashPayment";
import { cashDrawerValuePence, type CashDrawerState } from "./cashDrawer";
import { denominationLabel } from "./cashRegister";
import type { CashCountRecord } from "./cashManagement";

const PREFIX = "s3-cash-management-";
const money = (pence: number): string => `${pence < 0 ? "−" : ""}£${(Math.abs(pence) / 100).toFixed(2)}`;
const signedMoney = (pence: number): string => `${pence > 0 ? "+" : ""}${money(pence)}`;
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
type RefundReason = "return" | "void";
export type CashManagementCommand = Extract<SimCommand, { type: "CONFIGURE_CASH_FLOAT" | "REFUND_TRANSACTION" | "RECORD_CASH_COUNT" }>;

export interface CashManagementCallbacks {
  dispatch(command: CashManagementCommand): boolean;
}

/** Keep incomplete edits invalid: a blank, exponent or decimal must never silently become cash. */
export function parseCashManagementCounts(values: ReadonlyMap<CashDenominationPence, string>):
  { drawer: CashDrawerState; totalPence: number } | { error: string } {
  const drawer = {} as CashDrawerState;
  for (const denomination of CASH_DENOMINATIONS_PENCE) {
    const raw = values.get(denomination) ?? "";
    const count = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(count) || count < 0) {
      return { error: `请填写 ${denominationLabel(denomination)} 的非负整数枚数；没有请填 0。` };
    }
    drawer[denomination] = count;
  }
  try { return { drawer, totalPence: cashDrawerValuePence(drawer) } }
  catch { return { error: "现金总额超过可记录范围，请检查各面额数量。" } }
}

function countInputs(kind: "float" | "count"): string {
  return CASH_DENOMINATIONS_PENCE.map((denomination) => `<label class="s3-cash-management-denomination" for="${PREFIX}${kind}-${denomination}"><span>${denominationLabel(denomination)} <small>${denomination >= 500 ? "张" : "枚"}</small></span><input id="${PREFIX}${kind}-${denomination}" type="number" min="0" step="1" inputmode="numeric" autocomplete="off" aria-label="${kind === "float" ? "备用金" : "实点"} ${denominationLabel(denomination)} 数量" aria-describedby="${PREFIX}${kind}-reason" value=""><small id="${PREFIX}${kind}-current-${denomination}"></small></label>`).join("");
}

export function cashManagementMarkup(): string {
  return `<div class="s3-cash-management-heading"><p class="s3-eyebrow">CASH MANAGEMENT</p><h3 id="${PREFIX}title" tabindex="-1">管好小店的现金</h3><p class="s3-muted">准备找零、处理整单退款、打烊时点清钱箱。这里会暂停营业。</p></div>
    <dl class="s3-cash-management-balances"><div><dt>钱箱账面</dt><dd id="${PREFIX}drawer"></dd></div><div><dt>现金保管余额</dt><dd id="${PREFIX}reserve"></dd></div><div><dt>可分配现金合计</dt><dd id="${PREFIX}available"></dd></div></dl>
    <p class="s3-muted">钱箱与保管余额用于现金练习。调整备用金只在两处调配，不增加或扣减经营资金。</p>
    <p id="${PREFIX}notice" class="s3-pause-notice" role="status" aria-live="polite" hidden></p>
    <section class="s3-cash-management-card" aria-labelledby="${PREFIX}float-title"><h4 id="${PREFIX}float-title">开店备用金 <span lang="en">Opening float</span></h4><p class="s3-muted">准备期开门前填写各面额数量。剩余金额转入保管余额，可在下次准备时重新分配面额。</p><div class="s3-cash-management-counts">${countInputs("float")}</div><p id="${PREFIX}float-preview" class="s3-cash-management-preview" role="status" aria-live="polite"></p><p id="${PREFIX}float-reason" class="s3-inline-reason" role="status"></p><div class="s3-management-buttons"><button id="${PREFIX}float-save" type="button" class="s3-primary-button" disabled>保存开店备用金</button><button id="${PREFIX}float-reset" type="button" class="s3-secondary-button">恢复当前面额</button></div></section>
    <section class="s3-cash-management-card" aria-labelledby="${PREFIX}refund-title"><h4 id="${PREFIX}refund-title">当天整单退款 / 撤销 <span lang="en">Refunds</span></h4><p class="s3-muted">退货用于顾客退回整单，撤销用于纠正已收款的整单。都按原付款渠道退还原成交金额，商品退回可用货架或货箱，可重新售卖；保留原小票并追加一次记录。仅当天未日结、当前顾客离店且双手空闲时可操作。</p><p id="${PREFIX}refund-empty" class="s3-muted"></p><div id="${PREFIX}transactions" class="s3-cash-management-transactions"></div>
      <section id="${PREFIX}refund-confirm" class="s3-confirm" aria-labelledby="${PREFIX}refund-confirm-title" hidden><h4 id="${PREFIX}refund-confirm-title">确认退款？</h4><p id="${PREFIX}refund-confirm-description"></p><p id="${PREFIX}refund-confirm-pieces" class="s3-muted"></p><div class="s3-management-buttons"><button id="${PREFIX}refund-confirm-button" type="button" class="s3-primary-button">确认整单退款</button><button id="${PREFIX}refund-cancel" type="button" class="s3-secondary-button">保留原交易</button></div></section>
    </section>
    <section class="s3-cash-management-card" aria-labelledby="${PREFIX}count-title"><h4 id="${PREFIX}count-title">打烊钱箱盘点 <span lang="en">Cash count</span></h4><p class="s3-muted">打烊并送走顾客后，逐项填写实际点到的枚数，没有请填 0。差异会留在记录里，不自动修改钱箱或经营资金；日结前建议核对一次。</p><p id="${PREFIX}count-status" class="s3-cash-management-preview" role="status"></p><div class="s3-cash-management-counts">${countInputs("count")}</div><p id="${PREFIX}count-difference" class="s3-cash-management-preview" role="status" aria-live="polite"></p><label class="s3-cash-management-note" for="${PREFIX}count-note">盘点备注 <span>金额或面额有差异时必填，最多 200 字</span><textarea id="${PREFIX}count-note" rows="3" maxlength="200" aria-describedby="${PREFIX}count-reason" placeholder="例如：少了一枚 £1，已复点，待核查"></textarea></label><p id="${PREFIX}count-reason" class="s3-inline-reason" role="status"></p><div class="s3-management-buttons"><button id="${PREFIX}count-save" type="button" class="s3-primary-button" disabled>保存盘点记录</button><button id="${PREFIX}count-reset" type="button" class="s3-secondary-button">重新填写实点数量</button></div><div id="${PREFIX}count-history" class="s3-cash-management-history" aria-label="现金盘点记录"></div></section>`;
}

/** The pause dialog owns modality; this panel retains unfinished inputs across state renders. */
export class CashManagementPanel {
  private readonly lifetime = new AbortController();
  private transactionEvents = new AbortController();
  private state: SimState | null = null;
  private writable = false;
  private draftDay = 0;
  private floatDirty = false;
  private readonly floatDraft = new Map<CashDenominationPence, string>();
  private readonly countDraft = new Map<CashDenominationPence, string>();
  private countNote = "";
  private transactionSignature = "";
  private countSignature = "";
  private pendingRefund: { transactionId: string; reason: RefundReason } | null = null;

  constructor(private readonly host: HTMLElement, private readonly callbacks: CashManagementCallbacks) {
    host.innerHTML = cashManagementMarkup();
    const listen = (suffix: string, event: string, action: () => void): void => {
      this.element(suffix).addEventListener(event, action, { signal: this.lifetime.signal });
    };
    for (const denomination of CASH_DENOMINATIONS_PENCE) {
      listen(`float-${denomination}`, "input", () => {
        this.floatDraft.set(denomination, this.element<HTMLInputElement>(`float-${denomination}`).value);
        this.floatDirty = true;
        this.renderFloat();
      });
      listen(`count-${denomination}`, "input", () => {
        this.countDraft.set(denomination, this.element<HTMLInputElement>(`count-${denomination}`).value);
        this.renderCount();
      });
    }
    listen("count-note", "input", () => { this.countNote = this.element<HTMLTextAreaElement>("count-note").value; this.renderCount(); });
    listen("float-reset", "click", () => { if (this.state) { this.resetFloat(); this.renderFloat(); this.element("float-1").focus(); } });
    listen("count-reset", "click", () => { this.resetCount(); this.renderCount(); this.element("count-1").focus(); });
    listen("float-save", "click", () => this.saveFloat());
    listen("count-save", "click", () => this.saveCount());
    listen("refund-cancel", "click", () => this.cancelConfirmation(true));
    listen("refund-confirm-button", "click", () => this.confirmRefund());
  }

  private element<T extends HTMLElement = HTMLElement>(suffix: string): T {
    const element = this.host.querySelector<T>(`#${PREFIX}${suffix}`);
    if (!element) throw new Error(`Missing cash management element: ${suffix}`);
    return element;
  }
  private text(suffix: string, value: string): void { this.element(suffix).textContent = value; }
  private notice(message: string): void { this.text("notice", message); this.element("notice").hidden = !message; }

  resetDrafts(): void {
    this.draftDay = 0;
    this.floatDirty = false;
    this.floatDraft.clear();
    this.resetCount();
    this.cancelConfirmation();
    this.notice("");
  }

  private resetFloat(): void {
    if (!this.state) return;
    this.floatDirty = false;
    for (const denomination of CASH_DENOMINATIONS_PENCE) {
      const value = String(this.state.cashDrawer[denomination]);
      this.floatDraft.set(denomination, value);
      this.element<HTMLInputElement>(`float-${denomination}`).value = value;
    }
  }

  private resetCount(): void {
    this.countDraft.clear();
    this.countNote = "";
    for (const denomination of CASH_DENOMINATIONS_PENCE) this.element<HTMLInputElement>(`count-${denomination}`).value = "";
    this.element<HTMLTextAreaElement>("count-note").value = "";
  }

  render(state: SimState, writable: boolean): void {
    this.state = state;
    this.writable = writable;
    if (this.draftDay !== state.day.number) {
      this.draftDay = state.day.number;
      this.resetFloat();
      this.resetCount();
      this.cancelConfirmation();
      this.notice("");
    } else if (!this.floatDirty) this.resetFloat();
    const summary = getCashManagementSummary(state);
    this.text("drawer", money(summary.drawerPence));
    this.text("reserve", money(summary.reservePence));
    this.text("available", money(summary.availableFloatPence));
    this.renderFloat();
    this.renderTransactions();
    this.renderCount();
    if (!writable) this.cancelConfirmation();
  }

  private renderFloat(): void {
    if (!this.state) return;
    const summary = getCashManagementSummary(this.state);
    const parsed = parseCashManagementCounts(this.floatDraft);
    const gateReason = !this.writable ? "请在可编辑的小店管理中操作。" : summary.configureReason;
    const reason = gateReason || ("error" in parsed ? parsed.error : parsed.totalPence > summary.availableFloatPence ? "备用金超过可分配现金，请减少面额数量。" : "");
    this.text("float-preview", "error" in parsed ? "填齐面额数量后显示调配结果。" : `配置后钱箱 ${money(parsed.totalPence)} · 保管余额 ${money(summary.availableFloatPence - parsed.totalPence)}`);
    this.text("float-reason", reason || "金额足够，保存后按这些面额开始找零。" );
    this.element<HTMLButtonElement>("float-save").disabled = !this.writable || !summary.canConfigureFloat || !!reason;
    this.element<HTMLButtonElement>("float-reset").disabled = !this.writable || !summary.canConfigureFloat;
    for (const denomination of CASH_DENOMINATIONS_PENCE) {
      this.element<HTMLInputElement>(`float-${denomination}`).disabled = !this.writable || !summary.canConfigureFloat;
      this.text(`float-current-${denomination}`, `现有 ${this.state.cashDrawer[denomination]}`);
    }
  }

  private saveFloat(): void {
    if (!this.state || !this.writable || !getCashManagementSummary(this.state).canConfigureFloat) return;
    const parsed = parseCashManagementCounts(this.floatDraft);
    if ("error" in parsed || parsed.totalPence > getCashManagementSummary(this.state).availableFloatPence) return;
    if (this.callbacks.dispatch({ type: "CONFIGURE_CASH_FLOAT", drawer: parsed.drawer })) {
      this.resetFloat();
      this.renderFloat();
      this.notice("开店备用金已保存。钱箱与现金保管余额合计不变。");
    } else this.notice("备用金尚未更改。若面额与当前一致，无需重复保存；其他原因请查看管理提示。");
  }

  private renderTransactions(): void {
    if (!this.state) return;
    const state = this.state;
    const transactions = state.transactions.slice(state.day.transactionStart);
    const refunds = state.cashJournal.filter((record) => record.kind === "refund");
    const rows = transactions.map((transaction) => ({
      transaction, offer: getRefundOffer(state, transaction.id),
      refund: refunds.find((record) => record.transactionId === transaction.id),
    }));
    this.text("refund-empty", rows.length ? `今天共 ${rows.length} 笔原始交易，退款后仍保留在这里。` : "今天还没有已收款交易。");
    const signature = JSON.stringify([rows, this.writable]);
    if (signature !== this.transactionSignature) {
      this.transactionSignature = signature;
      this.transactionEvents.abort();
      this.transactionEvents = new AbortController();
      this.element("transactions").innerHTML = [...rows].reverse().map(({ transaction, offer, refund }) => {
        const reason = refund ? `已${refund.reason === "void" ? "撤销" : "退货退款"} · ${money(refund.amountPence)}，不会再次退款。`
          : !this.writable ? "此页面暂不能修改交易。" : offer.reason ?? "可按原渠道整单退款。";
        const disabled = !this.writable || !offer.allowed;
        return `<article class="s3-cash-management-transaction"><div><strong>第 ${transaction.customerNumber} 位顾客 · ${money(transaction.amountPence)}</strong><span>${transaction.paymentMethod === "cash" ? "现金" : "刷卡"} · ${transaction.itemIds.length} 件商品</span></div><p id="${PREFIX}transaction-reason-${escapeHtml(transaction.id)}" class="s3-muted">${escapeHtml(reason)}</p><div class="s3-management-buttons"><button id="${PREFIX}refund-${escapeHtml(transaction.id)}" class="s3-secondary-button" type="button" aria-describedby="${PREFIX}transaction-reason-${escapeHtml(transaction.id)}" ${disabled ? "disabled" : ""}>整单退货退款</button><button id="${PREFIX}void-${escapeHtml(transaction.id)}" class="s3-text-button" type="button" ${disabled ? "disabled" : ""}>撤销这笔收款</button></div></article>`;
      }).join("");
      for (const { transaction } of rows) {
        for (const reason of ["return", "void"] as const) {
          this.element(`${reason === "return" ? "refund" : "void"}-${transaction.id}`).addEventListener("click", () => {
            if (!this.state || !this.writable || !getRefundOffer(this.state, transaction.id).allowed) return;
            this.pendingRefund = { transactionId: transaction.id, reason };
            this.renderRefundConfirmation();
            this.element("refund-cancel").focus();
          }, { signal: this.transactionEvents.signal });
        }
      }
    }
    this.renderRefundConfirmation();
  }

  private renderRefundConfirmation(): void {
    const pending = this.pendingRefund;
    const transaction = pending && this.state?.transactions.find((record) => record.id === pending.transactionId);
    if (!pending || !transaction || !this.state || !getRefundOffer(this.state, transaction.id).allowed) {
      this.cancelConfirmation();
      return;
    }
    const offer = getRefundOffer(this.state, transaction.id);
    this.element("refund-confirm").hidden = false;
    this.text("refund-confirm-title", pending.reason === "void" ? "确认撤销这笔已收款交易？" : "确认整单退货退款？");
    this.text("refund-confirm-description", `向第 ${transaction.customerNumber} 位顾客按原${transaction.paymentMethod === "cash" ? "现金" : "刷卡"}渠道退还 ${money(transaction.amountPence)}，${transaction.itemIds.length} 件商品退回可用货架或货箱。原交易会保留，此单只可退款一次。`);
    this.text("refund-confirm-pieces", transaction.paymentMethod === "cash" ? `从钱箱退还：${offer.returnedCash.map(denominationLabel).join(" + ")}。` : "刷卡退款不会取出钱箱现金。");
    this.element<HTMLButtonElement>("refund-confirm-button").disabled = !this.writable;
    this.text("refund-confirm-button", pending.reason === "void" ? "确认撤销并退款" : "确认整单退款");
  }

  private confirmRefund(): void {
    if (!this.pendingRefund || !this.state || !this.writable) return;
    const pending = { ...this.pendingRefund };
    if (!getRefundOffer(this.state, pending.transactionId).allowed) { this.renderRefundConfirmation(); return; }
    if (this.callbacks.dispatch({ type: "REFUND_TRANSACTION", ...pending })) {
      this.cancelConfirmation();
      this.notice("已按原渠道完成整单退款。原小票保留，商品退回可用货架或货箱，可重新售卖。");
      this.element("title").focus();
    } else this.notice("退款尚未完成，原交易保留。请查看管理提示后再试。");
  }

  cancelConfirmation(restoreFocus = false): boolean {
    const previous = this.pendingRefund;
    this.pendingRefund = null;
    this.element("refund-confirm").hidden = true;
    if (restoreFocus && previous) this.element(`${previous.reason === "return" ? "refund" : "void"}-${previous.transactionId}`).focus();
    return previous !== null;
  }

  private renderCount(): void {
    if (!this.state) return;
    const state = this.state;
    const summary = getCashManagementSummary(state);
    const status = getCashCountStatus(state);
    const recordedDenominationDifference = status.record !== null && Object.values(status.record.denominationDifferences).some((count) => count !== 0);
    const parsed = parseCashManagementCounts(this.countDraft);
    const difference = "error" in parsed ? null : parsed.totalPence - summary.drawerPence;
    const differentDenominations = "error" in parsed ? false : CASH_DENOMINATIONS_PENCE.some((denomination) => parsed.drawer[denomination] !== state.cashDrawer[denomination]);
    const reason = !this.writable ? "请在可编辑的小店管理中操作。" : summary.countReason || ("error" in parsed ? parsed.error : differentDenominations && !this.countNote.trim() ? "金额或面额有差异，请填写备注后保存。" : this.countNote.trim().length > 200 ? "备注请控制在 200 字以内。" : "");
    this.text("count-status", status.status === "missing" ? "今天尚未盘点。" : status.status === "stale" ? "上次盘点后现金或交易发生变化，请重新盘点。" : `最新盘点：实点 ${money(status.record!.countedPence)} · 差额 ${signedMoney(status.record!.differencePence)}${recordedDenominationDifference ? " · 面额有差异" : " · 各面额一致"}。`);
    this.text("count-difference", "error" in parsed ? "填齐所有面额后显示实点金额和差额。" : `账面 ${money(summary.drawerPence)} · 实点 ${money(parsed.totalPence)} · 差额 ${signedMoney(difference!)}${differentDenominations && difference === 0 ? " · 总额相同，面额数量有差异" : ""}`);
    this.text("count-reason", reason || "核对后可保存。盘点只记录实际点数，不自动调整账面余额。" );
    this.element<HTMLButtonElement>("count-save").disabled = !this.writable || !summary.canCountCash || !!reason;
    this.element<HTMLButtonElement>("count-reset").disabled = !this.writable || !summary.canCountCash;
    this.element<HTMLTextAreaElement>("count-note").disabled = !this.writable || !summary.canCountCash;
    for (const denomination of CASH_DENOMINATIONS_PENCE) {
      this.element<HTMLInputElement>(`count-${denomination}`).disabled = !this.writable || !summary.canCountCash;
      this.text(`count-current-${denomination}`, `账面 ${state.cashDrawer[denomination]}`);
    }
    const records = state.cashJournal.filter((record): record is CashCountRecord => record.kind === "count" && record.dayNumber === state.day.number);
    const signature = JSON.stringify(records);
    if (signature !== this.countSignature) {
      this.countSignature = signature;
      this.element("count-history").innerHTML = records.length ? `<h5>今日盘点记录</h5>${[...records].reverse().map((record) => `<article><strong>实点 ${money(record.countedPence)} · 差额 ${signedMoney(record.differencePence)}</strong><p>账面 ${money(record.expectedPence)}${record.note ? ` · ${escapeHtml(record.note)}` : " · 面额核对一致"}</p></article>`).join("")}` : "";
    }
  }

  private saveCount(): void {
    if (!this.state || !this.writable || !getCashManagementSummary(this.state).canCountCash) return;
    const parsed = parseCashManagementCounts(this.countDraft);
    if ("error" in parsed || this.countNote.trim().length > 200) return;
    if (CASH_DENOMINATIONS_PENCE.some((denomination) => parsed.drawer[denomination] !== this.state!.cashDrawer[denomination]) && !this.countNote.trim()) return;
    if (this.callbacks.dispatch({ type: "RECORD_CASH_COUNT", counts: parsed.drawer, note: this.countNote.trim() })) {
      this.notice("盘点记录已保存。差额已记录，钱箱、保管余额和经营资金未被调整。");
      this.renderCount();
    } else this.notice("盘点尚未保存，填写的数量和备注已保留。请查看管理提示后再试。");
  }

  dispose(): void { this.lifetime.abort(); this.transactionEvents.abort(); this.host.replaceChildren(); }
}
