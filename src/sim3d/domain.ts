/** First-person shop inventory and first-day economy, separate from the legacy 2D game. */
export const PRODUCT_IDS = ["milk", "bread"] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];
export type CrateId = "milk-crate" | "bread-crate";

export interface ProductDefinition {
  nameEn: string;
  nameZh: string;
  unitEn: string;
  pricePence: number;
  costPence: number;
}

export const PRODUCTS: Record<ProductId, ProductDefinition> = {
  milk: { nameEn: "milk", nameZh: "牛奶", unitEn: "carton", pricePence: 160, costPence: 90 },
  bread: { nameEn: "bread", nameZh: "面包", unitEn: "loaf", pricePence: 240, costPence: 140 },
};

export interface Position { x: number; z: number }
export interface PlayerPose extends Position { yaw: number; pitch: number }

export const SAFE_DROP_POINTS: readonly Position[] = [
  { x: 1.35, z: -2.9 },
  { x: 2.2, z: -2.9 },
  { x: -1.1, z: 2.6 },
  { x: 1.8, z: 1.35 },
];
export const WORLD_BOUNDS = { minX: -3.4, maxX: 3.4, minZ: -4.6, maxZ: 4.6 } as const;
export const UPGRADE_COST_PENCE = 800;
export const INITIAL_CAPITAL_PENCE = 1200;
export const CRATE_CAPACITY = 8;
export const DAY_CUSTOMER_TARGET = 3;
export const PURCHASE_PAIR_COST_PENCE = PRODUCTS.milk.costPence + PRODUCTS.bread.costPence;
export const PURCHASE_PAIR_OPTIONS = [1, 3, 6] as const;
export type PurchasePairs = (typeof PURCHASE_PAIR_OPTIONS)[number];

export type ReturnLocation =
  | { kind: "crate"; crateId: CrateId }
  | { kind: "shelf"; productId: ProductId; slot: number };
export type ItemLocation = ReturnLocation
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
export interface SimTransaction {
  id: string;
  customerNumber: number;
  itemIds: string[];
  amountPence: number;
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
  transactions: SimTransaction[];
  cashPence: number;
  upgraded: boolean;
  playerPose: PlayerPose;
}
/** Exact old S0 snapshot shape. Migration must retain these fields, not manufacture capital. */
export interface LegacySimState extends SimWorldState { schemaVersion: 3 }
export interface SimPurchase {
  id: string;
  dayNumber: number;
  pairs: PurchasePairs;
  itemIds: string[];
  amountPence: number;
}
export interface SimDay {
  number: number;
  phase: "preparing" | "open" | "settled";
  targetCustomers: 3;
  transactionStart: number;
  purchaseStart: number;
  openingCashPence: number;
  openingInventoryValuePence: number;
  openingStockUnits: number;
}
export interface SimDaySummary {
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
export interface SimSettlement extends SimDaySummary {
  transactionStart: number;
  transactionEnd: number;
  purchaseStart: number;
  purchaseEnd: number;
  openingInventoryValuePence: number;
  openingStockUnits: number;
}
export interface SimState extends SimWorldState {
  schemaVersion: 4;
  /** Only these two fixed, auditable opening balances are accepted. */
  openingKind: "first-day" | "legacy-s0";
  day: SimDay;
  purchases: SimPurchase[];
  upgradeDay: number | null;
  settlements: SimSettlement[];
}
export interface PurchaseOffer {
  pairs: PurchasePairs;
  costPence: number;
  allowed: boolean;
  reason?: string;
}

export type SimCommand =
  | { type: "PICK_CRATE"; crateId: CrateId }
  | { type: "DROP_HELD"; position: Position }
  | { type: "TAKE_ITEM"; itemId: string }
  | { type: "RETURN_ITEM" }
  | { type: "STOCK"; productId: ProductId; slot: number }
  | { type: "INSPECT"; productId: ProductId }
  | { type: "OPEN_STORE" }
  | { type: "CUSTOMER_ADVANCE" }
  | { type: "SCAN"; itemId: string }
  | { type: "PAY"; success: boolean }
  | { type: "NEXT_CUSTOMER" }
  | { type: "CANCEL_CUSTOMER" }
  | { type: "BUY_UPGRADE" }
  | { type: "PURCHASE_STOCK"; orderId: string; pairs: PurchasePairs }
  | { type: "SETTLE_DAY" }
  | { type: "START_NEXT_DAY" }
  | { type: "SAVE_POSE"; pose: PlayerPose };
export interface SimResult { state: SimState; changed: boolean; message?: string }

const crateIdFor = (productId: ProductId): CrateId => `${productId}-crate`;
const isProductId = (value: unknown): value is ProductId => value === "milk" || value === "bread";
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positionEquals = (a: Position, b: Position): boolean => Math.abs(a.x - b.x) < 0.001 && Math.abs(a.z - b.z) < 0.001;

export function capacityFor(state: Pick<SimState, "upgraded">): number { return state.upgraded ? 8 : 4 }

function createLegacyInitialState(): LegacySimState {
  return {
    schemaVersion: 3,
    revision: 0,
    items: PRODUCT_IDS.flatMap((productId) => Array.from({ length: 4 }, (_, index) => ({
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
    number: 1, phase: "preparing", targetCustomers: DAY_CUSTOMER_TARGET,
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
    ...world, schemaVersion: 4, items: [], cashPence: INITIAL_CAPITAL_PENCE,
    openingKind: "first-day", day: firstDay("first-day"), purchases: [], upgradeDay: null, settlements: [],
  };
}

/** S0 trial goods are an opening grant; all old cash, sales, scan and held state remain intact. */
export function migrateLegacySimState(value: unknown): SimState {
  if (!validateLegacySimState(value)) throw new Error("旧版 3D 存档校验失败，不能迁移这份库存或金额。");
  const legacy = structuredClone(value);
  const day = firstDay("legacy-s0");
  day.phase = legacy.customer.phase === "outside" ? "preparing" : "open";
  return {
    ...legacy, schemaVersion: 4, openingKind: "legacy-s0", day,
    purchases: [], upgradeDay: legacy.upgraded ? 1 : null, settlements: [],
  };
}

export function countAt(state: SimState, productId: ProductId, kind: ItemLocation["kind"]): number {
  return state.items.filter((item) => item.productId === productId && item.location.kind === kind).length;
}

export function getCheckoutTotal(state: SimState): number {
  return state.items.filter((item) => item.location.kind === "checkout")
    .reduce((total, item) => total + PRODUCTS[item.productId].pricePence, 0);
}

function unsoldItems(state: SimState, productId?: ProductId): SimItem[] {
  return state.items.filter((item) => item.location.kind !== "sold" && (!productId || item.productId === productId));
}

function inventoryValue(items: SimItem[]): number {
  return items.reduce((sum, item) => sum + PRODUCTS[item.productId].costPence, 0);
}

function purchaseItemIds(orderId: string, pairs: PurchasePairs): string[] {
  return PRODUCT_IDS.flatMap((productId) => Array.from({ length: pairs }, (_, index) => `${productId}-purchase-${orderId}-${index + 1}`));
}

const validOrderId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);
const validPairs = (pairs: unknown): pairs is PurchasePairs => PURCHASE_PAIR_OPTIONS.some((option) => option === pairs);

/** A paired delivery always preserves both product types needed for a payable order. */
export function getPurchaseOffer(state: SimState, pairs: PurchasePairs): PurchaseOffer {
  const costPence = validPairs(pairs) ? pairs * PURCHASE_PAIR_COST_PENCE : 0;
  const denied = (reason: string): PurchaseOffer => ({ pairs, costPence, allowed: false, reason });
  if (!validPairs(pairs)) return denied("每次可订购 1、3 或 6 份组合货；每份含 1 盒牛奶和 1 袋面包。");
  if (state.day.phase === "settled") return denied("今天已经日结，请先开始次日再进货。");
  if (state.cashPence < costPence) return denied(`资金不足，需要 £${(costPence / 100).toFixed(2)}；可以选择较小的一份补货。`);
  for (const productId of PRODUCT_IDS) {
    const held = state.held;
    // A hand-held item reserves its exact crate return space until placed elsewhere.
    const reserved = held.kind === "item" && held.returnTo.kind === "crate" && held.returnTo.crateId === crateIdFor(productId) ? 1 : 0;
    if (countAt(state, productId, "crate") + reserved + pairs > CRATE_CAPACITY) {
      return denied(`${PRODUCTS[productId].nameZh}箱最多容纳 ${CRATE_CAPACITY} 件，请先上架或卖出部分商品。`);
    }
    // Keep room to cancel an unpaid basket safely even after shelf replenishment.
    if (unsoldItems(state, productId).length + pairs > CRATE_CAPACITY + capacityFor(state)) {
      return denied(`${PRODUCTS[productId].nameZh}暂存空间不足，请先完成当前交易或卖出部分商品。`);
    }
  }
  return { pairs, costPence, allowed: true };
}

function summaryForRange(
  state: SimState, day: SimDay, transactionEnd: number, purchaseEnd: number,
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
  return {
    dayNumber: day.number, paidCustomers: transactions.length, targetCustomers: DAY_CUSTOMER_TARGET,
    openingCashPence: day.openingCashPence, revenuePence, procurementPence, costOfGoodsPence,
    grossProfitPence: revenuePence - costOfGoodsPence, upgradeSpendPence,
    closingCashPence: day.openingCashPence + revenuePence - procurementPence - upgradeSpendPence,
    remainingStockUnits: day.openingStockUnits + purchases.reduce((sum, purchase) => sum + purchase.itemIds.length, 0)
      - transactions.reduce((sum, sale) => sum + sale.itemIds.length, 0),
    remainingInventoryValuePence: day.openingInventoryValuePence + procurementPence - costOfGoodsPence,
  };
}

/** Purchase expense is cash flow; gross profit subtracts sold-goods cost, not all unsold stock. */
export function getDaySummary(state: SimState): SimDaySummary {
  return summaryForRange(state, state.day, state.transactions.length, state.purchases.length);
}

export function canSettleDay(state: SimState): boolean {
  return state.day.phase === "open" && getDaySummary(state).paidCustomers >= DAY_CUSTOMER_TARGET
    && state.customer.phase === "complete" && state.scannedIds.length === 0
    && !state.items.some((item) => item.location.kind === "basket" || item.location.kind === "checkout");
}

function settlementFor(state: SimState): SimSettlement {
  return {
    ...getDaySummary(state), transactionStart: state.day.transactionStart, transactionEnd: state.transactions.length,
    purchaseStart: state.day.purchaseStart, purchaseEnd: state.purchases.length,
    openingInventoryValuePence: state.day.openingInventoryValuePence, openingStockUnits: state.day.openingStockUnits,
  };
}

export function getObjective(state: SimState): string {
  if (state.day.phase === "settled") return `第 ${state.day.number} 天已日结。可以查看收支、用资金扩充货架，或开始次日继续营业。`;
  if (canSettleDay(state)) return `今天已完成 ${DAY_CUSTOMER_TARGET} 单收款！打开经营面板，日结后查看毛利与库存，再决定扩容。`;
  if (state.customer.phase === "outside") {
    const held = state.held;
    const crate = held.kind === "crate" ? state.crates.find((entry) => entry.id === held.crateId) : undefined;
    const item = held.kind === "item" ? state.items.find((entry) => entry.id === held.itemId) : undefined;
    const heldProduct = crate?.productId ?? item?.productId;
    if (crate && !state.items.some((entry) => entry.location.kind === "crate" && entry.location.crateId === crate.id)) {
      if (!unsoldItems(state, crate.productId).length) return "货箱是空的，打开经营面板订购牛奶与面包组合货；首单建议 3 份。";
      return "货箱已经空了，走近安全卸货点按 G 放下，再搬下一箱货。";
    }
    if (heldProduct) {
      const product = PRODUCTS[heldProduct];
      if (!state.inspectedProducts.includes(heldProduct)) return `先按 F 近看手里的${product.nameZh}，把 ${product.nameEn} 和实物对应起来。`;
      if (countAt(state, heldProduct, "shelf") >= capacityFor(state)) return `${product.nameZh}货架已满，先按 G 放下手里的货物。`;
      const remaining = crate ? state.items.filter((entry) => entry.location.kind === "crate" && entry.location.crateId === crate.id).length : 1;
      return `把手里的${product.nameZh}摆上${heldProduct === "milk" ? "牛奶冰柜" : "面包架"}，看向货架按 E，逐件上架${crate ? `（箱内剩 ${remaining} 件）` : ""}。`;
    }
    const missing = PRODUCT_IDS.find((id) => countAt(state, id, "shelf") < 1);
    if (missing && !unsoldItems(state, missing).length) return "先打开经营面板进货：每份含 1 盒牛奶和 1 袋面包，首单建议 3 份，共 £6.90。";
    if (missing) return state.inspectedProducts.includes(missing)
      ? `搬起${PRODUCTS[missing].nameZh}货箱，把商品摆上${missing === "milk" ? "牛奶冰柜" : "面包架"}。`
      : `搬起门边的${PRODUCTS[missing].nameZh}货箱，按 F 近看商品，再摆上货架。`;
    // Observation is a suggestion, not an additional condition for opening the store.
    return "商品已经就位，到门口翻转营业牌。";
  }
  if (state.customer.phase === "to-milk") return countAt(state, "milk", "shelf") ? "顾客正在寻找牛奶。" : "冰箱空了，先补一盒牛奶。";
  if (state.customer.phase === "to-bread") return countAt(state, "bread", "shelf") ? "顾客正在挑选面包。" : "面包架空了，先补一袋面包。";
  if (state.customer.phase === "to-checkout") return "顾客正在前往收银台，你也可以准备收银。";
  if (state.customer.phase === "checkout") return state.scannedIds.length < 2 ? "扫描台面上的两件商品。" : "商品已扫描，启用刷卡机完成收款。";
  if (state.customer.phase === "leaving") return "顾客正在离店，可以整理货架或补货。";
  if (PRODUCT_IDS.some((id) => unsoldItems(state, id).length === 0)) return "商品不足，打开经营面板订购组合货，再分别摆上牛奶冰柜和面包架。";
  if (!state.upgraded && state.cashPence >= UPGRADE_COST_PENCE) return "资金已足够，按 U 可查看 £8 普通容量升级，也可以留钱进货。";
  return "补齐牛奶和面包，准备接待下一位顾客。";
}

function freeSlot(state: SimState, productId: ProductId): number | undefined {
  for (let slot = 0; slot < capacityFor(state); slot += 1) {
    if (!state.items.some((item) => item.location.kind === "shelf" && item.location.productId === productId && item.location.slot === slot)) return slot;
  }
  return undefined;
}

function returnUnpaidItem(state: SimState, item: SimItem): void {
  const slot = freeSlot(state, item.productId);
  item.location = slot === undefined
    ? { kind: "crate", crateId: crateIdFor(item.productId) }
    : { kind: "shelf", productId: item.productId, slot };
}

/** Pure, deterministic commands; rejected input keeps the original state object. */
export function reduceSim(state: SimState, command: SimCommand): SimResult {
  const next: SimState = structuredClone(state);
  const reject = (message: string): SimResult => ({ state, changed: false, message });
  const finish = (message?: string): SimResult => {
    next.revision += 1;
    if (!validateSimState(next)) throw new Error(`3D inventory/economy invariant failed after ${command.type}`);
    return { state: next, changed: true, ...(message ? { message } : {}) };
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
      const halfWidth = crate.productId === "milk" ? 0.23 : 0.35;
      if (Math.abs(position.x - next.playerPose.x) < halfWidth + 0.24
        && Math.abs(position.z - next.playerPose.z) < 0.20 + 0.24) return reject("请先离卸货点远一点，不能把货箱放在自己脚下。");
      crate.position = { ...position };
      next.held = { kind: "none" };
      return finish("货箱已放稳。");
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
      else returnUnpaidItem(next, item);
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
      if (item.productId !== command.productId) return reject(`${PRODUCTS[item.productId].nameZh}应放在${item.productId === "milk" ? "冰箱" : "面包架"}。`);
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
      if (command.type === "OPEN_STORE" && next.day.phase !== "preparing") return reject("今天已经开始营业。");
      if (command.type === "NEXT_CUSTOMER" && next.day.phase !== "open") return reject("请先上架商品并打开营业牌。");
      if (getDaySummary(next).paidCustomers >= DAY_CUSTOMER_TARGET) return reject("今天的三单已经完成，请等顾客离店后进行日结。");
      const expected = command.type === "OPEN_STORE" ? "outside" : "complete";
      if (next.customer.phase !== expected) return reject("请先完成当前顾客的流程。");
      if (PRODUCT_IDS.some((id) => countAt(next, id, "shelf") < 1)) return reject("先给牛奶和面包各补至少一件货。");
      if (command.type === "NEXT_CUSTOMER") next.customer.number += 1;
      next.day.phase = "open";
      next.customer.phase = "to-milk";
      return finish("营业开始，一位邻居走进了小店。");
    }
    case "CUSTOMER_ADVANCE": {
      if (next.customer.phase === "to-milk" || next.customer.phase === "to-bread") {
        const productId = next.customer.phase === "to-milk" ? "milk" : "bread";
        const item = next.items.find((candidate) => candidate.productId === productId && candidate.location.kind === "shelf");
        if (!item) return reject(`顾客还没拿到${PRODUCTS[productId].nameZh}，请先补货。`);
        item.location = { kind: "basket" };
        next.customer.phase = productId === "milk" ? "to-bread" : "to-checkout";
        return finish(`顾客取走一件${PRODUCTS[productId].nameZh}。`);
      }
      if (next.customer.phase === "to-checkout") {
        for (const item of next.items) if (item.location.kind === "basket") item.location = { kind: "checkout" };
        next.customer.phase = "checkout";
        return finish("顾客已到收银台，正准备刷卡付款。R 可重听，E 扫描商品。");
      }
      if (next.customer.phase === "leaving") {
        next.customer.phase = "complete";
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
      const items = next.items.filter((item) => item.location.kind === "checkout");
      if (items.length === 0 || items.some((item) => !next.scannedIds.includes(item.id))) return reject("请先扫描全部商品，再收款。");
      if (!command.success) return reject("付款未成功，商品和金额均未改变，可以重试或取消。");
      const transactionId = `sale-${next.customer.number}`;
      if (next.transactions.some((transaction) => transaction.id === transactionId)) return reject("这笔交易已经收款。");
      const amountPence = getCheckoutTotal(next);
      next.transactions.push({ id: transactionId, customerNumber: next.customer.number, itemIds: items.map((item) => item.id), amountPence });
      next.cashPence += amountPence;
      for (const item of items) item.location = { kind: "sold", transactionId };
      next.scannedIds = [];
      next.customer.phase = "leaving";
      return finish(`收款成功 +£${(amountPence / 100).toFixed(2)}`);
    }
    case "CANCEL_CUSTOMER": {
      if (["outside", "leaving", "complete"].includes(next.customer.phase)) return reject("当前没有可以取消的购物流程。");
      for (const item of next.items) if (item.location.kind === "basket" || item.location.kind === "checkout") returnUnpaidItem(next, item);
      next.scannedIds = [];
      next.customer.phase = "leaving";
      return finish("本单已取消，未付款的商品已归还，资金未改变。");
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
    case "PURCHASE_STOCK": {
      if (!validOrderId(command.orderId)) return reject("进货单号不可用，请重新发起订货。");
      const prior = next.purchases.find((purchase) => purchase.id === command.orderId);
      if (prior) return reject(prior.pairs === command.pairs ? "这笔进货已经送达，不会再次扣钱或发货。" : "同一进货单号不能改成不同数量。");
      const offer = getPurchaseOffer(next, command.pairs);
      if (!offer.allowed) return reject(offer.reason ?? "当前无法进货。");
      const itemIds = purchaseItemIds(command.orderId, command.pairs);
      next.purchases.push({ id: command.orderId, dayNumber: next.day.number, pairs: command.pairs, itemIds, amountPence: offer.costPence });
      for (const [index, id] of itemIds.entries()) {
        const productId = index < command.pairs ? "milk" : "bread";
        next.items.push({ id, productId, location: { kind: "crate", crateId: crateIdFor(productId) } });
      }
      next.cashPence -= offer.costPence;
      return finish(`进货成功 -£${(offer.costPence / 100).toFixed(2)}：${command.pairs} 盒牛奶和 ${command.pairs} 袋面包已放入对应货箱。`);
    }
    case "SETTLE_DAY": {
      if (next.day.phase === "settled") return reject("今天已经日结，不会重复结算或增加资金。");
      if (!canSettleDay(next)) return reject(`先完成今天 ${DAY_CUSTOMER_TARGET} 单收款，并等最后一位顾客离店后再日结。`);
      next.day.phase = "settled";
      next.settlements.push(settlementFor(next));
      return finish(`第 ${next.day.number} 天已日结，营业收入与采购支出已记录；资金不会在日结时重复入账。`);
    }
    case "START_NEXT_DAY": {
      if (next.day.phase !== "settled") return reject("请先完成今天的营业与日结。");
      const stock = unsoldItems(next);
      next.day = {
        number: next.day.number + 1, phase: "preparing", targetCustomers: DAY_CUSTOMER_TARGET,
        transactionStart: next.transactions.length, purchaseStart: next.purchases.length,
        openingCashPence: next.cashPence, openingInventoryValuePence: inventoryValue(stock), openingStockUnits: stock.length,
      };
      next.customer = { phase: "outside", number: next.customer.number + 1 };
      return finish(`第 ${next.day.number} 天开始。资金、剩余商品和货架扩容全部保留，不会追加免费本金。`);
    }
    case "SAVE_POSE": {
      const pose = command.pose;
      if (!isFiniteNumber(pose.x) || !isFiniteNumber(pose.z) || !isFiniteNumber(pose.yaw) || !isFiniteNumber(pose.pitch)
        || pose.x < WORLD_BOUNDS.minX || pose.x > WORLD_BOUNDS.maxX || pose.z < WORLD_BOUNDS.minZ || pose.z > WORLD_BOUNDS.maxZ) return reject("这个玩家位置不安全。");
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

function validPose(value: unknown): value is PlayerPose {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.z) && isFiniteNumber(value.yaw) && isFiniteNumber(value.pitch)
    && value.x >= WORLD_BOUNDS.minX && value.x <= WORLD_BOUNDS.maxX && value.z >= WORLD_BOUNDS.minZ && value.z <= WORLD_BOUNDS.maxZ
    && Math.abs(value.yaw) <= Math.PI + 0.00001 && Math.abs(value.pitch) <= 1.35;
}

function validReturnLocation(value: unknown, productId: ProductId, capacity: number): value is ReturnLocation {
  if (!isRecord(value)) return false;
  if (value.kind === "crate") return value.crateId === crateIdFor(productId);
  return value.kind === "shelf" && value.productId === productId && isInteger(value.slot) && value.slot >= 0 && value.slot < capacity;
}

/** Shared physical ownership checks; S0 additionally requires its fixed eight-unit grant. */
function validateWorldState(value: unknown, version: 3 | 4): value is SimState | LegacySimState {
  const legacy = version === 3;
  if (!isRecord(value) || value.schemaVersion !== version || !isInteger(value.revision) || value.revision < 0
    || typeof value.upgraded !== "boolean" || !isInteger(value.cashPence) || value.cashPence < 0 || !validPose(value.playerPose)) return false;
  if (!Array.isArray(value.crates) || value.crates.length !== 2 || !Array.isArray(value.items) || (legacy && value.items.length !== 8)
    || !Array.isArray(value.transactions) || (legacy && value.transactions.length > 4) || !Array.isArray(value.scannedIds)
    || !Array.isArray(value.inspectedProducts) || value.inspectedProducts.some((id) => !isProductId(id))
    || new Set(value.inspectedProducts).size !== value.inspectedProducts.length) return false;
  const crateIds = new Set<string>();
  const cratePositions: Position[] = [];
  for (const crate of value.crates) {
    if (!isRecord(crate) || !isProductId(crate.productId) || typeof crate.id !== "string" || crate.id !== crateIdFor(crate.productId)
      || !isRecord(crate.position) || !isFiniteNumber(crate.position.x) || !isFiniteNumber(crate.position.z)) return false;
    const position = { x: crate.position.x, z: crate.position.z };
    if (!SAFE_DROP_POINTS.some((point) => positionEquals(point, position)) || crateIds.has(crate.id)
      || cratePositions.some((previous) => positionEquals(previous, position))) return false;
    crateIds.add(crate.id);
    cratePositions.push(position);
  }
  if (!isRecord(value.customer) || !isInteger(value.customer.number) || value.customer.number < 1
    || typeof value.customer.phase !== "string" || !["outside", "to-milk", "to-bread", "to-checkout", "checkout", "leaving", "complete"].includes(value.customer.phase)) return false;
  const capacity = value.upgraded ? 8 : 4;
  const itemIds = new Set<string>();
  const occupiedSlots = new Set<string>();
  const items: SimItem[] = [];
  for (const item of value.items) {
    if (!isRecord(item) || !isProductId(item.productId) || typeof item.id !== "string"
      || (legacy && ![1, 2, 3, 4].some((number) => item.id === `${item.productId}-${number}`))
      || item.id.length === 0 || item.id.length > 128 || itemIds.has(item.id) || !isRecord(item.location)) return false;
    const location = item.location;
    if (location.kind === "crate" || location.kind === "shelf") {
      if (!validReturnLocation(location, item.productId, capacity)) return false;
      if (location.kind === "shelf") {
        const key = `${location.productId}:${location.slot}`;
        if (occupiedSlots.has(key)) return false;
        occupiedSlots.add(key);
      }
    } else if (location.kind === "sold") {
      if (typeof location.transactionId !== "string") return false;
    } else if (typeof location.kind !== "string" || !["hand", "basket", "checkout"].includes(location.kind)) return false;
    itemIds.add(item.id);
    items.push(item as unknown as SimItem);
  }
  if (legacy && !PRODUCT_IDS.every((productId) => items.filter((item) => item.productId === productId).length === 4)) return false;
  if (!isRecord(value.held)) return false;
  const handItems = items.filter((item) => item.location.kind === "hand");
  if (value.held.kind === "none") {
    if (handItems.length !== 0) return false;
  } else if (value.held.kind === "crate") {
    if (handItems.length !== 0 || typeof value.held.crateId !== "string" || !crateIds.has(value.held.crateId)) return false;
  } else if (value.held.kind === "item") {
    const item = handItems[0];
    if (handItems.length !== 1 || !item || value.held.itemId !== item.id || !validReturnLocation(value.held.returnTo, item.productId, capacity)) return false;
  } else return false;
  const basket = items.filter((item) => item.location.kind === "basket");
  const checkout = items.filter((item) => item.location.kind === "checkout");
  const isPair = (goods: SimItem[]): boolean => goods.length === 2 && PRODUCT_IDS.every((productId) => goods.some((item) => item.productId === productId));
  if (value.customer.phase === "to-bread") {
    if (basket.length !== 1 || basket[0]?.productId !== "milk" || checkout.length !== 0) return false;
  } else if (value.customer.phase === "to-checkout") {
    if (!isPair(basket) || checkout.length !== 0) return false;
  } else if (value.customer.phase === "checkout") {
    if (basket.length !== 0 || !isPair(checkout)) return false;
  } else if (basket.length !== 0 || checkout.length !== 0) return false;
  if (value.scannedIds.some((id) => typeof id !== "string" || !checkout.some((item) => item.id === id))
    || new Set(value.scannedIds).size !== value.scannedIds.length) return false;
  const transactionIds = new Set<string>();
  const soldIds = new Set<string>();
  let grossPence = 0;
  let previousCustomerNumber = 0;
  for (const transaction of value.transactions) {
    if (!isRecord(transaction) || !isInteger(transaction.customerNumber) || transaction.customerNumber <= previousCustomerNumber
      || transaction.customerNumber > value.customer.number || transaction.id !== `sale-${transaction.customerNumber}`
      || transactionIds.has(transaction.id) || !isInteger(transaction.amountPence)
      || !Array.isArray(transaction.itemIds) || transaction.itemIds.length !== 2 || new Set(transaction.itemIds).size !== 2) return false;
    if (transaction.customerNumber === value.customer.number && value.customer.phase !== "leaving" && value.customer.phase !== "complete") return false;
    const goods: SimItem[] = [];
    for (const id of transaction.itemIds) {
      const item = items.find((candidate) => candidate.id === id);
      if (!item || soldIds.has(item.id) || item.location.kind !== "sold" || item.location.transactionId !== transaction.id) return false;
      soldIds.add(item.id);
      goods.push(item);
    }
    if (!isPair(goods) || transaction.amountPence !== goods.reduce((sum, item) => sum + PRODUCTS[item.productId].pricePence, 0)) return false;
    transactionIds.add(transaction.id);
    grossPence += transaction.amountPence;
    previousCustomerNumber = transaction.customerNumber;
  }
  if (items.some((item) => item.location.kind === "sold" && !soldIds.has(item.id))) return false;
  if (legacy && value.customer.phase === "outside" && (value.customer.number !== 1 || value.transactions.length !== 0)) return false;
  return !legacy || value.cashPence === grossPence - (value.upgraded ? UPGRADE_COST_PENCE : 0);
}

export function validateLegacySimState(value: unknown): value is LegacySimState {
  return validateWorldState(value, 3);
}

const SUMMARY_FIELDS = [
  "dayNumber", "paidCustomers", "targetCustomers", "openingCashPence", "revenuePence", "procurementPence",
  "costOfGoodsPence", "grossProfitPence", "upgradeSpendPence", "closingCashPence", "remainingStockUnits", "remainingInventoryValuePence",
] as const;

/** The ledger proves each item source, purchase quantity, paid sale, daily carry and cash balance. */
export function validateSimState(value: unknown): value is SimState {
  if (!validateWorldState(value, 4) || value.schemaVersion !== 4) return false;
  if (value.openingKind !== "first-day" && value.openingKind !== "legacy-s0") return false;
  if (!isRecord(value.day) || !isInteger(value.day.number) || value.day.number < 1
    || typeof value.day.phase !== "string" || !["preparing", "open", "settled"].includes(value.day.phase) || value.day.targetCustomers !== DAY_CUSTOMER_TARGET
    || !isInteger(value.day.transactionStart) || value.day.transactionStart < 0 || value.day.transactionStart > value.transactions.length
    || !Array.isArray(value.purchases) || !isInteger(value.day.purchaseStart) || value.day.purchaseStart < 0 || value.day.purchaseStart > value.purchases.length
    || !Array.isArray(value.settlements)
    || [value.day.openingCashPence, value.day.openingInventoryValuePence, value.day.openingStockUnits].some((amount) => !isInteger(amount) || amount < 0)) return false;
  if (value.upgraded) {
    if (!isInteger(value.upgradeDay) || value.upgradeDay < 1 || value.upgradeDay > value.day.number) return false;
  } else if (value.upgradeDay !== null) return false;

  const itemById = new Map(value.items.map((item) => [item.id, item]));
  const sourceIds = new Set<string>();
  const sourceDay = new Map<string, number>();
  if (value.openingKind === "legacy-s0") {
    for (const productId of PRODUCT_IDS) for (let number = 1; number <= 4; number += 1) {
      const id = `${productId}-${number}`;
      if (itemById.get(id)?.productId !== productId) return false;
      sourceIds.add(id);
      sourceDay.set(id, 1);
    }
  }
  const purchaseIds = new Set<string>();
  let purchaseDay = 1;
  let purchaseSpendPence = 0;
  for (const purchase of value.purchases) {
    if (!isRecord(purchase) || !validOrderId(purchase.id) || purchaseIds.has(purchase.id) || !validPairs(purchase.pairs)
      || !isInteger(purchase.dayNumber) || purchase.dayNumber < purchaseDay || purchase.dayNumber > value.day.number
      || purchase.amountPence !== purchase.pairs * PURCHASE_PAIR_COST_PENCE || !Array.isArray(purchase.itemIds)) return false;
    const expectedIds = purchaseItemIds(purchase.id, purchase.pairs);
    if (purchase.itemIds.length !== expectedIds.length || purchase.itemIds.some((id, index) => id !== expectedIds[index])) return false;
    for (const [index, id] of expectedIds.entries()) {
      const expectedProduct = index < purchase.pairs ? "milk" : "bread";
      if (sourceIds.has(id) || itemById.get(id)?.productId !== expectedProduct) return false;
      sourceIds.add(id);
      sourceDay.set(id, purchase.dayNumber);
    }
    purchaseIds.add(purchase.id);
    purchaseDay = purchase.dayNumber;
    purchaseSpendPence += purchase.amountPence;
  }
  if (sourceIds.size !== value.items.length || value.items.some((item) => !sourceIds.has(item.id))) return false;
  for (const productId of PRODUCT_IDS) {
    const held = value.held;
    const reserved = held.kind === "item" && held.returnTo.kind === "crate" && held.returnTo.crateId === crateIdFor(productId) ? 1 : 0;
    if (countAt(value, productId, "crate") + reserved > CRATE_CAPACITY
      || unsoldItems(value, productId).length > CRATE_CAPACITY + capacityFor(value)) return false;
  }
  const opening = firstDay(value.openingKind);
  const grossPence = value.transactions.reduce((sum, transaction) => sum + transaction.amountPence, 0);
  const expectedCash = opening.openingCashPence + grossPence - purchaseSpendPence - (value.upgraded ? UPGRADE_COST_PENCE : 0);
  if (!isInteger(expectedCash) || value.cashPence !== expectedCash) return false;

  const expectedSettlementCount = value.day.number - (value.day.phase === "settled" ? 0 : 1);
  if (value.settlements.length !== expectedSettlementCount) return false;
  let transactionStart = 0;
  let purchaseStart = 0;
  let openingCashPence = opening.openingCashPence;
  let openingInventoryValuePence = opening.openingInventoryValuePence;
  let openingStockUnits = opening.openingStockUnits;
  for (const [index, record] of value.settlements.entries()) {
    const number = index + 1;
    if (!isRecord(record) || record.dayNumber !== number || record.transactionStart !== transactionStart || record.purchaseStart !== purchaseStart
      || !isInteger(record.transactionEnd) || record.transactionEnd < transactionStart || record.transactionEnd > value.transactions.length
      || !isInteger(record.purchaseEnd) || record.purchaseEnd < purchaseStart || record.purchaseEnd > value.purchases.length
      || record.openingInventoryValuePence !== openingInventoryValuePence || record.openingStockUnits !== openingStockUnits) return false;
    const day: SimDay = {
      number, phase: "settled", targetCustomers: DAY_CUSTOMER_TARGET, transactionStart, purchaseStart,
      openingCashPence, openingInventoryValuePence, openingStockUnits,
    };
    const summary = summaryForRange(value, day, record.transactionEnd, record.purchaseEnd);
    const maxPaid = value.openingKind === "legacy-s0" && number === 1 ? 4 : DAY_CUSTOMER_TARGET;
    if (summary.paidCustomers < DAY_CUSTOMER_TARGET || summary.paidCustomers > maxPaid
      || SUMMARY_FIELDS.some((field) => !isInteger(record[field]) || record[field] !== summary[field])
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
    || current.remainingInventoryValuePence !== inventoryValue(unsoldItems(value)) || current.paidCustomers > maxPaid) return false;
  if (value.day.phase === "preparing") {
    if (value.customer.phase !== "outside" || current.paidCustomers !== 0) return false;
  } else if (value.customer.phase === "outside") return false;
  if (value.day.phase === "settled" && (value.customer.phase !== "complete" || current.paidCustomers < DAY_CUSTOMER_TARGET)) return false;
  if (current.paidCustomers >= DAY_CUSTOMER_TARGET && !["leaving", "complete"].includes(value.customer.phase)) return false;
  return true;
}
