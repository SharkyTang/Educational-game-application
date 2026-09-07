import { TransformNode, Vector3, type Scene } from "@babylonjs/core";
import {
  EQUIPMENT_ASSETS,
  createEquipmentAsset,
  equipmentServiceWorldPosition,
  equipmentSlotWorldPosition,
  getEquipmentSlots,
} from "./equipment-library";
import {
  equipmentPlacementBounds,
} from "./equipmentLayout";
import type { LayoutCollider, ProductDimensions } from "./productLayout";
import type {
  EquipmentAssetState,
  EquipmentFloorPlacement,
  ShopEquipmentInstance,
} from "./equipmentCommerce";

export interface EquipmentSceneSlot {
  position: Vector3;
  yaw: number;
  maxSize: ProductDimensions;
}

export interface EquipmentSceneServicePoint {
  id: string;
  role: "customer" | "restock";
  position: Vector3;
  facing: Vector3;
}

export interface EquipmentSceneTarget {
  id: string;
  kind: "shelf";
  equipmentId: string;
  productId: ShopEquipmentInstance["productId"];
  position: Vector3;
  root: TransformNode;
}

interface EquipmentSceneRecord {
  instance: ShopEquipmentInstance;
  root: TransformNode;
  slots: EquipmentSceneSlot[];
  services: EquipmentSceneServicePoint[];
  collider: LayoutCollider;
}

export interface EquipmentSceneFixtures {
  readonly targets: EquipmentSceneTarget[];
  readonly colliders: LayoutCollider[];
  apply(state: EquipmentAssetState, placements: readonly EquipmentFloorPlacement[]): void;
  slot(equipmentId: string, slot: number): EquipmentSceneSlot | null;
  servicePoint(equipmentId: string, slot: number): EquipmentSceneServicePoint | null;
  dispose(): void;
}

/**
 * Creates only equipment that is both owned and committed to the floor layout.
 * Inventory remains owned by the reducer; this adapter exposes the real authored
 * mesh slots and customer service points to the world renderer.
 */
export function createEquipmentSceneFixtures(
  scene: Scene,
  state: EquipmentAssetState,
  placements: readonly EquipmentFloorPlacement[],
): EquipmentSceneFixtures {
  const root = new TransformNode("purchased-shop-equipment", scene);
  const records = new Map<string, EquipmentSceneRecord>();
  const targets: EquipmentSceneTarget[] = [];
  const colliders: LayoutCollider[] = [];

  const clear = (): void => {
    for (const record of records.values()) record.root.dispose(false, false);
    records.clear();
    targets.splice(0, targets.length);
    colliders.splice(0, colliders.length);
  };

  const apply = (nextState: EquipmentAssetState, nextPlacements: readonly EquipmentFloorPlacement[]): void => {
    clear();
    const byId = new Map(nextState.instances.map((instance) => [instance.id, instance]));
    for (const placement of nextPlacements) {
      const instance = byId.get(placement.instanceId);
      if (!instance) continue;
      const equipmentRoot = createEquipmentAsset(scene, instance.assetId, `floor-${instance.id}-${instance.assetId}`);
      equipmentRoot.parent = root;
      equipmentRoot.position.set(placement.x, 0, placement.z);
      equipmentRoot.rotation.y = placement.rotation * Math.PI / 2;
      equipmentRoot.computeWorldMatrix(true);

      const authoredSlots = getEquipmentSlots(equipmentRoot);
      const worldMatrix = equipmentRoot.getWorldMatrix();
      const slots = authoredSlots.map((authored) => {
        const facing = Vector3.TransformNormal(new Vector3(Math.sin(authored.rotationY), 0, Math.cos(authored.rotationY)), worldMatrix).normalize();
        return {
          position: equipmentSlotWorldPosition(equipmentRoot, authored.id),
          yaw: Math.atan2(facing.x, facing.z),
          maxSize: { width: authored.maxSize[0], height: authored.maxSize[1], depth: authored.maxSize[2] },
        };
      });
      const services = EQUIPMENT_ASSETS[instance.assetId].servicePoints.map((service) => ({
        id: service.id,
        role: service.role,
        position: equipmentServiceWorldPosition(equipmentRoot, service.id),
        facing: Vector3.TransformNormal(Vector3.FromArray(service.facing), worldMatrix).normalize(),
      }));
      const collider = equipmentPlacementBounds(instance, placement);
      const record: EquipmentSceneRecord = { instance, root: equipmentRoot, slots, services, collider };
      records.set(instance.id, record);
      colliders.push(collider);
      targets.push({
        id: `${instance.id}-shelf`,
        kind: "shelf",
        equipmentId: instance.id,
        productId: instance.productId,
        position: services[0]?.position.clone() ?? new Vector3(placement.x, 0, placement.z),
        root: equipmentRoot,
      });
    }
  };

  const servicePoint = (equipmentId: string, slotIndex: number): EquipmentSceneServicePoint | null => {
    const record = records.get(equipmentId);
    const slot = record?.slots[slotIndex];
    if (!record || !slot || record.services.length === 0) return null;
    // Double-sided fixtures use the aisle on the same physical side as the
    // selected stock slot. Single-sided fixtures naturally have one candidate.
    return record.services.reduce((nearest, candidate) => {
      const distance = Vector3.DistanceSquared(candidate.position, slot.position);
      return distance < nearest.distance ? { service: candidate, distance } : nearest;
    }, { service: record.services[0]!, distance: Vector3.DistanceSquared(record.services[0]!.position, slot.position) }).service;
  };

  apply(state, placements);
  return {
    targets,
    colliders,
    apply,
    slot: (equipmentId, slotIndex) => records.get(equipmentId)?.slots[slotIndex] ?? null,
    servicePoint,
    dispose: () => { clear(); root.dispose(false, false); },
  };
}
