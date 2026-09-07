import {
  EQUIPMENT_ASSETS,
  type EquipmentAssetId,
} from "./equipment-library/catalog";
import {
  PRODUCT_ASSETS,
  PRODUCT_ASSET_IDS,
  isProductAssetId,
  type ProductAssetId,
  type ProductShelf,
} from "./product-library/catalog";

/** The first six equipment models that have real shop-economy behaviour. */
export const OPERATIONAL_EQUIPMENT_ASSET_IDS = Object.freeze([
  "wall-shelf-narrow",
  "gondola-low",
  "chest-chiller-compact",
  "chest-chiller-wide",
  "produce-tiered",
  "bakery-glass",
] as const satisfies readonly EquipmentAssetId[]);

export type OperationalEquipmentAssetId = (typeof OPERATIONAL_EQUIPMENT_ASSET_IDS)[number];
export type ProductId = ProductAssetId;
export type EquipmentFloorRotation = 0 | 1 | 2 | 3;

export interface EquipmentCommerceDefinition {
  readonly id: OperationalEquipmentAssetId;
  readonly nameZh: string;
  readonly nameEn: string;
  readonly pricePence: number;
  /** Number of authored display slots on the corresponding art asset. */
  readonly capacity: number;
  readonly compatibleProducts: readonly ProductId[];
}

export interface ShopEquipmentInstance {
  id: string;
  assetId: OperationalEquipmentAssetId;
  productId: ProductId;
  purchasedDay: number;
}

export interface EquipmentFloorPlacement {
  instanceId: string;
  x: number;
  z: number;
  rotation: EquipmentFloorRotation;
}

export interface EquipmentPurchaseRecord {
  /** Caller-provided idempotency key. */
  id: string;
  instanceId: string;
  assetId: OperationalEquipmentAssetId;
  productId: ProductId;
  purchasedDay: number;
  amountPence: number;
}

export interface EquipmentAssetState {
  instances: ShopEquipmentInstance[];
  purchases: EquipmentPurchaseRecord[];
  nextSequence: number;
}

export interface EquipmentPurchaseRequest {
  purchaseId: string;
  assetId: OperationalEquipmentAssetId;
  productId: ProductId;
  purchasedDay: number;
}

export interface EquipmentPurchaseOffer {
  allowed: boolean;
  reason?: string;
  /** Zero only when the requested asset is unknown. */
  pricePence: number;
  /** Zero only when the requested asset is unknown. */
  capacity: number;
  /** Cash after applying the offer; denied offers never debit the balance. */
  cashAfterPence: number;
}

export interface EquipmentPurchaseResult {
  changed: boolean;
  state: EquipmentAssetState;
  cashPence: number;
  spentPence: number;
  instance: ShopEquipmentInstance | null;
  reason?: string;
}

export interface EquipmentInventoryBreakdown {
  total: number;
  inUse: number;
  inWarehouse: number;
  totalCapacity: number;
  inUseCapacity: number;
}

export interface EquipmentInventoryStats extends EquipmentInventoryBreakdown {
  byAsset: Readonly<Record<OperationalEquipmentAssetId, EquipmentInventoryBreakdown>>;
}

const PRICE_PENCE: Readonly<Record<OperationalEquipmentAssetId, number>> = Object.freeze({
  "wall-shelf-narrow": 600,
  "gondola-low": 1_000,
  "chest-chiller-compact": 1_200,
  "chest-chiller-wide": 1_800,
  "produce-tiered": 1_000,
  "bakery-glass": 1_200,
});

const operationalIds = new Set<string>(OPERATIONAL_EQUIPMENT_ASSET_IDS);
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const INSTANCE_ID = /^shop-equipment-([1-9][0-9]*)$/;
const STATE_KEYS = ["instances", "purchases", "nextSequence"] as const;
const INSTANCE_KEYS = ["id", "assetId", "productId", "purchasedDay"] as const;
const PURCHASE_KEYS = ["id", "instanceId", "assetId", "productId", "purchasedDay", "amountPence"] as const;
const REQUEST_KEYS = ["purchaseId", "assetId", "productId", "purchasedDay"] as const;
const PLACEMENT_KEYS = ["instanceId", "x", "z", "rotation"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSafeNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => isSafeNonNegativeInteger(value) && value > 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSafeExternalId = (value: unknown): value is string => typeof value === "string" && SAFE_EXTERNAL_ID.test(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

export function isOperationalEquipmentAssetId(value: unknown): value is OperationalEquipmentAssetId {
  return typeof value === "string" && operationalIds.has(value);
}

function allowedShelfKinds(assetId: OperationalEquipmentAssetId): readonly ProductShelf[] {
  if (assetId === "chest-chiller-compact" || assetId === "chest-chiller-wide") return ["chiller"];
  if (assetId === "produce-tiered") return ["produce"];
  if (assetId === "bakery-glass") return ["bakery", "ambient"];
  return ["ambient", "household"];
}

function productFitsAnAuthoredSlot(assetId: OperationalEquipmentAssetId, productId: ProductId): boolean {
  const size = PRODUCT_ASSETS[productId].size;
  return EQUIPMENT_ASSETS[assetId].placementSlots.some((slot) => size.every((dimension, axis) =>
    Number.isFinite(dimension) && dimension > 0 && dimension <= slot.maxSize[axis]! + 0.000001));
}

/** Permission combines the equipment's intended storage type with its authored slot envelopes. */
export function isEquipmentProductCompatible(assetId: unknown, productId: unknown): boolean {
  if (!isOperationalEquipmentAssetId(assetId) || !isProductAssetId(productId)) return false;
  const product = PRODUCT_ASSETS[productId];
  if (!allowedShelfKinds(assetId).includes(product.shelf)) return false;
  // The bakery cabinet is for bakery-category products even though some use the shared ambient shelf label.
  if (assetId === "bakery-glass" && product.category !== "bakery") return false;
  return productFitsAnAuthoredSlot(assetId, productId);
}

const commerceCatalog = Object.fromEntries(OPERATIONAL_EQUIPMENT_ASSET_IDS.map((id) => {
  const asset = EQUIPMENT_ASSETS[id];
  const compatibleProducts = Object.freeze(PRODUCT_ASSET_IDS.filter((productId) => isEquipmentProductCompatible(id, productId)));
  return [id, Object.freeze({
    id,
    nameZh: asset.nameZh,
    nameEn: asset.nameEn,
    pricePence: PRICE_PENCE[id],
    capacity: asset.capacity,
    compatibleProducts,
  })];
})) as Record<OperationalEquipmentAssetId, EquipmentCommerceDefinition>;

export const EQUIPMENT_COMMERCE_CATALOG = Object.freeze(commerceCatalog) as Readonly<Record<OperationalEquipmentAssetId, EquipmentCommerceDefinition>>;

export function compatibleProductsForEquipment(assetId: OperationalEquipmentAssetId): readonly ProductId[] {
  if (!isOperationalEquipmentAssetId(assetId)) return [];
  return [...EQUIPMENT_COMMERCE_CATALOG[assetId].compatibleProducts];
}

export function createEquipmentAssetState(): EquipmentAssetState {
  return { instances: [], purchases: [], nextSequence: 1 };
}

function instanceSequence(id: unknown): number | null {
  if (typeof id !== "string") return null;
  const match = INSTANCE_ID.exec(id);
  if (!match) return null;
  const sequence = Number(match[1]);
  return isPositiveInteger(sequence) ? sequence : null;
}

function validInstance(value: unknown): value is ShopEquipmentInstance {
  return isRecord(value) && hasExactKeys(value, INSTANCE_KEYS)
    && instanceSequence(value.id) !== null
    && isOperationalEquipmentAssetId(value.assetId)
    && isProductAssetId(value.productId)
    && isEquipmentProductCompatible(value.assetId, value.productId)
    && isPositiveInteger(value.purchasedDay);
}

function validPurchase(value: unknown): value is EquipmentPurchaseRecord {
  return isRecord(value) && hasExactKeys(value, PURCHASE_KEYS)
    && isSafeExternalId(value.id)
    && instanceSequence(value.instanceId) !== null
    && isOperationalEquipmentAssetId(value.assetId)
    && isProductAssetId(value.productId)
    && isEquipmentProductCompatible(value.assetId, value.productId)
    && isPositiveInteger(value.purchasedDay)
    && isSafeNonNegativeInteger(value.amountPence)
    && value.amountPence === PRICE_PENCE[value.assetId];
}

/** Strict JSON-safe validation for persisted equipment ownership. */
export function validateEquipmentAssetState(value: unknown): value is EquipmentAssetState {
  if (!isRecord(value) || !hasExactKeys(value, STATE_KEYS)
    || !Array.isArray(value.instances) || !Array.isArray(value.purchases)
    || value.instances.length !== value.purchases.length || !isPositiveInteger(value.nextSequence)) return false;

  const instances = new Map<string, ShopEquipmentInstance>();
  let largestSequence = 0;
  for (const candidate of value.instances as unknown[]) {
    if (!validInstance(candidate) || instances.has(candidate.id)) return false;
    const sequence = instanceSequence(candidate.id)!;
    if (sequence >= value.nextSequence) return false;
    largestSequence = Math.max(largestSequence, sequence);
    instances.set(candidate.id, candidate);
  }
  if (largestSequence >= value.nextSequence) return false;

  const purchaseIds = new Set<string>();
  const purchasedInstances = new Set<string>();
  for (const candidate of value.purchases as unknown[]) {
    if (!validPurchase(candidate) || purchaseIds.has(candidate.id) || purchasedInstances.has(candidate.instanceId)) return false;
    const instance = instances.get(candidate.instanceId);
    if (!instance || candidate.assetId !== instance.assetId || candidate.productId !== instance.productId
      || candidate.purchasedDay !== instance.purchasedDay) return false;
    purchaseIds.add(candidate.id);
    purchasedInstances.add(candidate.instanceId);
  }
  return purchasedInstances.size === instances.size;
}

function validRequest(value: unknown): value is EquipmentPurchaseRequest {
  return isRecord(value) && hasExactKeys(value, REQUEST_KEYS)
    && isSafeExternalId(value.purchaseId)
    && isOperationalEquipmentAssetId(value.assetId)
    && isProductAssetId(value.productId)
    && isPositiveInteger(value.purchasedDay);
}

interface PurchaseEvaluation {
  allowed: boolean;
  reason?: string;
  definition: EquipmentCommerceDefinition | null;
  request: EquipmentPurchaseRequest | null;
}

function evaluatePurchase(state: EquipmentAssetState, cashPence: number, request: unknown): PurchaseEvaluation {
  const raw = isRecord(request) ? request : null;
  const definition = raw && isOperationalEquipmentAssetId(raw.assetId) ? EQUIPMENT_COMMERCE_CATALOG[raw.assetId] : null;
  if (!validateEquipmentAssetState(state)) return { allowed: false, reason: "设备资产记录无效，无法购买。", definition, request: null };
  if (!isSafeNonNegativeInteger(cashPence)) return { allowed: false, reason: "店铺资金无效，无法购买。", definition, request: null };
  if (!raw || !isOperationalEquipmentAssetId(raw.assetId)) return { allowed: false, reason: "没有这种可购买设备。", definition: null, request: null };
  const knownDefinition = EQUIPMENT_COMMERCE_CATALOG[raw.assetId];
  if (!hasExactKeys(raw, REQUEST_KEYS)) return { allowed: false, reason: "设备购买请求格式无效。", definition: knownDefinition, request: null };
  if (!isSafeExternalId(raw.purchaseId)) return { allowed: false, reason: "设备购买编号无效。", definition: knownDefinition, request: null };
  if (!isProductAssetId(raw.productId)) return { allowed: false, reason: "没有这种经营商品。", definition: knownDefinition, request: null };
  if (!isPositiveInteger(raw.purchasedDay)) return { allowed: false, reason: "购买日期无效。", definition: knownDefinition, request: null };
  if (!validRequest(raw)) return { allowed: false, reason: "设备购买请求无效。", definition: knownDefinition, request: null };
  if (state.purchases.some((purchase) => purchase.id === raw.purchaseId)) {
    return { allowed: false, reason: "这笔设备购买已经处理过。", definition: knownDefinition, request: raw };
  }
  if (!isEquipmentProductCompatible(raw.assetId, raw.productId)) {
    return { allowed: false, reason: `${knownDefinition.nameZh}不能用于陈列${PRODUCT_ASSETS[raw.productId].nameZh}。`, definition: knownDefinition, request: raw };
  }
  if (cashPence < knownDefinition.pricePence) return { allowed: false, reason: "店铺资金不足。", definition: knownDefinition, request: raw };
  if (state.nextSequence === Number.MAX_SAFE_INTEGER) {
    return { allowed: false, reason: "设备编号已达到上限。", definition: knownDefinition, request: raw };
  }
  const instanceId = `shop-equipment-${state.nextSequence}`;
  if (state.instances.some((instance) => instance.id === instanceId)) {
    return { allowed: false, reason: "设备编号冲突，无法重复创建。", definition: knownDefinition, request: raw };
  }
  return { allowed: true, definition: knownDefinition, request: raw };
}

export function getEquipmentPurchaseOffer(
  state: EquipmentAssetState,
  cashPence: number,
  request: EquipmentPurchaseRequest,
): EquipmentPurchaseOffer {
  const evaluation = evaluatePurchase(state, cashPence, request);
  const pricePence = evaluation.definition?.pricePence ?? 0;
  const capacity = evaluation.definition?.capacity ?? 0;
  return evaluation.allowed
    ? { allowed: true, pricePence, capacity, cashAfterPence: cashPence - pricePence }
    : { allowed: false, reason: evaluation.reason, pricePence, capacity, cashAfterPence: cashPence };
}

/** Pure purchase reducer. Rejections retain the original state and balance references. */
export function purchaseEquipment(
  state: EquipmentAssetState,
  cashPence: number,
  request: EquipmentPurchaseRequest,
): EquipmentPurchaseResult {
  const evaluation = evaluatePurchase(state, cashPence, request);
  if (!evaluation.allowed || !evaluation.definition || !evaluation.request) {
    return { changed: false, state, cashPence, spentPence: 0, instance: null, reason: evaluation.reason };
  }
  const { definition, request: accepted } = evaluation;
  const instance: ShopEquipmentInstance = {
    id: `shop-equipment-${state.nextSequence}`,
    assetId: accepted.assetId,
    productId: accepted.productId,
    purchasedDay: accepted.purchasedDay,
  };
  const purchase: EquipmentPurchaseRecord = {
    id: accepted.purchaseId,
    instanceId: instance.id,
    assetId: instance.assetId,
    productId: instance.productId,
    purchasedDay: instance.purchasedDay,
    amountPence: definition.pricePence,
  };
  const next: EquipmentAssetState = {
    instances: [...state.instances.map((owned) => ({ ...owned })), instance],
    purchases: [...state.purchases.map((record) => ({ ...record })), purchase],
    nextSequence: state.nextSequence + 1,
  };
  return {
    changed: true,
    state: next,
    cashPence: cashPence - definition.pricePence,
    spentPence: definition.pricePence,
    instance: { ...instance },
  };
}

export function validateEquipmentFloorPlacements(value: unknown, state: EquipmentAssetState): value is EquipmentFloorPlacement[] {
  if (!validateEquipmentAssetState(state) || !Array.isArray(value)) return false;
  const owned = new Set(state.instances.map((instance) => instance.id));
  const placed = new Set<string>();
  for (const candidate of value as unknown[]) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, PLACEMENT_KEYS)
      || typeof candidate.instanceId !== "string" || !owned.has(candidate.instanceId) || placed.has(candidate.instanceId)
      || !isFiniteNumber(candidate.x) || !isFiniteNumber(candidate.z)
      || !isSafeNonNegativeInteger(candidate.rotation) || candidate.rotation > 3) return false;
    placed.add(candidate.instanceId);
  }
  return true;
}

function placedInstanceIds(placements: readonly EquipmentFloorPlacement[]): Set<string> {
  return new Set(placements.map((placement) => placement.instanceId));
}

export function equipmentInUseInstances(
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
): ShopEquipmentInstance[] {
  const placed = placedInstanceIds(placements);
  return state.instances.filter((instance) => placed.has(instance.id)).map((instance) => ({ ...instance }));
}

export function equipmentWarehouseInstances(
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
): ShopEquipmentInstance[] {
  const placed = placedInstanceIds(placements);
  return state.instances.filter((instance) => !placed.has(instance.id)).map((instance) => ({ ...instance }));
}

function emptyBreakdown(): EquipmentInventoryBreakdown {
  return { total: 0, inUse: 0, inWarehouse: 0, totalCapacity: 0, inUseCapacity: 0 };
}

export function equipmentInventoryStats(
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
): EquipmentInventoryStats {
  const placed = placedInstanceIds(placements);
  const mutableByAsset = Object.fromEntries(OPERATIONAL_EQUIPMENT_ASSET_IDS.map((id) => [id, emptyBreakdown()])) as Record<OperationalEquipmentAssetId, EquipmentInventoryBreakdown>;
  const totals = emptyBreakdown();
  for (const instance of state.instances) {
    const capacity = EQUIPMENT_COMMERCE_CATALOG[instance.assetId].capacity;
    const inUse = placed.has(instance.id);
    const rows = [totals, mutableByAsset[instance.assetId]];
    for (const row of rows) {
      row.total += 1;
      row.totalCapacity += capacity;
      if (inUse) {
        row.inUse += 1;
        row.inUseCapacity += capacity;
      } else row.inWarehouse += 1;
    }
  }
  const byAsset = Object.freeze(Object.fromEntries(OPERATIONAL_EQUIPMENT_ASSET_IDS.map((id) => [id, Object.freeze({ ...mutableByAsset[id] })]))) as Readonly<Record<OperationalEquipmentAssetId, EquipmentInventoryBreakdown>>;
  return { ...totals, byAsset };
}
