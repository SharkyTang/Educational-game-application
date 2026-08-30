import { TransformNode } from "@babylonjs/core";

/** Measure in the model's own frame, never in the moving customer's world frame. */
export function placeCustomerVisual(visual: TransformNode, parent: TransformNode, targetHeight = 1.68): void {
  visual.parent = null;
  const bounds = visual.getHierarchyBoundingVectors(true);
  const height = bounds.max.y - bounds.min.y;
  if (!Number.isFinite(height) || height < .1) throw new Error("顾客模型没有有效几何体。");
  const scale = targetHeight / height;
  visual.scaling.setAll(scale);
  visual.position.set(
    -(bounds.max.x + bounds.min.x) * scale / 2,
    -bounds.min.y * scale,
    -(bounds.max.z + bounds.min.z) * scale / 2,
  );
  visual.parent = parent;
}
