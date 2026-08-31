import { Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { EQUIPMENT_ASSETS, EQUIPMENT_LIBRARY_VERSION, isEquipmentAssetId, type EquipmentAssetId, type EquipmentPoint, type EquipmentSlot } from "./catalog";
import { CHECKOUT_BUILDERS } from "./checkouts";
import { DISPLAY_BUILDERS } from "./displays";
import { REFRIGERATION_BUILDERS } from "./refrigeration";
import { mergeParts, type EquipmentBuilder } from "./geometry";

export * from "./catalog";
const builders = { ...CHECKOUT_BUILDERS, ...REFRIGERATION_BUILDERS, ...DISPLAY_BUILDERS } satisfies Record<EquipmentAssetId, EquipmentBuilder>;
export interface EquipmentMetadata {
  equipmentId: EquipmentAssetId;
  assetType: "equipment";
  libraryVersion: string;
  gameplay: "library-only";
  units: "metres";
  front: "-Z";
  baseAnchored: true;
  capacity: number;
  dimensions: { width: number; height: number; depth: number };
  footprint: { width: number; depth: number };
  placementSlots: EquipmentSlot[];
  servicePoints: { id: string; role: "customer" | "restock"; position: EquipmentPoint; facing: EquipmentPoint }[];
}

/** Instantiate empty equipment only. Dispose instances with root.dispose(false, false). */
export function createEquipmentAsset(scene: Scene, id: EquipmentAssetId, name = `equipment-${id}`): TransformNode {
  if (!isEquipmentAssetId(id)) throw new Error(`Unknown equipment asset: ${String(id)}`);
  if (scene.isDisposed) throw new Error("Cannot create equipment in a disposed scene");
  const root = new TransformNode(name, scene);
  try {
    builders[id](scene, root);
    mergeParts(root);
    const original = root.getHierarchyBoundingVectors(true);
    const offset = new Vector3((original.min.x + original.max.x) / 2, original.min.y, (original.min.z + original.max.z) / 2);
    for (const child of root.getChildren(undefined, true)) if (child instanceof TransformNode) child.position.subtractInPlace(offset);
    const bounds = root.getHierarchyBoundingVectors(true);
    const size = bounds.max.subtract(bounds.min);
    const definition = EQUIPMENT_ASSETS[id];
    const translate = (point: EquipmentPoint): EquipmentPoint => [point[0] - offset.x, point[1] - offset.y, point[2] - offset.z];
    root.metadata = {
      equipmentId: id, assetType: "equipment", libraryVersion: EQUIPMENT_LIBRARY_VERSION, gameplay: "library-only",
      units: "metres", front: "-Z", baseAnchored: true, capacity: definition.capacity,
      dimensions: { width: size.x, height: size.y, depth: size.z }, footprint: { width: size.x, depth: size.z },
      placementSlots: definition.placementSlots.map((slot) => ({ ...slot, position: translate(slot.position), maxSize: [...slot.maxSize] })),
      servicePoints: definition.servicePoints.map((point) => ({ ...point, position: translate(point.position), facing: [...point.facing] })),
    } satisfies EquipmentMetadata;
    return root;
  } catch (error) { root.dispose(false, false); throw error; }
}

function metadataFor(root: TransformNode): EquipmentMetadata {
  const metadata = root.metadata as EquipmentMetadata | null;
  if (root.isDisposed() || metadata?.assetType !== "equipment" || !isEquipmentAssetId(metadata.equipmentId)) throw new Error("Expected a live equipment asset root");
  return metadata;
}
/** Returns copies. A caller cannot corrupt another instance or the catalogue through these arrays. */
export function getEquipmentSlots(root: TransformNode): EquipmentSlot[] {
  return metadataFor(root).placementSlots.map((slot) => ({ ...slot, position: [...slot.position], maxSize: [...slot.maxSize] }));
}
export function equipmentSlotWorldPosition(root: TransformNode, slotId: string): Vector3 {
  const slot = metadataFor(root).placementSlots.find((entry) => entry.id === slotId);
  if (!slot) throw new Error(`Unknown equipment slot: ${slotId}`);
  return Vector3.TransformCoordinates(Vector3.FromArray(slot.position), root.computeWorldMatrix(true));
}
export function equipmentServiceWorldPosition(root: TransformNode, pointId: string): Vector3 {
  const point = metadataFor(root).servicePoints.find((entry) => entry.id === pointId);
  if (!point) throw new Error(`Unknown equipment service point: ${pointId}`);
  return Vector3.TransformCoordinates(Vector3.FromArray(point.position), root.computeWorldMatrix(true));
}
/** Fit in the slot's local orientation. This is a geometry check, not permission to stock a SKU. */
export function equipmentSlotFits(slot: EquipmentSlot, size: EquipmentPoint): boolean {
  return size.every((value, axis) => Number.isFinite(value) && value > 0 && value <= slot.maxSize[axis]! + 0.000001);
}
