import {
  EQUIPMENT_ASSETS,
  type EquipmentPoint,
} from "./equipment-library/catalog";
import {
  EQUIPMENT_COMMERCE_CATALOG,
  validateEquipmentAssetState,
  type EquipmentAssetState,
  type EquipmentFloorPlacement,
  type ShopEquipmentInstance,
} from "./equipmentCommerce";
import type { LayoutCollider } from "./productLayout";
import {
  FIXED_LAYOUT_OBSTACLES,
  LAYOUT_WALK_RADIUS,
  RESERVED_LAYOUT_AREAS,
  SHOP_ENTRANCE,
  SHOP_ENTRANCE_POINT,
  layoutColliders,
  layoutRoute,
  shopBounds,
  shopWallColliders,
  validateShopLayoutReachability,
  validateShopLayoutStructure,
  type ShopLayout,
} from "./shopLayout";

const EPSILON = 1e-8;
const MAX_EQUIPMENT = 40;
const MAX_EXTRA_OBSTACLES = 160;
const PLACEMENT_KEYS = ["instanceId", "x", "z", "rotation"] as const;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** ShopLayout gains this field in the v2 domain integration; keeping the extension local avoids a runtime dependency cycle. */
export interface EquipmentShopLayout extends ShopLayout {
  equipment: EquipmentFloorPlacement[];
}

export interface EquipmentLayoutValidation {
  valid: boolean;
  reason?: string;
  instanceId?: string;
}

function rotatePoint(point: readonly [number, number, number], turns: number): { x: number; y: number; z: number } {
  const [x, y, z] = point;
  if (turns === 1) return { x: z, y, z: -x };
  if (turns === 2) return { x: -x, y, z: -z };
  if (turns === 3) return { x: -z, y, z: x };
  return { x, y, z };
}

export function transformEquipmentPoint(placement: EquipmentFloorPlacement, point: EquipmentPoint): { x: number; y: number; z: number } {
  const rotated = rotatePoint(point, placement.rotation);
  return { x: placement.x + rotated.x, y: rotated.y, z: placement.z + rotated.z };
}

export function equipmentPlacementBounds(instance: ShopEquipmentInstance, placement: EquipmentFloorPlacement): LayoutCollider {
  const [width, , depth] = EQUIPMENT_ASSETS[instance.assetId].size;
  const rotated = placement.rotation % 2 === 1;
  const halfWidth = (rotated ? depth : width) / 2;
  const halfDepth = (rotated ? width : depth) / 2;
  return {
    minX: placement.x - halfWidth,
    maxX: placement.x + halfWidth,
    minZ: placement.z - halfDepth,
    maxZ: placement.z + halfDepth,
  };
}

export function equipmentServicePositions(instance: ShopEquipmentInstance, placement: EquipmentFloorPlacement): { id: string; x: number; y: number; z: number }[] {
  return EQUIPMENT_ASSETS[instance.assetId].servicePoints.map((service) => ({ id: service.id, ...transformEquipmentPoint(placement, service.position) }));
}

export function equipmentSlotPosition(instance: ShopEquipmentInstance, placement: EquipmentFloorPlacement, slot: number): { x: number; y: number; z: number; yaw: number; maxSize: EquipmentPoint } | null {
  const authored = EQUIPMENT_ASSETS[instance.assetId].placementSlots[slot];
  if (!authored) return null;
  const point = transformEquipmentPoint(placement, authored.position);
  return { ...point, yaw: authored.rotationY + placement.rotation * Math.PI / 2, maxSize: authored.maxSize };
}

export function validateEquipmentPlacementsStructure(value: unknown): value is EquipmentFloorPlacement[] {
  if (!Array.isArray(value) || value.length > MAX_EQUIPMENT) return false;
  const seen = new Set<string>();
  for (const placement of value) {
    if (!record(placement)) return false;
    const keys = Object.keys(placement);
    const idMatch = typeof placement.instanceId === "string"
      ? /^shop-equipment-([1-9][0-9]*)$/.exec(placement.instanceId) : null;
    const sequence = idMatch ? Number(idMatch[1]) : Number.NaN;
    if (keys.length !== PLACEMENT_KEYS.length || keys.some((key) => !PLACEMENT_KEYS.includes(key as (typeof PLACEMENT_KEYS)[number]))
      || !Number.isSafeInteger(sequence)
      || typeof placement.instanceId !== "string" || seen.has(placement.instanceId) || !finite(placement.x) || !finite(placement.z)
      || !Number.isInteger(placement.rotation) || (placement.rotation as number) < 0 || (placement.rotation as number) > 3) return false;
    seen.add(placement.instanceId);
  }
  return true;
}

function overlaps(a: LayoutCollider, b: LayoutCollider): boolean {
  return a.maxX > b.minX + EPSILON && a.minX < b.maxX - EPSILON
    && a.maxZ > b.minZ + EPSILON && a.minZ < b.maxZ - EPSILON;
}

function insideBounds(box: LayoutCollider, bounds: LayoutCollider): boolean {
  return box.minX >= bounds.minX - EPSILON && box.maxX <= bounds.maxX + EPSILON
    && box.minZ >= bounds.minZ - EPSILON && box.maxZ <= bounds.maxZ + EPSILON;
}

function pointClear(point: { x: number; z: number }, boxes: readonly LayoutCollider[], radius: number): boolean {
  return boxes.every((box) => point.x <= box.minX - radius || point.x >= box.maxX + radius
    || point.z <= box.minZ - radius || point.z >= box.maxZ + radius);
}

export function equipmentLayoutColliders(layout: EquipmentShopLayout, state: EquipmentAssetState): LayoutCollider[] {
  const byId = new Map(state.instances.map((instance) => [instance.id, instance]));
  return layout.equipment.flatMap((placement) => {
    const instance = byId.get(placement.instanceId);
    return instance ? [equipmentPlacementBounds(instance, placement)] : [];
  });
}

/** Validates ownership, footprint, every service side and a real route from the door. */
export function validateEquipmentLayout(
  layout: EquipmentShopLayout,
  state: EquipmentAssetState,
  extraObstacles: readonly LayoutCollider[] = [],
): EquipmentLayoutValidation {
  if (!validateShopLayoutStructure(layout) || !validateEquipmentPlacementsStructure(layout.equipment)) {
    return { valid: false, reason: "设备布局格式无效。" };
  }
  if (!validateEquipmentAssetState(state)) return { valid: false, reason: "设备资产记录无效。" };
  if (!Array.isArray(extraObstacles) || extraObstacles.length > MAX_EXTRA_OBSTACLES
    || extraObstacles.some((box) => !record(box) || !finite(box.minX) || !finite(box.maxX)
      || !finite(box.minZ) || !finite(box.maxZ) || box.minX >= box.maxX || box.minZ >= box.maxZ)) {
    return { valid: false, reason: "货箱占位数据无效，暂时不能应用设备布局。" };
  }
  const byId = new Map(state.instances.map((instance) => [instance.id, instance]));
  if (layout.equipment.some((placement) => !byId.has(placement.instanceId))) {
    return { valid: false, reason: "布局中含有未购买的设备。" };
  }
  const bounds = shopBounds(layout.expansion);
  const base = layoutColliders(layout);
  const placed = layout.equipment.map((placement) => ({ placement, instance: byId.get(placement.instanceId)!, bounds: equipmentPlacementBounds(byId.get(placement.instanceId)!, placement) }));
  for (let index = 0; index < placed.length; index += 1) {
    const current = placed[index]!;
    const name = EQUIPMENT_COMMERCE_CATALOG[current.instance.assetId].nameZh;
    const fail = (reason: string): EquipmentLayoutValidation => ({ valid: false, instanceId: current.instance.id, reason });
    if (!insideBounds(current.bounds, bounds)) return fail(`${name}超出了店铺空间，请移回店内。`);
    if (overlaps(current.bounds, SHOP_ENTRANCE)) return fail(`${name}挡住了店门，请保留入口。`);
    if (FIXED_LAYOUT_OBSTACLES.some((box) => overlaps(current.bounds, box))) return fail(`${name}与固定盆栽重叠，请换一个位置。`);
    const reserved = RESERVED_LAYOUT_AREAS.find((area) => overlaps(current.bounds, area));
    if (reserved) return fail(`${name}占用了${reserved.name}，请保留卸货空间。`);
    if (base.some((box) => overlaps(current.bounds, box))) return fail(`${name}与现有家具重叠，请分开放置。`);
    if (extraObstacles.some((box) => overlaps(current.bounds, box))) return fail(`${name}与地上的货箱重叠，请先移开货箱。`);
    for (let other = index + 1; other < placed.length; other += 1) {
      if (overlaps(current.bounds, placed[other]!.bounds)) return fail(`${name}与另一台已购设备重叠，请分开放置。`);
    }
  }
  const equipmentBoxes = placed.map((entry) => entry.bounds);
  const obstacles = [...base, ...equipmentBoxes, ...shopWallColliders(layout.expansion), ...extraObstacles];
  const baseReachability = validateShopLayoutReachability(layout, obstacles);
  if (!baseReachability.valid) return { valid: false, reason: baseReachability.reason };
  for (const current of placed) {
    const name = EQUIPMENT_COMMERCE_CATALOG[current.instance.assetId].nameZh;
    for (const service of equipmentServicePositions(current.instance, current.placement)) {
      const servicePoint = { x: service.x, z: service.z };
      if (service.x < bounds.minX + LAYOUT_WALK_RADIUS || service.x > bounds.maxX - LAYOUT_WALK_RADIUS
        || service.z < bounds.minZ + LAYOUT_WALK_RADIUS || service.z > bounds.maxZ - LAYOUT_WALK_RADIUS
        || !pointClear(servicePoint, obstacles, LAYOUT_WALK_RADIUS)) {
        return { valid: false, instanceId: current.instance.id, reason: `${name}${service.id === "back" ? "背面" : "正面"}取货位置被挡住，请留出通道。` };
      }
      if (layoutRoute(SHOP_ENTRANCE_POINT, servicePoint, obstacles, bounds, LAYOUT_WALK_RADIUS) === null) {
        return { valid: false, instanceId: current.instance.id, reason: `${name}无法从店门到达，请调整设备和通道。` };
      }
    }
  }
  return { valid: true };
}

/** Suggests a valid grid position; callers still save the full layout through the reducer. */
export function suggestEquipmentPlacement(layout: EquipmentShopLayout, state: EquipmentAssetState, instanceId: string, extraObstacles: readonly LayoutCollider[] = []): EquipmentFloorPlacement | null {
  const instance = state.instances.find((candidate) => candidate.id === instanceId);
  if (!instance || layout.equipment.some((placement) => placement.instanceId === instanceId)) return null;
  const room = shopBounds(layout.expansion);
  const xs = [-2.6, -1.8, -0.9, 0, 0.9, 1.8, 2.6];
  const zs: number[] = [];
  for (let z = room.maxZ - .7; z >= room.minZ + .7; z -= .5) zs.push(Math.round(z * 10) / 10);
  for (const rotation of [0, 1, 2, 3] as const) for (const z of zs) for (const x of xs) {
    const placement: EquipmentFloorPlacement = { instanceId, x, z, rotation };
    const candidate: EquipmentShopLayout = { ...layout, equipment: [...layout.equipment, placement] };
    if (validateEquipmentLayout(candidate, state, extraObstacles).valid) return placement;
  }
  return null;
}
