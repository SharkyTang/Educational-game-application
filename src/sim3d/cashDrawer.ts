import {
  CASH_DENOMINATIONS_PENCE,
  MAX_CHANGE_PIECES,
  isCashDenomination,
  type CashDenominationPence,
} from "./cashPayment";

/** One own, enumerable, integer count for every supported GBP denomination. */
export type CashDrawerState = { [Denomination in CashDenominationPence]: number };

export interface CashDrawerTransaction {
  tenderedCash: readonly CashDenominationPence[];
  tenderedPence: number;
  /** Kept broad because resumed v8-v11 selections are validated at this boundary. */
  changeCash: readonly number[];
  changePence: number;
}

const DEFAULT_COUNTS: Readonly<CashDrawerState> = Object.freeze({
  1: 20,
  2: 20,
  5: 20,
  10: 20,
  20: 15,
  50: 10,
  100: 10,
  200: 5,
  500: 0,
  1000: 0,
});

const DENOMINATION_KEYS = CASH_DENOMINATIONS_PENCE.map(String);
const EXPECTED_DRAWER_KEYS = new Set(DENOMINATION_KEYS);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** Strict enough for a save snapshot: no inherited, accessor, symbol, missing or extra fields. */
export function validateCashDrawerState(value: unknown): value is CashDrawerState {
  try {
    if (!isPlainObject(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== DENOMINATION_KEYS.length
      || keys.some((key) => typeof key !== "string" || !EXPECTED_DRAWER_KEYS.has(key))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return DENOMINATION_KEYS.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
        && isNonNegativeInteger(descriptor.value);
    });
  } catch {
    return false;
  }
}

/** Returns a fresh mutable drawer so callers never share the teaching float. */
export function createDefaultCashDrawer(): CashDrawerState {
  return { ...DEFAULT_COUNTS };
}

function assertDrawer(drawer: unknown): asserts drawer is CashDrawerState {
  if (!validateCashDrawerState(drawer)) throw new Error("钱箱库存无效。");
}

function safeAdd(left: number, right: number, message: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(message);
  return result;
}

function cashPiecesAreValid(value: unknown, allowEmpty: boolean): value is readonly CashDenominationPence[] {
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

function cashPiecesTotalPence(pieces: readonly CashDenominationPence[]): number {
  let total = 0;
  for (const piece of pieces) total = safeAdd(total, piece, "现金金额超过安全范围。");
  return total;
}

function copyDrawer(drawer: CashDrawerState): CashDrawerState {
  return Object.fromEntries(CASH_DENOMINATIONS_PENCE.map((denomination) => [denomination, drawer[denomination]])) as CashDrawerState;
}

export function cashDrawerCount(drawer: CashDrawerState, denomination: CashDenominationPence): number {
  assertDrawer(drawer);
  if (!isCashDenomination(denomination)) throw new Error("现金面额无效。");
  return drawer[denomination];
}

export function cashDrawerPieceCount(drawer: CashDrawerState): number {
  assertDrawer(drawer);
  let total = 0;
  for (const denomination of CASH_DENOMINATIONS_PENCE) {
    total = safeAdd(total, drawer[denomination], "钱箱总枚数超过安全范围。");
  }
  return total;
}

export function cashDrawerValuePence(drawer: CashDrawerState): number {
  assertDrawer(drawer);
  let total = 0;
  for (const denomination of CASH_DENOMINATIONS_PENCE) {
    const subtotal = drawer[denomination] * denomination;
    if (!Number.isSafeInteger(subtotal)) throw new Error("钱箱总面值超过安全范围。");
    total = safeAdd(total, subtotal, "钱箱总面值超过安全范围。");
  }
  return total;
}

export function selectedChangeFitsDrawer(drawer: CashDrawerState, selectedChange: readonly number[]): boolean {
  if (!validateCashDrawerState(drawer) || !cashPiecesAreValid(selectedChange, true)) return false;
  const used = new Map<CashDenominationPence, number>();
  for (const denomination of selectedChange) {
    const next = (used.get(denomination) ?? 0) + 1;
    if (next > drawer[denomination]) return false;
    used.set(denomination, next);
  }
  return true;
}

interface ChangeGroup {
  denomination: CashDenominationPence;
  count: number;
  value: number;
}

function availableAfterReservation(
  drawer: CashDrawerState,
  reservedChange: readonly CashDenominationPence[],
): CashDrawerState | null {
  if (!selectedChangeFitsDrawer(drawer, reservedChange)) return null;
  const available = copyDrawer(drawer);
  for (const denomination of reservedChange) available[denomination] -= 1;
  return available;
}

/**
 * Finds a stable, minimum-piece exact combination, preferring larger denominations on ties.
 * `reservedChange` is already sitting on the learner's tray and is excluded from availability
 * and from the 100-piece budget.
 */
export function findExactChange(
  drawer: CashDrawerState,
  targetPence: number,
  reservedChange: readonly number[] = [],
): CashDenominationPence[] | null {
  if (!validateCashDrawerState(drawer) || !isNonNegativeInteger(targetPence)
    || !cashPiecesAreValid(reservedChange, true)) return null;
  const available = availableAfterReservation(drawer, reservedChange);
  if (available === null) return null;
  const pieceBudget = MAX_CHANGE_PIECES - reservedChange.length;
  if (targetPence === 0) return [];
  if (pieceBudget === 0 || targetPence > pieceBudget * CASH_DENOMINATIONS_PENCE.at(-1)!) return null;

  const groups: ChangeGroup[] = [];
  for (const denomination of [...CASH_DENOMINATIONS_PENCE].reverse()) {
    let remaining = Math.min(available[denomination], pieceBudget, Math.floor(targetPence / denomination));
    let groupSize = 1;
    while (remaining > 0) {
      const count = Math.min(groupSize, remaining);
      groups.push({ denomination, count, value: denomination * count });
      remaining -= count;
      groupSize *= 2;
    }
  }

  const unreachable = 0xff;
  let previous = new Uint8Array(targetPence + 1);
  previous.fill(unreachable);
  previous[0] = 0;
  const choices: Uint8Array[] = [];

  for (const group of groups) {
    const next = previous.slice();
    const chosen = new Uint8Array(targetPence + 1);
    for (let amount = group.value; amount <= targetPence; amount += 1) {
      const priorPieces = previous[amount - group.value]!;
      if (priorPieces === unreachable || priorPieces + group.count > pieceBudget) continue;
      const candidatePieces = priorPieces + group.count;
      // Groups are ordered high-to-low, so retaining an equal solution makes ties stable.
      if (candidatePieces < next[amount]!) {
        next[amount] = candidatePieces;
        chosen[amount] = 1;
      }
    }
    choices.push(chosen);
    previous = next;
  }

  if (previous[targetPence] === unreachable) return null;
  const result: CashDenominationPence[] = [];
  let amount = targetPence;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (choices[index]![amount] !== 1) continue;
    const group = groups[index]!;
    for (let piece = 0; piece < group.count; piece += 1) result.push(group.denomination);
    amount -= group.value;
  }
  if (amount !== 0) throw new Error("找零组合还原失败。");
  return result.sort((left, right) => right - left);
}

export function canMakeExactChange(
  drawer: CashDrawerState,
  targetPence: number,
  reservedChange: readonly number[] = [],
): boolean {
  return findExactChange(drawer, targetPence, reservedChange) !== null;
}

function isStrictTransaction(value: unknown): value is CashDrawerTransaction {
  try {
    if (!isPlainObject(value)) return false;
    const expected = ["tenderedCash", "tenderedPence", "changeCash", "changePence"];
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
  } catch {
    return false;
  }
}

/** Applies tender and change together; every failure leaves the caller's drawer untouched. */
export function applyCashDrawerTransaction(
  drawer: CashDrawerState,
  transaction: CashDrawerTransaction,
): CashDrawerState {
  assertDrawer(drawer);
  if (!isStrictTransaction(transaction)
    || !isPositiveInteger(transaction.tenderedPence)
    || !isNonNegativeInteger(transaction.changePence)
    || transaction.changePence > transaction.tenderedPence
    || !cashPiecesAreValid(transaction.tenderedCash, false)
    || !cashPiecesAreValid(transaction.changeCash, true)
    || cashPiecesTotalPence(transaction.tenderedCash) !== transaction.tenderedPence
    || cashPiecesTotalPence(transaction.changeCash) !== transaction.changePence) {
    throw new Error("现金成交明细无效。");
  }
  if (!selectedChangeFitsDrawer(drawer, transaction.changeCash)) throw new Error("钱箱零钱不足。");

  const next = copyDrawer(drawer);
  for (const denomination of transaction.tenderedCash) {
    next[denomination] = safeAdd(next[denomination], 1, "钱箱面额数量超过安全范围。");
  }
  for (const denomination of transaction.changeCash) next[denomination] -= 1;
  return next;
}
