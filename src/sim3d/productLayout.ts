import { PRODUCT_ASSET_IDS, PRODUCT_ASSETS, type ProductAssetId } from "./product-library/catalog";

export interface LayoutPoint { x: number; y: number; z: number }
export interface FloorPoint { x: number; z: number }
export interface LayoutCollider { minX: number; maxX: number; minZ: number; maxZ: number }
export interface ProductDimensions { width: number; height: number; depth: number }
export interface FixtureRack {
  id: string;
  title: string;
  subtitle: string;
  kind: "chiller" | "timber" | "household";
  position: FloorPoint;
  yaw: number;
  products: readonly ProductAssetId[];
}
export interface ProductDisplay {
  slots: LayoutPoint[];
  yaw: number;
  approach: FloorPoint;
  shelfName: string;
  /** Envelope before yaw; every pair of physical slots has a real clearance. */
  maxSize: ProductDimensions;
}

export const RACK_WIDTH = 1.24;
export const RACK_DEPTH = 0.58;
export const RACK_LEVELS = [0.48, 0.88, 1.36, 1.76] as const;
export const CATALOG_RACKS: readonly FixtureRack[] = [
  { id: "pantry-grains", title: "EVERYDAY PANTRY", subtitle: "粮食与烹饪", kind: "timber", position: { x: -3.025, z: -0.65 }, yaw: -Math.PI / 2, products: ["cereal", "pasta", "rice", "flour"] },
  { id: "pantry-drinks", title: "TEA & COFFEE", subtitle: "冲饮与调味", kind: "timber", position: { x: -3.025, z: 0.65 }, yaw: -Math.PI / 2, products: ["sugar", "tea", "coffee"] },
  { id: "produce-fruit", title: "FRESH PICKS", subtitle: "新鲜水果", kind: "timber", position: { x: -3.025, z: 1.95 }, yaw: -Math.PI / 2, products: ["apple", "banana", "orange", "tomato"] },
  { id: "produce-vegetables", title: "FROM THE GARDEN", subtitle: "时令蔬菜", kind: "timber", position: { x: -3.025, z: 3.25 }, yaw: -Math.PI / 2, products: ["potato", "carrot", "lettuce", "cucumber"] },
  { id: "household", title: "HOME ESSENTIALS", subtitle: "日用好物", kind: "household", position: { x: 3.025, z: -1.9 }, yaw: Math.PI / 2, products: ["soap", "shampoo", "tissues"] },
  { id: "snacks", title: "LITTLE TREATS", subtitle: "零食与点心", kind: "timber", position: { x: 3.025, z: 1.9 }, yaw: Math.PI / 2, products: ["crisps", "biscuits", "chocolate"] },
  { id: "chilled-drinks", title: "COLD & FRESH", subtitle: "冷藏饮品", kind: "chiller", position: { x: 1.24, z: 4.2 }, yaw: 0, products: ["water", "orange-juice", "cola", "yoghurt"] },
  { id: "chilled-food", title: "THE DAIRY", subtitle: "冷藏食品", kind: "chiller", position: { x: 2.60, z: 4.2 }, yaw: 0, products: ["cheese", "butter", "eggs"] },
];

export function rackPoint(rack: FixtureRack, local: LayoutPoint): LayoutPoint {
  const cosine = Math.cos(rack.yaw); const sine = Math.sin(rack.yaw);
  return { x: rack.position.x + local.x * cosine + local.z * sine, y: local.y, z: rack.position.z - local.x * sine + local.z * cosine };
}

export function rackCollider(rack: FixtureRack): LayoutCollider {
  const halfX = Math.abs(Math.cos(rack.yaw)) * RACK_WIDTH / 2 + Math.abs(Math.sin(rack.yaw)) * RACK_DEPTH / 2;
  const halfZ = Math.abs(Math.sin(rack.yaw)) * RACK_WIDTH / 2 + Math.abs(Math.cos(rack.yaw)) * RACK_DEPTH / 2;
  return { minX: rack.position.x - halfX, maxX: rack.position.x + halfX, minZ: rack.position.z - halfZ, maxZ: rack.position.z + halfZ };
}

const displays = {} as Record<ProductAssetId, ProductDisplay>;
displays.milk = {
  slots: [0.94, 1.40].flatMap((y) => [-0.30, -0.10, 0.10, 0.30].map((x) => ({ x, y, z: 3.77 }))),
  yaw: 0, approach: { x: 0, z: 2.72 }, shelfName: "牛奶冰柜",
  maxSize: { width: 0.18, height: 0.40, depth: 0.42 },
};
displays.bread = {
  slots: [0.82, 1.30].flatMap((y) => [-0.21, 0.13, 0.47, 0.81].map((z) => ({ x: 2.78, y, z }))),
  yaw: Math.PI / 2, approach: { x: 1.65, z: 0.35 }, shelfName: "面包架",
  maxSize: { width: 0.32, height: 0.40, depth: 0.49 },
};
for (const rack of CATALOG_RACKS) rack.products.forEach((productId, cell) => {
  const cellX = cell % 2 ? 0.30 : -0.30;
  const baseY = cell < 2 ? RACK_LEVELS[0] : RACK_LEVELS[2];
  const slots = Array.from({ length: 8 }, (_, slot) => rackPoint(rack, {
    x: cellX + (slot % 2 ? 0.138 : -0.138),
    y: baseY + (slot >= 4 ? 0.40 : 0),
    z: Math.floor(slot % 4 / 2) ? 0.125 : -0.125,
  }));
  const approach = rack.yaw === 0
    ? { x: rack.position.x + cellX, z: 3.10 }
    : { x: rack.position.x < 0 ? -2.02 : 2.02, z: rack.id === "snacks" ? 2.32 : rack.position.z - Math.sin(rack.yaw) * cellX };
  displays[productId] = {
    slots, yaw: rack.yaw, approach, shelfName: `${rack.subtitle} · ${PRODUCT_ASSETS[productId].nameZh}`,
    maxSize: { width: 0.25, height: 0.34, depth: 0.22 },
  };
});
if (PRODUCT_ASSET_IDS.some((id) => !displays[id])) throw new Error("Every product needs a physical shelf layout");
export const PRODUCT_DISPLAYS: Readonly<Record<ProductAssetId, ProductDisplay>> = displays;

export function crateDimensions(productId: ProductAssetId): ProductDimensions {
  if (productId === "milk") return { width: 0.46, height: 0.205, depth: 0.36 };
  if (productId === "bread") return { width: 0.70, height: 0.205, depth: 0.40 };
  const [width, , depth] = PRODUCT_ASSETS[productId].size;
  return { width: Math.min(0.80, Math.max(0.46, width * 2 + 0.10)), height: 0.205, depth: Math.min(0.46, Math.max(0.36, depth * 2 + 0.10)) };
}

export function fitProduct(dimensions: ProductDimensions, envelope: ProductDimensions, maximumScale = 1): number {
  return Math.min(maximumScale, envelope.width / dimensions.width, envelope.height / dimensions.height, envelope.depth / dimensions.depth);
}

export function cratePlacement(productId: ProductAssetId, dimensions: ProductDimensions, index: number): { position: LayoutPoint; scale: number } {
  const crate = crateDimensions(productId);
  const innerWidth = crate.width - 0.03; const innerDepth = crate.depth - 0.03;
  const scale = fitProduct(dimensions, { width: innerWidth / 2 - 0.015, depth: innerDepth / 2 - 0.015, height: 0.32 });
  return {
    position: { x: (index % 2 ? 1 : -1) * innerWidth / 4, y: 0.014 + Math.floor(index / 4) * (dimensions.height * scale + 0.016), z: (Math.floor(index % 4 / 2) ? 1 : -1) * innerDepth / 4 }, scale,
  };
}

export function basketPlacement(dimensions: ProductDimensions, index: number, quantity: number): { position: LayoutPoint; yaw: number; scale: number } {
  const envelope = { width: quantity > 1 ? 0.155 : 0.31, height: 0.33, depth: 0.235 };
  const scaleStraight = fitProduct(dimensions, envelope);
  const turned = { width: dimensions.depth, height: dimensions.height, depth: dimensions.width };
  const scaleTurned = fitProduct(turned, envelope);
  return { position: { x: quantity > 1 ? (index ? 0.095 : -0.095) : 0, y: 0.025, z: 0 }, yaw: scaleTurned > scaleStraight ? Math.PI / 2 : 0, scale: Math.max(scaleStraight, scaleTurned) };
}

export function checkoutPlacement(dimensions: ProductDimensions, index: number, scanned: boolean): { position: LayoutPoint; yaw: number; scale: number } {
  const envelope = { width: 0.23, height: 0.34, depth: 0.32 };
  const straight = fitProduct(dimensions, envelope);
  const turned = fitProduct({ width: dimensions.depth, height: dimensions.height, depth: dimensions.width }, envelope);
  return { position: { x: scanned ? -2.21 : -1.73, y: 1.012, z: (scanned ? -2.63 : -2.40) + index * (scanned ? 0.44 : 0.46) }, yaw: turned > straight ? Math.PI / 2 : 0, scale: Math.max(straight, turned) };
}

export function segmentClear(from: FloorPoint, to: FloorPoint, colliders: readonly LayoutCollider[], radius = 0.26): boolean {
  for (const collider of colliders) {
    let near = 0; let far = 1;
    for (const [axis, low, high] of [["x", collider.minX - radius, collider.maxX + radius], ["z", collider.minZ - radius, collider.maxZ + radius]] as const) {
      const delta = to[axis] - from[axis];
      if (Math.abs(delta) < 1e-8) {
        if (from[axis] <= low || from[axis] >= high) { near = 2; break; }
      } else {
        const a = (low - from[axis]) / delta; const b = (high - from[axis]) / delta;
        near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
        if (near >= far) break;
      }
    }
    if (near < far && far > 0 && near < 1) return false;
  }
  return true;
}

/** Small bounded shop grid; real fixture/crate rectangles determine the route. */
export function findCustomerRoute(from: FloorPoint, destination: FloorPoint, colliders: readonly LayoutCollider[]): FloorPoint[] | null {
  if (Math.hypot(from.x - destination.x, from.z - destination.z) < 0.025) return [];
  if (segmentClear(from, destination, colliders)) return [{ ...destination }];
  const columns = 25; const rows = 40; const total = columns * rows;
  const pointFor = (index: number): FloorPoint => ({ x: -3 + Math.floor(index / rows) * 0.25, z: -5.5 + (index % rows) * 0.25 });
  const allowed = Array.from({ length: total }, (_, index) => {
    const point = pointFor(index);
    return segmentClear(point, { x: point.x + 0.00001, z: point.z }, colliders);
  });
  const nearest = (point: FloorPoint): number => {
    let nearestIndex = -1; let distance = 0.5;
    for (let i = 0; i < total; i += 1) {
      if (!allowed[i]) continue;
      const candidate = pointFor(i);
      const separation = Math.hypot(point.x - candidate.x, point.z - candidate.z);
      if (separation < distance && segmentClear(point, candidate, colliders)) { distance = separation; nearestIndex = i; }
    }
    return nearestIndex;
  };
  const start = nearest(from); const end = nearest(destination);
  if (start < 0 || end < 0) return null;
  const parents = new Int32Array(total).fill(-2);
  const queue = new Int32Array(total);
  let read = 0; let write = 1; queue[0] = start; parents[start] = -1;
  while (read < write && parents[end] === -2) {
    const current = queue[read++]!;
    const column = Math.floor(current / rows); const row = current % rows;
    for (const [dc, dr] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const nextColumn = column + dc; const nextRow = row + dr;
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
      const next = nextColumn * rows + nextRow;
      if (!allowed[next] || parents[next] !== -2 || !segmentClear(pointFor(current), pointFor(next), colliders)) continue;
      parents[next] = current; queue[write++] = next;
    }
  }
  if (parents[end] === -2) return null;
  const route: FloorPoint[] = [{ ...destination }];
  for (let cursor = end; cursor >= 0; cursor = parents[cursor]!) route.push(pointFor(cursor));
  route.push({ ...from }); route.reverse();
  const compact: FloorPoint[] = [];
  let anchor = 0;
  while (anchor < route.length - 1) {
    let next = route.length - 1;
    while (next > anchor + 1 && !segmentClear(route[anchor]!, route[next]!, colliders)) next -= 1;
    compact.push(route[next]!); anchor = next;
  }
  return compact;
}
