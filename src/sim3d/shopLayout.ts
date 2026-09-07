/** Shop renovation geometry. Coordinates are metres in the original shop world. */
import { PRODUCT_ASSET_IDS, type ProductAssetId } from "./product-library/catalog";
import {
  CATALOG_RACKS, PRODUCT_DISPLAYS, crateDimensions, rackCollider, segmentClear,
  type FloorPoint, type LayoutCollider,
} from "./productLayout";

export const FURNITURE_IDS = [
  "pantry-grains", "pantry-drinks", "produce-fruit", "produce-vegetables",
  "household", "snacks", "chilled-drinks", "chilled-food",
  "milk-fridge", "bread-rack", "checkout-counter",
] as const;
export type FurnitureId = (typeof FURNITURE_IDS)[number];
export type FurnitureRotation = 0 | 1 | 2 | 3;
export interface FurniturePlacement extends FloorPoint { id: FurnitureId; rotation: FurnitureRotation }
export type ShopExpansionStage = 0 | 1 | 2;
export interface ShopLayout { expansion: ShopExpansionStage; placements: FurniturePlacement[] }
export interface FurnitureDefinition {
  readonly id: FurnitureId;
  readonly name: string;
  readonly kind: "shelf" | "fridge" | "counter";
  /** Footprint before renovation, already in world orientation. */
  readonly width: number;
  readonly depth: number;
  readonly origin: Readonly<FloorPoint>;
  /** Facing in the original world: customers stand on this side. */
  readonly front: Readonly<FloorPoint>;
}
export interface LayoutValidation { valid: boolean; reason?: string; furnitureId?: FurnitureId }
export interface ReservedLayoutArea extends LayoutCollider { readonly name: string }

export const FURNITURE_DEFINITIONS: readonly FurnitureDefinition[] = [
  ...CATALOG_RACKS.map((rack): FurnitureDefinition => {
    const bounds = rackCollider(rack);
    return {
      id: rack.id as FurnitureId, name: rack.subtitle,
      kind: rack.kind === "chiller" ? "fridge" : "shelf",
      width: bounds.maxX - bounds.minX, depth: bounds.maxZ - bounds.minZ,
      origin: { ...rack.position },
      front: rack.yaw === 0 ? { x: 0, z: -1 } : { x: rack.yaw < 0 ? 1 : -1, z: 0 },
    };
  }),
  // Match the established assets.ts collision envelopes, including trim.
  { id: "milk-fridge", name: "牛奶冰柜", kind: "fridge", width: 1.02, depth: 0.89,
    origin: { x: 0, z: 4.065 }, front: { x: 0, z: -1 } },
  { id: "bread-rack", name: "面包架", kind: "shelf", width: 0.70, depth: 1.84,
    origin: { x: 2.94, z: 0.3 }, front: { x: -1, z: 0 } },
  { id: "checkout-counter", name: "收银台", kind: "counter", width: 1.28, depth: 1.67,
    origin: { x: -2.2, z: -2.2 }, front: { x: 1, z: 0 } },
];

const definitions = new Map(FURNITURE_DEFINITIONS.map((definition) => [definition.id, definition]));
const furnitureIds = new Set<string>(FURNITURE_IDS);
const productFurniture = new Map<ProductAssetId, FurnitureId>([["milk", "milk-fridge"], ["bread", "bread-rack"]]);
for (const rack of CATALOG_RACKS) for (const productId of rack.products) productFurniture.set(productId, rack.id as FurnitureId);

export const SHOP_ENTRANCE: Readonly<LayoutCollider> = { minX: -0.9, maxX: 0.9, minZ: -4.6, maxZ: -3.6 };
export const SHOP_ENTRANCE_POINT: Readonly<FloorPoint> = { x: 0, z: -3.5 };
export const CHECKOUT_CUSTOMER_POINT: Readonly<FloorPoint> = { x: -0.94, z: -2.15 };
export const CHECKOUT_CLERK_POINT: Readonly<FloorPoint> = { x: -3.12, z: -2.2 };
export const LAYOUT_WALK_RADIUS = 0.26;

/** Fixed decoration. The window plant is moved toward the window to open the clerk aisle. */
export const FIXED_LAYOUT_OBSTACLES: readonly LayoutCollider[] = [
  { minX: -3.22, maxX: -2.81, minZ: -4.31, maxZ: -3.89 },
  { minX: -1.10, maxX: -0.70, minZ: 3.82, maxZ: 4.22 },
];

const unloadingHalfWidth = Math.max(0.38, ...PRODUCT_ASSET_IDS.map((id) => crateDimensions(id).width / 2));
const unloadingHalfDepth = Math.max(0.31, ...PRODUCT_ASSET_IDS.map((id) => crateDimensions(id).depth / 2));
/** Keep the four indoor SAFE_DROP_POINTS and the widest possible carton free of furniture. Mats remain walkable. */
export const RESERVED_LAYOUT_AREAS: readonly ReservedLayoutArea[] = [
  { x: 1.35, z: -2.9, name: "门边卸货位 1" },
  { x: 2.2, z: -2.9, name: "门边卸货位 2" },
  { x: -1.1, z: 2.6, name: "后场卸货位" },
  { x: 1.8, z: 1.35, name: "侧面卸货位" },
].map(({ x, z, name }) => ({ name, minX: x - unloadingHalfWidth, maxX: x + unloadingHalfWidth, minZ: z - unloadingHalfDepth, maxZ: z + unloadingHalfDepth }));

export function definitionForFurniture(id: FurnitureId): FurnitureDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error(`Unknown furniture: ${id}`);
  return definition;
}

export function furnitureForProduct(productId: ProductAssetId): FurnitureId {
  const id = productFurniture.get(productId);
  if (!id) throw new Error(`No furniture for product: ${productId}`);
  return id;
}

export function createDefaultShopLayout(): ShopLayout {
  return { expansion: 0, placements: FURNITURE_DEFINITIONS.map(({ id, origin }) => ({ id, ...origin, rotation: 0 })) };
}

export function shopBounds(expansion: ShopExpansionStage): LayoutCollider {
  return { minX: -3.4, maxX: 3.4, minZ: -4.6, maxZ: 4.6 + expansion * 3 };
}

/** Match the real five wall collision rectangles, including the open doorway. */
export function shopWallColliders(expansion: ShopExpansionStage): LayoutCollider[] {
  const extension = expansion * 3;
  return [
    { minX: -3.6, maxX: -3.39, minZ: -4.8, maxZ: 4.8 + extension },
    { minX: 3.39, maxX: 3.6, minZ: -4.8, maxZ: 4.8 + extension },
    { minX: -3.6, maxX: 3.6, minZ: 4.56 + extension, maxZ: 4.8 + extension },
    { minX: -3.6, maxX: -0.95, minZ: -4.8, maxZ: -4.50 },
    { minX: 0.95, maxX: 3.6, minZ: -4.8, maxZ: -4.50 },
  ];
}

export function furnitureBounds(placement: FurniturePlacement): LayoutCollider {
  const definition = definitionForFurniture(placement.id);
  const rotated = placement.rotation % 2 === 1;
  const halfWidth = (rotated ? definition.depth : definition.width) / 2;
  const halfDepth = (rotated ? definition.width : definition.depth) / 2;
  return { minX: placement.x - halfWidth, maxX: placement.x + halfWidth, minZ: placement.z - halfDepth, maxZ: placement.z + halfDepth };
}

/** Positive quarter turns use Babylon's positive Y yaw: (x,z) becomes (z,-x). */
export function transformLayoutPoint<T extends FloorPoint>(layout: ShopLayout, id: FurnitureId, point: T): T {
  const definition = definitionForFurniture(id);
  const placement = layout.placements.find((entry) => entry.id === id);
  if (!placement) throw new Error(`Missing furniture placement: ${id}`);
  if (placement.rotation === 0) return { ...point, x: point.x + (placement.x - definition.origin.x), z: point.z + (placement.z - definition.origin.z) };
  const dx = point.x - definition.origin.x; const dz = point.z - definition.origin.z;
  const offset = placement.rotation === 1 ? { x: dz, z: -dx }
    : placement.rotation === 2 ? { x: -dx, z: -dz } : { x: -dz, z: dx };
  return { ...point, x: placement.x + offset.x, z: placement.z + offset.z };
}

/** Furniture and plants only; world wall colliders and occupied cartons are added by callers. */
export function layoutColliders(layout: ShopLayout): LayoutCollider[] {
  return [...layout.placements.map(furnitureBounds), ...FIXED_LAYOUT_OBSTACLES.map((bounds) => ({ ...bounds }))];
}

export function layoutEquals(a: ShopLayout, b: ShopLayout): boolean {
  if (a.expansion !== b.expansion || a.placements.length !== b.placements.length) return false;
  return a.placements.every((placement) => b.placements.some((other) => other.id === placement.id
    && other.x === placement.x && other.z === placement.z && other.rotation === placement.rotation));
}

const EPSILON = 1e-8;
const ROUTE_MARGIN = 0.00001;
const MAX_ROUTE_OBSTACLES = 256;
const MAX_ROUTE_NODES = 50_000;
const MAX_CACHED_LAYOUTS = 64;
const staticValidationCache = new Map<string, LayoutValidation>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function finitePoint(point: unknown): point is FloorPoint { return record(point) && finite(point.x) && finite(point.z); }
function finiteBounds(bounds: unknown): bounds is LayoutCollider {
  return record(bounds) && finite(bounds.minX) && finite(bounds.maxX) && finite(bounds.minZ) && finite(bounds.maxZ)
    && bounds.minX < bounds.maxX && bounds.minZ < bounds.maxZ
    && Number.isFinite(bounds.maxX - bounds.minX) && Number.isFinite(bounds.maxZ - bounds.minZ);
}
function overlaps(a: LayoutCollider, b: LayoutCollider): boolean {
  return a.maxX > b.minX + EPSILON && a.minX < b.maxX - EPSILON
    && a.maxZ > b.minZ + EPSILON && a.minZ < b.maxZ - EPSILON;
}
function inside(point: FloorPoint, bounds: LayoutCollider, radius = 0): boolean {
  return point.x >= bounds.minX + radius - EPSILON && point.x <= bounds.maxX - radius + EPSILON
    && point.z >= bounds.minZ + radius - EPSILON && point.z <= bounds.maxZ - radius + EPSILON;
}
function pointClear(point: FloorPoint, colliders: readonly LayoutCollider[], radius: number): boolean {
  return colliders.every((box) => point.x <= box.minX - radius || point.x >= box.maxX + radius
    || point.z <= box.minZ - radius || point.z >= box.maxZ + radius);
}

/** Cheap save-shape check. Does not confuse a temporary carton obstruction with corrupt data. */
export function validateShopLayoutStructure(value: unknown): value is ShopLayout {
  if (!record(value) || (value.expansion !== 0 && value.expansion !== 1 && value.expansion !== 2)
    || !Array.isArray(value.placements) || value.placements.length !== FURNITURE_IDS.length) return false;
  const seen = new Set<string>();
  for (const placement of value.placements as unknown[]) {
    if (!record(placement) || typeof placement.id !== "string" || !furnitureIds.has(placement.id) || seen.has(placement.id)
      || !finite(placement.x) || !finite(placement.z) || !finite(placement.rotation)
      || !Number.isInteger(placement.rotation) || placement.rotation < 0 || placement.rotation > 3) return false;
    seen.add(placement.id);
  }
  return true;
}

interface RouteGrid {
  xs: number[];
  zs: number[];
  rows: number;
  source: number;
  destinations: number[];
  parents: Int32Array;
}

/** A bounded rectilinear grid includes narrow aisle edges and the exact service positions. */
function routeAxis(low: number, high: number, coordinates: readonly number[]): number[] {
  const sorted = [low, high, ...coordinates.filter((value) => value >= low && value <= high)].sort((a, b) => a - b);
  const edges = sorted.filter((value, index) => index === 0 || value - sorted[index - 1]! > EPSILON);
  const result: number[] = [];
  for (let index = 0; index < edges.length; index += 1) {
    const value = edges[index]!;
    if (index > 0) result.push(edges[index - 1]! + (value - edges[index - 1]!) / 2);
    result.push(value);
  }
  return result;
}

function createRouteGrid(from: FloorPoint, destinations: readonly FloorPoint[], obstacles: readonly LayoutCollider[], bounds: LayoutCollider, radius: number): RouteGrid | null {
  const relevant = obstacles.filter((obstacle) => overlaps(bounds, {
    minX: obstacle.minX - radius, maxX: obstacle.maxX + radius, minZ: obstacle.minZ - radius, maxZ: obstacle.maxZ + radius,
  }));
  const allPoints = [from, ...destinations];
  const xs = routeAxis(bounds.minX + radius, bounds.maxX - radius, [
    ...allPoints.map((point) => point.x),
    ...relevant.flatMap((box) => [box.minX - radius - ROUTE_MARGIN, box.maxX + radius + ROUTE_MARGIN]),
  ]);
  const zs = routeAxis(bounds.minZ + radius, bounds.maxZ - radius, [
    ...allPoints.map((point) => point.z),
    ...relevant.flatMap((box) => [box.minZ - radius - ROUTE_MARGIN, box.maxZ + radius + ROUTE_MARGIN]),
  ]);
  const rows = zs.length; const total = xs.length * rows;
  if (total > MAX_ROUTE_NODES) return null;
  const indexFor = (point: FloorPoint): number => {
    const column = xs.findIndex((x) => Math.abs(x - point.x) <= EPSILON);
    const row = zs.findIndex((z) => Math.abs(z - point.z) <= EPSILON);
    return column < 0 || row < 0 ? -1 : column * rows + row;
  };
  const pointFor = (index: number): FloorPoint => ({ x: xs[Math.floor(index / rows)]!, z: zs[index % rows]! });
  const source = indexFor(from); const targets = destinations.map(indexFor);
  if (source < 0 || targets.some((index) => index < 0)) return null;
  const allowed = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) allowed[index] = pointClear(pointFor(index), relevant, radius) ? 1 : 0;
  const parents = new Int32Array(total).fill(-2);
  const queue = new Int32Array(total);
  const remaining = new Set(targets.filter((target) => target !== source));
  let read = 0; let write = 1; queue[0] = source; parents[source] = -1;
  while (read < write && remaining.size > 0) {
    const current = queue[read++]!;
    const column = Math.floor(current / rows); const row = current % rows;
    for (const next of [column + 1 < xs.length ? current + rows : -1, row + 1 < rows ? current + 1 : -1,
      column > 0 ? current - rows : -1, row > 0 ? current - 1 : -1]) {
      if (next < 0 || !allowed[next] || parents[next] !== -2 || !segmentClear(pointFor(current), pointFor(next), relevant, radius)) continue;
      parents[next] = current; queue[write++] = next; remaining.delete(next);
    }
  }
  return { xs, zs, rows, source, destinations: targets, parents };
}

/** Routes within the supplied rectangle; callers may extend minZ to include the street doorway. */
export function layoutRoute(from: FloorPoint, destination: FloorPoint, colliders: readonly LayoutCollider[], bounds: LayoutCollider = shopBounds(1), radius = LAYOUT_WALK_RADIUS): FloorPoint[] | null {
  if (!finitePoint(from) || !finitePoint(destination) || !finiteBounds(bounds) || !finite(radius) || radius < 0
    || !Array.isArray(colliders) || colliders.length > MAX_ROUTE_OBSTACLES || [...colliders].some((collider) => !finiteBounds(collider))
    || !inside(from, bounds, radius) || !inside(destination, bounds, radius)
    || !pointClear(from, colliders, radius) || !pointClear(destination, colliders, radius)) return null;
  if (Math.hypot(from.x - destination.x, from.z - destination.z) < EPSILON) return [];
  if (segmentClear(from, destination, colliders, radius)) return [{ ...destination }];
  const grid = createRouteGrid(from, [destination], colliders, bounds, radius);
  if (!grid || grid.parents[grid.destinations[0]!] === -2) return null;
  const points: FloorPoint[] = [{ ...destination }];
  for (let cursor = grid.destinations[0]!; cursor !== grid.source; cursor = grid.parents[cursor]!) {
    points.push({ x: grid.xs[Math.floor(cursor / grid.rows)]!, z: grid.zs[cursor % grid.rows]! });
  }
  points.push({ ...from }); points.reverse();
  const route: FloorPoint[] = [];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = points.length - 1;
    while (next > anchor + 1 && !segmentClear(points[anchor]!, points[next]!, colliders, radius)) next -= 1;
    route.push(points[next]!); anchor = next;
  }
  return route;
}

/** Revalidates every built-in shelf and both checkout sides against one composed obstacle set. */
export function validateShopLayoutReachability(layout: ShopLayout, obstacles: readonly LayoutCollider[]): LayoutValidation {
  const bounds = shopBounds(layout.expansion);
  const targets = PRODUCT_ASSET_IDS.map((productId) => {
    const id = furnitureForProduct(productId);
    return { id, point: transformLayoutPoint(layout, id, PRODUCT_DISPLAYS[productId].approach),
      reason: `${definitionForFurniture(id).name}前方无法到达，请留出取货通道。` };
  });
  targets.push(
    { id: "checkout-counter", point: transformLayoutPoint(layout, "checkout-counter", CHECKOUT_CUSTOMER_POINT), reason: "收银台顾客侧无法到达，请留出排队通道。" },
    { id: "checkout-counter", point: transformLayoutPoint(layout, "checkout-counter", CHECKOUT_CLERK_POINT), reason: "收银台店员侧无法到达，请留出工作通道。" },
  );
  if (!pointClear(SHOP_ENTRANCE_POINT, obstacles, LAYOUT_WALK_RADIUS)) return { valid: false, reason: "店门内侧被挡住了，请留出进店通道。" };
  for (const target of targets) {
    if (!inside(target.point, bounds, LAYOUT_WALK_RADIUS) || !pointClear(target.point, obstacles, LAYOUT_WALK_RADIUS)) {
      return { valid: false, furnitureId: target.id, reason: target.reason };
    }
  }
  const indirect = targets.filter((target) => !segmentClear(SHOP_ENTRANCE_POINT, target.point, obstacles, LAYOUT_WALK_RADIUS));
  if (!indirect.length) return { valid: true };
  // One connected-component search validates every service point, rather than 32 independent searches.
  const grid = createRouteGrid(SHOP_ENTRANCE_POINT, indirect.map((target) => target.point), obstacles, bounds, LAYOUT_WALK_RADIUS);
  if (!grid) return { valid: false, reason: "暂时无法确认店内通道，请简化设备周围的摆放。" };
  const unreachable = indirect.find((_, index) => grid.parents[grid.destinations[index]!] === -2);
  return unreachable ? { valid: false, furnitureId: unreachable.id, reason: unreachable.reason } : { valid: true };
}

function validateGeometry(layout: ShopLayout, extraObstacles: readonly LayoutCollider[]): LayoutValidation {
  const bounds = shopBounds(layout.expansion);
  const fixtures = layout.placements.map((placement) => ({ placement, bounds: furnitureBounds(placement) }));
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index]!; const id = fixture.placement.id; const name = definitionForFurniture(id).name;
    const fail = (reason: string): LayoutValidation => ({ valid: false, furnitureId: id, reason });
    if (!inside({ x: fixture.bounds.minX, z: fixture.bounds.minZ }, bounds) || !inside({ x: fixture.bounds.maxX, z: fixture.bounds.maxZ }, bounds)) return fail(`${name}超出了店铺空间，请移回店内。`);
    if (overlaps(fixture.bounds, SHOP_ENTRANCE)) return fail(`${name}挡住了店门，请保留入口。`);
    if (FIXED_LAYOUT_OBSTACLES.some((obstacle) => overlaps(fixture.bounds, obstacle))) return fail(`${name}与固定盆栽重叠，请换一个位置。`);
    const reserved = RESERVED_LAYOUT_AREAS.find((area) => overlaps(fixture.bounds, area));
    if (reserved) return fail(`${name}占用了${reserved.name}，请保留卸货空间。`);
    for (let other = index + 1; other < fixtures.length; other += 1) {
      if (overlaps(fixture.bounds, fixtures[other]!.bounds)) return fail(`${name}与${definitionForFurniture(fixtures[other]!.placement.id).name}重叠，请分开放置。`);
    }
    if (extraObstacles.some((obstacle) => overlaps(fixture.bounds, obstacle))) return fail(`${name}与地上的货箱重叠，请先移开货箱。`);
  }
  if (extraObstacles.some((obstacle) => overlaps(obstacle, SHOP_ENTRANCE))) return { valid: false, reason: "货箱挡住了店门，请先清理入口。" };
  return validateShopLayoutReachability(layout, [...layoutColliders(layout), ...shopWallColliders(layout.expansion), ...extraObstacles]);
}

/**
 * Omit extraObstacles when validating persisted layouts: cartons may temporarily block a route.
 * Include occupied-carton rectangles when applying a renovation draft. All checks are read-only.
 */
export function validateShopLayout(value: unknown, extraObstacles: readonly LayoutCollider[] = []): LayoutValidation {
  if (!validateShopLayoutStructure(value)) return { valid: false, reason: "布局需要保留全部 11 件设备，且位置和朝向必须有效。" };
  if (!Array.isArray(extraObstacles) || extraObstacles.length > MAX_ROUTE_OBSTACLES - FURNITURE_IDS.length - FIXED_LAYOUT_OBSTACLES.length - 5
    || [...extraObstacles].some((obstacle) => !finiteBounds(obstacle))) return { valid: false, reason: "货箱占位数据无效，暂时不能应用布局。" };
  if (extraObstacles.length) return validateGeometry(value, extraObstacles);
  // Content keys also detect in-place editor changes. A bounded cache avoids re-routing on each autosave.
  const key = JSON.stringify([value.expansion, FURNITURE_IDS.map((id) => {
    const placement = value.placements.find((entry) => entry.id === id)!;
    return [placement.x, placement.z, placement.rotation];
  })]);
  const cached = staticValidationCache.get(key);
  if (cached) return { ...cached };
  const result = validateGeometry(value, []);
  if (staticValidationCache.size >= MAX_CACHED_LAYOUTS) staticValidationCache.delete(staticValidationCache.keys().next().value!);
  staticValidationCache.set(key, { ...result });
  return result;
}
