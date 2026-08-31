import { Mesh, VertexData, type PBRMaterial, type Scene, type TransformNode } from "@babylonjs/core";
import {
  box, cylinder, ellipsoid, finish, labelMaterial, labelPlane, lathe, printedMaterial,
  surface, translucent, tube, type Point, type ProductBuilder,
} from "./geometry";

/** Metres, bottom-centred, with the principal readable label facing -Z. */
type PackagedId = "water" | "orange-juice" | "cola" | "crisps" | "biscuits"
  | "chocolate" | "yoghurt" | "cheese" | "butter" | "eggs";
type Ring = readonly [y: number, halfWidth: number, halfDepth: number];

function meshFromData(
  scene: Scene, root: TransformNode, name: string, positions: number[], indices: number[],
  uvs: number[], mat: PBRMaterial,
): Mesh {
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = uvs;
  const mesh = new Mesh(`${root.name}-${name}`, scene);
  data.applyToMesh(mesh);
  return finish(mesh, root, mat);
}

/** Flat-shaded, closed convex packaging folds; orient each face away from its interior. */
function solidFaces(
  scene: Scene, root: TransformNode, name: string, faces: readonly (readonly Point[])[],
  interior: Point, mat: PBRMaterial,
): Mesh {
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  for (const face of faces) {
    const points = [...face];
    const [a, b, c] = [points[0]!, points[1]!, points[2]!];
    const ab = a.map((value, i) => value - b[i]!) as [number, number, number];
    const cb = c.map((value, i) => value - b[i]!) as [number, number, number];
    // Babylon's left-handed face normal is (a - b) cross (c - b).
    const normal: Point = [ab[1] * cb[2] - ab[2] * cb[1], ab[2] * cb[0] - ab[0] * cb[2], ab[0] * cb[1] - ab[1] * cb[0]];
    const centre = [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis]!, 0) / points.length);
    if (normal.reduce((sum, value, axis) => sum + value * (centre[axis]! - interior[axis]!), 0) < 0) points.reverse();
    const start = positions.length / 3;
    points.forEach((point, index) => {
      positions.push(...point);
      uvs.push(index === 1 || index === 2 ? 1 : 0, index >= 2 ? 1 : 0);
    });
    for (let i = 1; i < points.length - 1; i += 1) indices.push(start, start + i, start + i + 1);
  }
  return meshFromData(scene, root, name, positions, indices, uvs, mat);
}

/** A welded ring surface with separate, closed end caps; not a squashed sphere. */
function pillowBody(scene: Scene, root: TransformNode, name: string, rings: readonly Ring[], mat: PBRMaterial): Mesh {
  const sides = 40;
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  for (let row = 0; row < rings.length; row += 1) {
    const [y, rx, rz] = rings[row]!;
    for (let side = 0; side < sides; side += 1) {
      const theta = side / sides * Math.PI * 2;
      const sin = Math.sin(theta), cos = Math.cos(theta);
      positions.push(Math.sign(sin) * Math.abs(sin) ** 0.55 * rx, y, -Math.sign(cos) * Math.abs(cos) ** 0.55 * rz);
      uvs.push(side / sides, row / (rings.length - 1));
      if (row < rings.length - 1) {
        const a = row * sides + side, b = row * sides + (side + 1) % sides;
        indices.push(a, b, b + sides, a, b + sides, a + sides);
      }
    }
  }
  for (const row of [0, rings.length - 1]) {
    const centre = positions.length / 3;
    positions.push(0, rings[row]![0], 0); uvs.push(0.5, 0.5);
    const rim = positions.length / 3;
    for (let side = 0; side < sides; side += 1) {
      const source = (row * sides + side) * 3;
      positions.push(positions[source]!, positions[source + 1]!, positions[source + 2]!);
      uvs.push(0.5, 0.5);
    }
    for (let side = 0; side < sides; side += 1) {
      const a = rim + side, b = rim + (side + 1) % sides;
      if (row === 0) indices.push(centre, b, a); else indices.push(centre, a, b);
    }
  }
  return meshFromData(scene, root, name, positions, indices, uvs, mat);
}

/** UVs remain upright on curved front labels rather than floating in front of a bottle. */
function printedGrid(
  scene: Scene, root: TransformNode, name: string, columns: number, rows: number,
  point: (u: number, v: number) => Point, mat: PBRMaterial,
): Mesh {
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  for (let y = 0; y <= rows; y += 1) for (let x = 0; x <= columns; x += 1) {
    positions.push(...point(x / columns, y / rows)); uvs.push(x / columns, y / rows);
    if (x < columns && y < rows) {
      const a = y * (columns + 1) + x, c = a + columns + 2;
      indices.push(a, a + 1, c, a, c, c - 1);
    }
  }
  return meshFromData(scene, root, name, positions, indices, uvs, mat);
}

function bottleLabel(
  scene: Scene, root: TransformNode, name: string, bottom: number, top: number,
  bottomRadius: number, topRadius: number, mat: PBRMaterial, halfAngle = 1.08,
): void {
  printedGrid(scene, root, name, 24, 1, (u, v) => {
    const theta = (u * 2 - 1) * halfAngle;
    const radius = bottomRadius + (topRadius - bottomRadius) * v;
    return [Math.sin(theta) * radius, bottom + (top - bottom) * v, -Math.cos(theta) * radius];
  }, mat);
}

function ringPoints(radius: number, y: number, z = 0, zRadius = radius, steps = 40): Point[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = index % steps / steps * Math.PI * 2;
    return [Math.sin(angle) * radius, y, z + Math.cos(angle) * zRadius] as Point;
  });
}

function screwCap(
  scene: Scene, root: TransformNode, key: string, anchor: Point, diameter: number, height: number,
  tilt: number, mat: PBRMaterial, collar: PBRMaterial,
): void {
  const place = (x: number, y: number, z: number): Point => [
    anchor[0] + x, anchor[1] + Math.cos(tilt) * y - Math.sin(tilt) * z,
    anchor[2] + Math.sin(tilt) * y + Math.cos(tilt) * z,
  ];
  cylinder(scene, root, `${key}-tamper-ring`, diameter * 1.08, diameter * 1.08, 0.003, place(0, 0.0015, 0), collar).rotation.x = tilt;
  cylinder(scene, root, `${key}-screw-cap`, diameter, diameter, height - 0.002, place(0, (height + 0.002) / 2, 0), mat).rotation.x = tilt;
  for (let index = 0; index < 28; index += 1) {
    const theta = index / 28 * Math.PI * 2, radius = diameter / 2;
    tube(scene, root, `${key}-grip-${index}`, [
      place(Math.sin(theta) * radius, 0.004, Math.cos(theta) * radius),
      place(Math.sin(theta) * radius, height - 0.0015, Math.cos(theta) * radius),
    ], 0.0004, mat, 5);
  }
}

function landscapeLabel(
  scene: Scene, key: string, title: string, subtitle: string, paper: string, ink: string, accent: string,
): PBRMaterial {
  return printedMaterial(scene, key, 1024, 512, (ctx) => {
    ctx.fillStyle = paper; ctx.fillRect(0, 0, 1024, 512);
    ctx.strokeStyle = accent; ctx.lineWidth = 7; ctx.strokeRect(22, 22, 980, 468);
    ctx.textAlign = "center"; ctx.fillStyle = ink;
    ctx.font = "600 37px Georgia, serif"; ctx.fillText("CORNER SHOP", 512, 112);
    ctx.fillStyle = accent; ctx.fillRect(405, 143, 214, 3);
    ctx.fillStyle = ink; ctx.font = "bold 122px Arial, sans-serif"; ctx.fillText(title, 512, 298, 906);
    ctx.font = "32px Arial, sans-serif"; ctx.fillText(subtitle, 512, 385, 918);
    ctx.font = "22px Arial, sans-serif"; ctx.fillText("TRAINING PRODUCT", 512, 444);
  });
}

const water: ProductBuilder = (scene, root) => {
  const glass = translucent(scene, "water-bottle-pet", "#c0dddd", 0.24);
  const liquid = translucent(scene, "water-liquid", "#a8d1cf", 0.20);
  const rib = translucent(scene, "water-rib-highlights", "#e0efeb", 0.39);
  const teal = surface(scene, "water-teal-cap", "#347f80", 0.36);
  const collar = surface(scene, "water-tamper-collar", "#96bdb6", 0.49);
  lathe(scene, root, "water-pet-bottle", [
    [0.024, 0], [0.030, 0.004], [0.033, 0.012], [0.033, 0.025], [0.0316, 0.029],
    [0.033, 0.033], [0.033, 0.050], [0.0317, 0.054], [0.033, 0.059],
    [0.033, 0.155], [0.032, 0.159], [0.033, 0.164], [0.031, 0.185],
    [0.0275, 0.196], [0.019, 0.210], [0.012, 0.216], [0.0115, 0.225],
  ], glass, 48);
  lathe(scene, root, "water-filled-volume", [
    [0.024, 0.006], [0.0304, 0.015], [0.0304, 0.175], [0.029, 0.187],
  ], liquid, 40);
  for (const y of [0.024, 0.049, 0.154, 0.170]) tube(scene, root, `water-moulded-rib-${y}`, ringPoints(0.03265, y), 0.0007, rib, 7);
  for (let index = 0; index < 5; index += 1) {
    const angle = index / 5 * Math.PI * 2;
    ellipsoid(scene, root, `water-base-foot-${index}`, [0.016, 0.006, 0.014], [Math.sin(angle) * 0.021, 0.004, Math.cos(angle) * 0.021], glass, 12);
  }
  screwCap(scene, root, "water", [0, 0.222, 0], 0.026, 0.018, 0, teal, collar);
  const print = printedMaterial(scene, "water-front-print", 512, 768, (ctx) => {
    ctx.fillStyle = "#edf1e5"; ctx.fillRect(0, 0, 512, 768);
    ctx.fillStyle = "#38817c"; ctx.fillRect(0, 0, 512, 17); ctx.fillRect(0, 688, 512, 80);
    ctx.textAlign = "center"; ctx.fillStyle = "#25575a";
    ctx.font = "600 24px Georgia, serif"; ctx.fillText("CORNER SHOP", 256, 90);
    ctx.font = "bold 55px Arial, sans-serif"; ctx.fillText("SPARKLING", 256, 220, 458); ctx.fillText("WATER", 256, 293);
    ctx.font = "23px Arial, sans-serif"; ctx.fillText("LIGHT & BUBBLY", 256, 358);
    ctx.strokeStyle = "#6fa49a"; ctx.lineWidth = 5;
    for (const [x, y, r] of [[218, 499, 48], [300, 451, 29], [307, 539, 18], [215, 410, 12]]) {
      ctx.beginPath(); ctx.arc(x!, y!, r!, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.font = "32px Arial, sans-serif"; ctx.fillText("500 ml", 256, 634);
    ctx.fillStyle = "#f6f4e8"; ctx.font = "19px Arial, sans-serif"; ctx.fillText("TRAINING PRODUCT", 256, 737);
  });
  bottleLabel(scene, root, "water-curved-label", 0.066, 0.150, 0.03325, 0.03325, print);
};

const orangeJuice: ProductBuilder = (scene, root) => {
  const paper = surface(scene, "orange-juice-carton", "#eaa341", 0.75);
  const seam = surface(scene, "orange-juice-paper-fold", "#f6cf84", 0.82);
  const cream = surface(scene, "orange-juice-cap", "#f6eee0", 0.42);
  box(scene, root, "orange-juice-carton-body", [0.074, 0.159, 0.074], [0, 0.0795, 0], paper);
  const a: Point = [-0.037, 0.159, -0.037], b: Point = [0.037, 0.159, -0.037];
  const c: Point = [0.037, 0.207, 0], d: Point = [-0.037, 0.207, 0];
  const e: Point = [-0.037, 0.159, 0.037], f: Point = [0.037, 0.159, 0.037];
  solidFaces(scene, root, "orange-juice-closed-folded-roof", [[a, b, c, d], [e, d, c, f], [a, d, e], [b, f, c], [a, e, f, b]], [0, 0.177, 0], paper);
  box(scene, root, "orange-juice-ridge-seal", [0.0745, 0.009, 0.004], [0, 0.2105, 0], seam);
  box(scene, root, "orange-juice-bottom-fold", [0.0744, 0.007, 0.0744], [0, 0.0035, 0], seam);
  tube(scene, root, "orange-juice-right-fold", [[0.0373, 0.159, -0.036], [0.0373, 0.194, 0], [0.0373, 0.159, 0.036]], 0.00055, seam, 6);
  box(scene, root, "orange-juice-back-glue-line", [0.004, 0.151, 0.0008], [0.029, 0.079, 0.0372], seam);
  screwCap(scene, root, "orange-juice", [0, 0.1839, -0.0193], 0.023, 0.013, -0.914, cream, seam);
  const print = labelMaterial(scene, "orange-juice-front-print", {
    title: "ORANGE\nJUICE", subtitle: "SMOOTH & FRUITY", detail: "1 L", paper: "#f5e4b7", ink: "#315c39", accent: "#e6972d", motif: "orange",
  });
  labelPlane(scene, root, "orange-juice-front-label", 0.073, 0.151, [0, 0.080, -0.03725], print);
  const sidePrint = landscapeLabel(scene, "orange-juice-side-print", "ORANGE", "JUICE · 1 L", "#f1c469", "#5c562c", "#d78b2c");
  labelPlane(scene, root, "orange-juice-side-label", 0.068, 0.053, [0.03725, 0.091, 0], sidePrint, [0, -Math.PI / 2, 0]);
};

const cola: ProductBuilder = (scene, root) => {
  const lacquer = surface(scene, "cola-red-lacquer", "#8f353d", 0.38, 0.16);
  const aluminium = surface(scene, "cola-aluminium", "#c4c9c3", 0.27, 0.82);
  const recess = surface(scene, "cola-recess", "#35433e", 0.5, 0.60);
  lathe(scene, root, "cola-drawn-can", [
    [0.025, 0], [0.0285, 0.0018], [0.0305, 0.006], [0.033, 0.011],
    [0.033, 0.106], [0.0315, 0.111], [0.029, 0.116], [0.0288, 0.119],
  ], lacquer, 48);
  tube(scene, root, "cola-bottom-rolled-rim", ringPoints(0.0276, 0.0018), 0.0010, aluminium, 8);
  cylinder(scene, root, "cola-recessed-lid", 0.058, 0.058, 0.0015, [0, 0.1185, 0], aluminium, 48);
  tube(scene, root, "cola-top-rolled-rim", ringPoints(0.0291, 0.1200), 0.0015, aluminium, 10);
  tube(scene, root, "cola-lid-score", ringPoints(0.0245, 0.1195), 0.0003, recess, 6);
  ellipsoid(scene, root, "cola-opening-recess", [0.0135, 0.0005, 0.019], [0, 0.11945, -0.009], recess, 20);
  tube(scene, root, "cola-pull-tab", ringPoints(0.0053, 0.1204, 0.0015, 0.0095, 32), 0.0014, aluminium, 9);
  box(scene, root, "cola-tab-bridge", [0.010, 0.0010, 0.0038], [0, 0.1200, 0.007], aluminium);
  cylinder(scene, root, "cola-tab-rivet", 0.0034, 0.0034, 0.0018, [0, 0.1200, 0.010], aluminium, 18);
  const print = printedMaterial(scene, "cola-front-print", 512, 768, (ctx) => {
    ctx.fillStyle = "#8f353d"; ctx.fillRect(0, 0, 512, 768);
    ctx.fillStyle = "#ead9b9"; ctx.textAlign = "center";
    ctx.font = "600 25px Georgia, serif"; ctx.fillText("CORNER SHOP", 256, 92);
    ctx.strokeStyle = "#bd8d70"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(81, 129); ctx.lineTo(431, 129); ctx.stroke();
    ctx.font = "italic bold 137px Georgia, serif"; ctx.fillText("Cola", 252, 366, 460);
    ctx.font = "25px Arial, sans-serif"; ctx.fillText("CLASSIC FIZZ", 256, 448);
    ctx.strokeStyle = "#d3bfa0"; ctx.lineWidth = 3;
    for (let i = 0; i < 7; i += 1) { ctx.beginPath(); ctx.arc(130 + i * 43, 525 + Math.sin(i * 0.9) * 17, 4 + i % 3 * 4, 0, Math.PI * 2); ctx.stroke(); }
    ctx.font = "35px Arial, sans-serif"; ctx.fillText("330 ml", 256, 646);
    ctx.font = "19px Arial, sans-serif"; ctx.fillText("TRAINING PRODUCT", 256, 713);
  });
  bottleLabel(scene, root, "cola-curved-print", 0.015, 0.107, 0.0332, 0.0332, print, 1.20);
};

const crisps: ProductBuilder = (scene, root) => {
  const bag = surface(scene, "crisps-golden-film", "#cfaa4d", 0.47, 0.07);
  const crimp = surface(scene, "crisps-sealed-edge", "#a78238", 0.6, 0.08);
  const highlight = surface(scene, "crisps-fold-highlight", "#e2c778", 0.53);
  const rings: readonly Ring[] = [
    [0.008, 0.070, 0.003], [0.022, 0.070, 0.017], [0.056, 0.069, 0.029],
    [0.112, 0.067, 0.032], [0.166, 0.069, 0.027], [0.195, 0.070, 0.013], [0.207, 0.070, 0.003],
  ];
  pillowBody(scene, root, "crisps-puffed-pillow-bag", rings, bag);
  for (const [key, y] of [["bottom", 0.004], ["top", 0.211]] as const) {
    box(scene, root, `crisps-${key}-heat-seal`, [0.145, 0.008, 0.007], [0, y, 0], bag);
    for (let i = 0; i < 27; i += 1) {
      box(scene, root, `crisps-${key}-crimp-${i}`, [0.0008, 0.007, 0.0007], [-0.069 + i * 0.0053, y, -0.0038], crimp);
    }
  }
  for (const side of [-1, 1]) tube(scene, root, `crisps-side-fold-${side}`, rings.map(([y, width]) => [side * width, y, 0] as Point), 0.0006, highlight, 6);
  const print = labelMaterial(scene, "crisps-front-print", {
    title: "POTATO\nCRISPS", subtitle: "LIGHTLY SALTED", detail: "150 g", paper: "#345449", ink: "#f6ecd4", accent: "#d3af59", motif: "crisps",
  });
  // Keep a vertex row at every underlying bag fold: a uniform label grid would
  // bridge those slope changes and intersect the bag, producing jagged stripes.
  const labelHeights = [0.028, 0.056, 0.112, 0.166, 0.187];
  const labelColumns = 48;
  const labelPositions: number[] = [], labelIndices: number[] = [], labelUvs: number[] = [];
  for (let row = 0; row < labelHeights.length; row += 1) {
    const y = labelHeights[row]!;
    let lower = rings[0]!, upper = rings[1]!;
    for (let i = 0; i < rings.length - 1; i += 1) if (y >= rings[i]![0] && y <= rings[i + 1]![0]) { lower = rings[i]!; upper = rings[i + 1]!; break; }
    const t = (y - lower[0]) / (upper[0] - lower[0]);
    const rx = lower[1] + (upper[1] - lower[1]) * t, rz = lower[2] + (upper[2] - lower[2]) * t;
    const exponent = 2 / 0.55;
    for (let column = 0; column <= labelColumns; column += 1) {
      const u = column / labelColumns, x = (u - 0.5) * 0.120;
      const front = -rz * Math.max(0, 1 - Math.abs(x / rx) ** exponent) ** (1 / exponent);
      labelPositions.push(x, y, front - 0.00095);
      labelUvs.push(u, (y - 0.028) / 0.159);
      if (column < labelColumns && row < labelHeights.length - 1) {
        const a = row * (labelColumns + 1) + column, c = a + labelColumns + 2;
        labelIndices.push(a, a + 1, c, a, c, c - 1);
      }
    }
  }
  meshFromData(scene, root, "crisps-conforming-printed-front", labelPositions, labelIndices, labelUvs, print);
  for (const side of [-1, 1]) for (const top of [false, true]) {
    const y = top ? 0.193 : 0.023;
    tube(scene, root, `crisps-diagonal-fold-${side}-${top}`, [[side * 0.067, top ? 0.205 : 0.010, -0.004], [side * 0.057, y, -0.017], [side * 0.062, top ? 0.177 : 0.039, -0.020]], 0.00035, highlight, 5);
  }
};

const biscuits: ProductBuilder = (scene, root) => {
  const wrapper = surface(scene, "biscuits-blue-wrapper", "#63838d", 0.57);
  const seam = surface(scene, "biscuits-crimp", "#4b6874", 0.69);
  const pale = surface(scene, "biscuits-fold-highlight", "#bed0c8", 0.64);
  const roll = lathe(scene, root, "biscuits-horizontal-roll", [
    [0.004, -0.088], [0.027, -0.079], [0.035, -0.071], [0.0365, -0.063],
    [0.0365, 0.063], [0.035, 0.071], [0.027, 0.079], [0.004, 0.088],
  ], wrapper, 40);
  roll.rotation.z = Math.PI / 2; roll.position.y = 0.0365;
  for (const side of [-1, 1]) {
    box(scene, root, `biscuits-end-seal-${side}`, [0.015, 0.062, 0.004], [side * 0.090, 0.0365, 0], wrapper);
    for (let i = 0; i < 12; i += 1) box(scene, root, `biscuits-crimp-${side}-${i}`, [0.013, 0.0006, 0.0007], [side * 0.090, 0.009 + i * 0.0052, -0.0022], seam);
    for (let i = 0; i < 6; i += 1) {
      const theta = i / 6 * Math.PI * 2;
      tube(scene, root, `biscuits-gather-fold-${side}-${i}`, [[side * 0.071, 0.0365 + Math.sin(theta) * 0.0345, Math.cos(theta) * 0.0345], [side * 0.086, 0.0365 + Math.sin(theta) * 0.023, Math.cos(theta) * 0.003]], 0.00045, pale, 6);
    }
  }
  const print = printedMaterial(scene, "biscuits-front-print", 1024, 512, (ctx) => {
    ctx.fillStyle = "#ebe5cf"; ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = "#cca35a"; ctx.fillRect(0, 0, 22, 512); ctx.fillRect(1002, 0, 22, 512);
    ctx.fillStyle = "#315361"; ctx.textAlign = "center"; ctx.font = "600 32px Georgia, serif"; ctx.fillText("CORNER SHOP", 512, 87);
    ctx.font = "bold 98px Arial, sans-serif"; ctx.fillText("BISCUITS", 512, 218, 910);
    ctx.font = "27px Arial, sans-serif"; ctx.fillText("GOLDEN OAT · 200 g", 512, 276);
    for (let biscuit = 0; biscuit < 3; biscuit += 1) {
      const cx = 428 + biscuit * 84, cy = 372 + (biscuit === 1 ? -13 : 0);
      ctx.fillStyle = biscuit === 1 ? "#d9b571" : "#c89d51"; ctx.beginPath(); ctx.arc(cx, cy, 48, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#a57d3e"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, 39, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#94703c";
      for (let i = 0; i < 6; i += 1) { ctx.beginPath(); ctx.arc(cx + Math.cos(i * Math.PI / 3) * 23, cy + Math.sin(i * Math.PI / 3) * 23, 3.2, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.font = "18px Arial, sans-serif"; ctx.fillStyle = "#315361"; ctx.fillText("TRAINING PRODUCT", 512, 479);
  });
  printedGrid(scene, root, "biscuits-curved-wrapper-print", 1, 24, (u, v) => {
    const theta = (v * 2 - 1) * 1.10;
    return [(u - 0.5) * 0.133, 0.0365 + Math.sin(theta) * 0.03675, -Math.cos(theta) * 0.03675];
  }, print);
};

const chocolate: ProductBuilder = (scene, root) => {
  const foil = surface(scene, "chocolate-inner-foil", "#d2d0c3", 0.32, 0.74);
  const foilShade = surface(scene, "chocolate-foil-fold", "#9faaa3", 0.42, 0.64);
  const paper = surface(scene, "chocolate-cocoa-paper", "#503e3c", 0.75);
  box(scene, root, "chocolate-foil-wrapped-bar", [0.086, 0.166, 0.014], [0, 0.084, 0], foil);
  box(scene, root, "chocolate-paper-sleeve", [0.088, 0.137, 0.016], [0, 0.0705, 0], paper);
  box(scene, root, "chocolate-top-foil-seal", [0.087, 0.003, 0.0145], [0, 0.1685, 0], foilShade);
  box(scene, root, "chocolate-bottom-foil-seal", [0.087, 0.002, 0.0145], [0, 0.001, 0], foilShade);
  for (let i = 0; i < 3; i += 1) {
    box(scene, root, `chocolate-foil-relief-${i}`, [0.024, 0.021, 0.0007], [-0.027 + i * 0.027, 0.1535, -0.0072], foil);
  }
  for (const side of [-1, 1]) {
    tube(scene, root, `chocolate-upper-foil-fold-${side}`, [[side * 0.041, 0.1665, -0.0074], [side * 0.025, 0.159, -0.0076], [side * 0.041, 0.142, -0.0074]], 0.0004, foilShade, 5);
    box(scene, root, `chocolate-side-fold-${side}`, [0.0007, 0.155, 0.006], [side * 0.0432, 0.085, 0.002], foilShade);
  }
  const print = labelMaterial(scene, "chocolate-front-print", {
    title: "DARK\nCHOCOLATE", subtitle: "70% COCOA", detail: "100 g", paper: "#513b3b", ink: "#f2e4c9", accent: "#b79261", motif: "chocolate",
  });
  labelPlane(scene, root, "chocolate-front-label", 0.087, 0.135, [0, 0.0705, -0.0083], print);
  const back = landscapeLabel(scene, "chocolate-back-print", "CHOCOLATE", "100 g · DARK COCOA", "#513b3b", "#efdfc2", "#b79261");
  labelPlane(scene, root, "chocolate-back-label", 0.081, 0.054, [0, 0.083, 0.0083], back, [0, Math.PI, 0]);
};

const yoghurt: ProductBuilder = (scene, root) => {
  const cup = surface(scene, "yoghurt-moulded-cup", "#e5e3dc", 0.45);
  const lip = surface(scene, "yoghurt-purple-rim", "#b59baa", 0.44);
  const foil = surface(scene, "yoghurt-foil-lid", "#d9d6ce", 0.36, 0.54);
  lathe(scene, root, "yoghurt-tapered-cup", [
    [0.027, 0], [0.029, 0.003], [0.030, 0.010], [0.031, 0.019],
    [0.0396, 0.087], [0.0407, 0.096], [0.0430, 0.099], [0.0430, 0.101],
  ], cup, 48);
  tube(scene, root, "yoghurt-cup-foot", ringPoints(0.0285, 0.002), 0.0007, cup, 7);
  cylinder(scene, root, "yoghurt-rolled-lip", 0.088, 0.088, 0.002, [0, 0.101, 0], lip, 48);
  cylinder(scene, root, "yoghurt-sealed-foil", 0.089, 0.089, 0.0014, [0, 0.1027, 0], foil, 48);
  const tab = ellipsoid(scene, root, "yoghurt-peel-tab", [0.018, 0.0015, 0.023], [0.028, 0.103, -0.035], foil, 20);
  tab.rotation.y = -0.65;
  tube(scene, root, "yoghurt-tab-crease", [[0.021, 0.104, -0.035], [0.030, 0.104, -0.028]], 0.0003, lip, 5);
  const print = labelMaterial(scene, "yoghurt-front-print", {
    title: "YOGHURT", subtitle: "NATURAL & CREAMY", detail: "150 g", paper: "#ede8dd", ink: "#604859", accent: "#b7889e", motif: "none",
  });
  bottleLabel(scene, root, "yoghurt-tapered-label", 0.020, 0.092, 0.0314, 0.0405, print, 1.17);
  const lidPrint = printedMaterial(scene, "yoghurt-lid-print", 512, 512, (ctx) => {
    ctx.fillStyle = "#d9d6ce"; ctx.fillRect(0, 0, 512, 512);
    ctx.textAlign = "center"; ctx.fillStyle = "#604859";
    ctx.font = "600 25px Georgia, serif"; ctx.fillText("CORNER SHOP", 256, 132);
    ctx.font = "bold 53px Arial, sans-serif"; ctx.fillText("YOGHURT", 256, 245, 470);
    ctx.font = "28px Arial, sans-serif"; ctx.fillText("NATURAL", 256, 308);
    ctx.font = "26px Arial, sans-serif"; ctx.fillText("150 g", 256, 374);
  });
  labelPlane(scene, root, "yoghurt-lid-label", 0.060, 0.060, [0, 0.1035, 0], lidPrint, [Math.PI / 2, 0, 0]);
};

const cheese: ProductBuilder = (scene, root) => {
  const cheeseMat = surface(scene, "cheese-cut-cheddar", "#e6ba5c", 0.77);
  const cut = surface(scene, "cheese-cut-texture", "#d6a64f", 0.91);
  const film = translucent(scene, "cheese-clear-film", "#f2eee0", 0.13);
  const filmEdge = translucent(scene, "cheese-film-folds", "#fff5d8", 0.38);
  const band = surface(scene, "cheese-paper-band", "#f1e6c8", 0.85);
  box(scene, root, "cheese-cheddar-block", [0.122, 0.079, 0.042], [0, 0.0415, 0], cheeseMat);
  box(scene, root, "cheese-closed-clear-wrap", [0.129, 0.0835, 0.047], [0, 0.04175, 0], film);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i += 1) {
      ellipsoid(scene, root, `cheese-cut-grain-${side}-${i}`, [0.005 + i % 2 * 0.002, 0.0025, 0.0004], [side * (0.038 + i % 2 * 0.012), 0.019 + i * 0.015, -0.0212], cut, 10);
    }
    tube(scene, root, `cheese-upper-wrap-fold-${side}`, [[side * 0.062, 0.078, -0.022], [side * 0.038, 0.083, -0.0235], [side * 0.060, 0.073, -0.0235]], 0.00045, filmEdge, 6);
    tube(scene, root, `cheese-lower-wrap-fold-${side}`, [[side * 0.061, 0.006, -0.022], [side * 0.038, 0.003, -0.0235]], 0.0004, filmEdge, 6);
    box(scene, root, `cheese-film-end-seal-${side}`, [0.001, 0.074, 0.022], [side * 0.0645, 0.041, 0], filmEdge);
  }
  box(scene, root, "cheese-paper-sleeve", [0.054, 0.085, 0.048], [0, 0.0425, 0], band);
  const print = labelMaterial(scene, "cheese-front-print", {
    title: "CHEESE", subtitle: "MILD CHEDDAR", detail: "200 g", paper: "#f1e6c8", ink: "#416346", accent: "#c69946", motif: "none",
  });
  labelPlane(scene, root, "cheese-front-label", 0.0535, 0.083, [0, 0.0425, -0.0243], print);
  const rear = landscapeLabel(scene, "cheese-back-print", "CHEDDAR", "CHEESE · 200 g", "#f1e6c8", "#416346", "#c69946");
  labelPlane(scene, root, "cheese-back-label", 0.052, 0.032, [0, 0.045, 0.0243], rear, [0, Math.PI, 0]);
};

const butter: ProductBuilder = (scene, root) => {
  const paper = surface(scene, "butter-gold-paper", "#cfb068", 0.50, 0.28);
  const folded = surface(scene, "butter-folded-gold-paper", "#b79851", 0.62, 0.23);
  const seam = surface(scene, "butter-fold-highlight", "#e3cf97", 0.65, 0.12);
  box(scene, root, "butter-gold-paper-pack", [0.113, 0.044, 0.070], [0, 0.022, 0], paper);
  for (const side of [-1, 1]) {
    const x0 = side * 0.0565, x1 = side * 0.0575;
    const p: Point = [x0, 0.003, -0.032], q: Point = [x0, 0.041, -0.032], r: Point = [x0, 0.022, 0.029];
    const pp: Point = [x1, 0.003, -0.032], qq: Point = [x1, 0.041, -0.032], rr: Point = [x1, 0.022, 0.029];
    solidFaces(scene, root, `butter-triangular-end-fold-${side}`, [[p, q, r], [pp, rr, qq], [p, pp, qq, q], [q, qq, rr, r], [r, rr, pp, p]], [side * 0.057, 0.022, -0.010], folded);
    tube(scene, root, `butter-fold-edge-${side}`, [[side * 0.0577, 0.004, -0.031], [side * 0.0577, 0.022, 0.028], [side * 0.0577, 0.040, -0.031]], 0.00035, seam, 5);
  }
  box(scene, root, "butter-back-overlap", [0.108, 0.004, 0.001], [0, 0.029, 0.0352], folded);
  const print = landscapeLabel(scene, "butter-front-print", "BUTTER", "SALTED · 250 g", "#355343", "#f5e9c6", "#c2a663");
  labelPlane(scene, root, "butter-front-label", 0.083, 0.038, [0, 0.023, -0.03525], print);
  const top = landscapeLabel(scene, "butter-top-print", "BUTTER", "SALTED · 250 g", "#eee1b7", "#355343", "#ad914c");
  labelPlane(scene, root, "butter-top-label", 0.084, 0.052, [0, 0.0443, 0], top, [Math.PI / 2, 0, 0]);
};

const eggs: ProductBuilder = (scene, root) => {
  const pulp = surface(scene, "eggs-moulded-pulp", "#ad9d82", 0.98);
  const pulpEdge = surface(scene, "eggs-pulp-rim", "#baad92", 1);
  const paper = surface(scene, "eggs-paper-sleeve", "#d9d0b3", 0.90);
  const shells = ["#efe3cb", "#dbc8a6", "#e8d6b8"].map((colour, index) => surface(scene, `eggs-shell-${index}`, colour, 0.83));
  box(scene, root, "eggs-tray-base", [0.153, 0.006, 0.105], [0, 0.003, 0], pulp);
  // Tiny non-zero end radii keep CreateLathe's cap normals well-defined; caps still close the solids.
  const cupProfile: readonly (readonly [number, number])[] = [
    [0.0002, 0.001], [0.016, 0.001], [0.019, 0.006], [0.0244, 0.022],
    [0.0245, 0.026], [0.0220, 0.027], [0.0206, 0.024], [0.0170, 0.008], [0.0002, 0.006],
  ];
  const eggProfile: readonly (readonly [number, number])[] = [
    [0.0002, 0], [0.008, 0.002], [0.0155, 0.008], [0.0197, 0.020],
    [0.0190, 0.030], [0.0152, 0.043], [0.009, 0.051], [0.0036, 0.054], [0.0002, 0.0547],
  ];
  for (let column = 0; column < 3; column += 1) for (let row = 0; row < 2; row += 1) {
    const index = column * 2 + row, x = (column - 1) * 0.050, z = (row - 0.5) * 0.054;
    const cup = lathe(scene, root, `eggs-pulp-cup-${index + 1}`, cupProfile, pulp, 24);
    cup.position.set(x, 0.001, z);
    const egg = lathe(scene, root, `eggs-whole-egg-${index + 1}`, eggProfile, shells[index % shells.length]!, 32);
    egg.position.set(x, 0.014 + (index % 2) * 0.0004, z);
    egg.rotation.z = (index % 3 - 1) * 0.025;
  }
  for (const x of [-0.025, 0.025]) {
    cylinder(scene, root, `eggs-separator-pillar-${x}`, 0.025, 0.010, 0.035, [x, 0.025, 0], pulpEdge, 8);
  }
  const rim: Point[] = [];
  for (let corner = 0; corner < 4; corner += 1) {
    const cx = corner === 0 || corner === 3 ? 0.067 : -0.067;
    const cz = corner < 2 ? 0.043 : -0.043;
    for (let i = 0; i <= 6; i += 1) {
      const angle = corner * Math.PI / 2 + i / 6 * Math.PI / 2;
      rim.push([cx + Math.cos(angle) * 0.011, 0.027, cz + Math.sin(angle) * 0.011]);
    }
  }
  rim.push(rim[0]!);
  tube(scene, root, "eggs-rounded-tray-rim", rim, 0.002, pulpEdge, 8);
  // A narrow real paper belly-band leaves all six egg silhouettes distinguishable.
  box(scene, root, "eggs-paper-top-strap", [0.030, 0.0013, 0.109], [0, 0.0692, 0], paper);
  box(scene, root, "eggs-paper-front-strap", [0.030, 0.067, 0.0013], [0, 0.0345, -0.054], paper);
  box(scene, root, "eggs-paper-back-strap", [0.030, 0.067, 0.0013], [0, 0.0345, 0.054], paper);
  box(scene, root, "eggs-paper-bottom-strap", [0.030, 0.001, 0.109], [0, 0.0005, 0], paper);
  const print = labelMaterial(scene, "eggs-front-print", {
    title: "6\nEGGS", subtitle: "MEDIUM", detail: "HANDLE WITH CARE", paper: "#d9d0b3", ink: "#4b5a40", accent: "#a18a55", motif: "none",
  });
  labelPlane(scene, root, "eggs-front-sleeve-print", 0.0293, 0.061, [0, 0.036, -0.0548], print);
  const top = landscapeLabel(scene, "eggs-top-print", "6 EGGS", "MEDIUM", "#d9d0b3", "#4b5a40", "#a18a55");
  labelPlane(scene, root, "eggs-top-sleeve-print", 0.027, 0.052, [0, 0.0700, -0.004], top, [Math.PI / 2, 0, 0]);
};

export const FRESH_PACKAGED_BUILDERS = {
  water, "orange-juice": orangeJuice, cola, crisps, biscuits, chocolate, yoghurt, cheese, butter, eggs,
} satisfies Record<PackagedId, ProductBuilder>;
