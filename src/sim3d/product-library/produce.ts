import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import { cylinder, ellipsoid, finish, labelMaterial, labelPlane, lathe, surface, tube, type Point, type ProductBuilder } from "./geometry";

function meshFromData(scene: Scene, root: TransformNode, name: string, positions: number[], indices: number[], mat: PBRMaterial, colours?: number[]): Mesh {
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions; data.indices = indices; data.normals = normals;
  if (colours) data.colors = colours;
  const mesh = new Mesh(`${root.name}-${name}`, scene);
  data.applyToMesh(mesh);
  return finish(mesh, root, mat);
}

/** Lobes, dimples and small deterministic surface variation are actual geometry. */
function fruit(scene: Scene, root: TransformNode, name: string, size: Point, position: Point, kind: "apple" | "orange" | "tomato" | "potato", seed = 0): Mesh {
  const palette = {
    apple: ["#ae3430", "#d46a3b", 0.38], orange: ["#d87518", "#eda42a", 0.73],
    tomato: ["#bc3525", "#e25832", 0.4], potato: ["#aa8555", "#cead77", 0.9],
  } as const;
  const [dark, light, roughness] = palette[kind];
  const a = Color3.FromHexString(dark); const b = Color3.FromHexString(light);
  const positions: number[] = []; const indices: number[] = []; const colours: number[] = [];
  const rings = 28; const sides = 48;
  for (let ring = 0; ring <= rings; ring += 1) {
    const v = ring / rings; const polar = v * Math.PI;
    for (let side = 0; side <= sides; side += 1) {
      const angle = side / sides * Math.PI * 2;
      const lobe = kind === "apple" ? 0.042 * Math.cos(angle * 5) * (0.25 + Math.abs(Math.cos(polar)))
        : kind === "tomato" ? 0.04 * Math.cos(angle * 6) : 0;
      const irregular = kind === "potato" ? 0.047 * Math.sin(angle * 3 + seed + v * 7) + 0.025 * Math.cos(angle * 5 - v * 9)
        : kind === "orange" ? 0.006 * Math.sin(angle * 29 + ring * 9) : 0.002 * Math.sin(angle * 23 + ring * 3);
      const shoulder = kind === "apple" ? 1 + Math.cos(polar) * 0.1 : 1;
      const radius = Math.sin(polar) * (1 + lobe + irregular) * shoulder;
      const dimple = kind === "apple" || kind === "tomato" ? 0.006 * Math.exp(-((v / 0.115) ** 2)) : 0.001;
      const x = Math.cos(angle) * radius * size[0] / 2;
      const y = (Math.cos(polar) + 1) * size[1] / 2 - dimple;
      const z = Math.sin(angle) * radius * size[2] / 2;
      positions.push(x + position[0], y + position[1], z + position[2]);
      const fleck = (Math.sin(side * 7.13 + ring * 17.7 + seed) + 1) * 0.5;
      const blend = kind === "apple" ? Math.min(1, 0.14 + 0.38 * (Math.sin(angle * 11 + v * 5) + 1) / 2 + fleck * 0.14)
        : 0.21 + fleck * (kind === "potato" ? 0.44 : 0.3);
      const colour = Color3.Lerp(a, b, blend);
      colours.push(colour.r, colour.g, colour.b, 1);
      if (ring < rings && side < sides) {
        const i = ring * (sides + 1) + side;
        indices.push(i, i + sides + 1, i + 1, i + 1, i + sides + 1, i + sides + 2);
      }
    }
  }
  return meshFromData(scene, root, name, positions, indices, surface(scene, `${kind}-skin`, "#ffffff", roughness), colours);
}

function smallLeaf(scene: Scene, root: TransformNode, name: string, start: Point, end: Point, width: number, mat: PBRMaterial): void {
  const origin = new Vector3(...start); const tip = new Vector3(...end); const axis = tip.subtract(origin);
  let side = Vector3.Cross(axis, Vector3.Up());
  if (side.lengthSquared() < 0.00001) side = Vector3.Right();
  side.normalize();
  const positions: number[] = []; const indices: number[] = [];
  for (let row = 0; row <= 8; row += 1) for (let col = 0; col <= 4; col += 1) {
    const t = row / 8; const across = col / 2 - 1;
    const p = origin.add(axis.scale(t)).add(side.scale(across * width * Math.sin(Math.PI * t) / 2));
    p.y += 0.003 * Math.sin(Math.PI * t) * (1 - across * across);
    positions.push(p.x, p.y, p.z);
    if (row < 8 && col < 4) { const i = row * 5 + col; indices.push(i, i + 5, i + 1, i + 1, i + 5, i + 6) }
  }
  mat.backFaceCulling = false;
  mat.twoSidedLighting = true;
  meshFromData(scene, root, name, positions, indices, mat);
}

function apple(scene: Scene, root: TransformNode): void {
  fruit(scene, root, "dimpled-apple", [0.078, 0.076, 0.078], [0, 0.001, 0], "apple");
  const brown = surface(scene, "apple-stem", "#604b2c", 0.9);
  tube(scene, root, "stem", [[0, 0.069, 0], [0.002, 0.079, 0.001], [0.006, 0.088, 0.002]], 0.0018, brown);
  smallLeaf(scene, root, "leaf", [0.003, 0.081, 0.001], [0.028, 0.086, 0.008], 0.013, surface(scene, "apple-leaf", "#4c6832", 0.8));
  tube(scene, root, "leaf-vein", [[0.003, 0.082, 0.001], [0.017, 0.088, 0.005], [0.028, 0.087, 0.008]], 0.0003, surface(scene, "apple-vein", "#8c9c49", 0.83), 6);
}

function orange(scene: Scene, root: TransformNode): void {
  fruit(scene, root, "pored-orange", [0.082, 0.079, 0.082], [0, 0.001, 0], "orange");
  const green = surface(scene, "orange-calyx", "#667c39", 0.92);
  ellipsoid(scene, root, "stem-scar", [0.011, 0.002, 0.011], [0, 0.0794, 0], green);
  cylinder(scene, root, "short-stem", 0.003, 0.002, 0.005, [0, 0.082, 0], surface(scene, "orange-stem", "#86703d", 0.88));
  for (let i = 0; i < 5; i += 1) {
    const a = i / 5 * Math.PI * 2;
    smallLeaf(scene, root, `calyx-${i}`, [0, 0.08, 0], [Math.cos(a) * 0.009, 0.0775, Math.sin(a) * 0.009], 0.005, green);
  }
}

function tomato(scene: Scene, root: TransformNode): void {
  fruit(scene, root, "lobed-tomato", [0.083, 0.061, 0.083], [0, 0.001, 0], "tomato");
  const green = surface(scene, "tomato-calyx", "#45623c", 0.78);
  tube(scene, root, "stem", [[0, 0.056, 0], [0.001, 0.064, 0], [0.008, 0.07, 0.002]], 0.0025, green);
  for (let i = 0; i < 5; i += 1) {
    const a = i / 5 * Math.PI * 2 + 0.15;
    smallLeaf(scene, root, `pointed-sepal-${i}`, [0, 0.059, 0], [Math.cos(a) * 0.027, 0.052, Math.sin(a) * 0.027], 0.012, green);
    tube(scene, root, `sepal-rib-${i}`, [[0, 0.06, 0], [Math.cos(a) * 0.014, 0.061, Math.sin(a) * 0.014], [Math.cos(a) * 0.026, 0.053, Math.sin(a) * 0.026]], 0.0007, green, 6);
  }
}

function banana(scene: Scene, root: TransformNode): void {
  const peel = surface(scene, "banana-peel", "#e6c548", 0.59);
  const seam = surface(scene, "banana-ridge", "#d3ad36", 0.7);
  const end = surface(scene, "banana-tips", "#665331", 0.88);
  const stalk = surface(scene, "banana-stalk", "#a4a054", 0.85);
  for (let finger = 0; finger < 3; finger += 1) {
    const path: Vector3[] = [];
    for (let i = 0; i <= 22; i += 1) {
      const t = i / 22;
      path.push(new Vector3(-0.087 + t * (0.171 + finger * 0.005), 0.019 + 0.065 * (2 * t - 1) ** 2 + (finger % 2) * 0.009, (finger - 1) * 0.033 * Math.sin(t * Math.PI / 2) + 0.009 * Math.sin(t * Math.PI)));
    }
    const radiusAt = (index: number): number => 0.004 + 0.0105 * Math.sin(index / 22 * Math.PI) ** 0.42;
    const body = MeshBuilder.CreateTube(`${root.name}-curved-banana-${finger}`, { path, radiusFunction: radiusAt, tessellation: 10, cap: Mesh.CAP_ALL }, scene);
    finish(body, root, peel);
    for (const side of [-1, 1]) {
      const crease = path.slice(2, -2).map((p, i) => [p.x, p.y + radiusAt(i + 2) * 0.75, p.z + side * radiusAt(i + 2) * 0.64] as Point);
      tube(scene, root, `longitudinal-ridge-${finger}-${side}`, crease, 0.00048, seam, 6);
    }
    const first = path[0]!; const last = path[path.length - 1]!;
    tube(scene, root, `heel-${finger}`, [[first.x, first.y, first.z], [first.x - 0.008, first.y + 0.014, first.z]], 0.0045, stalk);
    tube(scene, root, `dark-tip-${finger}`, [[last.x, last.y, last.z], [last.x + 0.003, last.y + 0.006, last.z]], 0.0038, end);
  }
  tube(scene, root, "joined-bunch-stalk", [[-0.096, 0.088, 0], [-0.10, 0.112, 0.001]], 0.008, stalk, 12);
  tube(scene, root, "cut-stalk-end", [[-0.10, 0.111, 0.001], [-0.10, 0.114, 0.001]], 0.0076, end, 12);
}

function potato(scene: Scene, root: TransformNode): void {
  const paper = surface(scene, "potato-kraft", "#b79965", 0.98);
  const darkPaper = surface(scene, "potato-kraft-fold", "#8f744b", 0.99);
  const profile = [[0, 0], [0.039, 0], [0.06, 0.006], [0.074, 0.045], [0.071, 0.103], [0.065, 0.134], [0.066, 0.139]];
  const bag = finish(MeshBuilder.CreateLathe(`${root.name}-open-paper-bag`, {
    shape: profile.map(([r, y]) => new Vector3(r!, y!, 0)), tessellation: 32, cap: Mesh.NO_CAP, sideOrientation: Mesh.DOUBLESIDE,
  }, scene), root, paper);
  bag.scaling.z = 0.63;
  const rim: Point[] = Array.from({ length: 33 }, (_, i) => [Math.cos(i / 32 * Math.PI * 2) * 0.066, 0.139 + Math.sin(i * 1.9) * 0.001, Math.sin(i / 32 * Math.PI * 2) * 0.0416]);
  tube(scene, root, "rolled-paper-rim", rim, 0.002, darkPaper, 8);
  const potatoes: { size: Point; position: Point }[] = [
    { size: [0.071, 0.056, 0.055], position: [-0.026, 0.116, -0.014] },
    { size: [0.062, 0.062, 0.057], position: [0.026, 0.117, 0.013] },
    { size: [0.064, 0.049, 0.058], position: [-0.02, 0.104, 0.017] },
    { size: [0.056, 0.056, 0.049], position: [0.023, 0.109, -0.02] },
  ];
  const eye = surface(scene, "potato-eye", "#8d6c42", 0.99);
  potatoes.forEach(({ size, position }, index) => {
    fruit(scene, root, `potato-${index}`, size, position, "potato", index * 2);
    for (let dot = 0; dot < 3; dot += 1) {
      const a = 1 + dot * 1.9; const polar = 0.35 + dot * 0.26;
      ellipsoid(scene, root, `eye-${index}-${dot}`, [0.0022, 0.0008, 0.0014], [position[0] + Math.cos(a) * Math.sin(polar) * size[0] / 2, position[1] + (Math.cos(polar) + 1) * size[1] / 2, position[2] + Math.sin(a) * Math.sin(polar) * size[2] / 2], eye, 6);
    }
  });
  for (const side of [-1, 1]) tube(scene, root, `paper-fold-${side}`, [[side * 0.049, 0.014, -0.027], [side * 0.065, 0.069, -0.028], [side * 0.058, 0.129, -0.026]], 0.0008, darkPaper, 6);
  labelPlane(scene, root, "produce-label", 0.077, 0.098, [0, 0.068, -0.047], labelMaterial(scene, "potato-label", { title: "POTATOES", subtitle: "PANTRY FAVOURITES", detail: "1 kg", accent: "#9e793b", motif: "leaf" }));
}

function carrot(scene: Scene, root: TransformNode): void {
  const orangeMat = surface(scene, "carrot-skin", "#d77d2c", 0.79);
  const dark = surface(scene, "carrot-root-lines", "#b66225", 0.91);
  lathe(scene, root, "tapered-root", [[0.0008, 0], [0.0024, 0.014], [0.006, 0.047], [0.012, 0.092], [0.0195, 0.143], [0.023, 0.169], [0.02, 0.184], [0.012, 0.189], [0, 0.19]], orangeMat, 36);
  for (let ring = 0; ring < 8; ring += 1) {
    const y = 0.035 + ring * 0.019;
    const radius = y < 0.14 ? 0.0044 + (y - 0.035) * 0.139 : 0.0208;
    const points: Point[] = Array.from({ length: 8 }, (_, i) => {
      const a = Math.PI * 1.16 + i * 0.108;
      return [Math.cos(a) * (radius + 0.0005), y + Math.sin(i * 0.5 + ring) * 0.0011, Math.sin(a) * (radius + 0.0005)];
    });
    tube(scene, root, `growth-mark-${ring}`, points, 0.0006, dark, 6);
  }
  const green = surface(scene, "carrot-leaf", "#506e35", 0.86);
  const stem = surface(scene, "carrot-stalk", "#6e883c", 0.84);
  for (let i = 0; i < 5; i += 1) {
    const a = i * 2.399; const x = Math.cos(a) * 0.017; const z = Math.sin(a) * 0.017;
    const y = 0.225 + (i % 3) * 0.007;
    tube(scene, root, `stalk-${i}`, [[0, 0.187, 0], [x * 0.6, 0.211, z * 0.6], [x, y, z]], 0.00135, stem, 8);
    for (const side of [-1, 1]) smallLeaf(scene, root, `leaf-${i}-${side}`, [x * 0.6, 0.211, z * 0.6], [x + side * 0.009, y - 0.005, z + side * 0.004], 0.007, green);
  }
}

function cucumber(scene: Scene, root: TransformNode): void {
  const skin = surface(scene, "cucumber-skin", "#365b31", 0.64);
  const highlight = surface(scene, "cucumber-stripe", "#547341", 0.71);
  const path: Vector3[] = [];
  const radiusAt = (index: number): number => 0.003 + 0.019 * Math.sin(index / 24 * Math.PI) ** 0.31;
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    path.push(new Vector3(Math.sin(t * Math.PI) * 0.006, 0.006 + t * 0.216, 0));
  }
  const body = MeshBuilder.CreateTube(`${root.name}-curved-cucumber`, { path, radiusFunction: radiusAt, tessellation: 32, cap: Mesh.CAP_ALL }, scene);
  finish(body, root, skin);
  // The scattered subtle light/dark pores remain part of the shared skin mesh.
  const vertices = body.getVerticesData(VertexBuffer.PositionKind)!;
  const colours: number[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    const shade = 0.9 + ((Math.sin(i * 9.27) + 1) / 2) * 0.16;
    colours.push(shade, shade, shade, 1);
  }
  body.setVerticesData(VertexBuffer.ColorKind, colours);
  for (let stripe = 0; stripe < 7; stripe += 1) {
    const a = stripe / 7 * Math.PI * 2;
    const points: Point[] = path.slice(2, -2).map((p, i) => [p.x + Math.cos(a) * radiusAt(i + 2), p.y, Math.sin(a) * radiusAt(i + 2)]);
    tube(scene, root, `subtle-long-ridge-${stripe}`, points, 0.00055, highlight, 6);
  }
  tube(scene, root, "cut-stem", [[0, 0.221, 0], [-0.0015, 0.23, 0.001]], 0.0024, surface(scene, "cucumber-stem", "#839155", 0.91), 8);
}

function lettuce(scene: Scene, root: TransformNode): void {
  const mats = [surface(scene, "lettuce-outer-leaf", "#5d803f", 0.88), surface(scene, "lettuce-middle-leaf", "#82a453", 0.86), surface(scene, "lettuce-heart-leaf", "#b7c77c", 0.87)];
  const vein = surface(scene, "lettuce-vein", "#bfcb89", 0.87);
  const rows = 16; const cols = 14;
  for (let leaf = 0; leaf < 13; leaf += 1) {
    const layer = leaf < 5 ? 0 : leaf < 10 ? 1 : 2;
    const radius = [0.08, 0.063, 0.045][layer]!;
    const base = [0.008, 0.02, 0.03][layer]!;
    const angle = leaf * 2.399;
    const leafPoint = (t: number, across: number): Point => {
      const beta = 0.07 + t * 2.34;
      // Lettuce tips are broad and softly scalloped, not pointed artichoke scales.
      const spread = Math.sin(Math.PI * t * 0.8) ** 0.65;
      const theta = angle + across * 0.97 * spread;
      const frill = (Math.sin(t * 43 + leaf * 2) * 0.002 + Math.cos(across * 27) * 0.002) * Math.abs(across) ** 3
        + Math.sin(t * 29 + across * 17 + leaf) * 0.0012 * Math.sin(Math.PI * t);
      const r = radius * Math.sin(beta) + frill;
      const y = base + radius * (1 - Math.cos(beta)) * 0.77 + frill * 0.8 - across * across * spread * 0.008 - across * across * t ** 3 * 0.009;
      return [Math.cos(theta) * r, y, Math.sin(theta) * r];
    };
    const positions: number[] = []; const indices: number[] = [];
    for (let row = 0; row <= rows; row += 1) for (let col = 0; col <= cols; col += 1) {
      positions.push(...leafPoint(row / rows, col / cols * 2 - 1));
      if (row < rows && col < cols) { const i = row * (cols + 1) + col; indices.push(i, i + 1, i + cols + 1, i + 1, i + cols + 2, i + cols + 1) }
    }
    const mat = mats[layer]!; mat.backFaceCulling = false; mat.twoSidedLighting = true;
    meshFromData(scene, root, `ruffled-leaf-${leaf}`, positions, indices, mat);
    const central: Point[] = Array.from({ length: 13 }, (_, i) => {
      const p = leafPoint(0.02 + i / 12 * 0.91, 0);
      return [p[0] * 1.006, p[1] + 0.0006, p[2] * 1.006];
    });
    tube(scene, root, `midrib-${leaf}`, central, layer === 0 ? 0.00075 : 0.0005, vein, 6);
    if (layer < 2) for (let branch = 0; branch < 3; branch += 1) for (const side of [-1, 1]) {
      const t = 0.3 + branch * 0.19;
      const points: Point[] = Array.from({ length: 5 }, (_, i) => {
        const p = leafPoint(t + i * 0.03, side * i * 0.18);
        return [p[0] * 1.007, p[1] + 0.0006, p[2] * 1.007];
      });
      tube(scene, root, `vein-${leaf}-${branch}-${side}`, points, 0.00025, vein, 5);
    }
  }
  cylinder(scene, root, "cut-lettuce-base", 0.024, 0.038, 0.012, [0, 0.006, 0], surface(scene, "lettuce-base", "#d4d4a0", 0.95));
}

export const PRODUCE_BUILDERS = { apple, banana, orange, tomato, potato, carrot, lettuce, cucumber } satisfies Record<"apple" | "banana" | "orange" | "tomato" | "potato" | "carrot" | "lettuce" | "cucumber", ProductBuilder>;
