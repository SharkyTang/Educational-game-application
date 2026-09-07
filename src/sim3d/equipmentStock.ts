import {
  EQUIPMENT_COMMERCE_CATALOG,
  validateEquipmentAssetState,
  validateEquipmentFloorPlacements,
  type EquipmentAssetState,
  type EquipmentFloorPlacement,
} from "./equipmentCommerce";
import { isProductAssetId, type ProductAssetId } from "./product-library/catalog";

export type ProductId = ProductAssetId;

/** Shelf locations without equipmentId belong to the original per-product shop fixture. */
export interface ShelfStockLocation {
  kind: "shelf";
  productId: ProductId;
  slot: number;
  equipmentId?: string;
}

/** Structural view accepted from the domain without importing its ItemLocation union. */
export interface StockItemView {
  readonly location: {
    readonly kind: string;
    readonly productId?: unknown;
    readonly slot?: unknown;
    readonly equipmentId?: unknown;
  };
}

export const BASE_SHELF_CAPACITY = 4;
export const UPGRADED_BASE_SHELF_CAPACITY = 8;

const BASE_LOCATION_KEYS = ["kind", "productId", "slot"] as const;
const EQUIPMENT_LOCATION_KEYS = [...BASE_LOCATION_KEYS, "equipmentId"] as const;
const INSTANCE_ID = /^shop-equipment-([1-9][0-9]*)$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSlotIndex = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const validInstanceId = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = INSTANCE_ID.exec(value);
  return !!match && Number.isSafeInteger(Number(match[1]));
};

export function baseShelfCapacity(upgraded: boolean): number {
  return upgraded ? UPGRADED_BASE_SHELF_CAPACITY : BASE_SHELF_CAPACITY;
}

function validEquipmentContext(state: EquipmentAssetState, placements: readonly EquipmentFloorPlacement[]): boolean {
  return validateEquipmentAssetState(state) && validateEquipmentFloorPlacements(placements, state);
}

export function equipmentIsInUse(
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
  equipmentId: string,
): boolean {
  return validInstanceId(equipmentId) && validEquipmentContext(state, placements)
    && placements.some((placement) => placement.instanceId === equipmentId);
}

/** Returns zero unless the instance is owned, placed and assigned to this product. */
export function equipmentShelfCapacity(
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
  equipmentId: string,
  productId: ProductId,
): number {
  if (!isProductAssetId(productId) || !equipmentIsInUse(state, placements, equipmentId)) return 0;
  const instance = state.instances.find((candidate) => candidate.id === equipmentId);
  return instance?.productId === productId ? EQUIPMENT_COMMERCE_CATALOG[instance.assetId].capacity : 0;
}

export function shelfCapacityFor(
  location: Pick<ShelfStockLocation, "productId" | "equipmentId">,
  upgraded: boolean,
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
): number {
  if (!isProductAssetId(location.productId)) return 0;
  return location.equipmentId === undefined
    ? baseShelfCapacity(upgraded)
    : equipmentShelfCapacity(state, placements, location.equipmentId, location.productId);
}

export function productInStoreCapacity(
  upgraded: boolean,
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
  productId: ProductId,
): number {
  if (!isProductAssetId(productId) || !validEquipmentContext(state, placements)) return 0;
  let capacity = baseShelfCapacity(upgraded);
  const byId = new Map(state.instances.map((instance) => [instance.id, instance]));
  for (const placement of placements) {
    const instance = byId.get(placement.instanceId);
    if (instance?.productId === productId) capacity += EQUIPMENT_COMMERCE_CATALOG[instance.assetId].capacity;
  }
  return capacity;
}

function structurallyValidShelfLocation(value: unknown): value is ShelfStockLocation {
  if (!isRecord(value) || value.kind !== "shelf" || !isProductAssetId(value.productId) || !isSlotIndex(value.slot)) return false;
  if (value.equipmentId === undefined) return hasOnlyKeys(value, BASE_LOCATION_KEYS);
  return validInstanceId(value.equipmentId) && hasOnlyKeys(value, EQUIPMENT_LOCATION_KEYS);
}

/** Stable across array order and unique between every base shelf and equipment instance. */
export function shelfSlotKey(location: ShelfStockLocation): string {
  if (!structurallyValidShelfLocation(location)) throw new Error("货位编号无效。");
  return location.equipmentId === undefined
    ? `base:${location.productId}:${location.slot}`
    : `equipment:${location.equipmentId}:${location.productId}:${location.slot}`;
}

export function isValidShelfStockLocation(
  value: unknown,
  upgraded: boolean,
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
  expectedProductId?: ProductId,
): value is ShelfStockLocation {
  if (!structurallyValidShelfLocation(value)) return false;
  if (expectedProductId !== undefined && (!isProductAssetId(expectedProductId) || value.productId !== expectedProductId)) return false;
  const capacity = shelfCapacityFor(value, upgraded, state, placements);
  return capacity > 0 && value.slot < capacity;
}

function occupiedShelfKeys(items: readonly StockItemView[]): Set<string> {
  const occupied = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.location) || !structurallyValidShelfLocation(item.location)) continue;
    occupied.add(shelfSlotKey(item.location));
  }
  return occupied;
}

/** Original fixture slots are exhausted before placed equipment, which follows saved layout order. */
export function findFirstEmptyShelfSlot(
  items: readonly StockItemView[],
  productId: ProductId,
  upgraded: boolean,
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
): ShelfStockLocation | null {
  if (!Array.isArray(items) || !isProductAssetId(productId) || !validEquipmentContext(state, placements)) return null;
  const occupied = occupiedShelfKeys(items);
  for (let slot = 0; slot < baseShelfCapacity(upgraded); slot += 1) {
    const location: ShelfStockLocation = { kind: "shelf", productId, slot };
    if (!occupied.has(shelfSlotKey(location))) return location;
  }

  const byId = new Map(state.instances.map((instance) => [instance.id, instance]));
  for (const placement of placements) {
    const instance = byId.get(placement.instanceId);
    if (instance?.productId !== productId) continue;
    const capacity = EQUIPMENT_COMMERCE_CATALOG[instance.assetId].capacity;
    for (let slot = 0; slot < capacity; slot += 1) {
      const location: ShelfStockLocation = { kind: "shelf", productId, slot, equipmentId: instance.id };
      if (!occupied.has(shelfSlotKey(location))) return location;
    }
  }
  return null;
}

/** Conservative removal guard: any shelf reference to the instance counts as stock. */
export function equipmentHasStock(items: readonly StockItemView[], equipmentId: string): boolean {
  if (!Array.isArray(items) || !validInstanceId(equipmentId)) return false;
  return items.some((item) => isRecord(item) && isRecord(item.location)
    && item.location.kind === "shelf" && item.location.equipmentId === equipmentId);
}
