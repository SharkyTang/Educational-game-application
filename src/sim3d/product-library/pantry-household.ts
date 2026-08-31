import { Mesh, PBRMaterial, Scene, TransformNode, VertexData } from "@babylonjs/core";
import {
  box, cylinder, ellipsoid, finish, labelMaterial, labelPlane, lathe, printedMaterial,
  surface, translucent, tube, type Point, type ProductBuilder,
} from "./geometry";

type BagRing = readonly [y: number, halfWidth: number, halfDepth: number];

/** Shared topology only: each package has its own silhouette, folds and artwork. */
function shapedPatch(
  scene: Scene, root: TransformNode, name: string, profile: readonly BagRing[], mat: PBRMaterial,
  start = 0, end = Math.PI * 2, segments = 32, power = 0.62, bottom = false, top = false,
): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const first = profile[0]!;
  const last = profile[profile.length - 1]!;
  const signedPower = (value: number) => Math.sign(value) * Math.abs(value) ** power;
  for (let row = 0; row < profile.length; row += 1) {
    const [y, width, depth] = profile[row]!;
    for (let column = 0; column <= segments; column += 1) {
      const angle = start + (end - start) * column / segments;
      positions.push(signedPower(Math.sin(angle)) * width, y, -signedPower(Math.cos(angle)) * depth);
      uvs.push(column / segments, (y - first[0]) / Math.max(0.0001, last[0] - first[0]));
      if (row < profile.length - 1 && column < segments) {
        const a = row * (segments + 1) + column;
        const c = a + segments + 1;
        indices.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  }
  for (const [enabled, row, upward] of [[bottom, 0, false], [top, profile.length - 1, true]] as const) {
    if (!enabled) continue;
    const center = positions.length / 3;
    positions.push(0, profile[row]![0], 0); uvs.push(0.5, 0.5);
    for (let column = 0; column < segments; column += 1) {
      const edge = row * (segments + 1) + column;
      indices.push(...(upward ? [center, edge + 1, edge] : [center, edge, edge + 1]));
    }
  }
  return customMesh(scene, root, name, positions, indices, uvs, mat);
}

function customMesh(
  scene: Scene, root: TransformNode, name: string, positions: number[], indices: number[],
  uvs: number[], mat: PBRMaterial,
): Mesh {
  const data = new VertexData();
  const normals: number[] = [];
  // Shapes above use outward right-handed winding; Babylon's default scene is
  // left-handed. Flip it here so the bag exterior and the box top face outward.
  const winding: number[] = [];
  for (let index = 0; index < indices.length; index += 3) {
    winding.push(indices[index]!, indices[index + 2]!, indices[index + 1]!);
  }
  VertexData.ComputeNormals(positions, winding, normals);
  data.positions = positions; data.indices = winding; data.normals = normals; data.uvs = uvs;
  const mesh = new Mesh(`${root.name}-${name}`, scene);
  data.applyToMesh(mesh);
  return finish(mesh, root, mat);
}

function pouch(
  scene: Scene, root: TransformNode, id: string, profile: readonly BagRing[], paper: PBRMaterial,
  window?: { bottom: number; top: number; angle: number; material: PBRMaterial },
): void {
  if (!window) {
    shapedPatch(scene, root, `${id}-formed-bag`, profile, paper, 0, Math.PI * 2, 32, 0.62, true, true);
    return;
  }
  const lower = profile.filter(([y]) => y <= window.bottom);
  const middle = profile.filter(([y]) => y >= window.bottom && y <= window.top);
  const upper = profile.filter(([y]) => y >= window.top);
  shapedPatch(scene, root, `${id}-lower-fold`, lower, paper, 0, Math.PI * 2, 32, 0.62, true);
  shapedPatch(scene, root, `${id}-upper-fold`, upper, paper, 0, Math.PI * 2, 32, 0.62, false, true);
  shapedPatch(scene, root, `${id}-window-sides`, middle, paper, window.angle, Math.PI * 2 - window.angle, 30);
  shapedPatch(scene, root, `${id}-clear-window`, middle, window.material, -window.angle, window.angle, 12);
}

function bagLabel(
  scene: Scene, root: TransformNode, name: string, profile: readonly BagRing[], mat: PBRMaterial,
  angle = 0.61, power = 0.62, clearance = 0.0004,
): void {
  shapedPatch(scene, root, name, profile.map(([y, width, depth]) => [y, width + clearance, depth + clearance]), mat, -angle, angle, 16, power);
}

function sealRidges(
  scene: Scene, root: TransformNode, id: string, width: number, y: number, z: number, mat: PBRMaterial,
): void {
  for (let index = 0; index < 17; index += 1) {
    box(scene, root, `${id}-crimp-${index}`, [0.00055, 0.007, 0.0005], [-width / 2 + width * index / 16, y, z], mat);
  }
}

function flatArtwork(
  scene: Scene, id: string, title: string, subtitle: string, paper: string, ink: string,
  accent: string, drawMotif: (ctx: CanvasRenderingContext2D) => void,
): PBRMaterial {
  return printedMaterial(scene, `${id}-landscape`, 768, 512, (ctx) => {
    ctx.fillStyle = paper; ctx.fillRect(0, 0, 768, 512);
    ctx.strokeStyle = accent; ctx.lineWidth = 8; ctx.strokeRect(23, 23, 722, 466);
    ctx.fillStyle = ink; ctx.textAlign = "left";
    ctx.font = "600 24px Georgia, serif"; ctx.fillText("CORNER SHOP", 54, 81);
    ctx.font = "bold 85px Arial, sans-serif"; ctx.fillText(title, 50, 223, 485);
    ctx.font = "27px Arial, sans-serif"; ctx.fillText(subtitle, 54, 280, 450);
    ctx.font = "21px Arial, sans-serif"; ctx.fillText("TRAINING PRODUCT", 54, 444);
    drawMotif(ctx);
  });
}

const cereal: ProductBuilder = (scene, root) => {
  const paper = surface(scene, "cereal-cardboard", "#e5bf67", 0.83);
  const edge = surface(scene, "cereal-fold-edges", "#b78d44", 0.95);
  const inner = surface(scene, "cereal-fold-paper", "#f3ddb0", 0.92);
  const artwork = labelMaterial(scene, "cereal-front", {
    title: "CEREAL", subtitle: "OAT FLAKES", detail: "500 g", motif: "grain",
    paper: "#f4dea0", ink: "#49492e", accent: "#bd8034",
  });
  box(scene, root, "cereal-carton", [0.168, 0.246, 0.063], [0, 0.123, 0], paper);
  labelPlane(scene, root, "cereal-front-label", 0.158, 0.231, [0, 0.124, -0.0317], artwork);
  const rear = flatArtwork(scene, "cereal-back", "OATS", "BREAKFAST FLAKES · 500 g", "#f2dda8", "#49492e", "#b68b42", (ctx) => {
    ctx.strokeStyle = "#b68b42"; ctx.lineWidth = 3;
    for (let line = 0; line < 5; line += 1) { ctx.beginPath(); ctx.moveTo(60, 330 + line * 15); ctx.lineTo(460 - (line % 2) * 50, 330 + line * 15); ctx.stroke() }
    ctx.fillStyle = "#b68b42";
    for (let row = 0; row < 5; row += 1) { ctx.beginPath(); ctx.ellipse(612, 180 + row * 36, 31, 11, row % 2 ? 0.65 : -0.65, 0, Math.PI * 2); ctx.fill() }
  });
  labelPlane(scene, root, "cereal-back-label", 0.151, 0.209, [0, 0.123, 0.0317], rear, [0, Math.PI, 0]);
  const frontFlap = box(scene, root, "cereal-front-top-flap", [0.166, 0.0015, 0.032], [0, 0.2478, -0.0147], paper);
  frontFlap.rotation.x = -0.032;
  const backFlap = box(scene, root, "cereal-back-top-flap", [0.166, 0.0015, 0.029], [0, 0.2475, 0.015], inner);
  backFlap.rotation.x = 0.025;
  tube(scene, root, "cereal-top-fold-seam", [[-0.081, 0.2488, 0.001], [0.081, 0.2488, 0.001]], 0.00045, edge, 6);
  for (const side of [-1, 1]) {
    box(scene, root, `cereal-side-fold-${side}`, [0.0007, 0.231, 0.002], [side * 0.0843, 0.123, 0.02], edge);
    tube(scene, root, `cereal-bottom-fold-${side}`, [[side * 0.08, 0.004, -0.03], [side * 0.068, 0.012, 0], [side * 0.08, 0.004, 0.03]], 0.00045, edge, 6);
  }
};

const pasta: ProductBuilder = (scene, root) => {
  const paper = surface(scene, "pasta-dark-green-pack", "#315b47", 0.78);
  const edge = surface(scene, "pasta-crimp-highlight", "#749376", 0.71);
  const film = translucent(scene, "pasta-window-film", "#eef1d9", 0.12);
  const noodle = surface(scene, "pasta-durum-wheat", "#e6bd61", 0.89);
  const lightNoodle = surface(scene, "pasta-durum-wheat-light", "#f0d180", 0.92);
  const profile: readonly BagRing[] = [
    [0, 0.042, 0.005], [0.011, 0.046, 0.006], [0.046, 0.048, 0.022],
    [0.125, 0.0495, 0.024], [0.202, 0.0465, 0.0215], [0.247, 0.045, 0.013],
    [0.260, 0.047, 0.0025], [0.2695, 0.047, 0.002],
  ];
  pouch(scene, root, "pasta", profile, paper, { bottom: 0.046, top: 0.202, angle: 0.62, material: film });
  for (let index = 0; index < 17; index += 1) {
    const x = -0.032 + index * 0.004;
    // Keep both ends inside the narrowing sealed shoulders, not through the
    // opaque footer or header when the package is viewed from an angle.
    const length = 0.186 + (index % 3) * 0.003;
    const strand = cylinder(scene, root, `pasta-strand-${index}`, 0.0029, 0.0026, length,
      [x, length / 2 + 0.034, -0.012 + (index % 2) * 0.008], index % 3 ? noodle : lightNoodle, 7);
    strand.rotation.z = Math.sin(index * 1.8) * 0.008;
  }
  const artwork = flatArtwork(scene, "pasta-header", "PASTA", "SPAGHETTI · 500 g", "#315b47", "#fff1d3", "#c9b36c", (ctx) => {
    ctx.strokeStyle = "#e8d399"; ctx.lineWidth = 6;
    for (let index = 0; index < 5; index += 1) { ctx.beginPath(); ctx.moveTo(578 + index * 18, 175); ctx.lineTo(589 + index * 16, 351); ctx.stroke() }
  });
  bagLabel(scene, root, "pasta-header-print", [[0.205, 0.0465, 0.0211], [0.245, 0.045, 0.0134]], artwork, 0.68);
  const footer = printedMaterial(scene, "pasta-footer", 512, 128, (ctx) => {
    ctx.fillStyle = "#315b47"; ctx.fillRect(0, 0, 512, 128); ctx.fillStyle = "#fff1d3";
    ctx.font = "600 34px Arial, sans-serif"; ctx.textAlign = "center"; ctx.fillText("DURUM WHEAT", 256, 80);
  });
  bagLabel(scene, root, "pasta-footer-print", [[0.020, 0.0465, 0.0101], [0.041, 0.0477, 0.0197]], footer, 0.65, 0.62, 0.001);
  sealRidges(scene, root, "pasta-top", 0.089, 0.265, -0.0026, edge);
  sealRidges(scene, root, "pasta-bottom", 0.079, 0.006, -0.0058, edge);
};

const rice: ProductBuilder = (scene, root) => {
  const paper = surface(scene, "rice-woven-cream-bag", "#e9dfbf", 0.86);
  const fold = surface(scene, "rice-crimp-and-fold", "#b9a987", 0.92);
  const grain = surface(scene, "rice-grains", "#f6ebcc", 0.86);
  const grainShadow = surface(scene, "rice-grains-shade", "#e7d6b5", 0.93);
  const profile: readonly BagRing[] = [
    [0, 0.051, 0.022], [0.016, 0.060, 0.030], [0.037, 0.064, 0.032],
    [0.078, 0.067, 0.0325], [0.105, 0.0645, 0.031], [0.160, 0.055, 0.022],
    [0.180, 0.056, 0.0035], [0.1895, 0.056, 0.0025],
  ];
  pouch(scene, root, "rice", profile, paper, { bottom: 0.037, top: 0.105, angle: 0.66, material: translucent(scene, "rice-window", "#fff8e5", 0.13) });
  ellipsoid(scene, root, "rice-visible-fill", [0.105, 0.102, 0.050], [0, 0.079, 0.002], grainShadow, 16);
  for (let row = 0; row < 8; row += 1) for (let column = 0; column < 12; column += 1) {
    const index = row * 12 + column;
    const x = -0.043 + column * 0.0077 + Math.sin(index * 2.31) * 0.0015;
    const y = 0.043 + row * 0.0074 + Math.cos(index * 1.71) * 0.001;
    const grainMesh = ellipsoid(scene, root, `rice-grain-${index}`, [0.0029, 0.0065, 0.0023],
      [x, y, -0.026 + Math.abs(x) * 0.12], index % 4 ? grain : grainShadow, 6);
    grainMesh.rotation.z = Math.sin(index * 4.13) * 1.25;
    grainMesh.rotation.y = Math.cos(index * 2.13) * 0.4;
  }
  const label = labelMaterial(scene, "rice-label", { title: "RICE", subtitle: "LONG GRAIN", detail: "1 kg", motif: "grain", paper: "#f5edd3", ink: "#653c37", accent: "#a9804a" });
  // Include the bag's shoulder breakpoint: interpolating straight from 0.150
  // to 0.165 otherwise cuts behind the 0.160 ring and hides the product name.
  bagLabel(scene, root, "rice-upper-label", [[0.108, 0.06398, 0.03051], [0.150, 0.05673, 0.02364], [0.160, 0.055, 0.022], [0.165, 0.05525, 0.017375]], label, 0.66, 0.62, 0.001);
  sealRidges(scene, root, "rice-sealed-mouth", 0.106, 0.185, -0.0033, fold);
  for (const side of [-1, 1]) {
    tube(scene, root, `rice-gusset-${side}`, [[side * 0.051, 0.005, 0.016], [side * 0.063, 0.043, 0.015], [side * 0.065, 0.10, 0.014], [side * 0.054, 0.169, 0.005]], 0.00045, fold, 6);
  }
};

const flour: ProductBuilder = (scene, root) => {
  const kraft = surface(scene, "flour-kraft-paper", "#c5a16d", 0.96);
  const folded = surface(scene, "flour-folded-edges", "#aa8350", 0.98);
  const profile: readonly BagRing[] = [
    [0, 0.052, 0.030], [0.012, 0.056, 0.035], [0.035, 0.059, 0.0375],
    [0.115, 0.0595, 0.036], [0.150, 0.055, 0.030], [0.175, 0.051, 0.020], [0.184, 0.052, 0.005],
  ];
  pouch(scene, root, "flour", profile, kraft);
  const artwork = labelMaterial(scene, "flour-label", { title: "FLOUR", subtitle: "ALL PURPOSE", detail: "1 kg", motif: "grain", paper: "#eee3c8", ink: "#665236", accent: "#b38a48" });
  bagLabel(scene, root, "flour-cream-label", [[0.027, 0.058, 0.0366], [0.035, 0.059, 0.0375], [0.115, 0.0595, 0.036], [0.149, 0.0551, 0.0302]], artwork, 0.60, 0.62, 0.001);
  const roll = cylinder(scene, root, "flour-rolled-paper-mouth", 0.011, 0.011, 0.106, [0, 0.1895, 0.001], folded, 12);
  roll.rotation.z = Math.PI / 2;
  box(scene, root, "flour-roll-fold", [0.108, 0.0025, 0.014], [0, 0.182, 0.003], kraft);
  tube(scene, root, "flour-roll-lip", [[-0.0505, 0.19, -0.0045], [0.0505, 0.19, -0.0045]], 0.00055, kraft, 6);
  for (const side of [-1, 1]) {
    tube(scene, root, `flour-side-gusset-${side}`, [[side * 0.052, 0.007, 0.020], [side * 0.057, 0.031, 0.025], [side * 0.0575, 0.110, 0.024], [side * 0.052, 0.163, 0.015]], 0.0006, folded, 6);
    tube(scene, root, `flour-bottom-paper-fold-${side}`, [[side * 0.053, 0.007, -0.028], [side * 0.041, 0.019, -0.033], [side * 0.030, 0.011, -0.034]], 0.0005, folded, 6);
  }
};

const sugar: ProductBuilder = (scene, root) => {
  const paper = surface(scene, "sugar-white-paper", "#ebece1", 0.88);
  const blue = surface(scene, "sugar-blue-folds", "#5185ac", 0.88);
  const profile: readonly BagRing[] = [
    [0, 0.043, 0.025], [0.018, 0.0485, 0.0305], [0.082, 0.050, 0.0325],
    [0.123, 0.047, 0.0305], [0.146, 0.0445, 0.011], [0.154, 0.044, 0.004],
  ];
  pouch(scene, root, "sugar", profile, paper);
  const artwork = printedMaterial(scene, "sugar-label", 512, 640, (ctx) => {
    ctx.fillStyle = "#f0f2e8"; ctx.fillRect(0, 0, 512, 640);
    ctx.fillStyle = "#5385ae"; ctx.fillRect(0, 391, 512, 249); ctx.fillRect(0, 0, 512, 13);
    ctx.textAlign = "center"; ctx.fillStyle = "#365d79";
    ctx.font = "600 22px Georgia, serif"; ctx.fillText("CORNER SHOP", 256, 65);
    ctx.font = "bold 78px Arial, sans-serif"; ctx.fillText("SUGAR", 256, 193, 456);
    ctx.font = "27px Arial, sans-serif"; ctx.fillText("WHITE GRANULATED", 256, 249);
    ctx.font = "32px Arial, sans-serif"; ctx.fillText("1 kg", 256, 340);
    for (let index = 0; index < 21; index += 1) {
      const x = 57 + (index % 7) * 65; const y = 438 + Math.floor(index / 7) * 60;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(index * 3.1) * 0.6);
      ctx.fillStyle = index % 3 ? "#f5f6ed" : "#c9dce5"; ctx.fillRect(-9, -9, 18, 18); ctx.restore();
    }
    ctx.fillStyle = "#ffffff"; ctx.font = "18px Arial, sans-serif"; ctx.fillText("TRAINING PRODUCT", 256, 610);
  });
  bagLabel(scene, root, "sugar-blue-white-print", [[0.019, 0.0485, 0.0306], [0.082, 0.050, 0.0325], [0.123, 0.047, 0.0305], [0.132, 0.046, 0.0229]], artwork, 0.72, 0.62, 0.001);
  box(scene, root, "sugar-folded-top-flap", [0.088, 0.0035, 0.018], [0, 0.1555, -0.001], paper);
  box(scene, root, "sugar-blue-closure-strip", [0.087, 0.0025, 0.0055], [0, 0.1585, -0.006], blue);
  for (const side of [-1, 1]) {
    tube(scene, root, `sugar-bottom-fold-${side}`, [[side * 0.043, 0.004, -0.024], [side * 0.029, 0.013, -0.029], [side * 0.015, 0.006, -0.027]], 0.00045, blue, 6);
  }
};

const tea: ProductBuilder = (scene, root) => {
  const paper = surface(scene, "tea-forest-green-box", "#294e3d", 0.84);
  const lid = surface(scene, "tea-lid-paper", "#37624a", 0.88);
  const gold = surface(scene, "tea-gold-print-and-fold", "#b6a366", 0.70);
  const artwork = flatArtwork(scene, "tea-front", "TEA", "LEAF BLEND · 40 TEA BAGS", "#294e3d", "#f0e6c8", "#b6a366", (ctx) => {
    ctx.strokeStyle = "#b6a366"; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(565, 388); ctx.quadraticCurveTo(618, 264, 650, 148); ctx.stroke();
    for (let leaf = 0; leaf < 5; leaf += 1) {
      ctx.fillStyle = leaf % 2 ? "#9fae72" : "#c0b178";
      ctx.beginPath(); ctx.ellipse(598 + leaf * 9 + (leaf % 2 ? 17 : -13), 342 - leaf * 39, 31, 13, leaf % 2 ? -0.5 : 0.55, 0, Math.PI * 2); ctx.fill();
    }
  });
  box(scene, root, "tea-paper-carton", [0.123, 0.096, 0.061], [0, 0.048, 0], paper);
  box(scene, root, "tea-overlapping-lid", [0.125, 0.012, 0.062], [0, 0.099, 0], lid);
  labelPlane(scene, root, "tea-front-print", 0.118, 0.085, [0, 0.047, -0.0307], artwork);
  labelPlane(scene, root, "tea-lid-print", 0.114, 0.050, [0, 0.1052, 0], artwork, [Math.PI / 2, 0, 0]);
  tube(scene, root, "tea-lid-front-seam", [[-0.061, 0.093, -0.0312], [0.061, 0.093, -0.0312]], 0.0004, gold, 6);
  tube(scene, root, "tea-lid-back-hinge", [[-0.059, 0.1052, 0.0245], [0.059, 0.1052, 0.0245]], 0.0003, gold, 6);
  for (const side of [-1, 1]) {
    box(scene, root, `tea-side-flap-${side}`, [0.0005, 0.080, 0.001], [side * 0.0617, 0.046, 0.017], gold);
  }
};

const coffee: ProductBuilder = (scene, root) => {
  const glass = translucent(scene, "coffee-amber-glass", "#b89973", 0.23);
  const coffeeFill = surface(scene, "coffee-roasted-contents", "#553928", 0.96);
  const granule = surface(scene, "coffee-ground-granules", "#74503a", 0.98);
  const dark = surface(scene, "coffee-screw-cap", "#2e2e2a", 0.49);
  const rim = surface(scene, "coffee-lid-rib-highlights", "#48453d", 0.57);
  lathe(scene, root, "coffee-glass-jar", [[0.033, 0], [0.039, 0.0025], [0.042, 0.010], [0.0425, 0.030], [0.0425, 0.099], [0.040, 0.113], [0.034, 0.123], [0.034, 0.131]], glass, 40);
  lathe(scene, root, "coffee-visible-ground-fill", [[0.029, 0.006], [0.037, 0.010], [0.038, 0.028], [0.038, 0.097], [0.035, 0.111], [0.030, 0.116]], coffeeFill, 32);
  for (let index = 0; index < 24; index += 1) {
    const angle = index * 2.4; const radius = 0.008 + (index % 5) * 0.0042;
    ellipsoid(scene, root, `coffee-surface-granule-${index}`, [0.0045, 0.0024, 0.0038], [Math.sin(angle) * radius, 0.1162, Math.cos(angle) * radius], index % 3 ? coffeeFill : granule, 6);
  }
  const artwork = labelMaterial(scene, "coffee-label", { title: "COFFEE", subtitle: "ROASTED & GROUND", detail: "200 g", motif: "coffee", paper: "#e6d5b4", ink: "#443a2e", accent: "#95633e" });
  bagLabel(scene, root, "coffee-curved-front-label", [[0.025, 0.0425, 0.0425], [0.098, 0.0425, 0.0425]], artwork, 0.94, 1);
  cylinder(scene, root, "coffee-cap-skirt", 0.078, 0.078, 0.018, [0, 0.133, 0], dark, 40);
  cylinder(scene, root, "coffee-cap-top", 0.076, 0.075, 0.004, [0, 0.143, 0], dark, 40);
  cylinder(scene, root, "coffee-cap-lower-rim", 0.079, 0.079, 0.0016, [0, 0.125, 0], rim, 40);
  for (let index = 0; index < 36; index += 1) {
    const angle = index * Math.PI / 18;
    const rib = box(scene, root, `coffee-cap-grip-${index}`, [0.0013, 0.013, 0.001], [Math.sin(angle) * 0.039, 0.133, -Math.cos(angle) * 0.039], rim);
    rib.rotation.y = -angle;
  }
};

const soap: ProductBuilder = (scene, root) => {
  const bar = surface(scene, "soap-rounded-bar", "#d7e4c2", 0.49);
  const paper = surface(scene, "soap-paper-sleeve", "#f3eee0", 0.89);
  const green = surface(scene, "soap-sleeve-border", "#637d59", 0.85);
  shapedPatch(scene, root, "soap-soft-rounded-solid", [[0, 0.034, 0.019], [0.003, 0.042, 0.027], [0.009, 0.046, 0.030], [0.029, 0.046, 0.030], [0.035, 0.042, 0.027], [0.038, 0.034, 0.019]], bar, 0, Math.PI * 2, 36, 0.57, true, true);
  const artwork = printedMaterial(scene, "soap-sleeve-top", 512, 512, (ctx) => {
    ctx.fillStyle = "#f3eee0"; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = "#637d59"; ctx.fillRect(0, 0, 20, 512); ctx.fillRect(492, 0, 20, 512);
    ctx.textAlign = "center"; ctx.font = "600 24px Georgia, serif"; ctx.fillText("CORNER SHOP", 256, 83);
    ctx.font = "bold 87px Arial, sans-serif"; ctx.fillText("SOAP", 256, 204);
    ctx.font = "25px Arial, sans-serif"; ctx.fillText("EVERYDAY BAR", 256, 260);
    ctx.strokeStyle = "#8b9d70"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(216, 384); ctx.quadraticCurveTo(250, 326, 300, 299); ctx.stroke();
    for (let index = 0; index < 3; index += 1) { ctx.beginPath(); ctx.ellipse(233 + index * 23, 365 - index * 23, 22, 9, index % 2 ? 0.6 : -0.6, 0, Math.PI * 2); ctx.fill() }
    ctx.font = "23px Arial, sans-serif"; ctx.fillText("100 g", 256, 454);
  });
  labelPlane(scene, root, "soap-top-paper-sleeve", 0.042, 0.041, [0, 0.0384, 0], artwork, [Math.PI / 2, 0, 0]);
  // Follow the curved shoulders instead of leaving a rectangular box around the bar.
  for (const side of [-1, 1]) {
    const shoulder = labelPlane(scene, root, `soap-paper-shoulder-${side}`, 0.042, 0.014, [0, 0.0327, side * 0.0257], paper, [side * -Math.PI / 4, side > 0 ? Math.PI : 0, 0]);
    shoulder.material = paper;
    box(scene, root, `soap-front-back-sleeve-${side}`, [0.042, 0.021, 0.0007], [0, 0.0187, side * 0.0302], paper);
    for (const edge of [-1, 1]) {
      box(scene, root, `soap-sleeve-edge-${side}-${edge}`, [0.0016, 0.021, 0.0008], [edge * 0.0203, 0.0187, side * 0.0306], green);
    }
  }
  box(scene, root, "soap-underneath-paper-fold", [0.042, 0.00045, 0.040], [0, 0.00025, 0], paper);
};

const shampoo: ProductBuilder = (scene, root) => {
  const bottle = surface(scene, "shampoo-sage-bottle", "#8cb29d", 0.36);
  const capMat = surface(scene, "shampoo-charcoal-flip-cap", "#344b42", 0.41);
  const seam = surface(scene, "shampoo-cap-seam", "#20382f", 0.54);
  const body = lathe(scene, root, "shampoo-flat-oval-bottle", [[0.027, 0], [0.033, 0.003], [0.0375, 0.015], [0.0375, 0.118], [0.036, 0.149], [0.030, 0.164], [0.017, 0.176], [0.016, 0.181]], bottle, 40);
  body.scaling.z = 2 / 3;
  const artwork = labelMaterial(scene, "shampoo-label", { title: "SHAMPOO", subtitle: "EVERYDAY CARE", detail: "250 mL", motif: "leaf", paper: "#eeeade", ink: "#365346", accent: "#789775" });
  bagLabel(scene, root, "shampoo-curved-care-label", [[0.029, 0.0375, 0.025], [0.118, 0.0375, 0.025], [0.139, 0.0365, 0.0244]], artwork, 0.81, 1);
  const collar = cylinder(scene, root, "shampoo-cap-base", 0.035, 0.035, 0.014, [0, 0.185, 0], capMat, 32);
  collar.scaling.z = 0.86;
  const lid = cylinder(scene, root, "shampoo-flip-top", 0.036, 0.033, 0.012, [0, 0.199, 0], capMat, 32);
  lid.scaling.z = 0.86;
  const loop: Point[] = [];
  for (let index = 0; index <= 32; index += 1) { const angle = index * Math.PI / 16; loop.push([Math.sin(angle) * 0.0176, 0.193, Math.cos(angle) * 0.0152]) }
  tube(scene, root, "shampoo-flip-lid-join", loop, 0.00042, seam, 6);
  ellipsoid(scene, root, "shampoo-thumb-recess", [0.012, 0.0042, 0.0011], [0, 0.195, -0.0154], seam, 12);
  const hinge = cylinder(scene, root, "shampoo-flip-hinge", 0.0045, 0.0045, 0.015, [0, 0.1937, 0.015], capMat, 12);
  hinge.rotation.z = Math.PI / 2;
};

function tissueOpening(scene: Scene, root: TransformNode, paper: PBRMaterial): void {
  const positions: number[] = []; const indices: number[] = []; const uvs: number[] = [];
  const segments = 48;
  for (let index = 0; index <= segments; index += 1) {
    const angle = index * Math.PI * 2 / segments;
    const dx = Math.sin(angle); const dz = Math.cos(angle);
    const distance = Math.min(0.11 / Math.max(0.00001, Math.abs(dx)), 0.0575 / Math.max(0.00001, Math.abs(dz)));
    positions.push(dx * distance, 0.081, dz * distance, dx * 0.054, 0.081, dz * 0.019);
    uvs.push((dx * distance + 0.11) / 0.22, (dz * distance + 0.0575) / 0.115, (dx * 0.054 + 0.11) / 0.22, (dz * 0.019 + 0.0575) / 0.115);
    if (index < segments) { const a = index * 2; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
  }
  const mesh = customMesh(scene, root, "tissues-die-cut-top", positions, indices, uvs, paper);
  mesh.material!.backFaceCulling = false;
}

function standingTissue(scene: Scene, root: TransformNode, paper: PBRMaterial): void {
  const positions: number[] = []; const indices: number[] = []; const uvs: number[] = [];
  const columns = 18; const rows = 10;
  const upperEdge: Point[] = [];
  for (let row = 0; row <= rows; row += 1) {
    const t = row / rows;
    for (let column = 0; column <= columns; column += 1) {
      const u = -1 + 2 * column / columns;
      const x = u * (0.018 + 0.034 * t ** 0.7) + Math.sin(t * Math.PI) * 0.003;
      const y = 0.078 + t * 0.061 + t ** 3 * 0.006 * Math.sin((u + 1) * Math.PI * 1.5);
      const z = -0.002 + Math.sin(u * Math.PI * 2 + 0.8) * (0.002 + 0.007 * t) + t ** 2 * 0.014;
      positions.push(x, y, z); uvs.push(column / columns, t);
      if (row === rows) upperEdge.push([x, y, z]);
      if (row < rows && column < columns) {
        const a = row * (columns + 1) + column; const b = a + columns + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  customMesh(scene, root, "tissues-raised-folded-sheet", positions, indices, uvs, paper);
  tube(scene, root, "tissues-soft-upper-edge", upperEdge, 0.00025, paper, 5);
}

const tissues: ProductBuilder = (scene, root) => {
  const blue = surface(scene, "tissues-soft-blue-carton", "#bdd5d3", 0.86);
  const edge = surface(scene, "tissues-opening-card-edge", "#739e9b", 0.93);
  const inside = surface(scene, "tissues-shadow-inside-opening", "#536a67", 1);
  const paper = surface(scene, "tissues-white-folded-paper", "#faf9f0", 0.98);
  paper.backFaceCulling = false;
  box(scene, root, "tissues-box-bottom", [0.218, 0.002, 0.113], [0, 0.001, 0], blue);
  for (const side of [-1, 1]) {
    box(scene, root, `tissues-front-back-${side}`, [0.22, 0.08, 0.0015], [0, 0.04, side * 0.05675], blue);
    box(scene, root, `tissues-end-${side}`, [0.0015, 0.08, 0.112], [side * 0.10925, 0.04, 0], blue);
  }
  tissueOpening(scene, root, blue);
  ellipsoid(scene, root, "tissues-shadow-under-opening", [0.110, 0.003, 0.040], [0, 0.0755, 0], inside, 20);
  const opening: Point[] = [];
  for (let index = 0; index <= 48; index += 1) { const angle = index * Math.PI / 24; opening.push([Math.sin(angle) * 0.054, 0.0814, Math.cos(angle) * 0.019]) }
  tube(scene, root, "tissues-oval-opening-rim", opening, 0.00065, edge, 6);
  const artwork = flatArtwork(scene, "tissues-front", "TISSUES", "SOFT PAPER · 100 SHEETS", "#dce9df", "#38665f", "#83aba0", (ctx) => {
    for (let index = 0; index < 4; index += 1) {
      ctx.strokeStyle = "#98bbae"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(574 + index * 31, 385); ctx.quadraticCurveTo(622 + index * 24, 284, 586 + index * 28, 155); ctx.stroke();
      ctx.fillStyle = index % 2 ? "#aec9b7" : "#83aba0"; ctx.beginPath(); ctx.ellipse(591 + index * 27, 235 + (index % 2) * 73, 15, 39, index % 2 ? -0.5 : 0.4, 0, Math.PI * 2); ctx.fill();
    }
  });
  labelPlane(scene, root, "tissues-front-label", 0.213, 0.074, [0, 0.041, -0.0577], artwork);
  labelPlane(scene, root, "tissues-back-label", 0.213, 0.074, [0, 0.041, 0.0577], artwork, [0, Math.PI, 0]);
  for (const side of [-1, 1]) {
    tube(scene, root, `tissues-end-fold-${side}`, [[side * 0.1101, 0.006, -0.050], [side * 0.1101, 0.025, 0], [side * 0.1101, 0.006, 0.050]], 0.0003, edge, 6);
  }
  standingTissue(scene, root, paper);
};

export const PANTRY_HOUSEHOLD_BUILDERS = {
  cereal, pasta, rice, flour, sugar, tea, coffee, soap, shampoo, tissues,
} satisfies Record<"cereal" | "pasta" | "rice" | "flour" | "sugar" | "tea" | "coffee" | "soap" | "shampoo" | "tissues", ProductBuilder>;
