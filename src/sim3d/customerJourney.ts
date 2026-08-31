import { pickCustomerEntry } from "./customerSelection";
import type { FloorPoint, LayoutCollider } from "./productLayout";
import { LAYOUT_WALK_RADIUS, layoutRoute, shopBounds } from "./shopLayout";

/** Arrive from the ends of the near pavement, not from the shop threshold. */
export const CUSTOMER_STREET_SPAWNS: readonly Readonly<FloorPoint>[] = [
  { x: -19, z: -6.1 }, { x: 19, z: -6.1 },
];
export const CUSTOMER_DOORSTEP: Readonly<FloorPoint> = { x: 0, z: -5.3 };
// Stay on the pavement, north of the delivery van's entire driving corridor.
export const CUSTOMER_STREET_BOUNDS: Readonly<LayoutCollider> = {
  minX: -20, maxX: 20, minZ: -8.12, maxZ: -4.65,
};

/** Stable for a saved visit; alternate sides, with the other end as a fallback. */
export function customerArrivalOrigins(state: { customerSeed?: number; customer: { number: number } }): readonly Readonly<FloorPoint>[] {
  const first = pickCustomerEntry([0, 1], state.customerSeed ?? 31, state.customer.number, "street-arrival");
  return [CUSTOMER_STREET_SPAWNS[first]!, CUSTOMER_STREET_SPAWNS[1 - first]!];
}

/**
 * Keep the broad street search separate from the narrow, rearrangeable shop.
 * Joining at the doorstep prevents diagonal shortcuts through the facade.
 * Replanning uses the current position, including a cancelled visit outside.
 */
export function customerJourneyRoute(
  from: FloorPoint, destination: FloorPoint, colliders: readonly LayoutCollider[], expansion: 0 | 1,
): FloorPoint[] | null {
  // Render vectors expose x/z through getters; route copies need plain points.
  from = { x: from.x, z: from.z };
  destination = { x: destination.x, z: destination.z };
  const indoor = { ...shopBounds(expansion), minZ: -6 };
  const inShopApproach = (point: FloorPoint): boolean => point.x >= indoor.minX + LAYOUT_WALK_RADIUS
    && point.x <= indoor.maxX - LAYOUT_WALK_RADIUS && point.z >= indoor.minZ + LAYOUT_WALK_RADIUS
    && point.z <= indoor.maxZ - LAYOUT_WALK_RADIUS;
  const fromInside = inShopApproach(from);
  const toInside = inShopApproach(destination);
  if (fromInside === toInside) return layoutRoute(from, destination, colliders, fromInside ? indoor : CUSTOMER_STREET_BOUNDS);

  const first = layoutRoute(from, CUSTOMER_DOORSTEP, colliders, fromInside ? indoor : CUSTOMER_STREET_BOUNDS);
  if (first === null) return null;
  const second = layoutRoute(CUSTOMER_DOORSTEP, destination, colliders, toInside ? indoor : CUSTOMER_STREET_BOUNDS);
  return second === null ? null : [...first, ...second];
}
