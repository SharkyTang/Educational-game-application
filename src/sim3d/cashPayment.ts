export type PaymentMethod = "card" | "cash";

/** Exact v8-v11 payment shape. Kept read-only for strict old-save validation. */
export interface LegacyCashPaymentState {
  method: "cash";
  /** Money offered by this visitor, kept out of the shop ledger until confirmation. */
  tenderedPence: number;
  received: boolean;
  /** One denomination per selected piece; alternative correct combinations are valid. */
  selectedChange: number[];
}

export type LegacyPaymentState = { method: "card" } | LegacyCashPaymentState;

/** v12 records the actual pieces offered by the customer, not just their sum. */
export interface CashPaymentState extends LegacyCashPaymentState {
  tenderedCash: CashDenominationPence[];
  /** False only when v12 had to derive an in-progress v8-v11 tender from its total. */
  tenderedCashRecorded: boolean;
}

export type PaymentState = { method: "card" } | CashPaymentState;

export const CASH_DENOMINATIONS_PENCE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
export type CashDenominationPence = (typeof CASH_DENOMINATIONS_PENCE)[number];
export const MAX_CHANGE_PIECES = 100;

const LEGACY_CUSTOMER_SEED = 31;
const TENDER_NOTES_PENCE = [500, 1000] as const;
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isPositiveAmount = (value: unknown): value is number => isInteger(value) && value > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isCashDenomination(value: unknown): value is CashDenominationPence {
  return isInteger(value) && CASH_DENOMINATIONS_PENCE.some((denomination) => denomination === value);
}

function validChangeSelection(value: unknown): value is number[] {
  return validPieceArray(value, true);
}

function validCashPieces(value: unknown): value is CashDenominationPence[] {
  return validPieceArray(value, false);
}

function validPieceArray(value: unknown, allowEmpty: boolean): value is CashDenominationPence[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || (!allowEmpty && value.length === 0) || value.length > MAX_CHANGE_PIECES) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isCashDenomination(value[index])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validTender(tenderedPence: unknown, amountPence: number): tenderedPence is number {
  return isPositiveAmount(amountPence) && isPositiveAmount(tenderedPence) && tenderedPence >= amountPence
    && (tenderedPence === amountPence || TENDER_NOTES_PENCE.some((note) => note === tenderedPence));
}

/** Strict validator for unmodified v8-v11 cash snapshots. */
export function validateLegacyPaymentState(value: unknown, amountPence: number): value is LegacyPaymentState {
  if (!isPositiveAmount(amountPence) || !isRecord(value)) return false;
  if (value.method === "card") return Object.keys(value).length === 1;
  if (value.method !== "cash" || Object.keys(value).length !== 4 || !validTender(value.tenderedPence, amountPence)
    || typeof value.received !== "boolean" || !validChangeSelection(value.selectedChange)) return false;
  return value.received || value.selectedChange.length === 0;
}

/** Deliberately accepts incorrect selected totals so a learner can correct or resume them. */
export function validatePaymentState(value: unknown, amountPence: number): value is PaymentState {
  if (!isPositiveAmount(amountPence) || !isRecord(value)) return false;
  if (value.method === "card") return Object.keys(value).length === 1;
  if (value.method !== "cash" || Object.keys(value).length !== 6 || !validTender(value.tenderedPence, amountPence)
    || typeof value.received !== "boolean" || !validChangeSelection(value.selectedChange)
    || !validCashPieces(value.tenderedCash)
    || typeof value.tenderedCashRecorded !== "boolean"
    || selectedChangeTotalPence(value.tenderedCash) !== value.tenderedPence) return false;
  const tenderedCash = value.tenderedCash as CashDenominationPence[];
  if (!value.tenderedCashRecorded) {
    const derived = cashPiecesForAmount(value.tenderedPence);
    if (derived.length !== tenderedCash.length
      || derived.some((piece, index) => piece !== tenderedCash[index])) return false;
  }
  return value.received || value.selectedChange.length === 0;
}

export function selectedChangeTotalPence(selectedChange: readonly number[]): number {
  if (!validChangeSelection(selectedChange)) throw new Error("找零面额或数量无效。");
  // Bounded to 100 pieces of at most 1000p, far below Number.MAX_SAFE_INTEGER.
  return selectedChange.reduce((sum, denomination) => sum + denomination, 0);
}

export function cashChangeDuePence(payment: CashPaymentState, amountPence: number): number {
  if (!validTender(payment.tenderedPence, amountPence)) throw new Error("现金交款额无效。");
  return payment.tenderedPence - amountPence;
}

export function cashPaymentCanConfirm(payment: PaymentState | null, amountPence: number): boolean {
  return validatePaymentState(payment, amountPence) && payment.method === "cash" && payment.received
    && selectedChangeTotalPence(payment.selectedChange) === cashChangeDuePence(payment, amountPence);
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  result = Math.imul(result ^ (result >>> 16), 0x85ebca6b);
  result = Math.imul(result ^ (result >>> 13), 0xc2b2ae35);
  return (result ^ (result >>> 16)) >>> 0;
}

/** Canonical, deterministic pieces for customer tender and old-save migration. */
export function cashPiecesForAmount(amountPence: number): CashDenominationPence[] {
  if (!isPositiveAmount(amountPence)) throw new Error("现金金额无效。");
  const pieces: CashDenominationPence[] = [];
  let remaining = amountPence;
  for (const denomination of [...CASH_DENOMINATIONS_PENCE].reverse()) {
    while (remaining >= denomination) {
      pieces.push(denomination);
      remaining -= denomination;
      if (pieces.length > MAX_CHANGE_PIECES) throw new Error("现金面额数量超过单笔上限。");
    }
  }
  if (remaining !== 0) throw new Error("现金金额无法由现有英镑面额组成。");
  return pieces;
}

export interface PaymentVisit {
  customerSeed?: number;
  customerNumber: number;
  amountPence: number;
}

/** Draw only when a visitor enters, then persist the result throughout that visit. */
export function createPaymentForVisit({ customerSeed = LEGACY_CUSTOMER_SEED, customerNumber, amountPence }: PaymentVisit): PaymentState {
  if (!isInteger(customerSeed) || customerSeed < 0 || customerSeed > 0xffffffff) throw new Error("顾客随机种子无效。");
  if (!isInteger(customerNumber) || customerNumber < 1) throw new Error("顾客序号无效。");
  if (!isPositiveAmount(amountPence)) throw new Error("应付金额无效。");
  if (customerNumber === 1 || (customerNumber !== 2 && hash(`${customerSeed}:${customerNumber}:payment`) % 2 === 0)) {
    return { method: "card" };
  }

  let tenderedPence = amountPence;
  if (customerNumber === 2) {
    // The first cash visitor uses the smallest sufficient note; the basket is unchanged.
    const note = TENDER_NOTES_PENCE.find((candidate) => candidate >= amountPence);
    if (note !== undefined) tenderedPence = note;
  } else {
    const candidates = [...new Set([amountPence, ...TENDER_NOTES_PENCE.filter((note) => note >= amountPence)])];
    tenderedPence = candidates[hash(`${customerSeed}:${customerNumber}:cash-tender`) % candidates.length]!;
  }
  return {
    method: "cash", tenderedPence, tenderedCash: cashPiecesForAmount(tenderedPence), tenderedCashRecorded: true,
    received: false, selectedChange: [],
  };
}
