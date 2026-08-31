import {
  AbstractMesh,
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Scene,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { PRODUCT_ASSET_IDS, PRODUCT_ASSETS, type ProductAssetId } from "./product-library/catalog";
import { crateDimensions } from "./productLayout";
import { furnitureBounds, transformLayoutPoint, type FurnitureId, type ShopLayout } from "./shopLayout";

/** All distances are metres. Products and crates are anchored at their bottom. */
type ProductId = "milk" | "bread";
export interface ShopCollider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export interface ShopTarget {
  id: string;
  kind: "shelf" | "counter" | "open-sign" | "drop-zone";
  productId?: ProductAssetId;
  position: Vector3;
  mesh: AbstractMesh;
}
export interface ShopEnvironment {
  root: TransformNode;
  colliders: ShopCollider[];
  targets: ShopTarget[];
  applyLayout(layout: ShopLayout): void;
}

type MaterialName =
  | "plaster" | "ceiling" | "sage" | "sageDark" | "sageLight" | "oak"
  | "oakEdge" | "black" | "rubber" | "metal" | "brass" | "milkPaper"
  | "milkBlue" | "milkSeam" | "crust" | "score" | "scoreShade" | "plastic"
  | "plasticEdge" | "kraft" | "kraftEdge" | "tape" | "floorMat" | "leaf"
  | "leafLight" | "stem" | "terracotta" | "soil" | "glass" | "bulb"
  | "skin" | "skinShadow" | "nails" | "sleeve" | "cuff";

const materialCache = new WeakMap<Scene, Map<string, PBRMaterial>>();
const displayStateCache = new WeakMap<Scene, Map<string, string>>();

function material(scene: Scene, key: MaterialName): PBRMaterial {
  let cache = materialCache.get(scene);
  if (!cache) {
    cache = new Map();
    materialCache.set(scene, cache);
  }
  const existing = cache.get(key);
  if (existing) return existing;
  const colors: Record<MaterialName, [string, number, number]> = {
    plaster: ["#d8d0ba", 0.92, 0], ceiling: ["#e7e0ce", 0.93, 0],
    sage: ["#536254", 0.76, 0], sageDark: ["#34433a", 0.72, 0],
    sageLight: ["#7b8872", 0.72, 0], oak: ["#b79a70", 0.67, 0],
    oakEdge: ["#a78657", 0.64, 0], black: ["#202724", 0.48, 0.15],
    rubber: ["#161c1b", 0.90, 0], metal: ["#aab2af", 0.34, 0.73],
    brass: ["#a88743", 0.31, 0.77], milkPaper: ["#f4f1e8", 0.64, 0],
    milkBlue: ["#19488a", 0.38, 0], milkSeam: ["#d8d6cd", 0.72, 0],
    crust: ["#c89249", 0.89, 0], score: ["#ead8ae", 0.94, 0],
    scoreShade: ["#8f5426", 0.96, 0], plastic: ["#eff5f1", 0.12, 0],
    plasticEdge: ["#ffffff", 0.20, 0], kraft: ["#ad8854", 0.96, 0],
    kraftEdge: ["#735636", 0.98, 0], tape: ["#bda77d", 0.58, 0],
    floorMat: ["#6b7160", 0.98, 0], leaf: ["#2e5331", 0.76, 0],
    leafLight: ["#567542", 0.77, 0], stem: ["#6a5739", 0.91, 0],
    terracotta: ["#9d7355", 0.91, 0], soil: ["#43382b", 1, 0],
    glass: ["#c5d9da", 0.08, 0], bulb: ["#fff1cc", 0.26, 0],
    skin: ["#c99d7e", 0.72, 0], skinShadow: ["#a8795f", 0.79, 0],
    nails: ["#d2b1a0", 0.48, 0], sleeve: ["#233246", 0.98, 0],
    cuff: ["#1a293a", 1, 0],
  };
  const [color, roughness, metallic] = colors[key];
  const result = new PBRMaterial(`shop-${key}`, scene);
  result.albedoColor = Color3.FromHexString(color);
  result.roughness = roughness;
  result.metallic = metallic;
  if (key === "oak" || key === "crust") {
    const texture = new Texture(`/assets/sim3d/${key === "oak" ? "oak-floor" : "bread-crust"}.png`, scene);
    texture.anisotropicFilteringLevel = 4;
    result.albedoTexture = texture;
    result.albedoColor = key === "oak" ? new Color3(0.91, 0.86, 0.76) : Color3.White();
  }
  if (key === "plastic" || key === "plasticEdge" || key === "glass") {
    result.alpha = key === "plastic" ? 0.105 : key === "glass" ? 0.12 : 0.28;
    result.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    result.backFaceCulling = false;
    result.forceDepthWrite = false;
    result.clearCoat.isEnabled = true;
    result.clearCoat.intensity = 0.65;
    result.clearCoat.roughness = 0.1;
  }
  if (key === "bulb") result.emissiveColor = new Color3(0.65, 0.52, 0.27);
  cache.set(key, result);
  return result;
}

function finish<T extends Mesh>(mesh: T, parent: TransformNode, mat: PBRMaterial, position: Vector3): T {
  mesh.parent = parent;
  mesh.position.copyFrom(position);
  mesh.material = mat;
  mesh.isPickable = true;
  mesh.receiveShadows = true;
  return mesh;
}

function box(scene: Scene, parent: TransformNode, name: string, size: Vector3, position: Vector3, mat: MaterialName): Mesh {
  const mesh = finish(MeshBuilder.CreateBox(name, { width: size.x, height: size.y, depth: size.z }, scene), parent, material(scene, mat), position);
  if (["sage", "sageLight", "oak", "oakEdge", "kraft", "plaster"].includes(mat)) {
    // Small piece-to-piece variation prevents every painted board/cardboard face
    // having identical plastic-flat colour. Lighting still supplies the shading.
    const seed = Array.from(name).reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);
    const pieceTone = 0.94 + (seed % 7) * 0.01;
    const colors: number[] = [];
    const faceTone = [1, 0.98, 0.99, 0.985, 1, 0.98];
    for (let vertex = 0; vertex < mesh.getTotalVertices(); vertex += 1) {
      const tone = pieceTone * faceTone[Math.floor(vertex / 4)]!;
      colors.push(tone, tone, tone, 1);
    }
    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  }
  return mesh;
}

function cylinder(scene: Scene, parent: TransformNode, name: string, bottom: number, top: number, height: number, position: Vector3, mat: MaterialName, sides = 24): Mesh {
  return finish(MeshBuilder.CreateCylinder(name, { diameterBottom: bottom, diameterTop: top, height, tessellation: sides }, scene), parent, material(scene, mat), position);
}

function sphere(scene: Scene, parent: TransformNode, name: string, size: Vector3, position: Vector3, mat: MaterialName, segments = 16): Mesh {
  const mesh = finish(MeshBuilder.CreateSphere(name, { diameter: 1, segments }, scene), parent, material(scene, mat), position);
  mesh.scaling.copyFrom(size);
  return mesh;
}

function segment(scene: Scene, parent: TransformNode, name: string, from: Vector3, to: Vector3, radius: number, mat: MaterialName, radiusEnd = radius): Mesh {
  const direction = to.subtract(from);
  const length = direction.length();
  const mesh = cylinder(scene, parent, name, radius * 2, radiusEnd * 2, length, from.add(to).scale(0.5), mat, 12);
  direction.normalize();
  const axis = Vector3.Cross(Vector3.Up(), direction);
  const dot = Math.min(1, Math.max(-1, Vector3.Dot(Vector3.Up(), direction)));
  mesh.rotationQuaternion = axis.lengthSquared() < 0.000001
    ? Quaternion.RotationAxis(Vector3.Right(), dot < 0 ? Math.PI : 0)
    : Quaternion.RotationAxis(axis.normalize(), Math.acos(dot));
  return mesh;
}

function line(scene: Scene, parent: TransformNode, name: string, path: Vector3[], radius: number, mat: MaterialName): Mesh {
  return finish(MeshBuilder.CreateTube(name, { path, radius, tessellation: 6, cap: Mesh.CAP_ALL }, scene), parent, material(scene, mat), Vector3.Zero());
}

function printedMaterial(scene: Scene, key: string, width: number, height: number, draw: (context: CanvasRenderingContext2D) => void): PBRMaterial {
  let cache = materialCache.get(scene);
  if (!cache) {
    cache = new Map();
    materialCache.set(scene, cache);
  }
  const existing = cache.get(key);
  if (existing) return existing;
  const texture = new DynamicTexture(`print-${key}`, { width, height }, scene, true);
  draw(texture.getContext() as CanvasRenderingContext2D);
  texture.update();
  texture.anisotropicFilteringLevel = 4;
  const result = new PBRMaterial(`printed-${key}`, scene);
  result.albedoTexture = texture;
  result.metallic = 0;
  result.roughness = 0.79;
  result.backFaceCulling = false;
  cache.set(key, result);
  return result;
}

function sign(scene: Scene, parent: TransformNode, name: string, width: number, height: number, position: Vector3, heading: string, detail = "", light = false): Mesh {
  const pixelsHigh = Math.max(128, Math.round(1024 * height / width));
  const mat = printedMaterial(scene, `sign-${heading}-${detail}-${light}-${pixelsHigh}`, 1024, pixelsHigh, (ctx) => {
    ctx.fillStyle = light ? "#e9e3d2" : "#283b32";
    ctx.fillRect(0, 0, 1024, pixelsHigh);
    ctx.strokeStyle = light ? "#c1b59c" : "#768574";
    ctx.lineWidth = 4;
    const inset = Math.min(20, pixelsHigh * 0.06);
    ctx.strokeRect(20, inset, 984, pixelsHigh - inset * 2);
    ctx.textAlign = "center";
    ctx.fillStyle = light ? "#263c32" : "#f4eddc";
    const headingSize = Math.min(pixelsHigh * (detail ? 0.29 : 0.39), 930 / (heading.length * 0.66));
    ctx.font = `600 ${headingSize}px Georgia, serif`;
    ctx.fillText(heading, 512, pixelsHigh * (detail ? 0.49 : 0.60), 926);
    if (detail) {
      const detailSize = Math.min(pixelsHigh * 0.115, 920 / (detail.length * 0.57));
      ctx.font = `${detailSize}px Arial, sans-serif`;
      ctx.fillText(detail, 512, pixelsHigh * 0.735, 920);
    }
  });
  return finish(MeshBuilder.CreatePlane(name, { width, height }, scene), parent, mat, position);
}

function updateDisplay(scene: Scene, name: string, signature: string, draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void): void {
  const mesh = scene.getMeshByName(name);
  if (!mesh || !(mesh.material instanceof PBRMaterial) || !(mesh.material.albedoTexture instanceof DynamicTexture)) return;
  let cache = displayStateCache.get(scene);
  if (!cache) {
    cache = new Map();
    displayStateCache.set(scene, cache);
  }
  if (cache.get(name) === signature) return;
  const texture = mesh.material.albedoTexture;
  const { width, height } = texture.getSize();
  draw(texture.getContext() as CanvasRenderingContext2D, width, height);
  texture.update();
  mesh.metadata = { ...mesh.metadata, displayState: signature };
  cache.set(name, signature);
}

/** The physical shop sign changes along with the logical opening state. */
export function setShopSignState(scene: Scene, open: boolean): void {
  updateDisplay(scene, "open-sign", open ? "open" : "closed", (ctx, width, height) => {
    ctx.fillStyle = open ? "#294e3d" : "#e9e3d2";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = open ? "#83967c" : "#c1b59c";
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, width - 40, height - 40);
    ctx.textAlign = "center";
    ctx.fillStyle = open ? "#fff7e3" : "#263c32";
    ctx.font = `600 ${height * 0.36}px Georgia, serif`;
    ctx.fillText(open ? "OPEN" : "CLOSED", width / 2, height * 0.52, width - 80);
    ctx.font = `${height * 0.105}px Arial, sans-serif`;
    ctx.fillText(open ? "Come on in. Make yourself at home." : "Ready when you are", width / 2, height * 0.76, width - 90);
  });
}

export interface CheckoutDisplayState {
  scanned: number;
  totalPence: number;
  paid: boolean;
  itemCount?: number;
}

/** Changes the actual till/reader screens, without allocating a texture each frame. */
export function setCheckoutDisplay(scene: Scene, state: CheckoutDisplayState): void {
  const scanned = Number.isFinite(state.scanned) ? Math.max(0, Math.trunc(state.scanned)) : 0;
  const totalPence = Number.isFinite(state.totalPence) ? Math.max(0, Math.trunc(state.totalPence)) : 0;
  const itemCount = Math.max(0, Math.trunc(state.itemCount ?? 2));
  const signature = `${scanned}:${totalPence}:${state.paid}${state.itemCount === undefined ? "" : `:${itemCount}`}`;
  const amount = `£${(totalPence / 100).toFixed(2)}`;
  updateDisplay(scene, "pos-screen", signature, (ctx, width, height) => {
    ctx.fillStyle = "#193b31";
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = "center";
    ctx.fillStyle = "#d0dbc5";
    ctx.font = `${height * 0.084}px Arial, sans-serif`;
    ctx.fillText("CORNER SHOP", width / 2, height * 0.18);
    ctx.fillStyle = "#fbf4e2";
    ctx.font = `600 ${height * 0.28}px Arial, sans-serif`;
    ctx.fillText(amount, width / 2, height * 0.58, width - 80);
    ctx.font = `${height * 0.102}px Arial, sans-serif`;
    ctx.fillText(state.paid ? "PAYMENT RECEIVED" : scanned ? `${scanned} / ${itemCount} items scanned` : "READY TO SCAN", width / 2, height * 0.82, width - 90);
  });
  updateDisplay(scene, "reader-screen", signature, (ctx, width, height) => {
    ctx.fillStyle = state.paid ? "#d5e3c6" : "#dae5df";
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = "center";
    ctx.fillStyle = "#244f3c";
    ctx.font = `600 ${height * 0.24}px Arial, sans-serif`;
    ctx.fillText(state.paid ? "PAID" : itemCount > 0 && scanned >= itemCount ? amount : "CARD", width / 2, height * 0.49, width - 60);
    ctx.font = `${height * 0.10}px Arial, sans-serif`;
    ctx.fillText(state.paid ? "Thank you!" : itemCount > 0 && scanned >= itemCount ? "Tap to pay" : "Scan your items", width / 2, height * 0.76, width - 60);
  });
}

/** The extra shelf exists physically; its reserved-space cards leave when purchased. */
export function setShelfCapacity(scene: Scene, upgraded: boolean): void {
  for (const productId of PRODUCT_ASSET_IDS) {
    const mesh = scene.getMeshByName(`${productId}-capacity-note`);
    if (!mesh) continue;
    mesh.setEnabled(!upgraded);
    mesh.metadata = { ...mesh.metadata, capacityLocked: !upgraded };
  }
}

function mergeProductParts(root: TransformNode): void {
  const groups = new Map<PBRMaterial, Mesh[]>();
  for (const child of root.getChildMeshes()) {
    if (!(child instanceof Mesh) || !(child.material instanceof PBRMaterial)) continue;
    child.computeWorldMatrix(true);
    const group = groups.get(child.material) ?? [];
    group.push(child);
    groups.set(child.material, group);
  }
  for (const [mat, meshes] of groups) {
    if (meshes.length < 2) continue;
    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, false);
    if (!merged) continue;
    merged.name = `${root.name}-${mat.name}`;
    merged.parent = root;
    merged.material = mat;
    merged.isPickable = true;
    merged.receiveShadows = true;
  }
}

function milk(scene: Scene, root: TransformNode): void {
  // The paper carton really has a folded pitched roof, not a painted box.
  box(scene, root, `${root.name}-carton`, new Vector3(0.086, 0.182, 0.086), new Vector3(0, 0.091, 0), "milkPaper");
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const face = (...points: Vector3[]): void => {
    const start = positions.length / 3;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      positions.push(point.x, point.y, point.z);
      uvs.push(index === 1 || index === 2 ? 1 : 0, index >= 2 ? 1 : 0);
    }
    // Babylon's default left-handed front-face winding is clockwise.
    for (let index = 1; index < points.length - 1; index += 1) indices.push(start, start + index + 1, start + index);
  };
  const a = new Vector3(-0.043, 0.182, -0.043);
  const b = new Vector3(0.043, 0.182, -0.043);
  const c = new Vector3(0.043, 0.231, 0);
  const d = new Vector3(-0.043, 0.231, 0);
  const e = new Vector3(-0.043, 0.182, 0.043);
  const f = new Vector3(0.043, 0.182, 0.043);
  face(a, d, c, b);
  face(e, f, c, d);
  face(a, e, d);
  face(b, c, f);
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = uvs;
  const roof = new Mesh(`${root.name}-folded-roof`, scene);
  data.applyToMesh(roof);
  finish(roof, root, material(scene, "milkPaper"), Vector3.Zero());
  box(scene, root, `${root.name}-sealed-ridge`, new Vector3(0.086, 0.012, 0.005), new Vector3(0, 0.235, 0), "milkPaper");
  box(scene, root, `${root.name}-seal-line`, new Vector3(0.084, 0.0008, 0.0054), new Vector3(0, 0.237, 0), "milkSeam");
  box(scene, root, `${root.name}-side-seam`, new Vector3(0.0011, 0.172, 0.003), new Vector3(0.0431, 0.089, 0.033), "milkSeam");
  const cap = new TransformNode(`${root.name}-cap`, scene);
  cap.parent = root;
  cap.position.set(0, 0.206, -0.022);
  cap.rotation.x = -0.72;
  cylinder(scene, cap, `${root.name}-cap-base`, 0.027, 0.027, 0.004, new Vector3(0, 0.002, 0), "milkSeam", 32);
  cylinder(scene, cap, `${root.name}-blue-screw-cap`, 0.023, 0.023, 0.010, new Vector3(0, 0.008, 0), "milkBlue", 32);
  for (let index = 0; index < 28; index += 1) {
    const angle = index / 28 * Math.PI * 2;
    const ridge = box(scene, cap, `${root.name}-cap-grip-${index}`, new Vector3(0.0007, 0.0072, 0.001), new Vector3(Math.sin(angle) * 0.0115, 0.008, Math.cos(angle) * 0.0115), "milkBlue");
    ridge.rotation.y = angle;
  }
  const frontPrint = printedMaterial(scene, "milk-front", 512, 1024, (ctx) => {
    ctx.fillStyle = "#f4f1e8";
    ctx.fillRect(0, 0, 512, 1024);
    ctx.fillStyle = "#164884";
    ctx.fillRect(0, 789, 512, 235);
    ctx.textAlign = "center";
    ctx.font = "600 31px Georgia, serif";
    ctx.fillText("CORNER SHOP", 256, 130);
    ctx.fillRect(127, 175, 258, 3);
    ctx.font = "bold 87px Arial, sans-serif";
    ctx.fillText("WHOLE", 256, 381);
    ctx.fillText("MILK", 256, 483);
    ctx.font = "25px Arial, sans-serif";
    ctx.fillText("FRESH • BRITISH", 256, 574);
    ctx.font = "bold 51px Arial, sans-serif";
    ctx.fillText("1 L", 256, 744);
    ctx.fillStyle = "#f4f1e8";
    ctx.font = "22px Arial, sans-serif";
    ctx.fillText("KEEP REFRIGERATED", 256, 929);
  });
  finish(MeshBuilder.CreatePlane(`${root.name}-front-label`, { width: 0.085, height: 0.18 }, scene), root, frontPrint, new Vector3(0, 0.091, -0.04325));
  const rearPrint = printedMaterial(scene, "milk-nutrition", 512, 1024, (ctx) => {
    ctx.fillStyle = "#efede4";
    ctx.fillRect(0, 0, 512, 1024);
    ctx.fillStyle = "#30454a";
    ctx.textAlign = "left";
    ctx.font = "bold 34px Arial, sans-serif";
    ctx.fillText("WHOLE MILK", 42, 115);
    ctx.font = "24px Arial, sans-serif";
    const rows = ["Pasteurised whole milk", "Keep refrigerated", "Once opened, use within 3 days.", "", "Typical values       per 100 ml", "Energy                      64 kcal", "Fat                              3.6 g", "Carbohydrate                4.7 g", "Protein                         3.4 g"];
    rows.forEach((text, i) => ctx.fillText(text, 42, 180 + i * 57, 432));
    for (let index = 0; index < 57; index += 1) {
      if (index % 4 !== 0) ctx.fillRect(56 + index * 6, 792, index % 3 === 0 ? 4 : 2, 112);
    }
    ctx.font = "23px Arial, sans-serif";
    ctx.fillText("1 L  •  Training product", 50, 960);
  });
  const side = finish(MeshBuilder.CreatePlane(`${root.name}-side-label`, { width: 0.079, height: 0.172 }, scene), root, rearPrint, new Vector3(0.0434, 0.089, 0));
  side.rotation.y = -Math.PI / 2;
  box(scene, root, `${root.name}-lower-blue-back`, new Vector3(0.0864, 0.039, 0.0864), new Vector3(0, 0.0196, 0), "milkBlue");
}

function loafGeometry(scene: Scene, name: string, scale = 1): Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const slices = 24;
  const sides = 32;
  for (let slice = 0; slice <= slices; slice += 1) {
    const t = slice / slices * 2 - 1;
    const taper = Math.pow(Math.max(0.001, 1 - Math.pow(t, 6)), 0.36);
    for (let side = 0; side <= sides; side += 1) {
      const angle = side / sides * Math.PI * 2;
      const bakedVariation = 1 + 0.025 * Math.sin(slice * 1.31 + side * 1.9);
      const x = t * 0.147 * scale;
      const y = Math.max(0.010, 0.071 + Math.cos(angle) * 0.067 * taper * bakedVariation) * scale;
      const z = Math.sin(angle) * 0.071 * taper * bakedVariation * scale;
      positions.push(x, y, z);
      uvs.push(slice / slices, side / sides);
      if (slice < slices && side < sides) {
        const a = slice * (sides + 1) + side;
        const b = a + sides + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh);
  return mesh;
}

function bread(scene: Scene, root: TransformNode): void {
  finish(loafGeometry(scene, `${root.name}-baked-loaf`), root, material(scene, "crust"), Vector3.Zero());
  for (let cut = 0; cut < 4; cut += 1) {
    const path: Vector3[] = [];
    for (let point = 0; point <= 10; point += 1) {
      const z = -0.052 + point * 0.0104;
      const x = -0.088 + cut * 0.056 + z * 0.38;
      const taper = Math.pow(Math.max(0.001, 1 - Math.pow(x / 0.147, 6)), 0.36);
      const y = 0.071 + 0.067 * Math.sqrt(1 - (z / 0.071) ** 2) * taper;
      path.push(new Vector3(x, y + 0.001, z));
    }
    line(scene, root, `${root.name}-crust-cut-${cut}`, path, 0.0041, "scoreShade");
    line(scene, root, `${root.name}-flour-cut-${cut}`, path.map((point) => point.add(new Vector3(0, 0.0017, 0))), 0.0024, "score");
  }
  const bag = finish(loafGeometry(scene, `${root.name}-clear-bread-bag`, 1.035), root, material(scene, "plastic"), new Vector3(0, -0.002, 0));
  bag.alphaIndex = 1;
  // Fine folded edges make the clear bag legible without making it opaque.
  for (let crease = 0; crease < 7; crease += 1) {
    const x = -0.12 + crease * 0.04;
    const taper = Math.pow(Math.max(0.001, 1 - Math.pow(x / 0.154, 6)), 0.36);
    const path: Vector3[] = [];
    for (let index = 0; index < 9; index += 1) {
      const angle = -1.25 + index * 0.30;
      path.push(new Vector3(x + Math.sin(index * 1.4 + crease) * 0.004, 0.073 + Math.cos(angle) * 0.070 * taper, Math.sin(angle) * 0.074 * taper));
    }
    line(scene, root, `${root.name}-bag-crease-${crease}`, path, 0.00055, "plasticEdge");
  }
  const gathered = cylinder(scene, root, `${root.name}-gathered-bag`, 0.045, 0.012, 0.047, new Vector3(0.147, 0.092, 0), "plastic", 10);
  gathered.rotation.z = -Math.PI / 2;
  const closure = cylinder(scene, root, `${root.name}-bag-tie`, 0.015, 0.015, 0.003, new Vector3(0.171, 0.093, 0), "kraftEdge", 14);
  closure.rotation.z = Math.PI / 2;
  const mouth = cylinder(scene, root, `${root.name}-bag-mouth`, 0.012, 0.045, 0.025, new Vector3(0.184, 0.094, 0), "plastic", 9);
  mouth.rotation.z = -Math.PI / 2;
  const label = printedMaterial(scene, "bread-front", 768, 384, (ctx) => {
    ctx.fillStyle = "#dfcba4";
    ctx.fillRect(0, 0, 768, 384);
    ctx.strokeStyle = "#8c754d";
    ctx.lineWidth = 3;
    ctx.strokeRect(15, 15, 738, 354);
    ctx.textAlign = "center";
    ctx.fillStyle = "#34463a";
    ctx.font = "28px Arial, sans-serif";
    ctx.fillText("FRESHLY BAKED", 384, 95);
    ctx.font = "bold 101px Georgia, serif";
    ctx.fillText("BREAD", 384, 225);
    ctx.font = "25px Arial, sans-serif";
    ctx.fillText("WHITE LOAF  ·  400 g", 384, 309);
  });
  const front = finish(MeshBuilder.CreatePlane(`${root.name}-bread-paper-label`, { width: 0.109, height: 0.052 }, scene), root, label, new Vector3(-0.009, 0.082, -0.082));
  front.rotation.x = -0.12;
}

export function createProduct(scene: Scene, productId: ProductId, name: string): TransformNode {
  const root = new TransformNode(name, scene);
  root.metadata = { productId, assetType: "product", baseAnchored: true };
  if (productId === "milk") milk(scene, root);
  else bread(scene, root);
  mergeProductParts(root);
  return root;
}

export function createCrate(scene: Scene, productId: ProductAssetId, name: string): TransformNode {
  const root = new TransformNode(name, scene);
  const { width, depth, height } = crateDimensions(productId);
  root.metadata = { productId, assetType: "crate", baseAnchored: true, width, depth, height };
  box(scene, root, `${name}-bottom`, new Vector3(width, 0.007, depth), new Vector3(0, 0.004, 0), "kraft");
  for (const side of [-1, 1]) {
    box(scene, root, `${name}-long-wall-${side}`, new Vector3(width, height, 0.006), new Vector3(0, height / 2, side * depth / 2), "kraft");
    box(scene, root, `${name}-short-wall-${side}`, new Vector3(0.006, height, depth), new Vector3(side * width / 2, height / 2, 0), "kraft");
    box(scene, root, `${name}-cut-long-edge-${side}`, new Vector3(width, 0.0024, 0.0065), new Vector3(0, height + 0.001, side * depth / 2), "kraftEdge");
    box(scene, root, `${name}-cut-short-edge-${side}`, new Vector3(0.0065, 0.0024, depth), new Vector3(side * width / 2, height + 0.001, 0), "kraftEdge");
    const flap = box(scene, root, `${name}-open-flap-${side}`, new Vector3(width * 0.98, 0.004, 0.092), new Vector3(0, height - 0.009, side * (depth / 2 + 0.043)), "kraft");
    flap.rotation.x = side * 0.19;
    const shortFlap = box(scene, root, `${name}-short-flap-${side}`, new Vector3(0.08, 0.004, depth * 0.97), new Vector3(side * (width / 2 + 0.036), height - 0.005, 0), "kraft");
    shortFlap.rotation.z = -side * 0.16;
    for (let index = 0; index < 18; index += 1) {
      box(scene, root, `${name}-corrugation-${side}-${index}`, new Vector3(0.003, 0.001, 0.0067), new Vector3(-width / 2 + 0.014 + index * (width - 0.028) / 17, height + 0.002, side * depth / 2), "kraft");
    }
  }
  box(scene, root, `${name}-bottom-tape`, new Vector3(0.052, 0.001, depth * 0.99), new Vector3(0, 0.008, 0), "tape");
  sign(scene, root, `${name}-delivery-label`, width * 0.72, 0.094, new Vector3(0, 0.108, -depth / 2 - 0.0035), PRODUCT_ASSETS[productId].nameEn.toUpperCase(), "CORNER SHOP · DELIVERY", true);
  mergeProductParts(root);
  return root;
}

function wallPanels(scene: Scene, root: TransformNode): (extension: number) => void {
  const stretched: { mesh: Mesh; depth: number }[] = [];
  const rear: Mesh[] = [];
  const extraPanels = new TransformNode("expanded-wall-details", scene);
  extraPanels.parent = root;
  extraPanels.setEnabled(false);
  for (const side of [-1, 1]) {
    stretched.push({ mesh: box(scene, root, `wall-${side}`, new Vector3(0.18, 3, 9.35), new Vector3(side * 3.49, 1.5, 0), "plaster"), depth: 9.35 });
    stretched.push({ mesh: box(scene, root, `wainscot-${side}`, new Vector3(0.038, 1.05, 9.2), new Vector3(side * 3.389, 0.525, 0), "sage"), depth: 9.2 });
    stretched.push({ mesh: box(scene, root, `dado-${side}`, new Vector3(0.065, 0.052, 9.2), new Vector3(side * 3.37, 1.075, 0), "sageLight"), depth: 9.2 });
    stretched.push({ mesh: box(scene, root, `skirting-${side}`, new Vector3(0.067, 0.14, 9.2), new Vector3(side * 3.368, 0.07, 0), "sageDark"), depth: 9.2 });
    for (let panel = 0; panel < 20; panel += 1) {
      box(scene, panel < 15 ? root : extraPanels, `wainscot-stile-${side}-${panel}`, new Vector3(0.04, 0.91, 0.038), new Vector3(side * 3.355, 0.575, -4.4 + panel * 0.625), "sageLight");
    }
  }
  rear.push(box(scene, root, "back-plaster", new Vector3(6.8, 3, 0.18), new Vector3(0, 1.5, 4.69), "plaster"));
  rear.push(box(scene, root, "back-wainscot", new Vector3(6.8, 1.05, 0.05), new Vector3(0, 0.525, 4.578), "sage"));
  rear.push(box(scene, root, "back-dado", new Vector3(6.8, 0.052, 0.068), new Vector3(0, 1.075, 4.56), "sageLight"));
  rear.push(box(scene, root, "back-skirting", new Vector3(6.8, 0.14, 0.08), new Vector3(0, 0.07, 4.55), "sageDark"));
  stretched.push({ mesh: box(scene, root, "shop-ceiling", new Vector3(7.0, 0.10, 9.5), new Vector3(0, 3.08, 0), "ceiling"), depth: 9.5 });
  for (const z of [-4.50, 4.50]) {
    const cornice = box(scene, root, `ceiling-cornice-${z}`, new Vector3(6.8, 0.07, 0.09), new Vector3(0, 2.98, z), "ceiling");
    if (z > 0) rear.push(cornice);
  }
  const rearAnchors = rear.map((mesh) => ({ mesh, z: mesh.position.z }));
  return (extension) => {
    for (const { mesh, depth } of stretched) {
      mesh.position.z = extension / 2;
      mesh.scaling.z = (depth + extension) / depth;
      mesh.computeWorldMatrix(true);
    }
    for (const { mesh, z } of rearAnchors) {
      mesh.position.z = z + extension;
      mesh.computeWorldMatrix(true);
    }
    extraPanels.setEnabled(extension > 0);
  };
}

function plant(scene: Scene, parent: TransformNode, name: string, position: Vector3, scale: number): void {
  const root = new TransformNode(name, scene);
  root.parent = parent;
  root.position.copyFrom(position);
  root.scaling.setAll(scale);
  cylinder(scene, root, `${name}-pot`, 0.19, 0.25, 0.27, new Vector3(0, 0.135, 0), "terracotta");
  cylinder(scene, root, `${name}-pot-rim`, 0.26, 0.26, 0.032, new Vector3(0, 0.263, 0), "terracotta");
  cylinder(scene, root, `${name}-soil`, 0.22, 0.22, 0.006, new Vector3(0, 0.27, 0), "soil");
  for (let branch = 0; branch < 7; branch += 1) {
    const angle = branch * 2.399;
    const height = 0.40 + (branch % 3) * 0.065;
    const tip = new Vector3(Math.sin(angle) * 0.19, height + 0.23, Math.cos(angle) * 0.19);
    segment(scene, root, `${name}-branch-${branch}`, new Vector3(0, 0.27, 0), tip, 0.005, "stem", 0.002);
    for (let leaf = 0; leaf < 3; leaf += 1) {
      const point = Vector3.Lerp(new Vector3(0, 0.28, 0), tip, 0.45 + leaf * 0.24);
      const shape = sphere(scene, root, `${name}-leaf-${branch}-${leaf}`, new Vector3(0.067, 0.009, 0.13), point.add(new Vector3(Math.cos(angle) * 0.028, 0.008, Math.sin(angle) * 0.028)), leaf % 2 ? "leaf" : "leafLight", 6);
      shape.rotation.set(0.1 + leaf * 0.22, angle + leaf * 0.8, 0.2);
    }
  }
}

function createFridge(scene: Scene, root: TransformNode): ShopTarget {
  const back = box(scene, root, "milk-fridge", new Vector3(0.98, 2.22, 0.11), new Vector3(0, 1.11, 4.43), "black");
  box(scene, back, "fridge-inner-back", new Vector3(0.81, 1.83, 0.017), new Vector3(0, 0.07, -0.066), "milkPaper");
  for (const side of [-1, 1]) {
    box(scene, back, `fridge-side-${side}`, new Vector3(0.08, 2.22, 0.79), new Vector3(side * 0.45, 0, -0.385), "black");
    box(scene, back, `fridge-insulation-${side}`, new Vector3(0.026, 1.82, 0.60), new Vector3(side * 0.392, 0.065, -0.379), "milkPaper");
    box(scene, back, `fridge-front-trim-${side}`, new Vector3(0.023, 1.91, 0.037), new Vector3(side * 0.408, 0.065, -0.785), "metal");
  }
  box(scene, back, "fridge-top", new Vector3(0.98, 0.135, 0.82), new Vector3(0, 1.046, -0.36), "black");
  box(scene, back, "fridge-base", new Vector3(0.98, 0.21, 0.82), new Vector3(0, -1.005, -0.36), "black");
  for (let vent = 0; vent < 6; vent += 1) box(scene, back, `fridge-vent-${vent}`, new Vector3(0.83, 0.011, 0.011), new Vector3(0, -1.08 + vent * 0.027, -0.777), "rubber");
  for (const y of [0.36, 0.94, 1.40, 1.85]) {
    box(scene, back, `fridge-shelf-${y}`, new Vector3(0.79, 0.018, 0.64), new Vector3(0, y - 1.119, -0.455), "metal");
    for (let slat = 0; slat < 10; slat += 1) box(scene, back, `fridge-rack-${y}-${slat}`, new Vector3(0.007, 0.005, 0.62), new Vector3(-0.354 + slat * 0.0785, y - 1.108, -0.455), "milkPaper");
  }
  sign(scene, back, "fridge-dairy-header", 0.52, 0.11, new Vector3(0, 1.04, -0.779), "FRESH MILK", "");
  sign(scene, back, "fridge-price", 0.25, 0.085, new Vector3(0, -0.215, -0.782), "milk · £1.60", "");
  sign(scene, back, "milk-capacity-note", 0.47, 0.205, new Vector3(0, 0.405, -0.783), "EXTRA SPACE", "扩充后启用 · 4 → 8", true);
  return { id: "milk-shelf", kind: "shelf", productId: "milk", position: new Vector3(0, 1.19, 3.66), mesh: back };
}

function createBreadRack(scene: Scene, root: TransformNode): ShopTarget {
  const back = box(scene, root, "bread-rack", new Vector3(0.075, 1.88, 1.78), new Vector3(3.22, 0.94, 0.3), "oak");
  for (const side of [-1, 1]) {
    box(scene, back, `bread-side-${side}`, new Vector3(0.65, 1.88, 0.045), new Vector3(-0.288, 0, side * 0.876), "oak");
  }
  for (const y of [0.32, 0.82, 1.30]) {
    box(scene, back, `bread-tray-${y}`, new Vector3(0.65, 0.037, 1.76), new Vector3(-0.28, y - 0.958, 0), "oak");
    box(scene, back, `bread-rail-${y}`, new Vector3(0.044, 0.095, 1.77), new Vector3(-0.591, y - 0.948, 0), "oakEdge");
    const label = sign(scene, back, `bread-price-${y}`, 0.32, 0.088, new Vector3(-0.615, y - 0.938, 0), "bread · £2.40");
    label.rotation.y = Math.PI / 2;
  }
  const header = sign(scene, back, "bread-rack-header", 1.26, 0.22, new Vector3(-0.044, 0.749, 0), "BAKED THIS MORNING", "");
  header.rotation.y = Math.PI / 2;
  const extraSpace = sign(scene, back, "bread-capacity-note", 0.61, 0.223, new Vector3(-0.35, 0.495, 0), "EXTRA SPACE", "扩充后启用 · 4 → 8", true);
  extraSpace.rotation.y = Math.PI / 2;
  return { id: "bread-shelf", kind: "shelf", productId: "bread", position: new Vector3(2.58, 1.04, 0.3), mesh: back };
}

function createCounter(scene: Scene, root: TransformNode): ShopTarget {
  const body = box(scene, root, "checkout-counter", new Vector3(1.18, 0.93, 1.55), new Vector3(-2.2, 0.465, -2.2), "sage");
  box(scene, body, "counter-oak-top", new Vector3(1.28, 0.068, 1.67), new Vector3(0, 0.501, 0), "oak");
  for (const x of [-0.638, 0.638]) segment(scene, body, `counter-rounded-edge-${x}`, new Vector3(x, 0.532, -0.825), new Vector3(x, 0.532, 0.825), 0.007, "oakEdge");
  for (const z of [-0.832, 0.832]) segment(scene, body, `counter-rounded-end-${z}`, new Vector3(-0.635, 0.532, z), new Vector3(0.635, 0.532, z), 0.007, "oakEdge");
  box(scene, body, "counter-foot", new Vector3(1.20, 0.13, 1.58), new Vector3(0, -0.40, 0), "sageDark");
  for (let index = 0; index < 8; index += 1) {
    box(scene, body, `counter-front-bead-${index}`, new Vector3(0.026, 0.71, 0.022), new Vector3(-0.516 + index * 0.147, 0.03, -0.784), "sageLight");
    box(scene, body, `counter-side-bead-${index}`, new Vector3(0.022, 0.71, 0.025), new Vector3(0.598, 0.03, -0.66 + index * 0.187), "sageLight");
  }
  box(scene, body, "counter-drawer", new Vector3(0.37, 0.070, 0.34), new Vector3(-0.19, 0.566, 0.49), "black");
  cylinder(scene, body, "pos-stand", 0.12, 0.08, 0.17, new Vector3(-0.21, 0.688, 0.48), "black");
  const monitor = box(scene, body, "pos-terminal", new Vector3(0.35, 0.235, 0.032), new Vector3(-0.21, 0.823, 0.48), "black");
  monitor.rotation.x = 0.15;
  monitor.rotation.y = Math.PI;
  sign(scene, monitor, "pos-screen", 0.31, 0.193, new Vector3(0, 0.002, -0.018), "CORNER SHOP", "Ready to scan");
  const scanner = box(scene, body, "checkout-scanner", new Vector3(0.18, 0.055, 0.22), new Vector3(0.25, 0.563, 0.28), "black");
  box(scene, scanner, "scanner-reading-window", new Vector3(0.12, 0.006, 0.13), new Vector3(0, 0.03, 0), "glass");
  const reader = box(scene, body, "card-terminal", new Vector3(0.12, 0.05, 0.18), new Vector3(0.42, 0.572, -0.46), "black");
  reader.rotation.z = -0.12;
  const readerScreen = sign(scene, reader, "reader-screen", 0.092, 0.079, new Vector3(0, 0.027, -0.025), "CARD", "Tap to pay");
  readerScreen.rotation.x = Math.PI / 2;
  for (let row = 0; row < 3; row += 1) for (let col = 0; col < 3; col += 1) box(scene, reader, `key-${row}-${col}`, new Vector3(0.019, 0.004, 0.012), new Vector3(-0.027 + col * 0.027, 0.027, 0.029 + row * 0.018), "metal");
  const receipt = box(scene, body, "receipt-printer", new Vector3(0.13, 0.15, 0.13), new Vector3(-0.4, 0.611, 0.12), "black");
  box(scene, receipt, "receipt-paper", new Vector3(0.081, 0.055, 0.001), new Vector3(0, 0.085, -0.018), "milkPaper");
  const welcome = sign(scene, body, "counter-welcome", 0.50, 0.19, new Vector3(0.602, 0.125, -0.20), "A LITTLE LOCAL", "GOOD FOOD · GOOD COMPANY");
  welcome.rotation.y = -Math.PI / 2;
  return { id: "counter", kind: "counter", position: new Vector3(-1.63, 1.05, -2.15), mesh: body };
}

function pantry(scene: Scene, root: TransformNode): void {
  const rack = new TransformNode("pantry-display", scene);
  rack.parent = root;
  rack.position.set(1.93, 0, 4.20);
  for (const x of [-0.45, 0.45]) box(scene, rack, `pantry-side-${x}`, new Vector3(0.058, 2.24, 0.58), new Vector3(x, 1.12, 0), "sageDark");
  box(scene, rack, "pantry-back", new Vector3(0.94, 2.24, 0.05), new Vector3(0, 1.12, 0.295), "sage");
  for (const y of [0.22, 0.72, 1.23, 1.73, 2.22]) box(scene, rack, `pantry-level-${y}`, new Vector3(0.90, 0.035, 0.63), new Vector3(0, y, -0.02), "oak");
  for (let row = 0; row < 3; row += 1) for (let col = 0; col < 4; col += 1) {
    const x = -0.32 + col * 0.211;
    const y = 0.752 + row * 0.506;
    const jar = cylinder(scene, rack, `display-jar-${row}-${col}`, 0.104, 0.099, 0.166, new Vector3(x, y + 0.08, -0.12), row % 2 ? "kraft" : "oakEdge", 18);
    cylinder(scene, jar, `jar-lid-${row}-${col}`, 0.11, 0.11, 0.018, new Vector3(0, 0.088, 0), "brass", 18);
    const label = sign(scene, jar, `jar-label-${row}-${col}`, 0.078, 0.064, new Vector3(0, 0, -0.052), row === 1 ? "HONEY" : "PRESERVES", "", true);
    label.isPickable = true;
  }
  sign(scene, rack, "display-only-note", 0.48, 0.10, new Vector3(0, 0.193, -0.339), "PANTRY DISPLAY", "");
  plant(scene, rack, "pantry-plant", new Vector3(0, 2.25, 0), 0.75);
}

function entrance(scene: Scene, root: TransformNode): ShopTarget {
  // Front glazing admits a visual view of the pavement. No invisible glass wall in the doorway.
  for (const side of [-1, 1]) {
    box(scene, root, `front-low-wall-${side}`, new Vector3(2.42, 0.7, 0.17), new Vector3(side * 2.21, 0.35, -4.62), "sageDark");
    const window = box(scene, root, `front-window-${side}`, new Vector3(2.35, 1.90, 0.018), new Vector3(side * 2.2, 1.67, -4.64), "glass");
    window.receiveShadows = false;
    for (const x of [side * 1.01, side * 2.18, side * 3.36]) box(scene, root, `window-mullion-${side}-${x}`, new Vector3(0.047, 2.22, 0.082), new Vector3(x, 1.59, -4.61), "sageDark");
    box(scene, root, `window-sill-${side}`, new Vector3(2.43, 0.058, 0.28), new Vector3(side * 2.20, 0.73, -4.56), "oakEdge");
    box(scene, root, `window-crossbar-${side}`, new Vector3(2.4, 0.04, 0.08), new Vector3(side * 2.20, 2.19, -4.61), "sageDark");
  }
  box(scene, root, "front-door-header", new Vector3(6.8, 0.35, 0.18), new Vector3(0, 2.88, -4.61), "sageDark");
  for (const side of [-1, 1]) box(scene, root, `door-jamb-${side}`, new Vector3(0.07, 2.70, 0.17), new Vector3(side * 0.966, 1.35, -4.61), "sageDark");
  box(scene, root, "entrance-threshold", new Vector3(1.90, 0.025, 0.23), new Vector3(0, 0.012, -4.59), "metal");
  const mat = box(scene, root, "welcome-floor-mat", new Vector3(1.30, 0.012, 0.69), new Vector3(0, 0.006, -4.15), "floorMat");
  mat.receiveShadows = true;
  const hanging = sign(scene, root, "open-sign", 0.50, 0.235, new Vector3(0.62, 1.73, -4.40), "CLOSED", "Ready when you are", true);
  hanging.rotation.y = Math.PI;
  // Players can now stand outside. Print both faces so the street side is not mirrored.
  const outwardSign = sign(scene, hanging, "open-sign-exterior", 0.50, 0.235, new Vector3(0, 0, 0.018), "CLOSED", "Ready when you are", true);
  outwardSign.rotation.y = Math.PI;
  if (hanging.material) hanging.material.backFaceCulling = true;
  for (const x of [0.45, 0.79]) line(scene, root, `sign-cord-${x}`, [new Vector3(x, 1.848, -4.40), new Vector3(0.62, 2.075, -4.40)], 0.003, "kraftEdge");
  const exterior = box(scene, root, "pavement", new Vector3(11, 0.10, 3.9), new Vector3(0, -0.051, -6.5), "plaster");
  exterior.receiveShadows = true;
  for (let index = 0; index < 10; index += 1) box(scene, root, `pavement-joint-${index}`, new Vector3(0.018, 0.001, 3.9), new Vector3(-5 + index * 1.13, 0.001, -6.5), "sageLight");
  return { id: "open-sign", kind: "open-sign", position: new Vector3(0.62, 1.73, -4.40), mesh: hanging };
}

export function createShop(scene: Scene, options: { catalogFixtures?: boolean; layout?: ShopLayout } = {}): ShopEnvironment {
  const root = new TransformNode("corner-shop-environment", scene);
  const targets: ShopTarget[] = [];
  const floor = finish(MeshBuilder.CreateGround("oak-floor", { width: 6.8, height: 9.2 }, scene), root, material(scene, "oak"), Vector3.Zero());
  const floorMaterial = material(scene, "oak").clone("wide-oak-floor-material");
  if (floorMaterial) {
    const texture = new Texture("/assets/sim3d/oak-floor.png", scene);
    // The tile contains five boards: a 1.2 m tile gives plausible 24 cm planks.
    texture.uScale = 6.8 / 1.2;
    texture.vScale = 9.2 / 1.2;
    texture.anisotropicFilteringLevel = 8;
    floorMaterial.albedoTexture = texture;
    floorMaterial.roughness = 0.74;
    floor.material = floorMaterial;
  }
  const applyWallExpansion = wallPanels(scene, root);
  const furniture = [
    { id: "checkout-counter" as const, target: createCounter(scene, root) },
    { id: "milk-fridge" as const, target: createFridge(scene, root) },
    { id: "bread-rack" as const, target: createBreadRack(scene, root) },
  ].map((entry) => ({ ...entry, originalPosition: entry.target.mesh.position.clone(), originalTarget: entry.target.position.clone() }));
  for (const { id, target } of furniture) target.mesh.metadata = { ...target.mesh.metadata, furnitureId: id };
  targets.push(...furniture.map((entry) => entry.target), entrance(scene, root));
  if (!options.catalogFixtures) pantry(scene, root);

  const door = box(scene, root, "stockroom-door", new Vector3(0.91, 2.13, 0.072), new Vector3(-2.01, 1.065, 4.49), "sageDark");
  for (const x of [-0.498, 0.498]) box(scene, door, `door-frame-${x}`, new Vector3(0.074, 2.24, 0.09), new Vector3(x, 0.035, -0.035), "sage");
  box(scene, door, "door-lintel", new Vector3(1.07, 0.083, 0.1), new Vector3(0, 1.14, -0.035), "sage");
  for (const y of [-0.62, 0.36]) {
    box(scene, door, `door-inset-${y}`, new Vector3(0.71, 0.71, 0.016), new Vector3(0, y, -0.046), "sage");
    for (const x of [-0.356, 0.356]) box(scene, door, `door-trim-${y}-${x}`, new Vector3(0.024, 0.735, 0.013), new Vector3(x, y, -0.058), "sageLight");
  }
  sphere(scene, door, "brass-door-knob", new Vector3(0.054, 0.054, 0.059), new Vector3(0.34, -0.10, -0.076), "brass");
  sign(scene, door, "staff-door-plaque", 0.37, 0.123, new Vector3(0, 0.66, -0.060), "STAFF ONLY");
  plant(scene, root, "back-corner-plant", new Vector3(-0.90, 0, 4.02), 1.42);
  // Keep a real walking gap around the original counter's cashier side.
  plant(scene, root, "window-plant", new Vector3(-3.01, 0, -4.10), 1.5);

  const frame = box(scene, root, "local-grocer-frame", new Vector3(0.66, 0.83, 0.046), new Vector3(-3.325, 1.99, 1.67), "oakEdge");
  frame.rotation.y = -Math.PI / 2;
  sign(scene, frame, "local-grocer-poster", 0.574, 0.75, new Vector3(0, 0, -0.025), "YOUR LOCAL", "A little shop. A good day.", true);
  const backMark = sign(scene, root, "back-wall-shop-mark", 0.87, 0.26, new Vector3(0, 2.61, 4.576), "CORNER SHOP", "EST. 2026", true);

  const extraLighting = new TransformNode("expanded-shop-lighting", scene);
  extraLighting.parent = root;
  extraLighting.setEnabled(false);
  for (const z of [-1.5, 2.0, 5.5]) {
    const parent = z > 4.6 ? extraLighting : root;
    cylinder(scene, parent, `pendant-cable-${z}`, 0.008, 0.008, 0.36, new Vector3(0, 2.83, z), "black", 8);
    cylinder(scene, parent, `pendant-shade-${z}`, 0.47, 0.11, 0.19, new Vector3(0, 2.58, z), "sageDark", 40);
    cylinder(scene, parent, `pendant-inner-${z}`, 0.425, 0.10, 0.16, new Vector3(0, 2.567, z), "milkPaper", 40);
    sphere(scene, parent, `pendant-bulb-${z}`, new Vector3(0.08, 0.1, 0.08), new Vector3(0, 2.52, z), "bulb");
  }
  const dropPositions = [new Vector3(1.35, 0.006, -2.9), new Vector3(2.2, 0.006, -2.9), new Vector3(-1.1, 0.006, 2.6), new Vector3(1.8, 0.006, 1.35)];
  dropPositions.forEach((position, index) => {
    const mat = box(scene, root, `delivery-mat-${index}`, new Vector3(0.76, 0.010, 0.62), position, "floorMat");
    const label = sign(scene, mat, `delivery-mat-label-${index}`, 0.54, 0.16, new Vector3(0, 0.006, 0), index < 2 ? "DELIVERY" : "PUT DOWN", "", true);
    label.rotation.x = Math.PI / 2;
    targets.push({ id: `drop-${index}`, kind: "drop-zone", position: position.clone(), mesh: mat });
  });
  const originalSlots = {
    milk: [0.94, 1.40].flatMap((y) => [-0.30, -0.10, 0.10, 0.30].map((x) => new Vector3(x, y, 3.77))),
    bread: [0.82, 1.30].flatMap((y) => [-0.21, 0.13, 0.47, 0.81].map((z) => new Vector3(2.78, y, z))),
  };
  const shelfSlots = { milk: originalSlots.milk.map((point) => point.clone()), bread: originalSlots.bread.map((point) => point.clone()) };
  root.metadata = {
    shelfSlots,
    productYaw: { milk: 0, bread: Math.PI / 2 },
    counterTop: 1.0,
  };
  const colliders: ShopCollider[] = [
    { minX: -3.6, maxX: -3.39, minZ: -4.8, maxZ: 4.8 },
    { minX: 3.39, maxX: 3.6, minZ: -4.8, maxZ: 4.8 },
    { minX: -3.6, maxX: 3.6, minZ: 4.56, maxZ: 4.8 },
    { minX: -3.6, maxX: -0.95, minZ: -4.8, maxZ: -4.50 },
    { minX: 0.95, maxX: 3.6, minZ: -4.8, maxZ: -4.50 },
    { minX: -2.84, maxX: -1.56, minZ: -3.035, maxZ: -1.365 },
    { minX: -0.51, maxX: 0.51, minZ: 3.62, maxZ: 4.51 },
    { minX: 2.59, maxX: 3.29, minZ: -0.62, maxZ: 1.22 },
    ...(!options.catalogFixtures ? [{ minX: 1.44, maxX: 2.42, minZ: 3.86, maxZ: 4.52 }] : []),
    { minX: -3.22, maxX: -2.81, minZ: -4.31, maxZ: -3.89 },
    { minX: -1.10, maxX: -0.70, minZ: 3.82, maxZ: 4.22 },
  ];
  function applyLayout(layout: ShopLayout): void {
    const extension = layout.expansion * 3;
    floor.position.z = extension / 2;
    floor.scaling.z = (9.2 + extension) / 9.2;
    floor.computeWorldMatrix(true);
    if (floorMaterial?.albedoTexture instanceof Texture) floorMaterial.albedoTexture.vScale = (9.2 + extension) / 1.2;
    applyWallExpansion(extension);
    door.position.z = 4.49 + extension;
    door.computeWorldMatrix(true);
    backMark.position.z = 4.576 + extension;
    backMark.computeWorldMatrix(true);
    extraLighting.setEnabled(extension > 0);
    colliders[0]!.maxZ = 4.8 + extension;
    colliders[1]!.maxZ = 4.8 + extension;
    colliders[2]!.minZ = 4.56 + extension;
    colliders[2]!.maxZ = 4.8 + extension;
    furniture.forEach(({ id, target, originalPosition, originalTarget }, index) => {
      const placement = layout.placements.find((entry) => entry.id === id)!;
      const position = transformLayoutPoint(layout, id, { x: originalPosition.x, y: originalPosition.y, z: originalPosition.z });
      target.mesh.position.set(position.x, position.y, position.z);
      target.mesh.rotation.y = placement.rotation * Math.PI / 2;
      target.mesh.computeWorldMatrix(true);
      const point = transformLayoutPoint(layout, id, { x: originalTarget.x, y: originalTarget.y, z: originalTarget.z });
      target.position.set(point.x, point.y, point.z);
      Object.assign(colliders[index + 5]!, furnitureBounds(placement));
    });
    for (const [productId, id] of [["milk", "milk-fridge"], ["bread", "bread-rack"]] as const satisfies readonly (readonly [ProductId, FurnitureId])[]) {
      originalSlots[productId].forEach((original, index) => {
        const point = transformLayoutPoint(layout, id, { x: original.x, y: original.y, z: original.z });
        shelfSlots[productId][index]!.set(point.x, point.y, point.z);
      });
      const placement = layout.placements.find((entry) => entry.id === id)!;
      root.metadata.productYaw[productId] = (productId === "bread" ? Math.PI / 2 : 0) + placement.rotation * Math.PI / 2;
    }
  }
  if (options.layout) applyLayout(options.layout);
  return { root, colliders, targets, applyLayout };
}

export function createPlayerHands(scene: Scene): TransformNode {
  const root = new TransformNode("player-carry-hands", scene);
  root.metadata = { assetType: "player-hands", pose: "carry" };
  for (const side of [-1, 1]) {
    const palmX = side * 0.245;
    segment(scene, root, `navy-sleeve-${side}`, new Vector3(side * 0.36, -0.14, -0.47), new Vector3(side * 0.285, 0.09, -0.13), 0.060, "sleeve", 0.044);
    segment(scene, root, `ribbed-cuff-${side}`, new Vector3(side * 0.291, 0.066, -0.168), new Vector3(side * 0.28, 0.097, -0.12), 0.044, "cuff", 0.040);
    segment(scene, root, `wrist-${side}`, new Vector3(side * 0.28, 0.099, -0.122), new Vector3(palmX, 0.14, -0.053), 0.031, "skin", 0.031);
    const palm = sphere(scene, root, `palm-${side}`, new Vector3(0.047, 0.073, 0.088), new Vector3(palmX, 0.145, -0.025), "skin", 18);
    palm.rotation.z = side * 0.21;
    // Four fingers wrap over the box rim; thumbs sit on the inside lip.
    for (let finger = 0; finger < 4; finger += 1) {
      const z = -0.053 + finger * 0.018;
      const y = 0.165 + Math.sin((finger + 0.5) / 4 * Math.PI) * 0.010;
      const middle = new Vector3(palmX - side * 0.022, y + 0.010, z);
      const tip = new Vector3(palmX - side * 0.031, y - 0.014, z + 0.008);
      segment(scene, root, `finger-base-${side}-${finger}`, new Vector3(palmX + side * 0.012, y, z), middle, 0.0078, "skin", 0.0070);
      sphere(scene, root, `knuckle-${side}-${finger}`, new Vector3(0.017, 0.016, 0.017), middle, "skin", 8);
      segment(scene, root, `finger-tip-${side}-${finger}`, middle, tip, 0.0070, "skin", 0.0062);
      const nail = sphere(scene, root, `fingernail-${side}-${finger}`, new Vector3(0.0085, 0.0015, 0.010), tip.add(new Vector3(0, 0.0059, 0)), "nails", 6);
      nail.rotation.z = -side * 0.6;
    }
    const thumbBase = new Vector3(palmX - side * 0.003, 0.134, -0.058);
    const thumbTip = new Vector3(palmX - side * 0.040, 0.170, -0.048);
    segment(scene, root, `thumb-${side}`, thumbBase, thumbTip, 0.012, "skin", 0.0088);
    sphere(scene, root, `thumb-end-${side}`, new Vector3(0.017, 0.018, 0.018), thumbTip, "skin", 10);
  }
  mergeProductParts(root);
  return root;
}
