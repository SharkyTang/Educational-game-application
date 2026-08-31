import { Scene, TransformNode } from "@babylonjs/core";
import { createProductAsset, type ProductAssetId } from "./product-library";
import type { FloorPoint, ProductDimensions } from "./productLayout";

/** Scene-owned, lazy prototypes share geometry and materials between real instances. */
export class ProductVisuals {
  private readonly templates = new Map<ProductAssetId, TransformNode>();
  constructor(private readonly scene: Scene) {}

  create(productId: ProductAssetId, name: string): TransformNode {
    let template = this.templates.get(productId);
    if (!template) {
      template = createProductAsset(this.scene, productId, `product-source-${productId}`);
      template.setEnabled(false);
      this.templates.set(productId, template);
    }
    const instance = template.clone(name, null, false);
    if (!instance) throw new Error(`Cannot create product instance: ${productId}`);
    instance.metadata = { ...template.metadata };
    instance.position.setAll(0); instance.rotation.setAll(0); instance.scaling.setAll(1);
    instance.setEnabled(true);
    return instance;
  }

  get loadedProductCount(): number { return this.templates.size; }
}

/** The catalogue factory records measured, bottom-centred metre bounds on every root. */
export function productDimensions(root: TransformNode): ProductDimensions {
  const dimensions = root.metadata?.dimensions as ProductDimensions | undefined;
  if (!dimensions || ![dimensions.width, dimensions.height, dimensions.depth].every((value) => Number.isFinite(value) && value > 0)) throw new Error(`Product ${root.name} has no valid measured dimensions`);
  return dimensions;
}

export interface CrateSupport extends FloorPoint { height: number }

/** Include raised pad edges and lettering, not merely the pavement underneath. */
export function measureCrateSupport(position: FloorPoint, pad: TransformNode): CrateSupport {
  const height = pad.getHierarchyBoundingVectors(true).max.y;
  if (!Number.isFinite(height)) throw new Error(`Receiving pad ${pad.name} has no measurable support surface`);
  return { x: position.x, z: position.z, height };
}

/** Crates are bottom-anchored; one millimetre prevents coincident support faces. */
export function crateRestingHeight(position: FloorPoint, supports: readonly CrateSupport[] = []): number {
  const support = supports.find((entry) => Math.abs(entry.x - position.x) < 0.001 && Math.abs(entry.z - position.z) < 0.001);
  return (support?.height ?? 0) + 0.001;
}
