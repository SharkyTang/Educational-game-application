/** First-person shop inventory and economy, separate from the legacy 2D game. */
import { PRODUCTS, PRODUCT_IDS, isProductId, type CrateId, type ProductId } from "./products";
import {
  MAX_CHANGE_PIECES, cashChangeDuePence, cashPaymentCanConfirm, createPaymentForVisit,
  isCashDenomination, selectedChangeTotalPence, validatePaymentState, type PaymentMethod, type PaymentState,
} from "./cashPayment";
import { BUSINESS_DURATION_MS, advanceBusinessElapsedMs, customerArrivalDelayMs, type BusinessPhase } from "./businessTime";
import { crateDimensions as layoutCrateDimensions, type LayoutCollider } from "./productLayout";
import { layoutEquals, validateShopLayout, type ShopLayout } from "./shopLayout";
import {
  SHOP_EXPANSION_COST_PENCE, createInitialRenovation, getShopExpansionOffer,
  shopRenovationReason, validateRenovation, type ShopRenovation,
} from "./shopDevelopment";
import { streetNeighbourForDay, type StreetNeighbourId } from "./streetNeighbourContent";
export { PRODUCTS, PRODUCT_IDS, isProductId, type CrateId, type ProductId, type ProductDefinition } from "./products";
export type { PaymentMethod, PaymentState } from "./cashPayment";
export type { StreetNeighbourId } from "./streetNeighbourContent";
const LEGACY_PRODUCT_IDS = ["milk", "bread"] as const;
const isLegacyProductId = (value: unknown): value is (typeof LEGACY_PRODUCT_IDS)[number] => value === "milk" || value === "bread";

export interface Position { x: number; z: number }
export interface PlayerPose extends Position { yaw: number; pitch: number }

const INDOOR_DROP_POINTS: readonly Position[] = [
  { x: 1.35, z: -2.9 },
  { x: 2.2, z: -2.9 },
  { x: -1.1, z: 2.6 },
  { x: 1.8, z: 1.35 },
];
const LEGACY_DELIVERY_DROP_POINTS: readonly Position[] = [
  { x: 1.35, z: -6 },
  { x: 2.3, z: -6 },
];
export const DELIVERY_DROP_POINTS: readonly Position[] = [
  ...LEGACY_DELIVERY_DROP_POINTS,
  ...[4.7, 5.85, 7, 8.15, 9.3, 10.45, 11.6, 12.75, 13.9, 15.05, 16.2, 17.35]
    .flatMap((x) => [-5.1, -6.2, -7.25].map((z) => ({ x, z })))
    .filter(({ x, z }) => !(Math.abs(x - 10.35) < 1 && z < -5.5) && !(Math.abs(x - 8.25) < 0.7 && z < -7)),
];
export const SAFE_DROP_POINTS: readonly Position[] = [...INDOOR_DROP_POINTS, ...DELIVERY_DROP_POINTS];
const INDOOR_BOUNDS = { minX: -3.4, maxX: 3.4, minZ: -4.6, maxZ: 4.6 } as const;
export const WORLD_BOUNDS = { minX: -20, maxX: 20, minZ: -20, maxZ: 4.6 } as const;

/** The room joins the street without a radius-sized gap at the doorway seam. */
export function isWalkablePosition(position: Position, radius = 0, expansion: 0 | 1 = 0): boolean {
  const { x, z } = position;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0
    || x < WORLD_BOUNDS.minX + radius || x > WORLD_BOUNDS.maxX - radius
    || (expansion !== 0 && expansion !== 1)
    || z < WORLD_BOUNDS.minZ + radius || z > WORLD_BOUNDS.maxZ + expansion * 3 - radius) return false;
  if (z > INDOOR_BOUNDS.minZ && (x < INDOOR_BOUNDS.minX || x > INDOOR_BOUNDS.maxX)) return false;
  // Distance to the two forbidden quadrants beside the shop, including their inside corners.
  const belowSeam = Math.max(0, INDOOR_BOUNDS.minZ - z);
  return Math.hypot(Math.max(0, INDOOR_BOUNDS.maxX - x), belowSeam) >= radius
    && Math.hypot(Math.max(0, x - INDOOR_BOUNDS.minX), belowSeam) >= radius;
}
export const UPGRADE_COST_PENCE = 800;
export const INITIAL_CAPITAL_PENCE = 1200;
export const CRATE_CAPACITY = 8;
export const RECYCLING_REWARD_PENCE = 5;
/** Read-only legacy limit used to validate v3–v8 history, never an active-day target. */
export const DAY_CUSTOMER_TARGET = 3;
export const PURCHASE_PAIR_COST_PENCE = PRODUCTS.milk.costPence + PRODUCTS.bread.costPence;
export const PURCHASE_PAIR_OPTIONS = [1, 3, 6] as const;
export type PurchasePairs = (typeof PURCHASE_PAIR_OPTIONS)[number];

export type ReturnLocation =
  | { kind: "crate"; crateId: CrateId }
  | { kind: "shelf"; productId: ProductId; slot: number };
export type ItemLocation = ReturnLocation
  | { kind: "delivery"; orderId: string }
  | { kind: "hand" }
  | { kind: "basket" }
  | { kind: "checkout" }
  | { kind: "sold"; transactionId: string };
export interface SimItem { id: string; productId: ProductId; location: ItemLocation }
export interface SimCrate { id: CrateId; productId: ProductId; position: Position }
export type HeldState =
  | { kind: "none" }
  | { kind: "crate"; crateId: CrateId }
  | { kind: "item"; itemId: string; returnTo: ReturnLocation };
export type CustomerPhase = "outside" | "to-milk" | "to-bread" | "to-checkout" | "checkout" | "leaving" | "complete";
export interface SimTransactionV7 {
  id: string;
  customerNumber: number;
  itemIds: string[];
  amountPence: number;
}
export interface SimTransaction extends SimTransactionV7 {
  paymentMethod: PaymentMethod;
  tenderedPence: number;
  changePence: number;
}
interface SimWorldState {
  revision: number;
  items: SimItem[];
  crates: SimCrate[];
  held: HeldState;
  /** Exposure only. Inspection is never independent mastery evidence. */
  inspectedProducts: ProductId[];
  customer: { phase: CustomerPhase; number: number };
  scannedIds: string[];
  transactions: SimTransactionV7[];
  cashPence: number;
  upgraded: boolean;
  playerPose: PlayerPose;
}
/** Exact old S0 snapshot shape. Migration must retain these fields, not manufacture capital. */
export interface LegacySimState extends SimWorldState { schemaVersion: 3 }
export interface SimPurchaseV4 {
  id: string;
  dayNumber: number;
  pairs: PurchasePairs;
  itemIds: string[];
  amountPence: number;
}
export interface SimPurchaseV5 extends SimPurchaseV4 {
  /** Null means paid goods are still on the delivery vehicle; never available for sale. */
  receivedDay: number | null;
}
export interface PurchaseLine { productId: ProductId; quantity: number }
export interface SimPurchase {
  id: string;
  dayNumber: number;
  lines: PurchaseLine[];
  /** Kept only for migrated/legacy paired orders, with exact matching lines. */
  pairs?: PurchasePairs;
  itemIds: string[];
  amountPence: number;
  receivedDay: number | null;
}
export interface SimDayV8 {
  number: number;
  phase: "preparing" | "open" | "settled";
  targetCustomers: 3;
  transactionStart: number;
  purchaseStart: number;
  openingCashPence: number;
  openingInventoryValuePence: number;
  openingStockUnits: number;
}
export type BusinessCloseReason = "time" | "manual" | "legacy" | null;
export interface SimDay extends Omit<SimDayV8, "phase" | "targetCustomers"> {
  phase: BusinessPhase;
  targetCustomers: null;
  /** Active real milliseconds since 09:00. Preparation, pauses and closing never advance it. */
  elapsedOpenMs: number;
  /** Absolute active milliseconds of the next arrival, not a wall-clock timestamp. */
  nextCustomerAtMs: number | null;
  /** Legacy settled days have no recorded business duration. */
  closeReason: BusinessCloseReason;
}
export interface SimDaySummaryV6 {
  dayNumber: number;
  paidCustomers: number;
  targetCustomers: 3;
  openingCashPence: number;
  revenuePence: number;
  procurementPence: number;
  costOfGoodsPence: number;
  grossProfitPence: number;
  upgradeSpendPence: number;
  closingCashPence: number;
  remainingStockUnits: number;
  remainingInventoryValuePence: number;
}
export interface SimDaySummaryV7 extends SimDaySummaryV6 {
  recycledCrates: number;
  recyclingIncomePence: number;
}
export interface SimDaySummaryV9 extends Omit<SimDaySummaryV7, "targetCustomers"> {
  /** Null for timed days; retained as 3 only on audited legacy history. */
  targetCustomers: 3 | null;
}
export interface SimDaySummaryV10 extends SimDaySummaryV9 {
  /** Structural expansion is capital spending, separate from sold-goods cost and shelf capacity. */
  expansionSpendPence: number;
}
export interface SimDaySummary extends SimDaySummaryV10 {
  /** Voluntary cash support is a community expense, never merchandise cost or progression. */
  communitySupportCount: number;
  communityCashPence: number;
}
export interface SimSettlementV6 extends SimDaySummaryV6 {
  transactionStart: number;
  transactionEnd: number;
  purchaseStart: number;
  purchaseEnd: number;
  openingInventoryValuePence: number;
  openingStockUnits: number;
}
export interface SimSettlementV7 extends SimSettlementV6, SimDaySummaryV7 {}
export interface SimSettlementV9 extends Omit<SimSettlementV7, "targetCustomers">, SimDaySummaryV9 {}
export interface SimSettlementV10 extends SimSettlementV9, SimDaySummaryV10 {}
export interface SimSettlement extends SimSettlementV10, SimDaySummary {}
export interface SimRecyclingBatch {
  id: string;
  productId: ProductId;
  /** Receipt assigns sources to a physical box before any recycling reward is claimed. */
  purchaseIds: string[];
}
export interface SimRecyclingRecord {
  id: string;
  productId: ProductId;
  dayNumber: number;
  /** Null identifies free opening/return containers, which never earn income. */
  batchId: string | null;
  /** All previously unclaimed paid sources merged into this one physical crate. */
  purchaseIds: string[];
  amountPence: number;
}
export interface SimStreetSupportRecord {
  id: string;
  dayNumber: number;
  neighbourId: StreetNeighbourId;
  amountPence: 100 | 200;
}
interface SimEconomyState extends SimWorldState {
  /** Stable visit seed for appearance, speech and payment; absent in older saves. */
  customerSeed?: number;
  /** Only these two fixed, auditable opening balances are accepted. */
  openingKind: "first-day" | "legacy-s0";
  day: SimDayV8;
  upgradeDay: number | null;
  settlements: SimSettlementV6[];
}
export interface SimStateV4 extends SimEconomyState { schemaVersion: 4; purchases: SimPurchaseV4[] }
export interface SimStateV5 extends SimEconomyState { schemaVersion: 5; purchases: SimPurchaseV5[] }
export interface SimStateV6 extends SimEconomyState {
  schemaVersion: 6;
  purchases: SimPurchase[];
  customer: { phase: CustomerPhase; number: number; shoppingList: ProductId[] };
}
export interface SimStateV7 extends Omit<SimStateV6, "schemaVersion" | "settlements"> {
  schemaVersion: 7;
  recyclingBatches: SimRecyclingBatch[];
  recyclingRecords: SimRecyclingRecord[];
  settlements: SimSettlementV7[];
}
export interface SimStateV8 extends Omit<SimStateV7, "schemaVersion" | "transactions"> {
  schemaVersion: 8;
  /** Null outside an active unpaid visit; cash remains tentative until confirmation. */
  payment: PaymentState | null;
  transactions: SimTransaction[];
}
export interface SimStateV9 extends Omit<SimStateV8, "schemaVersion" | "day" | "settlements"> {
  schemaVersion: 9;
  day: SimDay;
  settlements: SimSettlementV9[];
}
export interface SimStateV10 extends Omit<SimStateV9, "schemaVersion" | "settlements"> {
  schemaVersion: 10;
  renovation: ShopRenovation;
  settlements: SimSettlementV10[];
}
export interface SimState extends Omit<SimStateV10, "schemaVersion" | "customer" | "settlements"> {
  schemaVersion: 11;
  customer: SimStateV10["customer"] & { contentVersion: 1 | 2 };
  streetSupportRecords: SimStreetSupportRecord[];
  settlements: SimSettlement[];
}
type EconomySnapshot = SimState | SimStateV4 | SimStateV5 | SimStateV6 | SimStateV7 | SimStateV8 | SimStateV9 | SimStateV10;
export interface RecyclingOffer { allowed: boolean; rewardPence: number; reason?: string }
export interface RecyclingSummary { recycledToday: number; incomeTodayPence: number }
export interface DeliverySummary {
  pendingOrders: number;
  pendingUnits: number;
  /** Number of orders received on the current business day. */
  receivedToday: number;
  canReceive: boolean;
  reason?: string;
}
export interface PurchaseOffer {
  pairs?: PurchasePairs;
  lines: PurchaseLine[];
  unitCount: number;
  costPence: number;
  allowed: boolean;
  reason?: string;
}

export type SimCommand =
  | { type: "PICK_CRATE"; crateId: CrateId }
  | { type: "DROP_HELD"; position: Position }
  | { type: "RECYCLE_CRATE" }
  | { type: "TAKE_ITEM"; itemId: string }
  | { type: "RETURN_ITEM" }
  | { type: "STOCK"; productId: ProductId; slot: number }
  | { type: "INSPECT"; productId: ProductId }
  | { type: "OPEN_STORE" }
  | { type: "CLOSE_STORE" }
  | { type: "ADVANCE_BUSINESS_TIME"; elapsedMs: number }
  | { type: "CUSTOMER_ADVANCE" }
  | { type: "SCAN"; itemId: string }
  | { type: "PAY"; success: boolean }
  | { type: "RECEIVE_CASH" }
  | { type: "ADD_CHANGE"; denominationPence: number }
  | { type: "REMOVE_CHANGE"; index: number }
  | { type: "CLEAR_CHANGE" }
  | { type: "CONFIRM_CASH" }
  | { type: "NEXT_CUSTOMER" }
  | { type: "CANCEL_CUSTOMER" }
  | { type: "BUY_UPGRADE" }
  | { type: "BUY_SPACE_EXPANSION" }
  | { type: "SUPPORT_STREET_NEIGHBOUR"; neighbourId: StreetNeighbourId; amountPence: 100 | 200 }
  | { type: "APPLY_SHOP_LAYOUT"; layout: ShopLayout }
  | { type: "PURCHASE_STOCK"; orderId: string; pairs: PurchasePairs; lines?: never }
  | { type: "PURCHASE_STOCK"; orderId: string; lines: readonly PurchaseLine[]; pairs?: never }
  | { type: "RECEIVE_DELIVERY" }
  | { type: "SETTLE_DAY" }
  | { type: "START_NEXT_DAY" }
  | { type: "SAVE_POSE"; pose: PlayerPose };
export interface SimResult { state: SimState; changed: boolean; message?: string }

const crateIdFor = (productId: ProductId): CrateId => `${productId}-crate`;
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positionEquals = (a: Position, b: Position): boolean => Math.abs(a.x - b.x) < 0.001 && Math.abs(a.z - b.z) < 0.001;

export function capacityFor(state: Pick<SimState, "upgraded">): number { return state.upgraded ? 8 : 4 }

function createLegacyInitialState(): LegacySimState {
  return {
    schemaVersion: 3,
    revision: 0,
    items: LEGACY_PRODUCT_IDS.flatMap((productId) => Array.from({ length: 4 }, (_, index) => ({
      id: `${productId}-${index + 1}`, productId,
      location: { kind: "crate" as const, crateId: crateIdFor(productId) },
    }))),
    crates: [
      { id: "milk-crate", productId: "milk", position: { x: 1.35, z: -2.9 } },
      { id: "bread-crate", productId: "bread", position: { x: 2.2, z: -2.9 } },
    ],
    held: { kind: "none" },
    inspectedProducts: [],
    customer: { phase: "outside", number: 1 },
    scannedIds: [],
    transactions: [],
    // The eight S0 trial items are provided free. This is not the S1 economy.
    cashPence: 0,
    upgraded: false,
    playerPose: { x: 0, z: -3.5, yaw: 0, pitch: 0 },
  };
}

function firstDay(openingKind: SimState["openingKind"]): SimDay {
  return {
    number: 1, phase: "preparing", targetCustomers: null,
    elapsedOpenMs: 0, nextCustomerAtMs: null, closeReason: null,
    transactionStart: 0, purchaseStart: 0,
    openingCashPence: openingKind === "first-day" ? INITIAL_CAPITAL_PENCE : 0,
    openingInventoryValuePence: openingKind === "first-day" ? 0 : PURCHASE_PAIR_COST_PENCE * 4,
    openingStockUnits: openingKind === "first-day" ? 0 : 8,
  };
}

/** Retained as a deterministic S0 regression fixture; new games use createFirstDayState. */
export function createInitialSimState(): SimState {
  return migrateLegacySimState(createLegacyInitialState());
}

export function createFirstDayState(): SimState {
  const world = createLegacyInitialState();
  return {
    ...world, schemaVersion: 11, renovation: createInitialRenovation(), items: [], cashPence: INITIAL_CAPITAL_PENCE, payment: null, transactions: [],
    customer: { ...world.customer, shoppingList: [], contentVersion: 2 },
    openingKind: "first-day", day: firstDay("first-day"), purchases: [], upgradeDay: null, settlements: [], recyclingBatches: [], recyclingRecords: [],
    streetSupportRecords: [],
  };
}

function activeCustomerPhase(phase: string): boolean {
  return ["to-milk", "to-bread", "to-checkout", "checkout"].includes(phase);
}

function nextArrivalAtMs(state: Pick<SimState, "day" | "customerSeed"> & Pick<SimWorldState, "customer">): number | null {
  return state.day.phase === "open"
    ? Math.min(BUSINESS_DURATION_MS, state.day.elapsedOpenMs + customerArrivalDelayMs(state.customerSeed, state.day.number, state.customer.number + 1))
    : null;
}

/** Old snapshots never recorded elapsed time. Preserve the phase and start open progress at 09:00. */
function migrateBusinessDay(previous: Pick<SimEconomyState, "day" | "customer" | "customerSeed">): SimDay {
  const day: SimDay = {
    ...previous.day, targetCustomers: null, elapsedOpenMs: 0, nextCustomerAtMs: null,
    closeReason: previous.day.phase === "settled" ? "legacy" : null,
  };
  if (previous.customer.phase === "complete") day.nextCustomerAtMs = nextArrivalAtMs({ ...previous, day });
  return day;
}

/** Old versions only implemented card. Never reroll an already-present old visitor. */
function migrateCardPayments(previous: Pick<SimWorldState, "customer" | "transactions">): Pick<SimState, "payment" | "transactions"> {
  return {
    payment: activeCustomerPhase(previous.customer.phase) ? { method: "card" } : null,
    transactions: previous.transactions.map(({ id, customerNumber, itemIds, amountPence }) => ({
      id, customerNumber, itemIds: [...itemIds], amountPence, paymentMethod: "card", tenderedPence: amountPence, changePence: 0,
    })),
  };
}

/** S0 trial goods are an opening grant; all old cash, sales, scan and held state remain intact. */
export function migrateLegacySimState(value: unknown): SimState {
  if (!validateLegacySimState(value)) throw new Error("旧版 3D 存档校验失败，不能迁移这份库存或金额。");
  const legacy = structuredClone(value);
  const day = firstDay("legacy-s0");
  day.phase = legacy.customer.phase === "outside" ? "preparing" : "open";
  const migrated: SimState = {
    ...legacy, ...migrateCardPayments(legacy), schemaVersion: 11, renovation: createInitialRenovation(), openingKind: "legacy-s0", day,
    customer: { ...legacy.customer, shoppingList: legacy.customer.phase === "outside" ? [] : [...LEGACY_PRODUCT_IDS], contentVersion: 1 },
    purchases: [], upgradeDay: legacy.upgraded ? 1 : null, settlements: [], recyclingBatches: [], recyclingRecords: [], streetSupportRecords: [],
  };
  if (migrated.customer.phase === "complete") migrated.day.nextCustomerAtMs = nextArrivalAtMs(migrated);
  if (!validateSimState(migrated)) throw new Error("旧版 3D 存档迁移校验失败，原始存档未改变。");
  return migrated;
}

/** Validate the complete v4 ledger first; goods already received stay exactly where they were. */
export function migrateV4SimState(value: unknown): SimState {
  if (!validateV4SimState(value)) throw new Error("旧版 v4 存档校验失败，不能迁移这份库存或金额。");
  const previous = structuredClone(value);
  const migrated: SimState = {
    ...previous, ...migrateCardPayments(previous), schemaVersion: 11, renovation: createInitialRenovation(), streetSupportRecords: [],
    day: migrateBusinessDay(previous), recyclingBatches: [], recyclingRecords: [],
    settlements: previous.settlements.map((record) => ({ ...record, recycledCrates: 0, recyclingIncomePence: 0, expansionSpendPence: 0,
      communitySupportCount: 0, communityCashPence: 0 })),
    customer: { ...previous.customer, shoppingList: previous.customer.phase === "outside" ? [] : [...LEGACY_PRODUCT_IDS], contentVersion: 1 },
    purchases: previous.purchases.map((purchase) => ({ ...purchase, lines: pairLines(purchase.pairs), receivedDay: purchase.dayNumber })),
  };
  recordReceivedCrateBatches(migrated, migrated.purchases);
  if (!validateSimState(migrated)) throw new Error("旧版 v4 存档迁移校验失败，原始存档未改变。");
  return migrated;
}

/** v5 preserves paid, unreceived deliveries as well as the whole existing world and ledger. */
export function migrateV5SimState(value: unknown): SimState {
  if (!validateV5SimState(value)) throw new Error("旧版 v5 存档校验失败，不能迁移这份库存或金额。");
  const previous = structuredClone(value);
  const migrated: SimState = {
    ...previous, ...migrateCardPayments(previous), schemaVersion: 11, renovation: createInitialRenovation(), streetSupportRecords: [],
    day: migrateBusinessDay(previous), recyclingBatches: [], recyclingRecords: [],
    settlements: previous.settlements.map((record) => ({ ...record, recycledCrates: 0, recyclingIncomePence: 0, expansionSpendPence: 0,
      communitySupportCount: 0, communityCashPence: 0 })),
    customer: { ...previous.customer, shoppingList: previous.customer.phase === "outside" ? [] : [...LEGACY_PRODUCT_IDS], contentVersion: 1 },
    purchases: previous.purchases.map((purchase) => ({ ...purchase, lines: pairLines(purchase.pairs) })),
  };
  recordReceivedCrateBatches(migrated, migrated.purchases.filter((purchase) => purchase.receivedDay !== null));
  if (!validateSimState(migrated)) throw new Error("旧版 v5 存档迁移校验失败，原始存档未改变。");
  return migrated;
}

/** Validate the original reusable-crate ledger before allowing empty crates to be removed. */
export function migrateV6SimState(value: unknown): SimState {
  if (!validateV6SimState(value)) throw new Error("旧版 v6 存档校验失败，不能迁移这份库存或金额。");
  const previous = structuredClone(value);
  const migrated: SimState = {
    ...previous, ...migrateCardPayments(previous), schemaVersion: 11, renovation: createInitialRenovation(), streetSupportRecords: [],
    day: migrateBusinessDay(previous), recyclingBatches: [], recyclingRecords: [],
    settlements: previous.settlements.map((record) => ({ ...record, recycledCrates: 0, recyclingIncomePence: 0, expansionSpendPence: 0,
      communitySupportCount: 0, communityCashPence: 0 })),
    customer: { ...previous.customer, contentVersion: 1 },
  };
  recordReceivedCrateBatches(migrated, migrated.purchases.filter((purchase) => purchase.receivedDay !== null));
  if (!validateSimState(migrated)) throw new Error("旧版 v6 存档迁移校验失败，原始存档未改变。");
  return migrated;
}

/** v7 recycling batches, paid sources and rewards remain untouched by payment migration. */
export function migrateV7SimState(value: unknown): SimState {
  if (!validateV7SimState(value)) throw new Error("旧版 v7 存档校验失败，不能迁移这份库存或金额。");
  const previous = structuredClone(value);
  const migrated: SimState = { ...previous, ...migrateCardPayments(previous), schemaVersion: 11, renovation: createInitialRenovation(),
    customer: { ...previous.customer, contentVersion: 1 }, streetSupportRecords: [], day: migrateBusinessDay(previous),
    settlements: previous.settlements.map((record) => ({ ...record, expansionSpendPence: 0, communitySupportCount: 0, communityCashPence: 0 })) };
  if (!validateSimState(migrated)) throw new Error("旧版 v7 存档迁移校验失败，原始存档未改变。");
  return migrated;
}

/** v8 cash tender, selected change, receipts and recycling are carried over without rerolling. */
export function migrateV8SimState(value: unknown): SimState {
  if (!validateV8SimState(value)) throw new Error("旧版 v8 存档校验失败，不能迁移这份库存、现金或日结。");
  const previous = structuredClone(value);
  const migrated: SimState = { ...previous, schemaVersion: 11, renovation: createInitialRenovation(),
    customer: { ...previous.customer, contentVersion: 1 }, streetSupportRecords: [], day: migrateBusinessDay(previous),
    settlements: previous.settlements.map((record) => ({ ...record, expansionSpendPence: 0, communitySupportCount: 0, communityCashPence: 0 })) };
  if (!validateSimState(migrated)) throw new Error("旧版 v8 存档迁移校验失败，原始存档未改变。");
  return migrated;
}

/** v9 already records time and cash; only the never-purchased renovation starts from zero. */
export function migrateV9SimState(value: unknown): SimState {
  if (!validateV9SimState(value)) throw new Error("旧版 v9 存档校验失败，不能迁移这份营业时间、库存或资金。");
  const previous = structuredClone(value);
  const migrated: SimState = {
    ...previous, schemaVersion: 11, renovation: createInitialRenovation(), customer: { ...previous.customer, contentVersion: 1 }, streetSupportRecords: [],
    settlements: previous.settlements.map((record) => ({ ...record, expansionSpendPence: 0, communitySupportCount: 0, communityCashPence: 0 })),
  };
  if (!validateSimState(migrated)) throw new Error("旧版 v9 存档迁移校验失败，原始存档未改变。");
  return migrated;
}

/** v10 already has the complete renovation ledger; community records begin empty without replaying cash. */
export function migrateV10SimState(value: unknown): SimState {
  if (!validateV10SimState(value)) throw new Error("旧版 v10 存档校验失败，不能迁移这份装修、库存或资金。");
  const previous = structuredClone(value);
  const migrated: SimState = {
    ...previous, schemaVersion: 11, customer: { ...previous.customer, contentVersion: 1 }, streetSupportRecords: [],
    settlements: previous.settlements.map((record) => ({ ...record, communitySupportCount: 0, communityCashPence: 0 })),
  };
  if (!validateSimState(migrated)) throw new Error("旧版 v10 存档迁移校验失败，原始存档未改变。");
  return migrated;
}

export function countAt(state: EconomySnapshot, productId: ProductId, kind: ItemLocation["kind"]): number {
  return state.items.filter((item) => item.productId === productId && item.location.kind === kind).length;
}

export function getCheckoutTotal(state: SimState): number {
  return state.items.filter((item) => item.location.kind === "checkout")
    .reduce((total, item) => total + PRODUCTS[item.productId].pricePence, 0);
}

function unsoldItems(state: EconomySnapshot, productId?: ProductId): SimItem[] {
  return state.items.filter((item) => item.location.kind !== "sold" && (!productId || item.productId === productId));
}

function inventoryValue(items: SimItem[]): number {
  return items.reduce((sum, item) => sum + PRODUCTS[item.productId].costPence, 0);
}

const validOrderId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);
const validPairs = (pairs: unknown): pairs is PurchasePairs => PURCHASE_PAIR_OPTIONS.some((option) => option === pairs);

function pairLines(pairs: PurchasePairs): PurchaseLine[] {
  return LEGACY_PRODUCT_IDS.map((productId) => ({ productId, quantity: pairs }));
}

function purchaseItemIds(orderId: string, lines: readonly PurchaseLine[]): string[] {
  return lines.flatMap(({ productId, quantity }) => Array.from({ length: quantity }, (_, index) => `${productId}-purchase-${orderId}-${index + 1}`));
}

function sameLines(a: readonly PurchaseLine[], b: readonly PurchaseLine[]): boolean {
  return a.length === b.length && a.every((line, index) => line.productId === b[index]?.productId && line.quantity === b[index]?.quantity);
}

function normalizeSelection(input: unknown): { lines: PurchaseLine[]; pairs?: PurchasePairs; reason?: string } {
  if (typeof input === "number") return validPairs(input) ? { lines: pairLines(input), pairs: input }
    : { lines: [], reason: "旧版组合货数量只支持 1、3 或 6 份；也可以在清单中自选商品。" };
  if (!Array.isArray(input) || input.length === 0) return { lines: [], reason: "请先选择商品，并填写要订购的数量。" };
  if (input.length > PRODUCT_IDS.length) return { lines: [], reason: "进货清单商品种类过多。" };
  const selected = new Map<ProductId, number>();
  for (const line of input) {
    if (!isRecord(line) || !isProductId(line.productId)) return { lines: [], reason: "进货清单含有不支持的商品。" };
    if (!isInteger(line.quantity) || line.quantity < 1 || line.quantity > CRATE_CAPACITY) return { lines: [], reason: `每种商品的订购数量须为 1 到 ${CRATE_CAPACITY} 的整数。` };
    if (selected.has(line.productId)) return { lines: [], reason: "同一种商品只能填写一行，请直接修改这一行的数量。" };
    selected.set(line.productId, line.quantity);
  }
  return { lines: PRODUCT_IDS.filter((id) => selected.has(id)).map((productId) => ({ productId, quantity: selected.get(productId)! })) };
}

/** The caller chooses every SKU and quantity; paired quantities remain an explicit legacy API. */
export function getPurchaseOffer(state: SimState, selection: readonly PurchaseLine[] | PurchasePairs): PurchaseOffer {
  const normalized = normalizeSelection(selection);
  const { lines, pairs } = normalized;
  const costPence = lines.reduce((sum, line) => sum + PRODUCTS[line.productId].costPence * line.quantity, 0);
  const unitCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const base = { lines, unitCount, costPence, ...(pairs === undefined ? {} : { pairs }) };
  const denied = (reason: string): PurchaseOffer => ({ ...base, allowed: false, reason });
  if (normalized.reason) return denied(normalized.reason);
  if (state.day.phase === "settled") return denied("今天已经日结，请先开始次日再进货。");
  if (state.day.phase === "closing") return denied("今天已打烊，不再接收新采购；已订货物仍可签收，明天再进货。");
  if (state.cashPence < costPence) return denied(`资金不足，本次需要 £${(costPence / 100).toFixed(2)}；请减少数量或先卖出库存。`);
  for (const { productId, quantity } of lines) {
    const held = state.held;
    // A hand-held item reserves its exact crate return space until placed elsewhere.
    const reserved = held.kind === "item" && held.returnTo.kind === "crate" && held.returnTo.crateId === crateIdFor(productId) ? 1 : 0;
    if (countAt(state, productId, "crate") + countAt(state, productId, "delivery") + reserved + quantity > CRATE_CAPACITY) {
      return denied(`${PRODUCTS[productId].nameZh}箱最多容纳 ${CRATE_CAPACITY} 件，请先上架或卖出部分商品。`);
    }
    // Keep room to cancel an unpaid basket safely even after shelf replenishment.
    if (unsoldItems(state, productId).length + quantity > CRATE_CAPACITY + capacityFor(state)) {
      return denied(`${PRODUCTS[productId].nameZh}暂存空间不足，请先完成当前交易或卖出部分商品。`);
    }
  }
  return { ...base, allowed: true };
}

function crateDimensions(productId: ProductId): { halfWidth: number; halfDepth: number } {
  return productId === "milk" ? { halfWidth: 0.23, halfDepth: 0.20 }
    : productId === "bread" ? { halfWidth: 0.35, halfDepth: 0.20 } : { halfWidth: 0.40, halfDepth: 0.23 };
}

function playerOccupiesDrop(state: SimState, productId: ProductId, point: Position): boolean {
  const { halfWidth, halfDepth } = crateDimensions(productId);
  return Math.abs(state.playerPose.x - point.x) < halfWidth + 0.24
    && Math.abs(state.playerPose.z - point.z) < halfDepth + 0.24;
}

function deliveryPlacements(state: SimState): { productId: ProductId; position: Position }[] | undefined {
  const pendingProducts = PRODUCT_IDS.filter((productId) => countAt(state, productId, "delivery") > 0);
  // Empty reusable crates retain a distinct return location for later returns/cancellations.
  const occupied = state.crates.filter((crate) => !pendingProducts.includes(crate.productId)).map((crate) => crate.position);
  const nearestPoints = [...DELIVERY_DROP_POINTS].sort((a, b) => Math.hypot(a.x, a.z + 4.6) - Math.hypot(b.x, b.z + 4.6));
  const placements: { productId: ProductId; position: Position }[] = [];
  for (const productId of pendingProducts) {
    const existing = state.crates.find((crate) => crate.productId === productId)?.position;
    const reusable = existing && DELIVERY_DROP_POINTS.some((point) => positionEquals(point, existing)) ? [existing] : [];
    const point = [...reusable, ...nearestPoints].find((candidate) => !occupied.some((position) => positionEquals(position, candidate)));
    if (!point) return undefined;
    occupied.push(point);
    placements.push({ productId, position: { ...point } });
  }
  return placements;
}

export function getDeliverySummary(state: SimState): DeliverySummary {
  const pending = state.purchases.filter((purchase) => purchase.receivedDay === null);
  const summary = {
    pendingOrders: pending.length,
    pendingUnits: pending.reduce((total, purchase) => total + purchase.itemIds.length, 0),
    receivedToday: state.purchases.filter((purchase) => purchase.receivedDay === state.day.number).length,
  };
  if (!pending.length) return { ...summary, canReceive: false, reason: "还没有待收货订单，可以先打开经营面板订货。" };
  if (state.held.kind !== "none") return { ...summary, canReceive: false, reason: "请先放下手里的货箱或商品，再到送货车旁签收。" };
  const placements = deliveryPlacements(state);
  if (!placements) return { ...summary, canReceive: false, reason: "卸货区暂时放不下本次货箱，请先上架或搬开已有货箱。" };
  for (const { productId, position } of placements) {
    if (playerOccupiesDrop(state, productId, position)) {
      return { ...summary, canReceive: false, reason: "请先离开门外的卸货点，给送货员留出放箱空间。" };
    }
  }
  return { ...summary, canReceive: true };
}

function activeRecyclingBatch(state: SimState, productId: ProductId): SimRecyclingBatch | undefined {
  const recycled = new Set(state.recyclingRecords.map((record) => record.batchId));
  return state.recyclingBatches.find((batch) => batch.productId === productId && !recycled.has(batch.id));
}

/** Multiple receipts into a still-existing box keep the same independently audited batch. */
function recordReceivedCrateBatches(state: SimState, purchases: readonly SimPurchase[]): void {
  for (const productId of PRODUCT_IDS) {
    const purchaseIds = purchases.filter((purchase) => purchase.lines.some((line) => line.productId === productId)).map((purchase) => purchase.id);
    if (!purchaseIds.length) continue;
    const batch = activeRecyclingBatch(state, productId);
    if (batch) batch.purchaseIds.push(...purchaseIds);
    else state.recyclingBatches.push({ id: `crate-batch-${state.recyclingBatches.length + 1}`, productId, purchaseIds });
  }
}

/** Paid deliveries earn one small reward per emptied physical box, even when orders were merged. */
export function getRecyclingOffer(state: SimState): RecyclingOffer {
  const held = state.held;
  if (held.kind !== "crate") return { allowed: false, rewardPence: 0, reason: "先抱起需要回收的空货箱。" };
  const crate = state.crates.find((candidate) => candidate.id === held.crateId);
  if (!crate) return { allowed: false, rewardPence: 0, reason: "找不到手里的货箱。" };
  if (state.items.some((item) => item.location.kind === "crate" && item.location.crateId === crate.id)) {
    return { allowed: false, rewardPence: 0, reason: "箱内还有商品，请先全部上架；回收不会丢弃商品。" };
  }
  return { allowed: true, rewardPence: activeRecyclingBatch(state, crate.productId) ? RECYCLING_REWARD_PENCE : 0 };
}

export function getRecyclingSummary(state: SimState): RecyclingSummary {
  const today = state.recyclingRecords.filter((record) => record.dayNumber === state.day.number);
  return { recycledToday: today.length, incomeTodayPence: today.reduce((sum, record) => sum + record.amountPence, 0) };
}

/** Visible ground cartons reserve furniture space, even when empty; untouched placeholders are omitted. */
export function getShopLayoutObstacles(state: SimState): LayoutCollider[] {
  const visibleProducts = new Set(state.items.filter((item) => item.location.kind !== "delivery").map((item) => item.productId));
  return state.crates.filter((crate) => visibleProducts.has(crate.productId)
    && !(state.held.kind === "crate" && state.held.crateId === crate.id)).map((crate) => {
    const { width, depth } = layoutCrateDimensions(crate.productId);
    return { minX: crate.position.x - width / 2, maxX: crate.position.x + width / 2,
      minZ: crate.position.z - depth / 2, maxZ: crate.position.z + depth / 2 };
  });
}

export function getCustomerOrder(state: SimState): readonly ProductId[] { return state.customer.shoppingList }

export function getShoppingProduct(state: SimState): ProductId | null {
  return state.customer.phase === "to-milk" ? state.customer.shoppingList[0] ?? null
    : state.customer.phase === "to-bread" ? state.customer.shoppingList[1] ?? null : null;
}

export function canStartCustomer(state: SimState): boolean {
  return ((state.day.phase === "preparing" && state.customer.phase === "outside")
      || (state.day.phase === "open" && state.day.elapsedOpenMs < BUSINESS_DURATION_MS && state.customer.phase === "complete"))
    && state.items.some((item) => item.location.kind === "shelf");
}

function chooseCustomerOrder(state: SimState): ProductId[] {
  const available = PRODUCT_IDS.filter((productId) => countAt(state, productId, "shelf") > 0);
  if (available.length <= 2) return available;
  const start = ((Math.imul(state.customer.number, 1103515245) ^ (state.customerSeed ?? 0)) >>> 0) % available.length;
  return [available[start]!, available[(start + 1) % available.length]!];
}

function summaryForRange(
  state: EconomySnapshot, day: Pick<SimDaySummary, "targetCustomers"> & Omit<SimDayV8, "phase" | "targetCustomers">,
  transactionEnd: number, purchaseEnd: number,
): SimDaySummary {
  const transactions = state.transactions.slice(day.transactionStart, transactionEnd);
  const purchases = state.purchases.slice(day.purchaseStart, purchaseEnd);
  const itemById = new Map(state.items.map((item) => [item.id, item]));
  const costOfGoodsPence = transactions.reduce((total, transaction) => total + transaction.itemIds.reduce((cost, id) => {
    const item = itemById.get(id);
    return cost + (item ? PRODUCTS[item.productId].costPence : Number.NaN);
  }, 0), 0);
  const revenuePence = transactions.reduce((total, transaction) => total + transaction.amountPence, 0);
  const procurementPence = purchases.reduce((total, purchase) => total + purchase.amountPence, 0);
  const upgradeSpendPence = state.upgradeDay === day.number ? UPGRADE_COST_PENCE : 0;
  const expansionSpendPence = (state.schemaVersion === 10 || state.schemaVersion === 11)
    && state.renovation.expansionDay === day.number ? SHOP_EXPANSION_COST_PENCE : 0;
  const recycling = state.schemaVersion === 7 || state.schemaVersion === 8 || state.schemaVersion === 9
    || state.schemaVersion === 10 || state.schemaVersion === 11
    ? state.recyclingRecords.filter((record) => record.dayNumber === day.number) : [];
  const recyclingIncomePence = recycling.reduce((sum, record) => sum + record.amountPence, 0);
  const community = state.schemaVersion === 11
    ? state.streetSupportRecords.filter((record) => record.dayNumber === day.number) : [];
  const communityCashPence = community.reduce((sum, record) => sum + record.amountPence, 0);
  return {
    dayNumber: day.number, paidCustomers: transactions.length, targetCustomers: day.targetCustomers,
    openingCashPence: day.openingCashPence, revenuePence, procurementPence, costOfGoodsPence,
    grossProfitPence: revenuePence - costOfGoodsPence, upgradeSpendPence, expansionSpendPence,
    recycledCrates: recycling.length, recyclingIncomePence,
    communitySupportCount: community.length, communityCashPence,
    closingCashPence: day.openingCashPence + revenuePence + recyclingIncomePence - procurementPence - upgradeSpendPence
      - expansionSpendPence - communityCashPence,
    remainingStockUnits: day.openingStockUnits + purchases.reduce((sum, purchase) => sum + purchase.itemIds.length, 0)
      - transactions.reduce((sum, sale) => sum + sale.itemIds.length, 0),
    remainingInventoryValuePence: day.openingInventoryValuePence + procurementPence - costOfGoodsPence,
  };
}

/** Purchase expense is cash flow; gross profit subtracts sold-goods cost, not all unsold stock. */
export function getDaySummary(state: EconomySnapshot): SimDaySummary {
  return summaryForRange(state, state.day, state.transactions.length, state.purchases.length);
}

export function canSettleDay(state: SimState): boolean {
  return state.day.phase === "closing" && ["outside", "complete"].includes(state.customer.phase)
    && state.payment === null && state.scannedIds.length === 0
    && !state.purchases.some((purchase) => purchase.receivedDay === null)
    && !state.items.some((item) => item.location.kind === "basket" || item.location.kind === "checkout" || item.location.kind === "delivery");
}

function settlementFor(state: SimState): SimSettlement {
  return {
    ...getDaySummary(state),
    // Cleanup/expansion after migrating an already-settled day must retain its audited old target.
    targetCustomers: state.day.closeReason === "legacy" ? DAY_CUSTOMER_TARGET : null,
    transactionStart: state.day.transactionStart, transactionEnd: state.transactions.length,
    purchaseStart: state.day.purchaseStart, purchaseEnd: state.purchases.length,
    openingInventoryValuePence: state.day.openingInventoryValuePence, openingStockUnits: state.day.openingStockUnits,
  };
}

export function getObjective(state: SimState): string {
  const recycling = getRecyclingOffer(state);
  if (recycling.allowed) return recycling.rewardPence
    ? "货箱已经空了，抱到店外的空箱回收点按 E，腾出双手并获得 £0.05。"
    : "货箱已经空了，抱到店外的空箱回收点按 E 清走；这个箱子没有新的回收奖励。";
  if (state.day.phase === "settled") return `第 ${state.day.number} 天已日结。可以查看收支、用资金扩充货架，或开始次日继续营业。`;
  if (canSettleDay(state)) return `今天已打烊，共完成 ${getDaySummary(state).paidCustomers} 单收款。打开经营面板日结，查看毛利与库存；没有成交也可以结束这一天。`;
  const delivery = getDeliverySummary(state);
  if (delivery.pendingOrders && ["outside", "complete"].includes(state.customer.phase)) {
    return state.held.kind !== "none" ? "订购的商品已到门口。先放下手里的物品，再到送货车旁按 E 签收。"
      : `送货车在店门口等你：${delivery.pendingUnits} 件商品待签收。走到车旁按 E，货箱会放在门外卸货点。`;
  }
  if (state.customer.phase === "outside") {
    const held = state.held;
    const crate = held.kind === "crate" ? state.crates.find((entry) => entry.id === held.crateId) : undefined;
    const item = held.kind === "item" ? state.items.find((entry) => entry.id === held.itemId) : undefined;
    const heldProduct = crate?.productId ?? item?.productId;
    if (heldProduct) {
      const product = PRODUCTS[heldProduct];
      if (!state.inspectedProducts.includes(heldProduct)) return `先按 F 近看手里的${product.nameZh}，把 ${product.nameEn} 和实物对应起来。`;
      if (countAt(state, heldProduct, "shelf") >= capacityFor(state)) return `${product.nameZh}货架已满，先按 G 放下手里的货物。`;
      const remaining = crate ? state.items.filter((entry) => entry.location.kind === "crate" && entry.location.crateId === crate.id).length : 1;
      const shelfName = heldProduct === "milk" ? "牛奶冰柜" : heldProduct === "bread" ? "面包架" : `${product.nameZh}货位`;
      return `把手里的${product.nameZh}摆上${shelfName}，看向货架按 E，逐件上架${crate ? `（箱内剩 ${remaining} 件）` : ""}。`;
    }
    const missing = PRODUCT_IDS.find((id) => countAt(state, id, "shelf") < 1 && countAt(state, id, "crate") > 0);
    if (!missing && !state.items.some((entry) => entry.location.kind === "shelf")) return "先打开经营面板进货：从清单自主选择商品和数量，签收后上架至少一件即可营业。";
    if (missing) return state.inspectedProducts.includes(missing)
      ? `搬起${PRODUCTS[missing].nameZh}货箱，把商品摆上${missing === "milk" ? "牛奶冰柜" : missing === "bread" ? "面包架" : "对应货位"}。`
      : `搬起门边的${PRODUCTS[missing].nameZh}货箱，按 F 近看商品，再摆上货架。`;
    // Observation is a suggestion, not an additional condition for opening the store.
    return "商品已经就位，到门口翻转营业牌。";
  }
  const shoppingProduct = getShoppingProduct(state);
  if (shoppingProduct) return countAt(state, shoppingProduct, "shelf") ? `顾客正在挑选${PRODUCTS[shoppingProduct].nameZh}。`
    : `${PRODUCTS[shoppingProduct].nameZh}货位暂时空了，请按这位顾客原有清单补货；购物清单不会随补货改变。`;
  if (state.customer.phase === "to-checkout") return "顾客正在前往收银台，你也可以准备收银。";
  if (state.customer.phase === "checkout") {
    if (state.scannedIds.length < state.customer.shoppingList.length) return `扫描台面上的 ${state.customer.shoppingList.length} 件商品。`;
    if (state.payment?.method === "cash") return state.payment.received
      ? "现金已暂收，请在收银抽屉配好找零后确认；完成前资金和商品均不入账。"
      : "商品已扫描，这位顾客用现金付款；打开收银抽屉接收现金。";
    return "商品已扫描，启用刷卡机完成收款。";
  }
  if (state.customer.phase === "leaving") return state.day.phase === "closing"
    ? "最后一位顾客正在离店。让顾客走完，再打开营业账本完成日结。"
    : "顾客正在离店，可以整理货架或补货。";
  if (!unsoldItems(state).length) return "库存已经售完，打开经营面板自主选择商品和数量订购，签收后继续补货。";
  if (!state.upgraded && state.cashPence >= UPGRADE_COST_PENCE) return "资金已足够，按 U 可查看 £8 普通容量升级，也可以留钱进货。";
  return "整理已购商品并给货架补货，准备接待下一位顾客。";
}

function freeSlot(state: SimState, productId: ProductId): number | undefined {
  for (let slot = 0; slot < capacityFor(state); slot += 1) {
    if (!state.items.some((item) => item.location.kind === "shelf" && item.location.productId === productId && item.location.slot === slot)) return slot;
  }
  return undefined;
}

function returnUnpaidItem(state: SimState, item: SimItem): boolean {
  const slot = freeSlot(state, item.productId);
  if (slot === undefined && !state.crates.some((crate) => crate.productId === item.productId)) {
    const position = SAFE_DROP_POINTS.find((point) => !state.crates.some((crate) => positionEquals(crate.position, point))
      && !playerOccupiesDrop(state, item.productId, point));
    if (!position) return false;
    // A return container has no new paid source; recycling it cannot mint another reward.
    state.crates.push({ id: crateIdFor(item.productId), productId: item.productId, position: { ...position } });
  }
  item.location = slot === undefined
    ? { kind: "crate", crateId: crateIdFor(item.productId) }
    : { kind: "shelf", productId: item.productId, slot };
  return true;
}

/** Pure, deterministic commands; rejected input keeps the original state object. */
export function reduceSim(state: SimState, command: SimCommand): SimResult {
  const reject = (message: string): SimResult => ({ state, changed: false, message });
  // High-frequency active-play ticks only change the clock. The trusted snapshot's
  // inventory remains shared; full ledger validation still runs on every game action/save.
  if (command.type === "ADVANCE_BUSINESS_TIME") {
    if (state.day.phase !== "open") return reject("准备、打烊和日结期间不推进营业时间。");
    if (!isFiniteNumber(command.elapsedMs) || command.elapsedMs <= 0) return reject("营业时间增量须为有限正毫秒数。");
    if (!validBusinessClock(state.day) || !isInteger(state.revision) || state.revision >= Number.MAX_SAFE_INTEGER) {
      return reject("营业时钟状态无效，进度未改变。");
    }
    const elapsedOpenMs = advanceBusinessElapsedMs(state.day.elapsedOpenMs, command.elapsedMs);
    if (elapsedOpenMs === state.day.elapsedOpenMs) return reject("营业时间没有变化。");
    const closing = elapsedOpenMs >= BUSINESS_DURATION_MS;
    const day: SimDay = { ...state.day, elapsedOpenMs,
      ...(closing ? { phase: "closing", closeReason: "time", nextCustomerAtMs: null } as const : {}) };
    return { state: { ...state, revision: state.revision + 1, day }, changed: true,
      ...(closing ? { message: "19:00 已打烊，不再接待新顾客。请完成当前收银、签收已订货物后日结。" } : {}) };
  }
  const next: SimState = structuredClone(state);
  const finish = (message?: string): SimResult => {
    next.revision += 1;
    if (!validateSimState(next)) throw new Error(`3D inventory/economy invariant failed after ${command.type}`);
    return { state: next, changed: true, ...(message ? { message } : {}) };
  };
  const checkoutItems = (): SimItem[] => next.items.filter((item) => item.location.kind === "checkout");
  const allScanned = (): boolean => {
    const items = checkoutItems();
    return items.length > 0 && items.every((item) => next.scannedIds.includes(item.id));
  };
  const commitPayment = (paymentMethod: PaymentMethod, tenderedPence: number, changePence: number): SimResult => {
    const transactionId = `sale-${next.customer.number}`;
    if (next.transactions.some((transaction) => transaction.id === transactionId)) return reject("这笔交易已经收款。");
    const items = checkoutItems();
    const amountPence = getCheckoutTotal(next);
    next.transactions.push({ id: transactionId, customerNumber: next.customer.number, itemIds: items.map((item) => item.id),
      amountPence, paymentMethod, tenderedPence, changePence });
    // This is the unified business balance, not a physical drawer balance.
    next.cashPence += amountPence;
    for (const item of items) item.location = { kind: "sold", transactionId };
    next.scannedIds = [];
    next.payment = null;
    next.customer.phase = "leaving";
    return finish(`收款成功 +£${(amountPence / 100).toFixed(2)}`);
  };

  switch (command.type) {
    case "PICK_CRATE": {
      if (next.held.kind !== "none") return reject("双手正忙，请先放下手里的物品。");
      if (!next.crates.some((crate) => crate.id === command.crateId)) return reject("找不到这个货箱。");
      next.held = { kind: "crate", crateId: command.crateId };
      return finish("抱起货箱；箱内商品仍然属于这个箱子。");
    }
    case "DROP_HELD": {
      if (next.held.kind !== "crate") return reject("货箱才能放在卸货点；单件商品请放回箱子或货架。");
      const position = SAFE_DROP_POINTS.find((point) => positionEquals(point, command.position));
      if (!position) return reject("请把货箱放在标出的安全卸货点。");
      if (next.crates.some((crate) => crate.id !== (next.held.kind === "crate" ? next.held.crateId : "") && positionEquals(crate.position, position))) return reject("这个卸货点已有货箱，请选择另一个位置。");
      const crate = next.crates.find((candidate) => next.held.kind === "crate" && candidate.id === next.held.crateId);
      if (!crate) return reject("找不到这个货箱。");
      if (playerOccupiesDrop(next, crate.productId, position)) return reject("请先离卸货点远一点，不能把货箱放在自己脚下。");
      crate.position = { ...position };
      next.held = { kind: "none" };
      return finish("货箱已放稳。");
    }
    case "RECYCLE_CRATE": {
      const offer = getRecyclingOffer(next);
      if (!offer.allowed) return reject(offer.reason ?? "现在没有可回收的空箱。");
      const held = next.held;
      const crate = next.crates.find((candidate) => held.kind === "crate" && candidate.id === held.crateId)!;
      const batch = activeRecyclingBatch(next, crate.productId);
      next.recyclingRecords.push({
        id: `recycle-${next.recyclingRecords.length + 1}`, productId: crate.productId, dayNumber: next.day.number,
        batchId: batch?.id ?? null, purchaseIds: batch ? [...batch.purchaseIds] : [], amountPence: offer.rewardPence,
      });
      next.crates = next.crates.filter((candidate) => candidate.id !== crate.id);
      next.held = { kind: "none" };
      next.cashPence += offer.rewardPence;
      // As with a closing-time upgrade, later cleanup still belongs to the settled business day.
      if (next.day.phase === "settled") next.settlements[next.settlements.length - 1] = settlementFor(next);
      return finish(offer.rewardPence ? `空箱已回收 +£${(offer.rewardPence / 100).toFixed(2)}，卸货位置已腾出。`
        : "空箱已回收，卸货位置已腾出；没有新的进货来源，不重复发放奖励。");
    }
    case "TAKE_ITEM": {
      if (next.held.kind !== "none") return reject("请先放下手里的物品。");
      const item = next.items.find((candidate) => candidate.id === command.itemId);
      if (!item || (item.location.kind !== "crate" && item.location.kind !== "shelf")) return reject("只能拿取箱内或货架上的商品。");
      next.held = { kind: "item", itemId: item.id, returnTo: { ...item.location } };
      item.location = { kind: "hand" };
      return finish(`拿起${PRODUCTS[item.productId].nameZh}。`);
    }
    case "RETURN_ITEM": {
      if (next.held.kind !== "item") return reject("手里没有单件商品。");
      const held = next.held;
      const item = next.items.find((candidate) => candidate.id === held.itemId);
      if (!item) return reject("找不到手里的商品。");
      const origin = held.returnTo;
      if (origin.kind === "crate") item.location = { ...origin };
      else if (!next.items.some((other) => other.location.kind === "shelf" && other.location.productId === origin.productId && other.location.slot === origin.slot)) item.location = { ...origin };
      else if (!returnUnpaidItem(next, item)) return reject("暂时没有安全空位归还商品，请先搬开或回收空箱。");
      next.held = { kind: "none" };
      return finish("商品已放回。");
    }
    case "STOCK": {
      if (!isProductId(command.productId)) return reject("没有对应的货架。");
      if (!Number.isInteger(command.slot) || command.slot < 0 || command.slot >= capacityFor(next)) return reject("这个位置不可用，或需要先升级容量。");
      if (next.items.some((item) => item.location.kind === "shelf" && item.location.productId === command.productId && item.location.slot === command.slot)) return reject("这个货位已有商品，请选择空位。");
      const held = next.held;
      const item = held.kind === "crate"
        ? next.items.find((candidate) => candidate.location.kind === "crate" && candidate.location.crateId === held.crateId)
        : held.kind === "item" ? next.items.find((candidate) => candidate.id === held.itemId) : undefined;
      if (!item) return reject(held.kind === "crate" ? "货箱已经空了。" : "先抱起货箱或拿起一件商品。");
      if (item.productId !== command.productId) return reject(`${PRODUCTS[item.productId].nameZh}应放在标有同种商品的货架上。`);
      item.location = { kind: "shelf", productId: command.productId, slot: command.slot };
      if (held.kind === "item") next.held = { kind: "none" };
      return finish(`${PRODUCTS[item.productId].nameEn} · 上架成功。`);
    }
    case "INSPECT": {
      if (!isProductId(command.productId) || !next.items.some((item) => item.productId === command.productId && ["crate", "shelf", "hand"].includes(item.location.kind))) return reject("需要找到一件可观察的实物。");
      if (next.inspectedProducts.includes(command.productId)) return reject("再次观察和听读不会被计为独立掌握。");
      next.inspectedProducts.push(command.productId);
      return finish(`${PRODUCTS[command.productId].nameEn} · ${PRODUCTS[command.productId].nameZh}`);
    }
    case "OPEN_STORE":
    case "NEXT_CUSTOMER": {
      if (next.day.phase === "settled") return reject("今天已经日结，请先开始次日。");
      if (next.day.phase === "closing" || next.day.elapsedOpenMs >= BUSINESS_DURATION_MS) return reject("今天已打烊，不再接待新顾客。");
      if (command.type === "OPEN_STORE" && next.day.phase !== "preparing") return reject("今天已经开始营业。");
      if (command.type === "NEXT_CUSTOMER" && next.day.phase !== "open") return reject("请先上架商品并打开营业牌。");
      const expected = command.type === "OPEN_STORE" ? "outside" : "complete";
      if (next.customer.phase !== expected) return reject("请先完成当前顾客的流程。");
      if (!next.items.some((item) => item.location.kind === "shelf")) return reject("先选择商品进货，并给货架补上至少一件商品。");
      if (command.type === "NEXT_CUSTOMER") {
        if (next.customer.number >= Number.MAX_SAFE_INTEGER) return reject("顾客序号已达到安全上限，不能再开始新交易。");
        next.customer.number += 1;
      }
      next.customer.contentVersion = 2;
      next.customer.shoppingList = chooseCustomerOrder(next);
      next.payment = createPaymentForVisit({ customerSeed: next.customerSeed, customerNumber: next.customer.number,
        amountPence: next.customer.shoppingList.reduce((sum, productId) => sum + PRODUCTS[productId].pricePence, 0) });
      next.day.phase = "open";
      next.day.nextCustomerAtMs = null;
      next.customer.phase = "to-milk";
      return finish("一位邻居正沿街走来，准备到小店购物。");
    }
    case "CLOSE_STORE": {
      if (next.day.phase === "settled") return reject("今天已经日结，不会重复打烊。");
      if (next.day.phase === "closing") return reject("今天已经打烊，请完成收尾后日结。");
      next.day.phase = "closing";
      next.day.closeReason = "manual";
      next.day.nextCustomerAtMs = null;
      return finish("已提前打烊，不再接待新顾客或采购；请完成当前顾客、签收已订货物后日结。");
    }
    case "CUSTOMER_ADVANCE": {
      if (next.customer.phase === "to-milk" || next.customer.phase === "to-bread") {
        const productId = getShoppingProduct(next);
        if (!productId) return reject("当前顾客没有对应的购物项目。");
        const item = next.items.find((candidate) => candidate.productId === productId && candidate.location.kind === "shelf");
        if (!item) return reject(`顾客还没拿到${PRODUCTS[productId].nameZh}，请先补货。`);
        item.location = { kind: "basket" };
        next.customer.phase = next.customer.phase === "to-milk" && next.customer.shoppingList.length > 1 ? "to-bread" : "to-checkout";
        return finish(`顾客取走一件${PRODUCTS[productId].nameZh}。`);
      }
      if (next.customer.phase === "to-checkout") {
        for (const item of next.items) if (item.location.kind === "basket") item.location = { kind: "checkout" };
        next.customer.phase = "checkout";
        return finish(`顾客已到收银台，正准备${next.payment?.method === "cash" ? "现金" : "刷卡"}付款。R 可重听，E 扫描商品。`);
      }
      if (next.customer.phase === "leaving") {
        next.payment = null;
        next.customer.phase = "complete";
        next.day.nextCustomerAtMs = nextArrivalAtMs(next);
        return finish("顾客已离店。");
      }
      return reject("顾客还在等待你的操作。");
    }
    case "SCAN": {
      if (next.customer.phase !== "checkout") return reject("请等顾客把商品放上收银台。");
      const item = next.items.find((candidate) => candidate.id === command.itemId && candidate.location.kind === "checkout");
      if (!item) return reject("这件商品不在收银台上。");
      if (next.scannedIds.includes(item.id)) return reject("这件商品已经扫描过了，不会重复计费。");
      next.scannedIds.push(item.id);
      return finish(`${PRODUCTS[item.productId].nameEn} · £${(PRODUCTS[item.productId].pricePence / 100).toFixed(2)}`);
    }
    case "PAY": {
      if (next.customer.phase !== "checkout") return reject("当前没有等待付款的交易。");
      if (next.payment?.method !== "card") return reject("这位顾客用现金付款，请接收现金并完成找零，不能使用刷卡收款。");
      if (!allScanned()) return reject("请先扫描全部商品，再收款。");
      if (command.success !== true) return reject("付款未成功，商品和金额均未改变，可以重试或取消。");
      return commitPayment("card", getCheckoutTotal(next), 0);
    }
    case "RECEIVE_CASH": {
      if (next.customer.phase !== "checkout" || next.payment?.method !== "cash") return reject("当前没有等待现金付款的顾客。");
      if (!allScanned()) return reject("请先扫描全部商品，再接收现金。");
      if (next.payment.received) return reject("这笔现金已经暂收，不会重复收钱。");
      next.payment.received = true;
      return finish(`已暂收 £${(next.payment.tenderedPence / 100).toFixed(2)}，请确认找零；资金尚未入账。`);
    }
    case "ADD_CHANGE":
    case "REMOVE_CHANGE":
    case "CLEAR_CHANGE": {
      if (next.customer.phase !== "checkout" || next.payment?.method !== "cash" || !next.payment.received || !allScanned()) {
        return reject("请先扫描全部商品并接收这位顾客的现金，再选择找零。");
      }
      if (command.type === "ADD_CHANGE") {
        if (!isCashDenomination(command.denominationPence)) return reject("请选择有效的英镑纸币或硬币面额。");
        if (next.payment.selectedChange.length >= MAX_CHANGE_PIECES) return reject(`一次最多选择 ${MAX_CHANGE_PIECES} 枚零钱，请先移除或清空部分选择。`);
        next.payment.selectedChange.push(command.denominationPence);
      } else if (command.type === "REMOVE_CHANGE") {
        if (!isInteger(command.index) || command.index < 0 || command.index >= next.payment.selectedChange.length) return reject("这枚零钱不在当前选择中。");
        next.payment.selectedChange.splice(command.index, 1);
      } else {
        if (!next.payment.selectedChange.length) return reject("当前没有需要清空的找零。");
        next.payment.selectedChange = [];
      }
      return finish(`已选找零 £${(selectedChangeTotalPence(next.payment.selectedChange) / 100).toFixed(2)}，确认前不会扣款。`);
    }
    case "CONFIRM_CASH": {
      if (next.customer.phase !== "checkout" || next.payment?.method !== "cash") return reject("当前没有等待现金付款的交易。");
      if (!allScanned()) return reject("请先扫描全部商品，再收款。");
      if (!next.payment.received) return reject("请先接收顾客交来的现金。");
      const amountPence = getCheckoutTotal(next);
      const changePence = cashChangeDuePence(next.payment, amountPence);
      if (!cashPaymentCanConfirm(next.payment, amountPence)) {
        const selected = selectedChangeTotalPence(next.payment.selectedChange);
        return reject(`找零${selected > changePence ? "多了" : "还不够"}，请重新核对；本单尚未完成，资金和商品未改变。`);
      }
      return commitPayment("cash", next.payment.tenderedPence, changePence);
    }
    case "CANCEL_CUSTOMER": {
      if (["outside", "leaving", "complete"].includes(next.customer.phase)) return reject("当前没有可以取消的购物流程。");
      const returnCash = next.payment?.method === "cash" && next.payment.received;
      for (const item of next.items) {
        if ((item.location.kind === "basket" || item.location.kind === "checkout") && !returnUnpaidItem(next, item)) {
          return reject("暂时没有安全空位归还商品，请先搬开或回收空箱；本单和商品保持不变。");
        }
      }
      next.scannedIds = [];
      next.payment = null;
      next.customer.phase = "leaving";
      return finish(returnCash ? "本单已取消，商品已归还，暂收现金已退回，资金未改变。" : "本单已取消，未付款的商品已归还，资金未改变。");
    }
    case "BUY_UPGRADE": {
      if (next.upgraded) return reject("货架容量已经升级过了。");
      if (next.cashPence < UPGRADE_COST_PENCE) return reject("普通容量升级需要 £8，只检查资金，不要求英语等级。");
      next.cashPence -= UPGRADE_COST_PENCE;
      next.upgraded = true;
      next.upgradeDay = next.day.number;
      // Expansion after closing is still this day's investment, not tomorrow's hidden debit.
      if (next.day.phase === "settled") next.settlements[next.settlements.length - 1] = settlementFor(next);
      return finish("普通容量升级成功，每种商品可放 8 件；升级不会凭空补货。");
    }
    case "BUY_SPACE_EXPANSION": {
      const offer = getShopExpansionOffer(next);
      if (!offer.allowed) return reject(offer.reason ?? "当前不能扩建店面。");
      next.cashPence -= offer.costPence;
      next.renovation.layout.expansion = 1;
      next.renovation.expansionDay = next.day.number;
      if (next.day.phase === "settled") next.settlements[next.settlements.length - 1] = settlementFor(next);
      return finish("店面已向后扩建 3 米，支出 £15 已单独记入账本；设备、库存和货架容量保持不变。");
    }
    case "SUPPORT_STREET_NEIGHBOUR": {
      if (next.day.phase === "settled") return reject("今天已经日结，社区现金帮助请记入下一个营业日。");
      if (command.neighbourId !== streetNeighbourForDay({ customerSeed: next.customerSeed, dayNumber: next.day.number }).id) {
        return reject("这位街头邻居今天不在这条街上。");
      }
      if (command.amountPence !== 100 && command.amountPence !== 200) return reject("现金帮助只可选择 £1 或 £2。");
      const recordId = `street-support-${next.day.number}-${command.neighbourId}`;
      if (next.streetSupportRecords.some((record) => record.id === recordId)) return reject("今天已经向这位邻居提供过现金帮助，不会重复扣款。");
      if (next.cashPence < command.amountPence) return reject("小店资金不足，这次帮助不会扣款。");
      next.streetSupportRecords.push({ id: recordId, dayNumber: next.day.number,
        neighbourId: command.neighbourId, amountPence: command.amountPence });
      next.cashPence -= command.amountPence;
      return finish(`已从小店资金提供 £${(command.amountPence / 100).toFixed(2)} 现金帮助；不增加经验或成就。`);
    }
    case "APPLY_SHOP_LAYOUT": {
      const reason = shopRenovationReason(next);
      if (reason) return reject(reason);
      const validation = validateShopLayout(command.layout, getShopLayoutObstacles(next));
      if (!validation.valid) return reject(validation.reason ?? "布局不可用，请保留设备和顾客通道。");
      if (command.layout.expansion !== next.renovation.layout.expansion) return reject("移动设备不能改变店面面积，请先购买已开放的店面扩建。");
      if (layoutEquals(command.layout, next.renovation.layout)) return reject("设备位置和朝向没有变化，不会重复记录装修。");
      if (next.renovation.layoutRevision >= Number.MAX_SAFE_INTEGER) return reject("装修记录已达到安全上限，本次布局未改变。");
      next.renovation.layout = structuredClone(command.layout);
      next.renovation.layoutRevision += 1;
      return finish("设备布局已保存，库存、订单和资金均未改变。");
    }
    case "PURCHASE_STOCK": {
      if (!validOrderId(command.orderId)) return reject("进货单号不可用，请重新发起订货。");
      if (command.lines !== undefined && command.pairs !== undefined) return reject("一张订单只能提交自选清单或旧版组合数量，不能同时提交。");
      const selection = normalizeSelection(command.lines ?? command.pairs);
      const prior = next.purchases.find((purchase) => purchase.id === command.orderId);
      if (prior) return reject(!selection.reason && sameLines(prior.lines, selection.lines) ? "这笔进货单已经记录，不会再次扣钱或发货。" : "同一进货单号不能改成不同商品或数量。");
      const offer = getPurchaseOffer(next, command.lines ?? command.pairs!);
      if (!offer.allowed) return reject(offer.reason ?? "当前无法进货。");
      const itemIds = purchaseItemIds(command.orderId, offer.lines);
      next.purchases.push({ id: command.orderId, dayNumber: next.day.number, lines: offer.lines,
        ...(offer.pairs === undefined ? {} : { pairs: offer.pairs }), itemIds, amountPence: offer.costPence, receivedDay: null });
      for (const line of offer.lines) {
        for (const id of purchaseItemIds(command.orderId, [line])) next.items.push({ id, productId: line.productId, location: { kind: "delivery", orderId: command.orderId } });
      }
      next.cashPence -= offer.costPence;
      return finish(`订货成功 -£${(offer.costPence / 100).toFixed(2)}：自选 ${offer.lines.length} 种、${offer.unitCount} 件商品待收货，请到门口送货车旁按 E 签收。`);
    }
    case "RECEIVE_DELIVERY": {
      const delivery = getDeliverySummary(next);
      if (!delivery.canReceive) return reject(delivery.reason ?? "当前无法签收送货。");
      const placements = deliveryPlacements(next);
      if (!placements) return reject("卸货区暂时没有足够的安全空位。");
      recordReceivedCrateBatches(next, next.purchases.filter((purchase) => purchase.receivedDay === null));
      for (const purchase of next.purchases) if (purchase.receivedDay === null) purchase.receivedDay = next.day.number;
      for (const item of next.items) if (item.location.kind === "delivery") item.location = { kind: "crate", crateId: crateIdFor(item.productId) };
      for (const { productId, position } of placements) {
        const crate = next.crates.find((candidate) => candidate.productId === productId);
        if (crate) crate.position = position;
        else next.crates.push({ id: crateIdFor(productId), productId, position });
      }
      return finish(`已签收 ${delivery.pendingOrders} 单、${delivery.pendingUnits} 件商品，货箱放在门外卸货点；本次不会再次扣款。`);
    }
    case "SETTLE_DAY": {
      if (next.day.phase === "settled") return reject("今天已经日结，不会重复结算或增加资金。");
      if (getDeliverySummary(next).pendingOrders) return reject("请先签收门口的待收货物，再完成日结。");
      if (!canSettleDay(next)) return reject("请先打烊，完成或取消当前收银，并等最后一位顾客离店后再日结。");
      next.day.phase = "settled";
      next.settlements.push(settlementFor(next));
      return finish(`第 ${next.day.number} 天已日结，营业收入与采购支出已记录；资金不会在日结时重复入账。`);
    }
    case "START_NEXT_DAY": {
      if (next.day.phase !== "settled") return reject("请先完成今天的营业与日结。");
      const stock = unsoldItems(next);
      next.day = {
        number: next.day.number + 1, phase: "preparing", targetCustomers: null,
        elapsedOpenMs: 0, nextCustomerAtMs: null, closeReason: null,
        transactionStart: next.transactions.length, purchaseStart: next.purchases.length,
        openingCashPence: next.cashPence, openingInventoryValuePence: inventoryValue(stock), openingStockUnits: stock.length,
      };
      next.customer = { phase: "outside", number: next.customer.number + 1, shoppingList: [], contentVersion: 2 };
      next.payment = null;
      return finish(`第 ${next.day.number} 天开始。资金、剩余商品和货架扩容全部保留，不会追加免费本金。`);
    }
    case "SAVE_POSE": {
      const pose = command.pose;
      if (!isFiniteNumber(pose.x) || !isFiniteNumber(pose.z) || !isFiniteNumber(pose.yaw) || !isFiniteNumber(pose.pitch)
        || !isWalkablePosition(pose, 0, next.renovation.layout.expansion)) return reject("这个玩家位置不安全。");
      const updated = { ...pose, yaw: Math.atan2(Math.sin(pose.yaw), Math.cos(pose.yaw)), pitch: Math.max(-1.35, Math.min(1.35, pose.pitch)) };
      if (Object.keys(updated).every((key) => updated[key as keyof PlayerPose] === next.playerPose[key as keyof PlayerPose])) return reject("位置没有变化。");
      next.playerPose = updated;
      return finish();
    }
  }
}

/** Advanced automation must match its own task evidence, not a generic skill count. */
export function canUnlockAdvancedUpgrade(input: {
  cashPence: number;
  costPence: number;
  requiredTaskIds: readonly string[];
  completedIndependentTaskIds: readonly string[];
}): boolean {
  return isInteger(input.cashPence) && isInteger(input.costPence) && input.costPence > 0
    && input.cashPence >= input.costPence && input.requiredTaskIds.length > 0
    && input.requiredTaskIds.every((id) => id.length > 0 && input.completedIndependentTaskIds.includes(id));
}

function validPose(value: unknown, version: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11, expansion: 0 | 1 = 0): value is PlayerPose {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.z) && isFiniteNumber(value.yaw) && isFiniteNumber(value.pitch)
    && (version >= 5 ? isWalkablePosition({ x: value.x, z: value.z }, 0, version >= 10 ? expansion : 0)
      : value.x >= INDOOR_BOUNDS.minX && value.x <= INDOOR_BOUNDS.maxX && value.z >= INDOOR_BOUNDS.minZ && value.z <= INDOOR_BOUNDS.maxZ)
    && Math.abs(value.yaw) <= Math.PI + 0.00001 && Math.abs(value.pitch) <= 1.35;
}

function validReturnLocation(value: unknown, productId: ProductId, capacity: number): value is ReturnLocation {
  if (!isRecord(value)) return false;
  if (value.kind === "crate") return value.crateId === crateIdFor(productId);
  return value.kind === "shelf" && value.productId === productId && isInteger(value.slot) && value.slot >= 0 && value.slot < capacity;
}

/** Shared physical ownership checks; S0 additionally requires its fixed eight-unit grant. */
function validateWorldState(value: unknown, version: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11): value is EconomySnapshot | LegacySimState {
  const legacy = version === 3;
  const knownProduct = (input: unknown): input is ProductId => version >= 6 ? isProductId(input) : isLegacyProductId(input);
  if (!isRecord(value) || value.schemaVersion !== version || !isInteger(value.revision) || value.revision < 0
    || typeof value.upgraded !== "boolean" || !isInteger(value.cashPence) || value.cashPence < 0) return false;
  let expansion: 0 | 1 = 0;
  if (version >= 10) {
    if (!isRecord(value.day) || !isInteger(value.day.number) || value.day.number < 1
      || !validateRenovation(value.renovation, value.day.number)) return false;
    expansion = value.renovation.layout.expansion;
  }
  if (!validPose(value.playerPose, version, expansion)) return false;
  if (!Array.isArray(value.crates) || (version >= 6 ? value.crates.length < (version >= 7 ? 0 : 2) || value.crates.length > PRODUCT_IDS.length : value.crates.length !== 2)
    || !Array.isArray(value.items) || (legacy && value.items.length !== 8)
    || !Array.isArray(value.transactions) || (legacy && value.transactions.length > 4) || !Array.isArray(value.scannedIds)
    || !Array.isArray(value.inspectedProducts) || value.inspectedProducts.some((id) => !knownProduct(id))
    || new Set(value.inspectedProducts).size !== value.inspectedProducts.length) return false;
  const crateIds = new Set<string>();
  const cratePositions: Position[] = [];
  for (const crate of value.crates) {
    if (!isRecord(crate) || !knownProduct(crate.productId) || typeof crate.id !== "string" || crate.id !== crateIdFor(crate.productId)
      || !isRecord(crate.position) || !isFiniteNumber(crate.position.x) || !isFiniteNumber(crate.position.z)) return false;
    const position = { x: crate.position.x, z: crate.position.z };
    const allowedPoints = version >= 6 ? SAFE_DROP_POINTS : version === 5 ? [...INDOOR_DROP_POINTS, ...LEGACY_DELIVERY_DROP_POINTS] : INDOOR_DROP_POINTS;
    if (!allowedPoints.some((point) => positionEquals(point, position)) || crateIds.has(crate.id)
      || cratePositions.some((previous) => positionEquals(previous, position))) return false;
    crateIds.add(crate.id);
    cratePositions.push(position);
  }
  if (!isRecord(value.customer) || !isInteger(value.customer.number) || value.customer.number < 1
    || typeof value.customer.phase !== "string" || !["outside", "to-milk", "to-bread", "to-checkout", "checkout", "leaving", "complete"].includes(value.customer.phase)) return false;
  if (version === 11 && value.customer.contentVersion !== 1 && value.customer.contentVersion !== 2) return false;
  const capacity = value.upgraded ? 8 : 4;
  const itemIds = new Set<string>();
  const occupiedSlots = new Set<string>();
  const items: SimItem[] = [];
  for (const item of value.items) {
    if (!isRecord(item) || !knownProduct(item.productId) || typeof item.id !== "string"
      || (legacy && ![1, 2, 3, 4].some((number) => item.id === `${item.productId}-${number}`))
      || item.id.length === 0 || item.id.length > 128 || itemIds.has(item.id) || !isRecord(item.location)) return false;
    const location = item.location;
    if (location.kind === "crate" || location.kind === "shelf") {
      if (!validReturnLocation(location, item.productId, capacity)) return false;
      if (location.kind === "crate" && !crateIds.has(crateIdFor(item.productId))) return false;
      if (location.kind === "shelf") {
        const key = `${location.productId}:${location.slot}`;
        if (occupiedSlots.has(key)) return false;
        occupiedSlots.add(key);
      }
    } else if (location.kind === "delivery") {
      if (version < 5 || !validOrderId(location.orderId)) return false;
    } else if (location.kind === "sold") {
      if (typeof location.transactionId !== "string") return false;
    } else if (typeof location.kind !== "string" || !["hand", "basket", "checkout"].includes(location.kind)) return false;
    itemIds.add(item.id);
    items.push(item as unknown as SimItem);
  }
  if (legacy && !LEGACY_PRODUCT_IDS.every((productId) => items.filter((item) => item.productId === productId).length === 4)) return false;
  if (!isRecord(value.held)) return false;
  const handItems = items.filter((item) => item.location.kind === "hand");
  if (value.held.kind === "none") {
    if (handItems.length !== 0) return false;
  } else if (value.held.kind === "crate") {
    if (handItems.length !== 0 || typeof value.held.crateId !== "string" || !crateIds.has(value.held.crateId)) return false;
  } else if (value.held.kind === "item") {
    const item = handItems[0];
    if (handItems.length !== 1 || !item || value.held.itemId !== item.id || !validReturnLocation(value.held.returnTo, item.productId, capacity)) return false;
    if (value.held.returnTo.kind === "crate" && !crateIds.has(crateIdFor(item.productId))) return false;
  } else return false;
  let shoppingList: ProductId[] = [...LEGACY_PRODUCT_IDS];
  if (version >= 6) {
    const list = value.customer.shoppingList;
    if (!Array.isArray(list) || list.some((id) => !knownProduct(id)) || new Set(list).size !== list.length
      || (value.customer.phase === "outside" ? list.length !== 0 : list.length < 1 || list.length > 2)
      || list.some((id) => !items.some((item) => item.productId === id))) return false;
    shoppingList = list as ProductId[];
  }
  const basket = items.filter((item) => item.location.kind === "basket");
  const checkout = items.filter((item) => item.location.kind === "checkout");
  const matchesOrder = (goods: SimItem[]): boolean => goods.length === shoppingList.length
    && shoppingList.every((productId) => goods.some((item) => item.productId === productId));
  if (value.customer.phase === "to-bread") {
    if (shoppingList.length !== 2 || basket.length !== 1 || basket[0]?.productId !== shoppingList[0] || checkout.length !== 0) return false;
  } else if (value.customer.phase === "to-checkout") {
    if (!matchesOrder(basket) || checkout.length !== 0) return false;
  } else if (value.customer.phase === "checkout") {
    if (basket.length !== 0 || !matchesOrder(checkout)) return false;
  } else if (basket.length !== 0 || checkout.length !== 0) return false;
  if (value.scannedIds.some((id) => typeof id !== "string" || !checkout.some((item) => item.id === id))
    || new Set(value.scannedIds).size !== value.scannedIds.length) return false;
  if (version >= 8) {
    if (activeCustomerPhase(value.customer.phase)) {
      const amountPence = shoppingList.reduce((sum, productId) => sum + PRODUCTS[productId].pricePence, 0);
      if (!validatePaymentState(value.payment, amountPence)) return false;
      const scannedIds = value.scannedIds;
      if (value.payment.method === "cash" && value.payment.received
        && (value.customer.phase !== "checkout" || checkout.some((item) => !scannedIds.includes(item.id)))) return false;
    } else if (value.payment !== null) return false;
  }
  const transactionIds = new Set<string>();
  const soldIds = new Set<string>();
  let grossPence = 0;
  let previousCustomerNumber = 0;
  for (const transaction of value.transactions) {
    if (!isRecord(transaction) || !isInteger(transaction.customerNumber) || transaction.customerNumber <= previousCustomerNumber
      || transaction.customerNumber > value.customer.number || transaction.id !== `sale-${transaction.customerNumber}`
      || transactionIds.has(transaction.id) || !isInteger(transaction.amountPence)
      || !Array.isArray(transaction.itemIds)
      || (version >= 6 ? transaction.itemIds.length < 1 || transaction.itemIds.length > 2 : transaction.itemIds.length !== 2)
      || new Set(transaction.itemIds).size !== transaction.itemIds.length) return false;
    if (transaction.customerNumber === value.customer.number && value.customer.phase !== "leaving" && value.customer.phase !== "complete") return false;
    const goods: SimItem[] = [];
    for (const id of transaction.itemIds) {
      const item = items.find((candidate) => candidate.id === id);
      if (!item || soldIds.has(item.id) || item.location.kind !== "sold" || item.location.transactionId !== transaction.id) return false;
      soldIds.add(item.id);
      goods.push(item);
    }
    if ((version >= 6 ? new Set(goods.map((item) => item.productId)).size !== goods.length
      : !LEGACY_PRODUCT_IDS.every((productId) => goods.some((item) => item.productId === productId)))
      || transaction.amountPence !== goods.reduce((sum, item) => sum + PRODUCTS[item.productId].pricePence, 0)) return false;
    if (version >= 6 && transaction.customerNumber === value.customer.number && !matchesOrder(goods)) return false;
    if (version >= 8) {
      if ((transaction.paymentMethod !== "card" && transaction.paymentMethod !== "cash")
        || !isInteger(transaction.tenderedPence) || !isInteger(transaction.changePence)
        || transaction.changePence < 0 || transaction.tenderedPence < transaction.amountPence
        || transaction.changePence !== transaction.tenderedPence - transaction.amountPence) return false;
      if (transaction.paymentMethod === "card") {
        if (transaction.tenderedPence !== transaction.amountPence || transaction.changePence !== 0) return false;
      } else if (!validatePaymentState({ method: "cash", tenderedPence: transaction.tenderedPence, received: true, selectedChange: [] }, transaction.amountPence)) return false;
    }
    transactionIds.add(transaction.id);
    grossPence += transaction.amountPence;
    previousCustomerNumber = transaction.customerNumber;
  }
  if (items.some((item) => item.location.kind === "sold" && !soldIds.has(item.id))) return false;
  if (legacy && value.customer.phase === "outside" && (value.customer.number !== 1 || value.transactions.length !== 0)) return false;
  return !legacy || value.cashPence === grossPence - (value.upgraded ? UPGRADE_COST_PENCE : 0);
}

export function validateLegacySimState(value: unknown): value is LegacySimState {
  return validateWorldState(value, 3) && value.schemaVersion === 3;
}

const SUMMARY_FIELDS = [
  "dayNumber", "paidCustomers", "openingCashPence", "revenuePence", "procurementPence",
  "costOfGoodsPence", "grossProfitPence", "upgradeSpendPence", "closingCashPence", "remainingStockUnits", "remainingInventoryValuePence",
] as const;
const RECYCLING_SUMMARY_FIELDS = ["recycledCrates", "recyclingIncomePence"] as const;
const COMMUNITY_SUMMARY_FIELDS = ["communitySupportCount", "communityCashPence"] as const;

/** Constant-time checks shared by the clock-only reducer path and the full save validator. */
function validBusinessClock(day: unknown): boolean {
  if (!isRecord(day) || day.targetCustomers !== null
    || !isFiniteNumber(day.elapsedOpenMs) || day.elapsedOpenMs < 0 || day.elapsedOpenMs > BUSINESS_DURATION_MS
    || (day.nextCustomerAtMs !== null && (!isFiniteNumber(day.nextCustomerAtMs)
      || day.nextCustomerAtMs <= 0 || day.nextCustomerAtMs > BUSINESS_DURATION_MS))) return false;
  if (day.phase === "preparing") return day.elapsedOpenMs === 0 && day.nextCustomerAtMs === null && day.closeReason === null;
  if (day.phase === "open") return day.elapsedOpenMs < BUSINESS_DURATION_MS && day.closeReason === null;
  if (day.phase !== "closing" && day.phase !== "settled") return false;
  if (day.nextCustomerAtMs !== null) return false;
  if (day.closeReason === "time") return day.elapsedOpenMs === BUSINESS_DURATION_MS;
  if (day.closeReason === "manual") return day.elapsedOpenMs < BUSINESS_DURATION_MS;
  return day.phase === "settled" && day.closeReason === "legacy" && day.elapsedOpenMs === 0;
}

/** The ledger proves each item source, purchase quantity, paid sale, daily carry and cash balance. */
function validateEconomyState(value: unknown, version: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11): value is EconomySnapshot {
  if (!validateWorldState(value, version) || value.schemaVersion === 3) return false;
  if (value.customerSeed !== undefined && (!isInteger(value.customerSeed) || value.customerSeed < 0 || value.customerSeed > 0xffffffff)) return false;
  if (value.openingKind !== "first-day" && value.openingKind !== "legacy-s0") return false;
  if (!isRecord(value.day) || !isInteger(value.day.number) || value.day.number < 1
    || typeof value.day.phase !== "string" || !(version >= 9 ? ["preparing", "open", "closing", "settled"] : ["preparing", "open", "settled"]).includes(value.day.phase)
    || value.day.targetCustomers !== (version >= 9 ? null : DAY_CUSTOMER_TARGET)
    || !isInteger(value.day.transactionStart) || value.day.transactionStart < 0 || value.day.transactionStart > value.transactions.length
    || !Array.isArray(value.purchases) || !isInteger(value.day.purchaseStart) || value.day.purchaseStart < 0 || value.day.purchaseStart > value.purchases.length
    || !Array.isArray(value.settlements)
    || [value.day.openingCashPence, value.day.openingInventoryValuePence, value.day.openingStockUnits].some((amount) => !isInteger(amount) || amount < 0)) return false;
  if (value.schemaVersion === 9 || value.schemaVersion === 10 || value.schemaVersion === 11) {
    if (!validBusinessClock(value.day)) return false;
    const awaitingCustomer = value.day.phase === "open" && value.customer.phase === "complete";
    if (awaitingCustomer !== (value.day.nextCustomerAtMs !== null)) return false;
  }
  if (value.upgraded) {
    if (!isInteger(value.upgradeDay) || value.upgradeDay < 1 || value.upgradeDay > value.day.number) return false;
  } else if (value.upgradeDay !== null) return false;

  const itemById = new Map(value.items.map((item) => [item.id, item]));
  const sourceIds = new Set<string>();
  const sourceDay = new Map<string, number>();
  if (value.openingKind === "legacy-s0") {
    for (const productId of LEGACY_PRODUCT_IDS) for (let number = 1; number <= 4; number += 1) {
      const id = `${productId}-${number}`;
      if (itemById.get(id)?.productId !== productId || itemById.get(id)?.location.kind === "delivery") return false;
      sourceIds.add(id);
      sourceDay.set(id, 1);
    }
  }
  const purchaseIds = new Set<string>();
  let purchaseDay = 1;
  let purchaseSpendPence = 0;
  const expectedCrateIds = new Set<string>(LEGACY_PRODUCT_IDS.map(crateIdFor));
  for (const purchase of value.purchases) {
    if (!isRecord(purchase) || !validOrderId(purchase.id) || purchaseIds.has(purchase.id)
      || !isInteger(purchase.dayNumber) || purchase.dayNumber < purchaseDay || purchase.dayNumber > value.day.number
      || !Array.isArray(purchase.itemIds)) return false;
    let lines: PurchaseLine[];
    if (version >= 6) {
      const normalized = normalizeSelection(purchase.lines);
      if (normalized.reason || !Array.isArray(purchase.lines) || !sameLines(purchase.lines, normalized.lines)) return false;
      lines = normalized.lines;
      if (purchase.pairs !== undefined && (!validPairs(purchase.pairs) || !sameLines(lines, pairLines(purchase.pairs)))) return false;
    } else {
      if (!validPairs(purchase.pairs)) return false;
      lines = pairLines(purchase.pairs);
    }
    if (purchase.amountPence !== lines.reduce((sum, line) => sum + PRODUCTS[line.productId].costPence * line.quantity, 0)) return false;
    const receivedDay = version >= 5 ? purchase.receivedDay : purchase.dayNumber;
    if (receivedDay !== null && (!isInteger(receivedDay) || receivedDay !== purchase.dayNumber)) return false;
    if (receivedDay === null && (purchase.dayNumber !== value.day.number || value.day.phase === "settled")) return false;
    const expectedIds = purchaseItemIds(purchase.id, lines);
    const expectedProducts = lines.flatMap((line) => Array.from({ length: line.quantity }, () => line.productId));
    if (purchase.itemIds.length !== expectedIds.length || purchase.itemIds.some((id, index) => id !== expectedIds[index])) return false;
    for (const [index, id] of expectedIds.entries()) {
      const expectedProduct = expectedProducts[index]!;
      const item = itemById.get(id);
      if (sourceIds.has(id) || item?.productId !== expectedProduct) return false;
      if (receivedDay === null) {
        if (item.location.kind !== "delivery" || item.location.orderId !== purchase.id) return false;
      } else if (item.location.kind === "delivery") return false;
      sourceIds.add(id);
      sourceDay.set(id, receivedDay ?? Infinity);
    }
    purchaseIds.add(purchase.id);
    if (receivedDay !== null) for (const line of lines) expectedCrateIds.add(crateIdFor(line.productId));
    purchaseDay = purchase.dayNumber;
    purchaseSpendPence += purchase.amountPence;
  }
  if (sourceIds.size !== value.items.length || value.items.some((item) => !sourceIds.has(item.id))) return false;
  if (version === 6 && (value.crates.length !== expectedCrateIds.size || value.crates.some((crate) => !expectedCrateIds.has(crate.id)))) return false;
  let recyclingIncomePence = 0;
  if (value.schemaVersion === 7 || value.schemaVersion === 8 || value.schemaVersion === 9
    || value.schemaVersion === 10 || value.schemaVersion === 11) {
    if (!Array.isArray(value.recyclingRecords) || !Array.isArray(value.recyclingBatches)) return false;
    const sourceBatches = new Map<string, string>();
    const batchById = new Map<string, SimRecyclingBatch>();
    const recycledProducts = new Set<ProductId>();
    const recycledBatches = new Set<string>();
    const purchaseById = new Map(value.purchases.map((purchase) => [purchase.id, purchase]));
    for (const [index, batch] of value.recyclingBatches.entries()) {
      if (!isRecord(batch) || batch.id !== `crate-batch-${index + 1}` || !isProductId(batch.productId)
        || !Array.isArray(batch.purchaseIds) || !batch.purchaseIds.length || new Set(batch.purchaseIds).size !== batch.purchaseIds.length) return false;
      for (const purchaseId of batch.purchaseIds) {
        if (typeof purchaseId !== "string") return false;
        const purchase = purchaseById.get(purchaseId);
        const sourceKey = `${batch.productId}:${purchaseId}`;
        if (!purchase || purchase.receivedDay === null || !purchase.lines.some((line) => line.productId === batch.productId)
          || sourceBatches.has(sourceKey)) return false;
        sourceBatches.set(sourceKey, batch.id);
      }
      batchById.set(batch.id, batch);
    }
    // A receipt assigns each paid SKU source exactly once, even before the box is emptied.
    for (const purchase of value.purchases) if (purchase.receivedDay !== null) {
      if (purchase.lines.some((line) => !sourceBatches.has(`${line.productId}:${purchase.id}`))) return false;
    }
    let recyclingDay = 1;
    for (const [index, record] of value.recyclingRecords.entries()) {
      if (!isRecord(record) || record.id !== `recycle-${index + 1}` || !isProductId(record.productId)
        || !expectedCrateIds.has(crateIdFor(record.productId))
        || !isInteger(record.dayNumber) || record.dayNumber < recyclingDay || record.dayNumber > value.day.number
        || !Array.isArray(record.purchaseIds) || new Set(record.purchaseIds).size !== record.purchaseIds.length
        || record.amountPence !== (record.purchaseIds.length ? RECYCLING_REWARD_PENCE : 0)) return false;
      if (record.batchId === null) {
        if (record.purchaseIds.length !== 0) return false;
      } else {
        if (typeof record.batchId !== "string") return false;
        const batch = batchById.get(record.batchId);
        if (!batch || recycledBatches.has(batch.id) || batch.productId !== record.productId
          || batch.purchaseIds.length !== record.purchaseIds.length
          || batch.purchaseIds.some((id, sourceIndex) => id !== record.purchaseIds[sourceIndex])) return false;
        recycledBatches.add(batch.id);
      }
      if (!LEGACY_PRODUCT_IDS.some((productId) => productId === record.productId)
        && !value.purchases.some((purchase) => purchase.receivedDay !== null && purchase.receivedDay <= record.dayNumber
          && purchase.lines.some((line) => line.productId === record.productId))) return false;
      for (const purchaseId of record.purchaseIds) {
        const purchase = purchaseById.get(purchaseId);
        if (!purchase || purchase.receivedDay === null || purchase.receivedDay > record.dayNumber) return false;
      }
      recycledProducts.add(record.productId);
      recyclingDay = record.dayNumber;
      recyclingIncomePence += record.amountPence;
    }
    if (value.crates.some((crate) => !expectedCrateIds.has(crate.id))) return false;
    const activeProducts = new Set<ProductId>();
    for (const batch of value.recyclingBatches) if (!recycledBatches.has(batch.id)) {
      if (activeProducts.has(batch.productId) || !value.crates.some((crate) => crate.productId === batch.productId)) return false;
      activeProducts.add(batch.productId);
    }
    for (const crateId of expectedCrateIds) {
      if (value.crates.some((crate) => crate.id === crateId)) continue;
      const productId = PRODUCT_IDS.find((id) => crateIdFor(id) === crateId)!;
      // Every missing box needs a disposal record; unpaid return containers may be rebuilt later.
      if (!recycledProducts.has(productId)) return false;
    }
  }
  let communityCashPence = 0;
  if (value.schemaVersion === 11) {
    if (!Array.isArray(value.streetSupportRecords)) return false;
    let previousSupportDay = 0;
    for (const record of value.streetSupportRecords) {
      if (!isRecord(record) || !isInteger(record.dayNumber) || record.dayNumber <= previousSupportDay || record.dayNumber > value.day.number
        || (record.neighbourId !== "sam" && record.neighbourId !== "ellis")
        || (record.amountPence !== 100 && record.amountPence !== 200)
        || record.neighbourId !== streetNeighbourForDay({ customerSeed: value.customerSeed, dayNumber: record.dayNumber }).id
        || record.id !== `street-support-${record.dayNumber}-${record.neighbourId}`) return false;
      previousSupportDay = record.dayNumber;
      communityCashPence += record.amountPence;
    }
  }
  for (const productId of PRODUCT_IDS) {
    const held = value.held;
    const reserved = held.kind === "item" && held.returnTo.kind === "crate" && held.returnTo.crateId === crateIdFor(productId) ? 1 : 0;
    if (countAt(value, productId, "crate") + countAt(value, productId, "delivery") + reserved > CRATE_CAPACITY
      || unsoldItems(value, productId).length > CRATE_CAPACITY + capacityFor(value)) return false;
  }
  const opening = firstDay(value.openingKind);
  const grossPence = value.transactions.reduce((sum, transaction) => sum + transaction.amountPence, 0);
  const expansionSpendPence = (value.schemaVersion === 10 || value.schemaVersion === 11)
    && value.renovation.layout.expansion === 1 ? SHOP_EXPANSION_COST_PENCE : 0;
  const expectedCash = opening.openingCashPence + grossPence + recyclingIncomePence - purchaseSpendPence
    - (value.upgraded ? UPGRADE_COST_PENCE : 0) - expansionSpendPence - communityCashPence;
  if (!isInteger(expectedCash) || value.cashPence !== expectedCash) return false;

  const expectedSettlementCount = value.day.number - (value.day.phase === "settled" ? 0 : 1);
  if (value.settlements.length !== expectedSettlementCount) return false;
  let transactionStart = 0;
  let purchaseStart = 0;
  let openingCashPence = opening.openingCashPence;
  let openingInventoryValuePence = opening.openingInventoryValuePence;
  let openingStockUnits = opening.openingStockUnits;
  let timedHistoryStarted = false;
  for (const [index, record] of value.settlements.entries()) {
    const number = index + 1;
    if (!isRecord(record) || record.dayNumber !== number || record.transactionStart !== transactionStart || record.purchaseStart !== purchaseStart
      || !isInteger(record.transactionEnd) || record.transactionEnd < transactionStart || record.transactionEnd > value.transactions.length
      || !isInteger(record.purchaseEnd) || record.purchaseEnd < purchaseStart || record.purchaseEnd > value.purchases.length
      || record.openingInventoryValuePence !== openingInventoryValuePence || record.openingStockUnits !== openingStockUnits) return false;
    if (record.targetCustomers !== DAY_CUSTOMER_TARGET && (version < 9 || record.targetCustomers !== null)) return false;
    if (record.targetCustomers === null) timedHistoryStarted = true;
    else if (timedHistoryStarted) return false;
    const day = {
      number, targetCustomers: record.targetCustomers, transactionStart, purchaseStart,
      openingCashPence, openingInventoryValuePence, openingStockUnits,
    };
    const summary = summaryForRange(value, day, record.transactionEnd, record.purchaseEnd);
    const maxPaid = value.openingKind === "legacy-s0" && number === 1 ? 4 : DAY_CUSTOMER_TARGET;
    if ((record.targetCustomers === DAY_CUSTOMER_TARGET && (summary.paidCustomers < DAY_CUSTOMER_TARGET || summary.paidCustomers > maxPaid))
      || SUMMARY_FIELDS.some((field) => !isInteger(record[field]) || record[field] !== summary[field])
      || ((value.schemaVersion === 7 || value.schemaVersion === 8 || value.schemaVersion === 9
          || value.schemaVersion === 10 || value.schemaVersion === 11)
        && RECYCLING_SUMMARY_FIELDS.some((field) => !isInteger(record[field]) || record[field] !== summary[field]))
      || ((value.schemaVersion === 10 || value.schemaVersion === 11)
        && (!isInteger(record.expansionSpendPence) || record.expansionSpendPence !== summary.expansionSpendPence))
      || (value.schemaVersion === 11
        && COMMUNITY_SUMMARY_FIELDS.some((field) => !isInteger(record[field]) || record[field] !== summary[field]))
      || summary.closingCashPence < 0 || summary.remainingStockUnits < 0 || summary.remainingInventoryValuePence < 0) return false;
    if (value.purchases.slice(purchaseStart, record.purchaseEnd).some((purchase) => purchase.dayNumber !== number)) return false;
    if (value.transactions.slice(transactionStart, record.transactionEnd)
      .some((sale) => sale.itemIds.some((id) => (sourceDay.get(id) ?? Infinity) > number))) return false;
    if (number === value.day.number && (value.day.transactionStart !== transactionStart || value.day.purchaseStart !== purchaseStart
      || value.day.openingCashPence !== openingCashPence || value.day.openingStockUnits !== openingStockUnits
      || value.day.openingInventoryValuePence !== openingInventoryValuePence)) return false;
    transactionStart = record.transactionEnd;
    purchaseStart = record.purchaseEnd;
    openingCashPence = summary.closingCashPence;
    openingStockUnits = summary.remainingStockUnits;
    openingInventoryValuePence = summary.remainingInventoryValuePence;
  }
  if (value.day.phase !== "settled") {
    if (value.day.transactionStart !== transactionStart || value.day.purchaseStart !== purchaseStart
      || value.day.openingCashPence !== openingCashPence || value.day.openingStockUnits !== openingStockUnits
      || value.day.openingInventoryValuePence !== openingInventoryValuePence
      || value.purchases.slice(purchaseStart).some((purchase) => purchase.dayNumber !== value.day.number)) return false;
  } else if (transactionStart !== value.transactions.length || purchaseStart !== value.purchases.length) return false;
  const current = getDaySummary(value);
  const maxPaid = value.openingKind === "legacy-s0" && value.day.number === 1 ? 4 : DAY_CUSTOMER_TARGET;
  if (current.closingCashPence !== value.cashPence || current.remainingStockUnits !== unsoldItems(value).length
    || current.remainingInventoryValuePence !== inventoryValue(unsoldItems(value)) || (version < 9 && current.paidCustomers > maxPaid)) return false;
  if (value.day.phase === "preparing") {
    if (value.customer.phase !== "outside" || current.paidCustomers !== 0) return false;
  } else if (value.customer.phase === "outside" && (version < 9 || value.day.phase === "open" || current.paidCustomers !== 0)) return false;
  if (value.schemaVersion === 9 || value.schemaVersion === 10 || value.schemaVersion === 11) {
    if (value.day.phase === "settled" && (!["outside", "complete"].includes(value.customer.phase)
      || value.payment !== null || value.scannedIds.length !== 0
      || value.settlements.at(-1)?.targetCustomers !== (value.day.closeReason === "legacy" ? DAY_CUSTOMER_TARGET : null))) return false;
  } else {
    if (value.day.phase === "settled" && (value.customer.phase !== "complete" || current.paidCustomers < DAY_CUSTOMER_TARGET)) return false;
    if (current.paidCustomers >= DAY_CUSTOMER_TARGET && !["leaving", "complete"].includes(value.customer.phase)) return false;
  }
  return true;
}

export function validateV4SimState(value: unknown): value is SimStateV4 {
  return validateEconomyState(value, 4) && value.schemaVersion === 4;
}

export function validateV5SimState(value: unknown): value is SimStateV5 {
  return validateEconomyState(value, 5) && value.schemaVersion === 5;
}

export function validateV6SimState(value: unknown): value is SimStateV6 {
  return validateEconomyState(value, 6) && value.schemaVersion === 6;
}

export function validateV7SimState(value: unknown): value is SimStateV7 {
  return validateEconomyState(value, 7) && value.schemaVersion === 7;
}

export function validateV8SimState(value: unknown): value is SimStateV8 {
  return validateEconomyState(value, 8) && value.schemaVersion === 8;
}

export function validateV9SimState(value: unknown): value is SimStateV9 {
  return validateEconomyState(value, 9) && value.schemaVersion === 9;
}

export function validateV10SimState(value: unknown): value is SimStateV10 {
  return validateEconomyState(value, 10) && value.schemaVersion === 10;
}

export function validateSimState(value: unknown): value is SimState {
  return validateEconomyState(value, 11) && value.schemaVersion === 11;
}
