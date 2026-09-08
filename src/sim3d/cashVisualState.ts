import {
  CASH_DENOMINATIONS_PENCE, MAX_CHANGE_PIECES, isCashDenomination, selectedChangeTotalPence,
  validatePaymentState, type CashDenominationPence, type PaymentState,
} from "./cashPayment";
import { cashDrawerValuePence, validateCashDrawerState, type CashDrawerState } from "./cashDrawer";
import type { CashRegisterCommand } from "./cashRegisterController";

/** A stack is a bounded sample of real pieces; its count label must use actualCount. */
export const MAX_VISIBLE_CASH_STACK_PIECES = 6;
export type CashVisualPieceKind = "coin" | "note";

export interface CashVisualInput {
  payment: PaymentState | null;
  cashDrawer: CashDrawerState;
  amountPence: number;
  checkout: boolean;
  open: boolean;
  /** Includes current write permission, scan readiness and host interaction availability. */
  canInteract: boolean;
  /** Presentation preference only; never persisted as part of payment. */
  reducedMotion?: boolean;
}

export interface CashVisualDrawerSlot {
  denominationPence: CashDenominationPence;
  kind: CashVisualPieceKind;
  /** Persisted denomination inventory, before the learner's tray reservation. */
  drawerCount: number;
  reservedCount: number;
  /** Available physical pieces, clamped at zero for recoverable old oversized trays. */
  actualCount: number;
  stackCount: number;
  canAdd: boolean;
}

export interface CashVisualStack {
  denominationPence: CashDenominationPence;
  kind: CashVisualPieceKind;
  actualCount: number;
  stackCount: number;
  /** Full original indices; no pieces are discarded from the payment or change tray. */
  indices: number[];
  /** The last bounded sample of original indices, suitable for individual mesh picks. */
  visibleIndices: number[];
}

export interface CashVisualChangePiece {
  denominationPence: CashDenominationPence;
  index: number;
  canRemove: boolean;
}

export interface CashVisualSnapshot {
  stage: "idle" | "awaiting" | "received";
  open: boolean;
  reducedMotion: boolean;
  canInteract: boolean;
  canReceive: boolean;
  amountPence: number;
  tenderedPence: number;
  changeDuePence: number;
  selectedChangePence: number;
  drawer: CashVisualDrawerSlot[];
  /** A copy of the complete recorded or legacy-derived offered-piece sequence. */
  tender: CashDenominationPence[];
  tenderStacks: CashVisualStack[];
  tenderSource: "none" | "recorded" | "derived";
  tenderSourceLabel: string;
  /** Complete original tray order, including old selections exceeding current stock. */
  change: CashVisualChangePiece[];
  changeStacks: CashVisualStack[];
}

export type CashVisualPick =
  | { kind: "receive" }
  | { kind: "add"; denominationPence: number }
  | { kind: "remove"; index: number };

export type CashVisualCommand = Extract<CashRegisterCommand, {
  type: "RECEIVE_CASH" | "ADD_CHANGE" | "REMOVE_CHANGE";
}>;

const pieceKind = (denomination: CashDenominationPence): CashVisualPieceKind => denomination >= 500 ? "note" : "coin";

function boundedStacks(pieces: readonly CashDenominationPence[]): CashVisualStack[] {
  return CASH_DENOMINATIONS_PENCE.flatMap((denominationPence) => {
    const indices = pieces.flatMap((piece, index) => piece === denominationPence ? [index] : []);
    if (indices.length === 0) return [];
    const stackCount = Math.min(indices.length, MAX_VISIBLE_CASH_STACK_PIECES);
    return [{ denominationPence, kind: pieceKind(denominationPence), actualCount: indices.length,
      stackCount, indices, visibleIndices: indices.slice(-stackCount) }];
  });
}

/**
 * Rendering-only projection. It never adds tentative tender to the till, removes money,
 * changes a payment or creates a second balance. Malformed input disables every pick.
 */
export function deriveCashVisualState(input: CashVisualInput): CashVisualSnapshot {
  let validDrawer = validateCashDrawerState(input.cashDrawer);
  if (validDrawer) {
    try { cashDrawerValuePence(input.cashDrawer); } catch { validDrawer = false; }
  }
  const validAmount = Number.isSafeInteger(input.amountPence) && input.amountPence > 0;
  const payment = input.checkout === true && validAmount && validatePaymentState(input.payment, input.amountPence)
    && input.payment?.method === "cash" ? input.payment : null;
  const stage: CashVisualSnapshot["stage"] = payment ? payment.received ? "received" : "awaiting" : "idle";
  const open = input.open === true;
  const canInteract = validDrawer && payment !== null && open && input.canInteract === true;
  const tender = payment ? [...payment.tenderedCash] : [];
  // validatePaymentState preserves incorrect totals and old over-reservations so they remain correctable.
  const selected = payment ? [...payment.selectedChange] as CashDenominationPence[] : [];
  const canRemove = canInteract && stage === "received";
  const drawer = CASH_DENOMINATIONS_PENCE.map((denominationPence): CashVisualDrawerSlot => {
    const drawerCount = validDrawer ? input.cashDrawer[denominationPence] : 0;
    const reservedCount = selected.filter((piece) => piece === denominationPence).length;
    const actualCount = Math.max(0, drawerCount - reservedCount);
    return { denominationPence, kind: pieceKind(denominationPence), drawerCount, reservedCount, actualCount,
      stackCount: Math.min(actualCount, MAX_VISIBLE_CASH_STACK_PIECES),
      canAdd: canRemove && actualCount > 0 && selected.length < MAX_CHANGE_PIECES };
  });
  const tenderSource: CashVisualSnapshot["tenderSource"] = payment
    ? payment.tenderedCashRecorded ? "recorded" : "derived" : "none";
  return {
    stage, open, reducedMotion: input.reducedMotion === true, canInteract, canReceive: canInteract && stage === "awaiting",
    amountPence: validAmount ? input.amountPence : 0,
    tenderedPence: payment?.tenderedPence ?? 0,
    changeDuePence: payment ? payment.tenderedPence - input.amountPence : 0,
    selectedChangePence: selectedChangeTotalPence(selected), drawer, tender, tenderStacks: boundedStacks(tender),
    tenderSource,
    tenderSourceLabel: tenderSource === "recorded" ? "顾客交款面额（已记录）"
      : tenderSource === "derived" ? "旧版未记录面额，以下按金额推导示意" : "",
    change: selected.map((denominationPence, index) => ({ denominationPence, index, canRemove })),
    changeStacks: boundedStacks(selected),
  };
}

/** Resolve against a freshly derived snapshot for each pick; the existing reducer remains authoritative. */
export function cashVisualPickCommand(snapshot: CashVisualSnapshot, pick: CashVisualPick): CashVisualCommand | null {
  if (!snapshot.open || !snapshot.canInteract || snapshot.stage === "idle") return null;
  if (pick.kind === "receive") return snapshot.stage === "awaiting" && snapshot.canReceive ? { type: "RECEIVE_CASH" } : null;
  if (snapshot.stage !== "received") return null;
  if (pick.kind === "add") {
    if (!isCashDenomination(pick.denominationPence) || snapshot.change.length >= MAX_CHANGE_PIECES) return null;
    const slot = snapshot.drawer.find((entry) => entry.denominationPence === pick.denominationPence);
    return slot?.canAdd && slot.actualCount > 0 ? { type: "ADD_CHANGE", denominationPence: slot.denominationPence } : null;
  }
  if (pick.kind === "remove") {
    if (!Number.isSafeInteger(pick.index) || pick.index < 0) return null;
    const piece = snapshot.change[pick.index];
    return piece?.canRemove && piece.index === pick.index ? { type: "REMOVE_CHANGE", index: piece.index } : null;
  }
  return null;
}
