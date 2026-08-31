import {
  Color3, DynamicTexture, Mesh, MeshBuilder, PBRMaterial, Quaternion,
  Scene, Texture, TransformNode, Vector3, VertexBuffer,
} from "@babylonjs/core";
import { STREET_VENUES, type VenueId as StreetVenueId } from "./progression";

interface StreetCollider { minX: number; maxX: number; minZ: number; maxZ: number }
interface StreetTarget {
  id: string;
  kind: "venue" | "delivery" | "drop-zone";
  venueId?: StreetVenueId;
  position: Vector3;
  mesh: Mesh;
}
export interface StreetEnvironment {
  root: TransformNode;
  colliders: StreetCollider[];
  targets: StreetTarget[];
  truck: TransformNode;
  /** Axles point along z. Rotate these roots about z to roll along the street. */
  wheels: TransformNode[];
}

type Paint =
  | "stone" | "stoneEdge" | "mortar" | "asphalt" | "roadPaint" | "ochre"
  | "cream" | "ivory" | "sage" | "sageDark" | "teal" | "terracotta"
  | "redBrick" | "sandBrick" | "roof" | "timber" | "iron" | "rubber"
  | "metal" | "brass" | "glass" | "windowShade" | "leaf" | "leafLight"
  | "leafShade" | "bark" | "soil" | "warmLight" | "redLight";

const colors: Record<Paint, string> = {
  stone: "#c7c0ac", stoneEdge: "#afa998", mortar: "#aaa38f", asphalt: "#666c68",
  roadPaint: "#e9e6d6", ochre: "#c2a25a", cream: "#ded3b7", ivory: "#f1ebdb",
  sage: "#677766", sageDark: "#344a40", teal: "#356765", terracotta: "#a96950",
  redBrick: "#a77962", sandBrick: "#c3ad8b", roof: "#505955", timber: "#9c7850",
  iron: "#283733", rubber: "#202725", metal: "#a9b6b2", brass: "#af925a",
  glass: "#acc5c0", windowShade: "#394d49", leaf: "#718354", leafLight: "#90a367",
  leafShade: "#536d46", bark: "#77654c", soil: "#514a3a", warmLight: "#fae8b5",
  redLight: "#a85b44",
};
const materials = new WeakMap<Scene, Map<string, PBRMaterial>>();
const displayStates = new WeakMap<Scene, Map<string, string>>();

function cacheFor(scene: Scene): Map<string, PBRMaterial> {
  let cache = materials.get(scene);
  if (!cache) { cache = new Map(); materials.set(scene, cache); }
  return cache;
}

function paint(scene: Scene, key: Paint): PBRMaterial {
  const cache = cacheFor(scene);
  const cached = cache.get(key);
  if (cached) return cached;
  const result = new PBRMaterial(`street-paint-${key}`, scene);
  result.albedoColor = Color3.FromHexString(colors[key]);
  result.roughness = ["metal", "brass"].includes(key) ? 0.39 : key === "glass" ? 0.16 : 0.89;
  result.metallic = ["metal", "brass"].includes(key) ? 0.65 : key === "iron" ? 0.2 : 0;
  if (key === "glass") {
    result.alpha = 0.25;
    result.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    result.backFaceCulling = false;
    result.clearCoat.isEnabled = true;
    result.clearCoat.intensity = 0.6;
    result.clearCoat.roughness = 0.14;
  }
  if (key === "warmLight") result.emissiveColor = new Color3(0.5, 0.38, 0.19);
  if (key === "redLight") result.emissiveColor = new Color3(0.16, 0.035, 0.016);
  if (key === "redBrick" || key === "sandBrick" || key === "asphalt") {
    const texture = new DynamicTexture(`street-surface-${key}`, { width: 512, height: 512 }, scene, true);
    const ctx = texture.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = key === "asphalt" ? "#747a74" : "#c2b5a0";
    ctx.fillRect(0, 0, 512, 512);
    if (key === "asphalt") {
      for (let i = 0; i < 1600; i += 1) {
        ctx.fillStyle = i % 3 ? "#80857e" : "#626b64";
        ctx.fillRect((i * 139 + 23) % 512, (i * 193 + 43) % 512, 1 + i % 2, 1);
      }
    } else {
      for (let row = 0; row < 16; row += 1) for (let col = -1; col < 5; col += 1) {
        const tone = 0.94 + ((row * 7 + col * 3 + 31) % 9) * 0.008;
        ctx.fillStyle = Color3.FromHexString(colors[key]).scale(tone).toHexString();
        ctx.fillRect(col * 128 + (row % 2) * 64 + 2, row * 32 + 2, 124, 28);
      }
      result.albedoColor = Color3.White();
    }
    texture.update();
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 4;
    result.albedoTexture = texture;
  }
  cache.set(key, result);
  return result;
}

function finish(mesh: Mesh, parent: TransformNode, mat: PBRMaterial, position: Vector3): Mesh {
  mesh.parent = parent;
  mesh.position.copyFrom(position);
  mesh.material = mat;
  mesh.isPickable = true;
  mesh.receiveShadows = true;
  return mesh;
}

function box(scene: Scene, parent: TransformNode, name: string, size: Vector3, position: Vector3, key: Paint): Mesh {
  const mesh = finish(MeshBuilder.CreateBox(name, { width: size.x, height: size.y, depth: size.z }, scene), parent, paint(scene, key), position);
  if (key === "redBrick" || key === "sandBrick" || key === "asphalt") {
    // Map in metres so a deep wall and a narrow pier have the same brick scale.
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
    const uvs: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]!; const y = positions[i + 1]!; const z = positions[i + 2]!;
      if (Math.abs(normals[i + 1]!) > 0.5) uvs.push(x / 1.8, z / 1.8);
      else if (Math.abs(normals[i]!) > 0.5) uvs.push(z / 1.8, y / 1.3);
      else uvs.push(x / 1.8, y / 1.3);
    }
    mesh.setVerticesData(VertexBuffer.UVKind, uvs);
  }
  return mesh;
}

function cylinder(scene: Scene, parent: TransformNode, name: string, bottom: number, top: number, height: number, position: Vector3, key: Paint, sides = 12): Mesh {
  return finish(MeshBuilder.CreateCylinder(name, { diameterBottom: bottom, diameterTop: top, height, tessellation: sides }, scene), parent, paint(scene, key), position);
}

function beam(scene: Scene, parent: TransformNode, name: string, from: Vector3, to: Vector3, radius: number, key: Paint, endRadius = radius): Mesh {
  const delta = to.subtract(from);
  const length = delta.length();
  const mesh = cylinder(scene, parent, name, radius * 2, endRadius * 2, length, from.add(to).scale(0.5), key);
  delta.scaleInPlace(1 / length);
  const axis = Vector3.Cross(Vector3.Up(), delta);
  const angle = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(Vector3.Up(), delta))));
  mesh.rotationQuaternion = axis.lengthSquared() < 1e-8
    ? Quaternion.RotationAxis(Vector3.Right(), angle)
    : Quaternion.RotationAxis(axis.normalize(), angle);
  return mesh;
}

function printed(scene: Scene, name: string, width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): PBRMaterial {
  const cache = cacheFor(scene);
  const cached = cache.get(name);
  if (cached) return cached;
  const texture = new DynamicTexture(`street-print-${name}`, { width, height }, scene, true);
  draw(texture.getContext() as CanvasRenderingContext2D);
  texture.update();
  texture.anisotropicFilteringLevel = 8;
  const result = new PBRMaterial(`street-print-${name}`, scene);
  result.albedoTexture = texture;
  result.metallic = 0;
  result.roughness = 0.91;
  // Signs are single-faced: the +z shopfront explicitly rotates its sign by pi.
  result.backFaceCulling = true;
  cache.set(name, result);
  return result;
}

function label(scene: Scene, parent: TransformNode, name: string, width: number, height: number, position: Vector3, heading: string, detail: string, background = "#354c42", front = 1): Mesh {
  const pixelsHigh = Math.max(128, Math.round(1024 * height / width));
  const mat = printed(scene, name, 1024, pixelsHigh, (ctx) => {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 1024, pixelsHigh);
    ctx.strokeStyle = "#b7ac87";
    ctx.lineWidth = 3;
    ctx.strokeRect(15, 12, 994, pixelsHigh - 24);
    ctx.fillStyle = "#f4efdf";
    ctx.textAlign = "center";
    ctx.font = `600 ${pixelsHigh * (detail ? 0.37 : 0.49)}px Georgia, 'PingFang SC', serif`;
    ctx.fillText(heading, 512, pixelsHigh * (detail ? 0.5 : 0.66), 948);
    if (detail) {
      ctx.font = `${pixelsHigh * 0.16}px Arial, 'PingFang SC', sans-serif`;
      ctx.fillText(detail, 512, pixelsHigh * 0.8, 922);
    }
  });
  const mesh = finish(MeshBuilder.CreatePlane(name, { width, height }, scene), parent, mat, position);
  mesh.rotation.y = front > 0 ? Math.PI : 0;
  return mesh;
}

function refreshDisplay(scene: Scene, name: string, signature: string, draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void): void {
  const mesh = scene.getMeshByName(name);
  if (!(mesh?.material instanceof PBRMaterial) || !(mesh.material.albedoTexture instanceof DynamicTexture)) return;
  let cache = displayStates.get(scene);
  if (!cache) { cache = new Map(); displayStates.set(scene, cache); }
  if (cache.get(name) === signature) return;
  const texture = mesh.material.albedoTexture;
  const size = texture.getSize();
  draw(texture.getContext() as CanvasRenderingContext2D, size.width, size.height);
  texture.update();
  cache.set(name, signature);
}

/** This changes the physical door plaque, never the venue's logical eligibility. */
export function setStreetVenueStatus(scene: Scene, venueId: StreetVenueId, statusText: string, detailText: string, eligible: boolean): void {
  refreshDisplay(scene, `street-${venueId}-status`, JSON.stringify([statusText, detailText, eligible]), (ctx, width, height) => {
    ctx.fillStyle = eligible ? "#3a5745" : "#ece4cf";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = eligible ? "#a7b395" : "#b7a681";
    ctx.lineWidth = 6;
    ctx.strokeRect(20, 20, width - 40, height - 40);
    ctx.textAlign = "center";
    ctx.fillStyle = eligible ? "#f6f0de" : "#35483c";
    ctx.font = `600 ${height * 0.265}px Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
    ctx.fillText(statusText, width / 2, height * 0.47, width - 95);
    ctx.font = `${height * 0.118}px Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
    ctx.fillText(detailText, width / 2, height * 0.72, width - 90);
    ctx.font = `${height * 0.075}px Arial, sans-serif`;
    ctx.fillText(eligible ? "YOUR NEXT CHAPTER" : "A NEW CHAPTER AWAITS", width / 2, height * 0.88, width - 100);
  });
}

export function setDeliveryTruckStatus(scene: Scene, text: string): void {
  refreshDisplay(scene, "delivery-truck-status", text, (ctx, width, height) => {
    ctx.fillStyle = "#e9e3cf";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#32594f";
    ctx.textAlign = "center";
    ctx.font = `600 ${height * 0.42}px Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
    ctx.fillText(text, width / 2, height * 0.65, width - 54);
  });
}

function sashWindow(scene: Scene, parent: TransformNode, name: string, x: number, y: number, z: number, width: number, height: number, front = 1): void {
  box(scene, parent, `${name}-window-shade`, new Vector3(width, height, 0.06), new Vector3(x, y, z), "windowShade");
  box(scene, parent, `${name}-window-pane`, new Vector3(width - 0.12, height - 0.12, 0.025), new Vector3(x, y, z + front * 0.036), "glass");
  for (const side of [-1, 1]) {
    box(scene, parent, `${name}-side-${side}`, new Vector3(0.084, height + 0.17, 0.12), new Vector3(x + side * (width / 2 + 0.018), y, z + front * 0.06), "ivory");
    box(scene, parent, `${name}-horizontal-${side}`, new Vector3(width + 0.23, 0.09, 0.15), new Vector3(x, y + side * height / 2, z + front * 0.06), "ivory");
  }
  box(scene, parent, `${name}-sash`, new Vector3(width, 0.047, 0.08), new Vector3(x, y, z + front * 0.09), "cream");
  box(scene, parent, `${name}-mullion`, new Vector3(0.035, height, 0.09), new Vector3(x, y, z + front * 0.1), "cream");
  box(scene, parent, `${name}-sill`, new Vector3(width + 0.3, 0.10, 0.31), new Vector3(x, y - height / 2 - 0.065, z + front * 0.12), "stoneEdge");
  // A pale, narrow curtain behind the frame adds depth without a reflective black mirror.
  for (const side of [-1, 1]) box(scene, parent, `${name}-curtain-${side}`, new Vector3(width * 0.14, height * 0.9, 0.012), new Vector3(x + side * width * 0.35, y, z + front * 0.047), "cream");
}

function flowerBox(scene: Scene, parent: TransformNode, name: string, x: number, z: number, width = 0.86): void {
  box(scene, parent, `${name}-body`, new Vector3(width, 0.43, 0.57), new Vector3(x, 0.25, z), "timber");
  for (const y of [0.09, 0.235, 0.39]) box(scene, parent, `${name}-band-${y}`, new Vector3(width + 0.028, 0.018, 0.594), new Vector3(x, y, z), "iron");
  box(scene, parent, `${name}-soil`, new Vector3(width - 0.09, 0.025, 0.46), new Vector3(x, 0.472, z), "soil");
  for (let i = 0; i < 5; i += 1) {
    const mesh = finish(MeshBuilder.CreateIcoSphere(`${name}-shrub-${i}`, { radius: 0.23, subdivisions: 1, flat: true }, scene), parent, paint(scene, i % 2 ? "leaf" : "leafLight"), new Vector3(x - width * 0.36 + width * 0.18 * i, 0.63 + (i % 2) * 0.04, z));
    mesh.scaling.set(1, 0.85, 0.88);
  }
}

function tree(scene: Scene, parent: TransformNode, colliders: StreetCollider[], x: number, z: number, index: number): void {
  const name = `street-tree-${index}`;
  const planter = box(scene, parent, `${name}-planter`, new Vector3(1.10, 0.42, 1.10), new Vector3(x, 0.25, z), "stoneEdge");
  box(scene, planter, `${name}-planter-rim`, new Vector3(1.18, 0.095, 1.18), new Vector3(0, 0.21, 0), "stone");
  box(scene, planter, `${name}-soil`, new Vector3(0.99, 0.012, 0.99), new Vector3(0, 0.267, 0), "soil");
  beam(scene, parent, `${name}-trunk`, new Vector3(x, 0.5, z), new Vector3(x + 0.09, 2.88, z), 0.12, "bark", 0.058);
  for (let branch = 0; branch < 4; branch += 1) {
    const angle = branch * 2.40 + index;
    beam(scene, parent, `${name}-branch-${branch}`, new Vector3(x + 0.05, 1.9, z), new Vector3(x + Math.cos(angle) * 0.67, 3.08, z + Math.sin(angle) * 0.66), 0.042, "bark", 0.013);
  }
  for (let lobe = 0; lobe < 8; lobe += 1) {
    const angle = lobe * 2.4 + index * 0.7;
    const offset = lobe === 7 ? 0 : 0.62;
    const crown = finish(MeshBuilder.CreateIcoSphere(`${name}-crown-${lobe}`, { radius: 0.80, subdivisions: 1, flat: true }, scene), parent, paint(scene, lobe % 3 === 0 ? "leafLight" : lobe % 3 === 1 ? "leaf" : "leafShade"), new Vector3(x + Math.cos(angle) * offset, 3.12 + (lobe % 3) * 0.28, z + Math.sin(angle) * offset));
    crown.scaling.set(1.0, 1.13, 0.92);
    crown.rotation.y = angle;
  }
  colliders.push({ minX: x - 0.60, maxX: x + 0.60, minZ: z - 0.60, maxZ: z + 0.60 });
}

function bench(scene: Scene, parent: TransformNode, colliders: StreetCollider[], x: number, z: number, front: number): void {
  const name = `street-bench-${x}-${z}`;
  for (const side of [-1, 1]) {
    for (const depth of [-1, 1]) box(scene, parent, `${name}-leg-${side}-${depth}`, new Vector3(0.055, 0.47, 0.065), new Vector3(x + side * 0.67, 0.25, z + depth * 0.17), "iron");
    beam(scene, parent, `${name}-back-support-${side}`, new Vector3(x + side * 0.67, 0.30, z - front * 0.20), new Vector3(x + side * 0.67, 0.97, z - front * 0.28), 0.027, "iron");
  }
  for (let slat = 0; slat < 4; slat += 1) {
    box(scene, parent, `${name}-seat-${slat}`, new Vector3(1.76, 0.052, 0.096), new Vector3(x, 0.49, z - 0.18 + slat * 0.118), "timber");
    box(scene, parent, `${name}-back-${slat}`, new Vector3(1.76, 0.086, 0.05), new Vector3(x, 0.63 + slat * 0.105, z - front * 0.25), "timber");
  }
  colliders.push({ minX: x - 0.89, maxX: x + 0.89, minZ: z - 0.32, maxZ: z + 0.32 });
}

function lamp(scene: Scene, parent: TransformNode, colliders: StreetCollider[], x: number, z: number): void {
  const name = `street-lamp-${x}-${z}`;
  cylinder(scene, parent, `${name}-foot`, 0.31, 0.23, 0.26, new Vector3(x, 0.15, z), "iron");
  cylinder(scene, parent, `${name}-pole`, 0.094, 0.066, 3.22, new Vector3(x, 1.89, z), "iron");
  cylinder(scene, parent, `${name}-collar`, 0.18, 0.18, 0.08, new Vector3(x, 3.43, z), "brass");
  box(scene, parent, `${name}-lantern`, new Vector3(0.27, 0.40, 0.27), new Vector3(x, 3.70, z), "warmLight");
  for (const dx of [-0.155, 0.155]) for (const dz of [-0.155, 0.155]) beam(scene, parent, `${name}-frame-${dx}-${dz}`, new Vector3(x + dx, 3.48, z + dz), new Vector3(x + dx * 0.7, 3.93, z + dz * 0.7), 0.019, "iron");
  cylinder(scene, parent, `${name}-roof`, 0.49, 0.08, 0.17, new Vector3(x, 3.97, z), "iron", 4).rotation.y = Math.PI / 4;
  cylinder(scene, parent, `${name}-cap`, 0.07, 0.018, 0.16, new Vector3(x, 4.11, z), "brass");
  colliders.push({ minX: x - 0.18, maxX: x + 0.18, minZ: z - 0.18, maxZ: z + 0.18 });
}

function cafeTable(scene: Scene, parent: TransformNode, x: number, z: number, name: string): void {
  cylinder(scene, parent, `${name}-foot`, 0.40, 0.18, 0.07, new Vector3(x, 0.075, z), "iron");
  cylinder(scene, parent, `${name}-stand`, 0.07, 0.055, 0.66, new Vector3(x, 0.42, z), "iron");
  cylinder(scene, parent, `${name}-tabletop`, 0.72, 0.72, 0.058, new Vector3(x, 0.77, z), "timber", 24);
  cylinder(scene, parent, `${name}-saucer`, 0.13, 0.13, 0.014, new Vector3(x + 0.11, 0.807, z), "ivory", 16);
  cylinder(scene, parent, `${name}-cup`, 0.07, 0.095, 0.083, new Vector3(x + 0.11, 0.851, z), "ivory", 16);
  cylinder(scene, parent, `${name}-coffee`, 0.079, 0.079, 0.004, new Vector3(x + 0.11, 0.895, z), "bark", 16);
  for (const side of [-1, 1]) {
    const chairX = x + side * 0.64;
    box(scene, parent, `${name}-chair-seat-${side}`, new Vector3(0.35, 0.044, 0.36), new Vector3(chairX, 0.45, z), "sage");
    for (const dx of [-0.14, 0.14]) for (const dz of [-0.14, 0.14]) beam(scene, parent, `${name}-chair-leg-${side}-${dx}-${dz}`, new Vector3(chairX + dx * 1.13, 0.04, z + dz * 1.13), new Vector3(chairX + dx, 0.45, z + dz), 0.016, "iron");
    for (const dz of [-0.14, 0.14]) beam(scene, parent, `${name}-chair-back-pole-${side}-${dz}`, new Vector3(chairX + side * 0.14, 0.40, z + dz), new Vector3(chairX + side * 0.19, 0.89, z + dz), 0.016, "iron");
    for (const y of [0.69, 0.81]) box(scene, parent, `${name}-chair-back-${side}-${y}`, new Vector3(0.046, 0.088, 0.35), new Vector3(chairX + side * 0.18, y, z), "sage");
  }
}

interface VenueDesign {
  id: StreetVenueId; x: number; width: number; subtitle: string;
  color: Paint; masonry: Paint; height: number; doorX: number;
}
const venues: VenueDesign[] = [
  { id: "cafe", x: -10, width: 6, subtitle: "咖啡店  ·  COFFEE & LITTLE MOMENTS", color: "sage", masonry: "sandBrick", height: 7.05, doorX: 1.83 },
  { id: "restaurant", x: -3.5, width: 6, subtitle: "餐厅  ·  GOOD FOOD, SHARED", color: "terracotta", masonry: "redBrick", height: 7.65, doorX: 1.82 },
  { id: "supermarket", x: 7, width: 12, subtitle: "未来大商超  ·  A LITTLE MORE FOR EVERYONE", color: "teal", masonry: "cream", height: 6.60, doorX: 0 },
];

function storefront(scene: Scene, parent: TransformNode, design: VenueDesign, colliders: StreetCollider[]): StreetTarget {
  const { id, x, width, subtitle, color, masonry, height, doorX } = design;
  const name = STREET_VENUES.find((venue) => venue.id === id)!.nameEn.toUpperCase();
  const root = new TransformNode(`street-building-${id}`, scene);
  root.parent = parent;
  root.position.set(x, 0, -17.8);
  const half = width / 2;
  box(scene, root, `${id}-back-wall`, new Vector3(width, height, 0.2), new Vector3(0, height / 2, -4), masonry);
  box(scene, root, `${id}-interior-floor`, new Vector3(width, 0.10, 4.1), new Vector3(0, 0.01, -1.97), "timber");
  box(scene, root, `${id}-interior-ceiling`, new Vector3(width, 0.12, 4.1), new Vector3(0, 2.78, -1.97), "cream");
  for (const side of [-1, 1]) {
    box(scene, root, `${id}-side-wall-${side}`, new Vector3(0.24, height, 4.2), new Vector3(side * (half - 0.08), height / 2, -1.93), masonry);
    box(scene, root, `${id}-shop-pier-${side}`, new Vector3(0.30, 3.15, 0.32), new Vector3(side * (half - 0.15), 1.58, 0.11), color);
    box(scene, root, `${id}-pier-foot-${side}`, new Vector3(0.39, 0.18, 0.38), new Vector3(side * (half - 0.15), 0.15, 0.13), "stone");
  }
  box(scene, root, `${id}-upper-wall`, new Vector3(width, height - 3.42, 0.24), new Vector3(0, (height + 3.42) / 2, -0.01), masonry);
  box(scene, root, `${id}-fascia`, new Vector3(width + 0.05, 0.61, 0.27), new Vector3(0, 3.09, 0.17), color);
  label(scene, root, `street-${id}-name`, width - 0.38, 0.48, new Vector3(0, 3.1, 0.312), name, subtitle, colors[color]);
  for (const [index, y, depth] of [[0, 2.76, 0.37], [1, 3.44, 0.46], [2, height + 0.015, 0.39], [3, height + 0.17, 0.57]] as const) {
    box(scene, root, `${id}-cornice-${index}`, new Vector3(width + 0.2, index === 1 ? 0.12 : 0.085, depth), new Vector3(0, y, 0.11), "stone");
  }
  box(scene, root, `${id}-roof`, new Vector3(width + 0.3, 0.13, 4.45), new Vector3(0, height + 0.26, -1.95), "roof");
  const windowCount = id === "supermarket" ? 5 : 3;
  for (let window = 0; window < windowCount; window += 1) {
    const wx = -half + width * (window + 0.5) / windowCount;
    sashWindow(scene, root, `${id}-upper-${window}`, wx, 5.3, 0.15, id === "supermarket" ? 1.22 : 1.03, id === "supermarket" ? 1.36 : 1.6);
  }
  if (id !== "supermarket") {
    box(scene, root, `${id}-chimney`, new Vector3(0.51, 0.98, 0.64), new Vector3(-half + 0.7, height + 0.68, -2.3), masonry);
    for (const dx of [-0.14, 0.14]) cylinder(scene, root, `${id}-chimney-pot-${dx}`, 0.16, 0.20, 0.31, new Vector3(-half + 0.7 + dx, height + 1.27, -2.3), "terracotta");
  }

  const doorWidth = id === "supermarket" ? 2.38 : 1.02;
  const door = box(scene, root, `street-${id}-door`, new Vector3(doorWidth, 2.36, 0.1), new Vector3(doorX, 1.26, 0.10), color);
  for (const side of [-1, 1]) {
    box(scene, door, `${id}-door-jamb-${side}`, new Vector3(0.072, 2.49, 0.20), new Vector3(side * (doorWidth / 2 + 0.038), 0.01, 0.035), "cream");
    const handleX = id === "supermarket" ? side * 0.13 : side * doorWidth * 0.36;
    if (id === "supermarket" || side === -1) cylinder(scene, door, `${id}-door-handle-${side}`, 0.026, 0.026, 0.26, new Vector3(handleX, -0.21, 0.145), "brass");
  }
  box(scene, door, `${id}-door-top`, new Vector3(doorWidth + 0.17, 0.08, 0.2), new Vector3(0, 1.22, 0.04), "cream");
  box(scene, door, `${id}-door-glass`, new Vector3(doorWidth - 0.17, 1.45, 0.016), new Vector3(0, 0.28, 0.061), "windowShade");
  box(scene, door, `${id}-door-bottom-panel`, new Vector3(doorWidth - 0.2, 0.42, 0.018), new Vector3(0, -0.84, 0.063), "sageDark");
  if (id === "supermarket") box(scene, door, `${id}-double-door-meeting-stile`, new Vector3(0.035, 2.34, 0.08), new Vector3(0, 0, 0.062), "metal");
  box(scene, root, `${id}-threshold`, new Vector3(doorWidth + 0.18, 0.07, 0.32), new Vector3(doorX, 0.045, 0.2), "stoneEdge");
  const plaqueWidth = id === "supermarket" ? 1.65 : 0.9;
  const plaqueHeight = id === "supermarket" ? 0.62 : 0.59;
  box(scene, door, `street-${id}-status-frame`, new Vector3(plaqueWidth + 0.045, plaqueHeight + 0.045, 0.035), new Vector3(0, 0.23, 0.133), "brass");
  label(scene, door, `street-${id}-status`, plaqueWidth, plaqueHeight, new Vector3(0, 0.23, 0.156), "暂未开放", "等级与成就达标后可查看", "#ece4cf");
  setStreetVenueStatus(scene, id, "暂未开放", "继续经营小店，解锁街区目标", false);

  const segments = [
    { left: -half + 0.29, right: doorX - doorWidth / 2 - 0.10 },
    { left: doorX + doorWidth / 2 + 0.10, right: half - 0.29 },
  ];
  segments.forEach(({ left, right }, segment) => {
    if (right - left < 0.12) return;
    const paneWidth = right - left;
    const mid = (left + right) / 2;
    box(scene, root, `${id}-display-base-${segment}`, new Vector3(paneWidth, 0.58, 0.25), new Vector3(mid, 0.32, 0.1), color);
    box(scene, root, `${id}-display-sill-${segment}`, new Vector3(paneWidth + 0.08, 0.075, 0.35), new Vector3(mid, 0.64, 0.13), "stone");
    box(scene, root, `${id}-display-glass-${segment}`, new Vector3(paneWidth, 1.99, 0.023), new Vector3(mid, 1.66, 0.129), "glass");
    for (const edge of [left, right]) box(scene, root, `${id}-display-frame-${segment}-${edge}`, new Vector3(0.055, 2.1, 0.12), new Vector3(edge, 1.69, 0.15), color);
    const divisions = Math.max(1, Math.ceil(paneWidth / 1.7));
    for (let division = 1; division < divisions; division += 1) box(scene, root, `${id}-display-mullion-${segment}-${division}`, new Vector3(0.049, 2.04, 0.10), new Vector3(left + paneWidth * division / divisions, 1.68, 0.15), color);
    box(scene, root, `${id}-display-transom-${segment}`, new Vector3(paneWidth, 0.055, 0.11), new Vector3(mid, 2.25, 0.16), color);
  });

  if (id === "cafe") {
    box(scene, root, "cafe-service-counter", new Vector3(3.40, 0.93, 0.70), new Vector3(-0.65, 0.51, -1.32), "sageDark");
    box(scene, root, "cafe-service-top", new Vector3(3.52, 0.065, 0.77), new Vector3(-0.65, 1.01, -1.32), "timber");
    box(scene, root, "cafe-espresso-machine", new Vector3(0.60, 0.45, 0.42), new Vector3(-0.28, 1.255, -1.40), "metal");
    box(scene, root, "cafe-espresso-front", new Vector3(0.48, 0.14, 0.038), new Vector3(-0.28, 1.29, -1.166), "iron");
    for (let cup = 0; cup < 4; cup += 1) cylinder(scene, root, `cafe-cup-${cup}`, 0.06, 0.08, 0.082, new Vector3(-1.53 + cup * 0.14, 1.083, -1.13), "ivory");
    label(scene, root, "cafe-interior-menu", 1.54, 0.78, new Vector3(-0.55, 1.91, -3.86), "Coffee, please.", "A new place to practise English", "#35483c");
    for (const lx of [-1.45, 0.28]) {
      beam(scene, root, `cafe-pendant-cord-${lx}`, new Vector3(lx, 2.76, -0.92), new Vector3(lx, 2.23, -0.92), 0.01, "iron");
      cylinder(scene, root, `cafe-pendant-shade-${lx}`, 0.39, 0.08, 0.2, new Vector3(lx, 2.19, -0.92), "brass");
    }
    const awning = box(scene, root, "cafe-awning", new Vector3(3.99, 0.095, 0.83), new Vector3(-0.69, 2.70, 0.55), "sage");
    awning.rotation.x = 0.13;
    for (let stripe = 0; stripe < 9; stripe += 1) box(scene, awning, `cafe-awning-stripe-${stripe}`, new Vector3(0.18, 0.006, 0.82), new Vector3(-1.80 + stripe * 0.45, 0.0505, 0), "cream");
    box(scene, root, "cafe-awning-valance", new Vector3(4.02, 0.16, 0.035), new Vector3(-0.69, 2.575, 0.96), "sage");
    cafeTable(scene, root, -1.25, 1.28, "cafe-outside-table");
    colliders.push({ minX: x - 2.22, maxX: x - 0.28, minZ: -17.03, maxZ: -16.02 });
  } else if (id === "restaurant") {
    for (const tx of [-1.35, 0.05]) {
      box(scene, root, `restaurant-table-leg-${tx}`, new Vector3(0.10, 0.78, 0.10), new Vector3(tx, 0.44, -1.06), "timber");
      box(scene, root, `restaurant-table-${tx}`, new Vector3(0.95, 0.065, 0.76), new Vector3(tx, 0.83, -1.06), "ivory");
      cylinder(scene, root, `restaurant-plate-${tx}`, 0.24, 0.24, 0.022, new Vector3(tx, 0.878, -0.87), "cream", 20);
      cylinder(scene, root, `restaurant-vase-${tx}`, 0.07, 0.055, 0.18, new Vector3(tx, 0.95, -1.18), "terracotta");
      for (const sx of [-0.43, 0.43]) box(scene, root, `restaurant-seat-${tx}-${sx}`, new Vector3(0.28, 0.69, 0.5), new Vector3(tx + sx, 0.38, -1.08), "sageDark");
    }
    label(scene, root, "restaurant-interior-words", 2.9, 0.62, new Vector3(-0.6, 1.95, -3.86), "A table for two?", "YOUR NEXT ENGLISH ADVENTURE", "#8d5843");
    flowerBox(scene, root, "restaurant-planter", -2.22, 0.52, 0.90);
    colliders.push({ minX: x - 2.73, maxX: x - 1.71, minZ: -17.6, maxZ: -16.94 });
  } else {
    for (const sx of [-3.38, 3.38]) {
      box(scene, root, `market-display-back-${sx}`, new Vector3(2.27, 1.7, 0.11), new Vector3(sx, 1.02, -1.37), "sageDark");
      for (const y of [0.40, 0.83, 1.26, 1.69]) {
        box(scene, root, `market-shelf-${sx}-${y}`, new Vector3(2.35, 0.054, 0.49), new Vector3(sx, y, -1.12), "cream");
        for (let item = 0; item < 6; item += 1) box(scene, root, `market-stock-${sx}-${y}-${item}`, new Vector3(0.21, 0.26, 0.19), new Vector3(sx - 0.96 + item * 0.38, y + 0.17, -1.1), ["ivory", "terracotta", "sage", "ochre"][item % 4] as Paint);
      }
    }
    label(scene, root, "market-interior-words", 3.65, 0.59, new Vector3(0, 2.01, -3.85), "Room to grow.", "MORE AISLES · MORE CONVERSATIONS", "#356765");
    for (const side of [-1, 1]) {
      flowerBox(scene, root, `market-planter-${side}`, side * 4.8, 0.5, 1.4);
      colliders.push({ minX: x + side * 4.8 - 0.77, maxX: x + side * 4.8 + 0.77, minZ: -17.65, maxZ: -16.97 });
    }
  }
  // Future shops have closed doors. There is no traversable, unimplemented room.
  colliders.push({ minX: x - half - 0.12, maxX: x + half + 0.12, minZ: -22.05, maxZ: -17.52 });
  return { id: `venue-${id}`, kind: "venue", venueId: id, position: new Vector3(x + doorX, 1.5, -17.57), mesh: door };
}

function cornerShopExterior(scene: Scene, root: TransformNode): void {
  box(scene, root, "corner-shop-exterior-fascia", new Vector3(7.12, 0.56, 0.24), new Vector3(0, 3.30, -4.67), "sageDark");
  label(scene, root, "corner-shop-exterior-name", 6.65, 0.42, new Vector3(0, 3.31, -4.798), "CORNER SHOP", "你的街角小店  ·  FRESH FOOD & GOOD NEIGHBOURS", "#344a40", -1);
  box(scene, root, "corner-shop-upper-front-wall", new Vector3(7.1, 3.25, 0.22), new Vector3(0, 5.17, -4.58), "sandBrick");
  for (const x of [-2.15, 0, 2.15]) sashWindow(scene, root, `corner-shop-upper-${x}`, x, 5.16, -4.735, 1.08, 1.64, -1);
  for (const y of [3.60, 6.83]) box(scene, root, `corner-shop-exterior-cornice-${y}`, new Vector3(7.35, 0.11, 0.39), new Vector3(0, y, -4.66), "stone");
  box(scene, root, "corner-shop-upper-roof", new Vector3(7.45, 0.12, 9.6), new Vector3(0, 6.95, 0), "roof");
  for (const side of [-1, 1]) {
    box(scene, root, `corner-shop-upper-side-wall-${side}`, new Vector3(0.18, 3.76, 9.42), new Vector3(side * 3.48, 5.03, 0.1), "sandBrick");
    box(scene, root, `corner-shop-exterior-pilaster-${side}`, new Vector3(0.17, 3.30, 0.22), new Vector3(side * 3.48, 1.65, -4.68), "sage");
  }
}

function backgroundBuildings(scene: Scene, root: TransformNode, colliders: StreetCollider[]): void {
  for (const design of [
    { x: -16.8, z: -18.12, width: 5.9, height: 6.6, front: 1 },
    { x: 17.35, z: -18.12, width: 6.8, height: 7.1, front: 1 },
    { x: -10.7, z: -4.30, width: 13.9, height: 7.0, front: -1 },
    { x: 11.65, z: -4.30, width: 16.0, height: 6.35, front: -1 },
  ]) {
    const { x, z, width, height, front } = design;
    const depth = 4.7;
    const name = `street-townhouse-${x}`;
    box(scene, root, `${name}-wall`, new Vector3(width, height, depth), new Vector3(x, height / 2, z - front * depth / 2), x < 0 ? "redBrick" : "sandBrick");
    box(scene, root, `${name}-foundation`, new Vector3(width + 0.08, 0.48, 0.18), new Vector3(x, 0.26, z + front * 0.06), "stoneEdge");
    box(scene, root, `${name}-cornice`, new Vector3(width + 0.21, 0.19, depth + 0.30), new Vector3(x, height + 0.03, z - front * depth / 2), "stone");
    const count = Math.max(2, Math.floor(width / 2.2));
    for (let i = 0; i < count; i += 1) {
      const wx = x - width / 2 + width * (i + 0.5) / count;
      sashWindow(scene, root, `${name}-upper-${i}`, wx, height - 1.58, z + front * 0.08, 0.99, 1.46, front);
      sashWindow(scene, root, `${name}-lower-${i}`, wx, 1.74, z + front * 0.08, 0.94, 1.55, front);
    }
    colliders.push({ minX: x - width / 2 - 0.13, maxX: x + width / 2 + 0.13, minZ: Math.min(z, z - front * depth) - 0.12, maxZ: Math.max(z, z - front * depth) + 0.12 });
  }
}

function deliveryTruck(scene: Scene, parent: TransformNode): { truck: TransformNode; wheels: TransformNode[]; target: StreetTarget } {
  const truck = new TransformNode("daily-delivery-truck", scene);
  truck.parent = parent;
  truck.position.set(3, 0, -9.1);
  const wheels: TransformNode[] = [];
  box(scene, truck, "delivery-truck-chassis", new Vector3(4.14, 0.18, 1.44), new Vector3(0.12, 0.47, 0), "iron");
  const cargo = box(scene, truck, "delivery-truck-cargo", new Vector3(2.75, 1.69, 1.66), new Vector3(-0.55, 1.40, 0), "ivory");
  box(scene, truck, "delivery-truck-roof", new Vector3(2.81, 0.095, 1.73), new Vector3(-0.55, 2.29, 0), "cream");
  for (const side of [-1, 1]) {
    box(scene, truck, `delivery-truck-lower-trim-${side}`, new Vector3(2.8, 0.25, 0.035), new Vector3(-0.55, 0.70, side * 0.848), "teal");
    for (const x of [-1.93, 0.83]) box(scene, truck, `delivery-truck-upright-${side}-${x}`, new Vector3(0.035, 1.65, 0.043), new Vector3(x, 1.39, side * 0.845), "metal");
    label(scene, truck, `delivery-truck-brand-${side}`, 2.34, 0.83, new Vector3(-0.55, 1.67, side * 0.836), "CORNER SHOP", "DAILY DELIVERY  ·  每日新鲜送达", "#356765", side);
  }
  label(scene, truck, "delivery-truck-status", 2.34, 0.30, new Vector3(-0.55, 1.02, 0.846), "每天送到小店门口", "", "#e9e3cf");
  setDeliveryTruckStatus(scene, "每天送到小店门口");

  box(scene, truck, "delivery-truck-cab-lower", new Vector3(1.41, 0.83, 1.63), new Vector3(1.43, 0.95, 0), "teal");
  box(scene, truck, "delivery-truck-cab-upper", new Vector3(1.11, 0.87, 1.60), new Vector3(1.27, 1.75, 0), "cream");
  box(scene, truck, "delivery-truck-cab-roof", new Vector3(1.23, 0.08, 1.70), new Vector3(1.28, 2.22, 0), "ivory");
  box(scene, truck, "delivery-truck-bonnet", new Vector3(0.42, 0.25, 1.61), new Vector3(2.0, 1.27, 0), "cream");
  box(scene, truck, "delivery-truck-front-window-pane", new Vector3(0.023, 0.61, 1.35), new Vector3(1.842, 1.78, 0), "windowShade");
  box(scene, truck, "delivery-truck-windscreen-divider", new Vector3(0.034, 0.63, 0.031), new Vector3(1.861, 1.78, 0), "cream");
  for (const side of [-1, 1]) {
    box(scene, truck, `delivery-truck-side-window-pane-${side}`, new Vector3(0.90, 0.58, 0.019), new Vector3(1.25, 1.80, side * 0.808), "windowShade");
    box(scene, truck, `delivery-truck-window-glint-${side}`, new Vector3(0.07, 0.45, 0.007), new Vector3(0.92, 1.81, side * 0.821), "glass").rotation.z = 0.18;
    box(scene, truck, `delivery-truck-door-frame-${side}`, new Vector3(0.035, 0.67, 0.022), new Vector3(0.855, 1.02, side * 0.827), "sageDark");
    box(scene, truck, `delivery-truck-door-handle-${side}`, new Vector3(0.19, 0.037, 0.04), new Vector3(0.99, 1.20, side * 0.845), "metal");
    beam(scene, truck, `delivery-truck-mirror-arm-${side}`, new Vector3(1.68, 1.62, side * 0.78), new Vector3(1.79, 1.62, side * 1.03), 0.018, "iron");
    box(scene, truck, `delivery-truck-mirror-${side}`, new Vector3(0.14, 0.23, 0.085), new Vector3(1.79, 1.66, side * 1.04), "iron");
    box(scene, truck, `delivery-truck-headlamp-${side}`, new Vector3(0.034, 0.21, 0.27), new Vector3(2.143, 0.99, side * 0.54), "warmLight");
    box(scene, truck, `delivery-truck-indicator-${side}`, new Vector3(0.036, 0.09, 0.15), new Vector3(2.145, 0.80, side * 0.61), "ochre");
    box(scene, truck, `delivery-truck-tail-light-${side}`, new Vector3(0.037, 0.22, 0.13), new Vector3(-1.954, 0.72, side * 0.67), "redLight");
    for (const axle of [-1.38, 1.40]) {
      const wheel = new TransformNode(`delivery-truck-wheel-${side}-${axle}`, scene);
      wheel.parent = truck;
      wheel.position.set(axle, 0.355, side * 0.807);
      const tyre = cylinder(scene, wheel, `${wheel.name}-tyre`, 0.75, 0.75, 0.22, Vector3.Zero(), "rubber", 24);
      tyre.rotation.x = Math.PI / 2;
      const hub = cylinder(scene, wheel, `${wheel.name}-hub`, 0.41, 0.41, 0.016, new Vector3(0, 0, side * 0.12), "metal", 16);
      hub.rotation.x = Math.PI / 2;
      const cap = cylinder(scene, wheel, `${wheel.name}-hubcap`, 0.19, 0.19, 0.019, new Vector3(0, 0, side * 0.132), "cream", 16);
      cap.rotation.x = Math.PI / 2;
      for (let lug = 0; lug < 5; lug += 1) {
        const angle = lug / 5 * Math.PI * 2;
        const nut = cylinder(scene, wheel, `${wheel.name}-lug-${lug}`, 0.033, 0.033, 0.016, new Vector3(Math.cos(angle) * 0.135, Math.sin(angle) * 0.135, side * 0.135), "iron", 6);
        nut.rotation.x = Math.PI / 2;
      }
      const path = Array.from({ length: 15 }, (_, index) => {
        const angle = index / 14 * Math.PI;
        return new Vector3(axle + Math.cos(angle) * 0.45, 0.355 + Math.sin(angle) * 0.45, side * 0.836);
      });
      finish(MeshBuilder.CreateTube(`delivery-truck-wheel-arch-${side}-${axle}`, { path, radius: 0.060, tessellation: 8, cap: Mesh.CAP_ALL }, scene), truck, paint(scene, "teal"), Vector3.Zero());
      wheels.push(wheel);
    }
  }
  box(scene, truck, "delivery-truck-grille", new Vector3(0.024, 0.21, 0.57), new Vector3(2.145, 0.97, 0), "iron");
  for (const y of [0.905, 0.965, 1.025]) box(scene, truck, `delivery-truck-grille-line-${y}`, new Vector3(0.026, 0.018, 0.53), new Vector3(2.163, y, 0), "metal");
  for (const end of [-1, 1]) box(scene, truck, `delivery-truck-bumper-${end}`, new Vector3(0.16, 0.16, 1.86), new Vector3(end < 0 ? -2.01 : 2.23, 0.49, 0), "metal");
  for (const side of [-1, 1]) {
    box(scene, truck, `delivery-truck-rear-door-${side}`, new Vector3(0.031, 1.47, 0.76), new Vector3(-1.944, 1.46, side * 0.398), "cream");
    beam(scene, truck, `delivery-truck-rear-lock-${side}`, new Vector3(-1.968, 0.91, side * 0.15), new Vector3(-1.968, 1.97, side * 0.15), 0.012, "metal");
    for (const y of [0.88, 1.39, 1.93]) box(scene, truck, `delivery-truck-rear-hinge-${side}-${y}`, new Vector3(0.05, 0.037, 0.17), new Vector3(-1.975, y, side * 0.68), "iron");
  }
  const rearSign = label(scene, truck, "delivery-truck-rear-lettering", 1.28, 0.28, new Vector3(-1.966, 2.02, 0), "DAILY DELIVERY", "", "#356765");
  rearSign.rotation.y = Math.PI / 2;
  const plate = label(scene, truck, "delivery-truck-numberplate", 0.50, 0.11, new Vector3(2.15, 0.65, 0), "CS 2026", "", "#a68d50");
  plate.rotation.y = -Math.PI / 2;
  return { truck, wheels, target: { id: "daily-delivery", kind: "delivery", position: new Vector3(3, 1.2, -8.2), mesh: cargo } };
}

function pavement(scene: Scene, root: TransformNode): void {
  box(scene, root, "street-ground-floor", new Vector3(90, 0.14, 65), new Vector3(0, -0.16, -17), "sage");
  box(scene, root, "street-road-floor", new Vector3(82, 0.12, 5.72), new Vector3(0, -0.075, -11.01), "asphalt");
  for (const [side, centerZ, depth] of [["near", -6.43, 3.55], ["far", -15.9, 4.0]] as const) {
    box(scene, root, `street-${side}-pavement-floor`, new Vector3(44, 0.12, depth), new Vector3(0, -0.043, centerZ), "stone");
    for (let i = 0; i < 38; i += 1) box(scene, root, `street-${side}-paver-joint-${i}`, new Vector3(0.012, 0.0018, depth), new Vector3(-21.62 + i * 1.17, 0.018, centerZ), "mortar");
    for (let row = 1; row < 5; row += 1) box(scene, root, `street-${side}-paver-row-${row}`, new Vector3(44, 0.0018, 0.012), new Vector3(0, 0.018, centerZ - depth / 2 + row * depth / 5), "mortar");
  }
  for (const z of [-8.16, -13.87]) {
    box(scene, root, `street-curb-${z}`, new Vector3(48, 0.15, 0.18), new Vector3(0, -0.014, z), "stoneEdge");
    for (let i = 0; i < 43; i += 1) box(scene, root, `street-curb-joint-${z}-${i}`, new Vector3(0.011, 0.004, 0.182), new Vector3(-23.4 + i * 1.12, 0.063, z), "mortar");
  }
  for (let i = 0; i < 7; i += 1) box(scene, root, `street-crosswalk-${i}`, new Vector3(2.40, 0.005, 0.44), new Vector3(-1.20, -0.008, -8.61 - i * 0.79), "roadPaint");
  for (let x = -37; x < 38; x += 4) {
    if (x > -4 && x < 1) continue;
    box(scene, root, `street-lane-mark-${x}`, new Vector3(1.9, 0.004, 0.073), new Vector3(x, -0.008, -11.02), "roadPaint");
  }
  for (const z of [-8.36, -13.66]) box(scene, root, `street-road-edge-mark-${z}`, new Vector3(62, 0.003, 0.038), new Vector3(0, -0.009, z), "ochre");
  for (const x of [-6.05, 6.92]) {
    box(scene, root, `street-drain-frame-${x}`, new Vector3(0.44, 0.01, 0.20), new Vector3(x, 0.063, -8.13), "iron");
    for (let grate = 0; grate < 7; grate += 1) box(scene, root, `street-drain-grate-${x}-${grate}`, new Vector3(0.022, 0.006, 0.19), new Vector3(x - 0.18 + grate * 0.06, 0.069, -8.13), "metal");
  }
}

/** Batch opaque scenery by material, but preserve every moving/interactive hierarchy. */
function batchScenery(root: TransformNode, protectedRoots: TransformNode[]): void {
  const grouped = new Map<string, { mat: PBRMaterial; meshes: Mesh[]; floor: boolean }>();
  for (const mesh of root.getChildMeshes()) {
    if (!(mesh instanceof Mesh) || !(mesh.material instanceof PBRMaterial)) continue;
    if (protectedRoots.some((protectedRoot) => mesh === protectedRoot || mesh.isDescendantOf(protectedRoot))) continue;
    if (mesh.material.alpha < 1 || mesh.material.name.startsWith("street-print-")) continue;
    const floor = /floor|paver|curb|crosswalk|road-edge-mark|lane-mark|drain/.test(mesh.name);
    const key = `${mesh.material.uniqueId}:${floor}`;
    const group = grouped.get(key) ?? { mat: mesh.material, meshes: [], floor };
    group.meshes.push(mesh);
    grouped.set(key, group);
  }
  // Preserve world transforms before disposal: an awning's stripes and a
  // planter's rim may be children of a mesh in a different material batch.
  for (const { meshes } of grouped.values()) for (const mesh of meshes) {
    if (mesh.parent !== root) mesh.setParent(root);
  }
  for (const { mat, meshes, floor } of grouped.values()) {
    if (meshes.length < 2) continue;
    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, false);
    if (!merged) continue;
    merged.name = `street-static-${floor ? "floor-" : ""}${mat.name}`;
    merged.parent = root;
    merged.material = mat;
    merged.receiveShadows = true;
    merged.isPickable = true;
  }
}

/** Procedural, local-only high street. The shop entrance remains unobstructed. */
export function createStreet(scene: Scene): StreetEnvironment {
  const root = new TransformNode("high-street-environment", scene);
  const colliders: StreetCollider[] = [];
  const targets: StreetTarget[] = [];
  pavement(scene, root);
  cornerShopExterior(scene, root);
  backgroundBuildings(scene, root, colliders);
  for (const design of venues) targets.push(storefront(scene, root, design, colliders));
  [[-15.35, -15.05], [-0.1, -14.95], [15.35, -15.1], [-8.2, -6.4], [10.35, -6.35]].forEach(([x, z], index) => tree(scene, root, colliders, x!, z!, index));
  for (const [x, z] of [[-17.8, -7.49], [-5.7, -7.48], [8.25, -7.48], [18.7, -7.49], [-16.6, -14.45], [1.26, -14.45], [16.7, -14.45]]) lamp(scene, root, colliders, x!, z!);
  bench(scene, root, colliders, -5.10, -5.66, -1);
  bench(scene, root, colliders, 14.55, -16.5, 1);
  flowerBox(scene, root, "corner-shop-left-planter", -3.90, -5.05, 0.76);
  colliders.push({ minX: -4.35, maxX: -3.45, minZ: -5.40, maxZ: -4.69 });
  for (const side of [-1, 1]) {
    for (const z of [-6.14, -16.12]) {
      box(scene, root, `street-edge-garden-wall-${side}-${z}`, new Vector3(0.38, 0.62, 3.26), new Vector3(side * 20.2, 0.34, z), "sandBrick");
      box(scene, root, `street-edge-garden-cap-${side}-${z}`, new Vector3(0.45, 0.085, 3.34), new Vector3(side * 20.2, 0.70, z), "stone");
      for (let post = 0; post < 8; post += 1) cylinder(scene, root, `street-edge-railing-${side}-${z}-${post}`, 0.035, 0.035, 0.79, new Vector3(side * 20.2, 1.1, z - 1.4 + post * 0.40), "iron", 8);
      box(scene, root, `street-edge-top-rail-${side}-${z}`, new Vector3(0.046, 0.043, 3.14), new Vector3(side * 20.2, 1.41, z), "iron");
      colliders.push({ minX: side * 20.2 - 0.24, maxX: side * 20.2 + 0.24, minZ: z - 1.7, maxZ: z + 1.7 });
    }
  }
  // Two small receiving pads sit beside, never across, the 1.9 m entrance.
  for (const [index, x] of [1.35, 2.30].entries()) {
    const pad = box(scene, root, `street-drop-${index}`, new Vector3(0.80, 0.014, 0.68), new Vector3(x, 0.028, -6.0), "sageDark");
    for (const side of [-1, 1]) {
      box(scene, pad, `street-drop-${index}-edge-${side}`, new Vector3(0.77, 0.004, 0.018), new Vector3(0, 0.009, side * 0.31), "ochre");
      box(scene, pad, `street-drop-${index}-end-${side}`, new Vector3(0.018, 0.004, 0.62), new Vector3(side * 0.375, 0.009, 0), "ochre");
    }
    const padLabel = label(scene, pad, `street-drop-${index}-lettering`, 0.62, 0.19, new Vector3(0, 0.01, 0.05), "DELIVERY", "卸货区", "#344a40", -1);
    padLabel.rotation.x = Math.PI / 2;
    targets.push({ id: `street-drop-${index}`, kind: "drop-zone", position: new Vector3(x, 0.04, -6), mesh: pad });
  }
  const { truck, wheels, target } = deliveryTruck(scene, root);
  targets.push(target);
  batchScenery(root, [truck, ...targets.map((entry) => entry.mesh)]);
  return { root, colliders, targets, truck, wheels };
}
