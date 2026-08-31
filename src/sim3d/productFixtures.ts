import { Color3, DynamicTexture, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { PRODUCT_ASSETS, type ProductAssetId } from "./product-library/catalog";
import { CATALOG_RACKS, PRODUCT_DISPLAYS, RACK_DEPTH, RACK_WIDTH, rackCollider, type LayoutCollider } from "./productLayout";

interface FixtureTarget { id: string; kind: "shelf"; productId: ProductAssetId; position: Vector3; mesh: Mesh }
export interface CatalogFixtures { root: TransformNode; targets: FixtureTarget[]; colliders: LayoutCollider[] }
const caches = new WeakMap<Scene, Map<string, PBRMaterial>>();

function cacheFor(scene: Scene): Map<string, PBRMaterial> {
  let result = caches.get(scene);
  if (!result) { result = new Map(); caches.set(scene, result); }
  return result;
}
function material(scene: Scene, key: "sage" | "wood" | "ivory" | "metal" | "dark"): PBRMaterial {
  const cache = cacheFor(scene); const existing = cache.get(key); if (existing) return existing;
  const mat = new PBRMaterial(`catalog-fixture-${key}`, scene);
  mat.albedoColor = Color3.FromHexString({ sage: "#536b58", wood: "#ba9a6d", ivory: "#e3e4d5", metal: "#9facab", dark: "#34443c" }[key]);
  mat.roughness = key === "metal" ? 0.40 : 0.83;
  mat.metallic = key === "metal" ? 0.52 : 0;
  cache.set(key, mat); return mat;
}
function box(scene: Scene, parent: TransformNode, name: string, width: number, height: number, depth: number, x: number, y: number, z: number, mat: PBRMaterial): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene);
  mesh.parent = parent; mesh.position.set(x, y, z); mesh.material = mat; mesh.receiveShadows = true; mesh.isPickable = true;
  return mesh;
}
function sign(scene: Scene, parent: TransformNode, name: string, width: number, height: number, x: number, y: number, z: number, heading: string, detail: string, light = false): Mesh {
  const cache = cacheFor(scene);
  let mat = cache.get(name);
  if (!mat) {
    const pixelHeight = Math.max(160, Math.round(768 * height / width));
    const texture = new DynamicTexture(`${name}-print`, { width: 768, height: pixelHeight }, scene, true);
    const ctx = texture.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = light ? "#eee6d2" : "#344b3f"; ctx.fillRect(0, 0, 768, pixelHeight);
    ctx.strokeStyle = light ? "#bdaf91" : "#8e9a79"; ctx.lineWidth = 3; ctx.strokeRect(9, 8, 750, pixelHeight - 16);
    ctx.fillStyle = light ? "#314b3c" : "#f2ebd9"; ctx.textAlign = "center";
    ctx.font = `600 ${pixelHeight * 0.32}px Arial, 'PingFang SC', sans-serif`;
    ctx.fillText(heading, 384, pixelHeight * 0.47, 720);
    ctx.font = `${pixelHeight * 0.22}px Arial, 'PingFang SC', sans-serif`;
    ctx.fillText(detail, 384, pixelHeight * 0.80, 716);
    texture.update(); texture.anisotropicFilteringLevel = 4;
    mat = new PBRMaterial(`${name}-material`, scene); mat.albedoTexture = texture; mat.roughness = 0.88; mat.metallic = 0;
    cache.set(name, mat);
  }
  const mesh = MeshBuilder.CreatePlane(name, { width, height }, scene);
  mesh.parent = parent; mesh.position.set(x, y, z); mesh.material = mat; mesh.isPickable = true;
  return mesh;
}

/** Empty, labelled compartments only. Stock is created exclusively from inventory. */
export function createCatalogFixtures(scene: Scene, prices: Partial<Record<ProductAssetId, { pricePence: number }>>): CatalogFixtures {
  const root = new TransformNode("catalog-shop-fixtures", scene);
  const targets: FixtureTarget[] = [];
  const colliders = CATALOG_RACKS.map(rackCollider);
  for (const rack of CATALOG_RACKS) {
    const rackRoot = new TransformNode(`catalog-rack-${rack.id}`, scene);
    rackRoot.parent = root; rackRoot.position.set(rack.position.x, 0, rack.position.z); rackRoot.rotation.y = rack.yaw;
    const body = material(scene, rack.kind === "chiller" ? "dark" : rack.kind === "household" ? "sage" : "wood");
    const surface = material(scene, rack.kind === "chiller" ? "metal" : "wood");
    const lining = material(scene, rack.kind === "chiller" ? "ivory" : "sage");
    box(scene, rackRoot, `${rack.id}-back`, RACK_WIDTH, 2.16, 0.042, 0, 1.08, 0.27, body);
    box(scene, rackRoot, `${rack.id}-plinth`, RACK_WIDTH, 0.23, RACK_DEPTH, 0, 0.115, 0, body);
    for (const x of [-RACK_WIDTH / 2 + 0.026, 0, RACK_WIDTH / 2 - 0.026]) box(scene, rackRoot, `${rack.id}-upright-${x}`, 0.042, 2.08, RACK_DEPTH, x, 1.12, 0, body);
    box(scene, rackRoot, `${rack.id}-header-board`, RACK_WIDTH, 0.27, RACK_DEPTH + 0.025, 0, 2.23, 0, body);
    sign(scene, rackRoot, `${rack.id}-header`, RACK_WIDTH - 0.10, 0.22, 0, 2.23, -RACK_DEPTH / 2 - 0.015, rack.title, rack.subtitle);
    rack.products.forEach((productId, cell) => {
      const definition = PRODUCT_ASSETS[productId]; const display = PRODUCT_DISPLAYS[productId];
      const cellX = cell % 2 ? 0.30 : -0.30; const baseY = cell < 2 ? 0.48 : 1.36;
      // A mesh root makes the back, rails, price and expansion note one interaction target.
      const cellRoot = new Mesh(`catalog-cell-${productId}`, scene);
      cellRoot.parent = rackRoot; cellRoot.position.set(cellX, baseY, 0); cellRoot.isPickable = true;
      box(scene, cellRoot, `${productId}-compartment-back`, 0.554, 0.79, 0.019, 0, 0.34, 0.243, lining);
      for (const [level, y] of [["base", 0], ["extra", 0.40]] as const) {
        box(scene, cellRoot, `${productId}-${level}-shelf`, 0.554, 0.022, 0.528, 0, y - 0.011, -0.005, surface);
        box(scene, cellRoot, `${productId}-${level}-rail`, 0.554, 0.060, 0.027, 0, y - 0.033, -0.277, body);
      }
      const price = prices[productId]?.pricePence;
      sign(scene, cellRoot, `${productId}-price`, 0.526, 0.138, 0, -0.073, -0.294, definition.nameEn, `${definition.nameZh}${price === undefined ? "" : ` · £${(price / 100).toFixed(2)}`}`, true);
      sign(scene, cellRoot, `${productId}-capacity-note`, 0.49, 0.19, 0, 0.53, -0.263, "EXTRA SPACE", "扩充后启用 · 4 → 8", true);
      const targetPosition = display.slots[0]!;
      targets.push({ id: `${productId}-shelf`, kind: "shelf", productId, position: new Vector3(targetPosition.x, baseY + 0.14, targetPosition.z), mesh: cellRoot });
    });
    if (rack.products.length === 3) sign(scene, rackRoot, `${rack.id}-quiet-panel`, 0.50, 0.23, 0.30, 1.75, 0.236, "A LITTLE LOCAL", "GOOD FOOD · GOOD COMPANY");
  }
  root.metadata = { productIds: targets.map((target) => target.productId), noDecorativeStock: true };
  return { root, targets, colliders };
}

/** Extra bays extend down the existing delivery pavement, keeping the entrance clear. */
export function createReceivingPads(scene: Scene, points: readonly { x: number; z: number }[]): { id: string; kind: "drop-zone"; position: Vector3; mesh: Mesh }[] {
  const root = new TransformNode("catalog-receiving-bays", scene);
  const mat = material(scene, "sage");
  return points.filter((point) => point.x > 4 && point.z < -4.7).map((point, index) => {
    const mesh = box(scene, root, `receiving-bay-${index}`, 0.87, 0.006, 0.59, point.x, 0.023, point.z, mat);
    return { id: `receiving-bay-${index}`, kind: "drop-zone", position: new Vector3(point.x, 0.026, point.z), mesh };
  });
}
