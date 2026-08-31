import { Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { createProduct } from "../assets";
import { PRODUCT_ASSETS, PRODUCT_LIBRARY_VERSION, isProductAssetId, type ProductAssetId } from "./catalog";
import { FRESH_PACKAGED_BUILDERS } from "./fresh-packaged";
import { PANTRY_HOUSEHOLD_BUILDERS } from "./pantry-household";
import { PRODUCE_BUILDERS } from "./produce";
import { mergeParts, type ProductBuilder } from "./geometry";

export * from "./catalog";

const builders = {
  ...FRESH_PACKAGED_BUILDERS, ...PANTRY_HOUSEHOLD_BUILDERS, ...PRODUCE_BUILDERS,
} satisfies Record<Exclude<ProductAssetId, "milk" | "bread">, ProductBuilder>;

/**
 * Independent reusable art factory. Distances are metres; front is -Z.
 * A root can be placed in a crate, hand, shelf or inspection scene unchanged.
 * Dispose roots with root.dispose(false, false): cached materials belong to Scene.
 * Nothing here registers SKUs with the S1 economy or reads/writes its save.
 */
export function createProductAsset(scene: Scene, productId: ProductAssetId, name = `product-${productId}`): TransformNode {
  if (!isProductAssetId(productId)) throw new Error(`Unknown product asset: ${String(productId)}`);
  if (scene.isDisposed) throw new Error("Cannot create a product in a disposed scene");
  const legacy = productId === "milk" || productId === "bread";
  const root = legacy ? createProduct(scene, productId, name) : new TransformNode(name, scene);
  try {
    if (!legacy) {
      builders[productId](scene, root);
      mergeParts(root);
    }
    // Normalize library instances only, including the two original models.
    // The game's existing createProduct factory and its placements stay unchanged.
    const originalBounds = root.getHierarchyBoundingVectors(true);
    const offset = new Vector3((originalBounds.min.x + originalBounds.max.x) / 2, originalBounds.min.y, (originalBounds.min.z + originalBounds.max.z) / 2);
    for (const child of root.getChildren(undefined, true)) {
      if (child instanceof TransformNode) child.position.subtractInPlace(offset);
    }
    const bounds = root.getHierarchyBoundingVectors(true);
    const dimensions = bounds.max.subtract(bounds.min);
    root.metadata = {
      ...root.metadata, productId, assetType: "product", baseAnchored: true,
      libraryVersion: PRODUCT_LIBRARY_VERSION, category: PRODUCT_ASSETS[productId].category,
      gameplay: PRODUCT_ASSETS[productId].gameplay, front: "-Z", units: "metres",
      dimensions: { width: dimensions.x, height: dimensions.y, depth: dimensions.z },
    };
    return root;
  } catch (error) {
    root.dispose(false, false);
    throw error;
  }
}
