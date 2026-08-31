export type PaymentMethod = "card" | "cash";

export interface CashPaymentState {
  method: "cash";
  /** Money offered by this visitor, kept out of the shop ledger until confirmation. */
  tenderedPence: number;
  received: boolean;
  /** One denomination per selected piece; alternative correct combinations are valid. */
  selectedChange: number[];
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
  if (!Array.isArray(value) || value.length > MAX_CHANGE_PIECES) return false;
  for (const denomination of value) if (!isCashDenomination(denomination)) return false;
  return true;
}

function validTender(tenderedPence: unknown, amountPence: number): tenderedPence is number {
  return isPositiveAmount(amountPence) && isPositiveAmount(tenderedPence) && tenderedPence >= amountPence
    && (tenderedPence === amountPence || TENDER_NOTES_PENCE.some((note) => note === tenderedPence));
}

/** Deliberately accepts incorrect selected totals so a learner can correct or resume them. */
export function validatePaymentState(value: unknown, amountPence: number): value is PaymentState {
  if (!isPositiveAmount(amountPence) || !isRecord(value)) return false;
  if (value.method === "card") return Object.keys(value).length === 1;
  if (value.method !== "cash" || Object.keys(value).length !== 4 || !validTender(value.tenderedPence, amountPence)
    || typeof value.received !== "boolean" || !validChangeSelection(value.selectedChange)) return false;
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
  return { method: "cash", tenderedPence, received: false, selectedChange: [] };
}
