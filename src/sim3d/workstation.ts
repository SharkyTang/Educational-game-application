import type { FloorPoint, LayoutCollider, LayoutPoint } from "./productLayout";

/** One free management computer, independent from the historical eleven shop fixtures. */
export const WORKSTATION_ID = "management-workstation";
export interface WorkstationPlacement extends FloorPoint { rotation: 0 | 1 | 2 | 3 }
export const WORKSTATION_WIDTH = 1.2;
export const WORKSTATION_DEPTH = 0.55;
export const DEFAULT_WORKSTATION_PLACEMENT: Readonly<WorkstationPlacement> = { x: -1.8, z: -4.15, rotation: 0 };
/** A single reserved physical position, not a general outdoor furniture area. */
export const FALLBACK_WORKSTATION_PLACEMENT: Readonly<WorkstationPlacement> = { x: -1.8, z: -5.25, rotation: 2 };

export function validateWorkstationPlacement(value: unknown): value is WorkstationPlacement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 3 && ["x", "z", "rotation"].every((key) => Object.hasOwn(input, key))
    && typeof input.x === "number" && Number.isFinite(input.x)
    && typeof input.z === "number" && Number.isFinite(input.z)
    && typeof input.rotation === "number" && Number.isInteger(input.rotation) && input.rotation >= 0 && input.rotation <= 3;
}

export function workstationEquals(a: WorkstationPlacement | undefined, b: WorkstationPlacement | undefined): boolean {
  return a === b || (!!a && !!b && a.x === b.x && a.z === b.z && a.rotation === b.rotation);
}

export function isFallbackWorkstation(placement: WorkstationPlacement): boolean {
  return workstationEquals(placement, FALLBACK_WORKSTATION_PLACEMENT);
}

export function workstationBounds(placement: WorkstationPlacement): LayoutCollider {
  const rotated = placement.rotation % 2 === 1;
  const halfX = (rotated ? WORKSTATION_DEPTH : WORKSTATION_WIDTH) / 2;
  const halfZ = (rotated ? WORKSTATION_WIDTH : WORKSTATION_DEPTH) / 2;
  return { minX: placement.x - halfX, maxX: placement.x + halfX, minZ: placement.z - halfZ, maxZ: placement.z + halfZ };
}

/** Babylon's positive Y quarter-turn maps +z toward +x. */
export function transformWorkstationPoint<T extends FloorPoint>(placement: WorkstationPlacement, point: T): T {
  const { x, z } = point;
  const offset = placement.rotation === 1 ? { x: z, z: -x }
    : placement.rotation === 2 ? { x: -x, z: -z }
      : placement.rotation === 3 ? { x: -z, z: x } : { x, z };
  return { ...point, x: placement.x + offset.x, z: placement.z + offset.z };
}

export function workstationServicePoint(placement: WorkstationPlacement): FloorPoint {
  return transformWorkstationPoint(placement, { x: 0, z: 0.85 });
}

export function workstationInteractionPoint(placement: WorkstationPlacement): LayoutPoint {
  return transformWorkstationPoint(placement, { x: 0, y: 1.15, z: -0.09 });
}
