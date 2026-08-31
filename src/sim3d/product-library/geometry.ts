import { Color3, DynamicTexture, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from "@babylonjs/core";

export type Point = readonly [number, number, number];
export type ProductBuilder = (scene: Scene, root: TransformNode) => void;
const materialCache = new WeakMap<Scene, Map<string, PBRMaterial>>();

function cacheFor(scene: Scene): Map<string, PBRMaterial> {
  let cache = materialCache.get(scene);
  if (!cache) { cache = new Map(); materialCache.set(scene, cache) }
  return cache;
}

export function surface(scene: Scene, key: string, colour: string, roughness = 0.65, metallic = 0): PBRMaterial {
  const cache = cacheFor(scene);
  const cacheKey = `surface:${key}:${colour}:${roughness}:${metallic}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const result = new PBRMaterial(`product-${key}`, scene);
  result.albedoColor = Color3.FromHexString(colour);
  result.roughness = roughness;
  result.metallic = metallic;
  cache.set(cacheKey, result);
  return result;
}

export function translucent(scene: Scene, key: string, colour: string, alpha = 0.24): PBRMaterial {
  const mat = surface(scene, `${key}-alpha-${alpha}`, colour, 0.16);
  mat.alpha = alpha;
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  mat.backFaceCulling = false;
  mat.twoSidedLighting = true;
  mat.clearCoat.isEnabled = true;
  mat.clearCoat.intensity = 0.45;
  return mat;
}

export function finish(mesh: Mesh, root: TransformNode, mat: PBRMaterial, position: Point = [0, 0, 0]): Mesh {
  mesh.parent = root;
  mesh.position.set(...position);
  mesh.material = mat;
  mesh.isPickable = true;
  mesh.receiveShadows = true;
  return mesh;
}

export function box(scene: Scene, root: TransformNode, name: string, size: Point, position: Point, mat: PBRMaterial): Mesh {
  return finish(MeshBuilder.CreateBox(`${root.name}-${name}`, { width: size[0], height: size[1], depth: size[2] }, scene), root, mat, position);
}

export function ellipsoid(scene: Scene, root: TransformNode, name: string, size: Point, position: Point, mat: PBRMaterial, segments = 16): Mesh {
  const mesh = finish(MeshBuilder.CreateSphere(`${root.name}-${name}`, { diameter: 1, segments }, scene), root, mat, position);
  mesh.scaling.set(...size);
  return mesh;
}

export function cylinder(scene: Scene, root: TransformNode, name: string, bottom: number, top: number, height: number, position: Point, mat: PBRMaterial, sides = 32): Mesh {
  return finish(MeshBuilder.CreateCylinder(`${root.name}-${name}`, { diameterBottom: bottom, diameterTop: top, height, tessellation: sides }, scene), root, mat, position);
}

export function lathe(scene: Scene, root: TransformNode, name: string, profile: readonly (readonly [number, number])[], mat: PBRMaterial, sides = 40): Mesh {
  return finish(MeshBuilder.CreateLathe(`${root.name}-${name}`, {
    // An exact zero-radius ring plus an automatic cap creates NaN ribbon normals.
    // A ten-micron end radius remains invisible and is closed by the real end cap.
    shape: profile.map(([radius, y]) => new Vector3(Math.max(0.00001, radius), y, 0)), tessellation: sides,
    cap: Mesh.CAP_ALL, sideOrientation: Mesh.FRONTSIDE,
  }, scene), root, mat);
}

export function tube(scene: Scene, root: TransformNode, name: string, points: readonly Point[], radius: number, mat: PBRMaterial, tessellation = 10): Mesh {
  return finish(MeshBuilder.CreateTube(`${root.name}-${name}`, {
    path: points.map((point) => new Vector3(...point)), radius, tessellation, cap: Mesh.CAP_ALL,
  }, scene), root, mat);
}

export function printedMaterial(scene: Scene, key: string, width: number, height: number, draw: (context: CanvasRenderingContext2D) => void): PBRMaterial {
  const cache = cacheFor(scene);
  const existing = cache.get(`print:${key}`);
  if (existing) return existing;
  const texture = new DynamicTexture(`product-print-${key}`, { width, height }, scene, true);
  draw(texture.getContext() as CanvasRenderingContext2D);
  texture.update();
  texture.anisotropicFilteringLevel = 4;
  const mat = new PBRMaterial(`product-label-${key}`, scene);
  mat.albedoTexture = texture;
  mat.roughness = 0.78;
  mat.metallic = 0;
  mat.backFaceCulling = false;
  mat.twoSidedLighting = true;
  cache.set(`print:${key}`, mat);
  return mat;
}

export interface LabelSpec {
  title: string;
  subtitle?: string;
  detail?: string;
  paper?: string;
  ink?: string;
  accent?: string;
  motif?: "orange" | "grain" | "leaf" | "biscuit" | "coffee" | "crisps" | "chocolate" | "none";
}

/** Original fictional packaging; labels never claim certification or use real brands. */
export function labelMaterial(scene: Scene, key: string, spec: LabelSpec): PBRMaterial {
  return printedMaterial(scene, key, 512, 768, (ctx) => {
    const paper = spec.paper ?? "#f5efdc";
    const ink = spec.ink ?? "#2d483b";
    const accent = spec.accent ?? "#c09a50";
    ctx.fillStyle = paper; ctx.fillRect(0, 0, 512, 768);
    ctx.fillStyle = accent; ctx.fillRect(0, 0, 512, 16); ctx.fillRect(0, 704, 512, 64);
    ctx.textAlign = "center"; ctx.fillStyle = ink;
    ctx.font = "600 22px Georgia, serif"; ctx.fillText("CORNER SHOP", 256, 78);
    ctx.fillRect(152, 101, 208, 2);
    ctx.font = "bold 57px Arial, sans-serif";
    const words = spec.title.split("\n");
    words.forEach((word, index) => ctx.fillText(word, 256, 200 + index * 63, 440));
    ctx.font = "21px Arial, sans-serif"; ctx.fillText(spec.subtitle ?? "", 256, words.length > 1 ? 309 : 273, 438);
    const cx = 256; const cy = 456;
    ctx.strokeStyle = accent; ctx.fillStyle = accent; ctx.lineWidth = 5;
    if (spec.motif === "orange") {
      ctx.beginPath(); ctx.arc(cx, cy, 90, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = paper; ctx.lineWidth = 5;
      for (let i = 0; i < 8; i += 1) {
        const a = i * Math.PI / 4;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * 79, cy + Math.sin(a) * 79); ctx.stroke();
      }
    } else if (spec.motif === "grain" || spec.motif === "leaf") {
      ctx.beginPath(); ctx.moveTo(cx - 43, cy + 80); ctx.quadraticCurveTo(cx, cy, cx + 47, cy - 84); ctx.stroke();
      for (let i = 0; i < 5; i += 1) for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.ellipse(cx - 21 + i * 13 + side * 18, cy + 43 - i * 27, spec.motif === "leaf" ? 30 : 21, 10, side * 0.75, 0, Math.PI * 2); ctx.fill();
      }
    } else if (spec.motif === "biscuit" || spec.motif === "crisps") {
      for (let i = 0; i < 3; i += 1) {
        ctx.fillStyle = i === 1 ? "#deb868" : accent;
        ctx.beginPath(); ctx.ellipse(cx - 61 + i * 60, cy + (i === 1 ? -25 : 20), 49, spec.motif === "crisps" ? 67 : 49, (i - 1) * 0.38, 0, Math.PI * 2); ctx.fill();
        if (spec.motif === "biscuit") {
          ctx.fillStyle = ink;
          for (let j = 0; j < 5; j += 1) { ctx.beginPath(); ctx.arc(cx - 61 + i * 60 + Math.cos(j * 1.25) * 25, cy + (i === 1 ? -25 : 20) + Math.sin(j * 1.25) * 25, 4, 0, Math.PI * 2); ctx.fill() }
        }
      }
    } else if (spec.motif === "coffee") {
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.ellipse(cx + side * 42, cy, 39, 67, side * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = paper; ctx.beginPath(); ctx.moveTo(cx + side * 42 - 16, cy + 47); ctx.quadraticCurveTo(cx + side * 42 + 20, cy, cx + side * 42 + 12, cy - 45); ctx.stroke();
      }
    } else if (spec.motif === "chocolate") {
      for (let x = 0; x < 3; x += 1) for (let y = 0; y < 2; y += 1) { ctx.fillRect(150 + x * 73, 400 + y * 70, 67, 62) }
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, 57, 0, Math.PI * 2); ctx.stroke();
      ctx.font = "italic 35px Georgia, serif"; ctx.fillText("cs", cx, cy + 10);
    }
    ctx.fillStyle = ink; ctx.font = "26px Arial, sans-serif"; ctx.fillText(spec.detail ?? "", 256, 626, 448);
    ctx.font = "17px Arial, sans-serif"; ctx.fillText("TRAINING PRODUCT", 256, 676);
  });
}

export function labelPlane(scene: Scene, root: TransformNode, name: string, width: number, height: number, position: Point, mat: PBRMaterial, rotation: Point = [0, 0, 0]): Mesh {
  const mesh = finish(MeshBuilder.CreatePlane(`${root.name}-${name}`, { width, height }, scene), root, mat, position);
  mesh.rotation.set(...rotation);
  return mesh;
}

export function mergeParts(root: TransformNode): void {
  const groups = new Map<PBRMaterial, Map<string, Mesh[]>>();
  for (const mesh of root.getChildMeshes()) {
    if (!(mesh instanceof Mesh) || !(mesh.material instanceof PBRMaterial)) continue;
    mesh.computeWorldMatrix(true);
    // Sculpted leaves, vertex-coloured skin and primitives have different layouts.
    // Merge only compatible buffers; never drop colours or fabricate texture UVs.
    const layout = mesh.getVerticesDataKinds().sort().join(",");
    const layouts = groups.get(mesh.material) ?? new Map<string, Mesh[]>();
    const parts = layouts.get(layout) ?? [];
    parts.push(mesh); layouts.set(layout, parts); groups.set(mesh.material, layouts);
  }
  for (const [mat, layouts] of groups) for (const parts of layouts.values()) {
    if (parts.length < 2) continue;
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    if (merged) { merged.name = `${root.name}-${mat.name}`; finish(merged, root, mat) }
  }
}
