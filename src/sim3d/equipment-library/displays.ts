import { Mesh, VertexData, type PBRMaterial, type Scene, type TransformNode } from "@babylonjs/core";
import { EQUIPMENT_ASSETS, type EquipmentAssetId } from "./catalog";
import {
  box, cylinder, equipmentMaterials, equipmentSign, finish, labelPlane, printedMaterial,
  tube, type EquipmentBuilder, type Point,
} from "./geometry";

type DisplayId = "wall-shelf-narrow" | "wall-shelf-wide" | "gondola-low" | "gondola-tall"
  | "produce-tiered" | "bakery-glass" | "pegboard-snacks";
type Materials = ReturnType<typeof equipmentMaterials>;

function shelfHeights(id: EquipmentAssetId): number[] {
  return [...new Set(EQUIPMENT_ASSETS[id].placementSlots.map((slot) => slot.position[1]))];
}

/** Four floor pads establish the nominal, centred footprint, including handles/rails. */
function floorPads(scene: Scene, root: TransformNode, id: string, width: number, depth: number, mat: PBRMaterial, pad = 0.065): void {
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    box(scene, root, `${id}-floor-pad-${x}-${z}`, [pad, 0.024, pad],
      [x * (width / 2 - pad / 2), 0.012, z * (depth / 2 - pad / 2)], mat);
  }
}

function plinth(scene: Scene, root: TransformNode, id: string, width: number, depth: number, top: number, m: Materials): void {
  floorPads(scene, root, id, width, depth, m.rubber);
  box(scene, root, `${id}-closed-plinth`, [width - 0.028, top - 0.019, depth - 0.028], [0, (top + 0.019) / 2, 0], m.sage);
  box(scene, root, `${id}-inset-kick-strip`, [width - 0.064, 0.032, 0.010], [0, 0.047, -depth / 2 + 0.008], m.dark);
}

/** Punched front of a folded steel channel: the adjustment slots are actual gaps. */
function adjustablePost(
  scene: Scene, root: TransformNode, id: string, x: number, z: number, bottom: number, top: number,
  width: number, depth: number, paint: PBRMaterial, inside: PBRMaterial,
): void {
  const height = top - bottom;
  const y = (bottom + top) / 2;
  const holeWidth = 0.012;
  const frontZ = z - depth / 2 + 0.0025;
  box(scene, root, `${id}-channel-back`, [width, height, 0.005], [x, y, z + depth / 2 - 0.0025], inside);
  for (const side of [-1, 1]) {
    box(scene, root, `${id}-channel-side-${side}`, [0.004, height, depth], [x + side * (width / 2 - 0.002), y, z], paint);
    const frontWidth = (width - holeWidth) / 2;
    box(scene, root, `${id}-perforated-front-side-${side}`, [frontWidth, height, 0.005],
      [x + side * (holeWidth / 2 + frontWidth / 2), y, frontZ], paint);
  }
  let cursor = bottom;
  let index = 0;
  for (let center = bottom + 0.072; center < top - 0.036; center += 0.058) {
    const low = center - 0.010;
    box(scene, root, `${id}-between-adjustment-holes-${index}`, [holeWidth, low - cursor, 0.005],
      [x, (cursor + low) / 2, frontZ], paint);
    cursor = center + 0.010;
    index += 1;
  }
  if (cursor < top) box(scene, root, `${id}-front-top-bridge`, [holeWidth, top - cursor, 0.005], [x, (cursor + top) / 2, frontZ], paint);
  box(scene, root, `${id}-closed-post-cap`, [width, 0.004, depth], [x, top - 0.002, z], paint);
}

function priceRail(
  scene: Scene, root: TransformNode, id: string, width: number, shelfY: number, z: number,
  columns: number, m: Materials, side: -1 | 1 = -1,
): void {
  box(scene, root, `${id}-price-channel`, [width, 0.036, 0.015], [0, shelfY - 0.012, z], m.green);
  box(scene, root, `${id}-price-channel-lower-lip`, [width, 0.006, 0.020], [0, shelfY - 0.029, z], m.steel);
  const artwork = printedMaterial(scene, `equipment-display-price-inserts-${columns}`, 1536, 96, (ctx) => {
    ctx.fillStyle = "#657e6d"; ctx.fillRect(0, 0, 1536, 96);
    // Blank reusable holders: these are not inventory, live prices or product claims.
    for (let column = 0; column < columns; column += 1) {
      const cell = 1536 / columns;
      const card = Math.min(cell * 0.66, 176);
      const left = cell * (column + 0.5) - card / 2;
      ctx.fillStyle = "#f0ecdc"; ctx.fillRect(left, 13, card, 68);
      ctx.fillStyle = "#a6ada0"; ctx.fillRect(left + 12, 27, card * 0.47, 6);
      ctx.fillStyle = "#bdc2b5"; ctx.fillRect(left + 12, 43, card * 0.66, 4);
      ctx.fillRect(left + 12, 56, card * 0.30, 4);
    }
  });
  labelPlane(scene, root, `${id}-blank-price-inserts`, width - 0.010, 0.027,
    [0, shelfY - 0.011, z + side * 0.0078], artwork, [0, side === -1 ? 0 : Math.PI, 0]);
}

function shelfBrackets(
  scene: Scene, root: TransformNode, id: string, x: number, surfaceY: number,
  rearZ: number, frontZ: number, m: Materials,
): void {
  for (const side of [-1, 1]) {
    const atX = side * x;
    tube(scene, root, `${id}-triangular-bracket-${side}`,
      [[atX, surfaceY - 0.025, rearZ], [atX, surfaceY - 0.104, rearZ], [atX, surfaceY - 0.029, frontZ]], 0.008, m.steel, 8);
  }
}

function wallShelf(scene: Scene, root: TransformNode, id: "wall-shelf-narrow" | "wall-shelf-wide"): void {
  const wide = id === "wall-shelf-wide";
  const m = equipmentMaterials(scene);
  const [width, height, depth] = EQUIPMENT_ASSETS[id].size;
  const shelfWidth = wide ? 1.54 : 0.864;
  const shelfDepth = wide ? 0.54 : 0.44;
  const postX = wide ? 0.795 : 0.453;
  const backZ = wide ? 0.293 : 0.237;
  const shelfZ = wide ? 0 : -0.009;
  const frontZ = wide ? -0.294 : -0.242;
  const columns = wide ? 6 : 3;
  plinth(scene, root, id, width, depth, 0.145, m);
  // Narrow uses a folded cream back; wide adds birch slats and a third support.
  if (wide) {
    for (let slat = 0; slat < 6; slat += 1) {
      box(scene, root, `${id}-birch-back-panel-${slat}`, [0.254, 1.824, 0.018], [(slat - 2.5) * 0.260, 1.060, backZ], m.wood);
    }
    for (const end of [-1, 1]) {
      tube(scene, root, `${id}-rear-cross-brace-${end}`,
        [[end * 0.744, 0.22, 0.308], [-end * 0.744, 1.950, 0.308]], 0.010, m.steel, 8);
    }
  } else {
    box(scene, root, `${id}-folded-back-sheet`, [0.867, 1.670, 0.016], [0, 0.993, backZ], m.cream);
    for (let rib = 0; rib < 5; rib += 1) {
      box(scene, root, `${id}-back-sheet-stiffener-${rib}`, [0.006, 1.65, 0.011], [(rib - 2) * 0.16, 0.993, backZ - 0.009], m.white);
    }
  }
  for (const side of [-1, 1]) {
    adjustablePost(scene, root, `${id}-upright-${side}`, side * postX, wide ? 0.278 : 0.220,
      0.124, height - 0.025, wide ? 0.051 : 0.041, 0.043, m.sage, m.dark);
  }
  if (wide) adjustablePost(scene, root, `${id}-centre-upright`, 0, 0.278, 0.124, height - 0.025, 0.035, 0.034, m.sage, m.dark);
  for (const [row, y] of shelfHeights(id).entries()) {
    const thickness = wide ? 0.034 : 0.026;
    box(scene, root, `${id}-usable-shelf-${row}`, [shelfWidth, thickness, shelfDepth], [0, y - thickness / 2, shelfZ], wide ? m.wood : m.cream);
    box(scene, root, `${id}-shelf-rear-upstand-${row}`, [shelfWidth, 0.036, 0.012], [0, y + 0.011, shelfZ + shelfDepth / 2 - 0.002], m.sage);
    shelfBrackets(scene, root, `${id}-row-${row}`, wide ? 0.749 : 0.412, y, wide ? 0.268 : 0.208, frontZ + 0.028, m);
    priceRail(scene, root, `${id}-row-${row}`, shelfWidth + 0.016, y, frontZ, columns, m);
    if (wide) box(scene, root, `${id}-centre-under-shelf-beam-${row}`, [0.038, 0.022, shelfDepth], [0, y - thickness - 0.012, shelfZ], m.steel);
  }
  const headerHeight = wide ? 0.166 : 0.151;
  const headerY = height - headerHeight / 2;
  box(scene, root, `${id}-top-classification-fascia`, [width - 0.070, headerHeight, 0.040], [0, headerY, wide ? 0.277 : 0.222], m.green);
  equipmentSign(scene, root, `${id}-corner-shop-sign`, width - 0.140, headerHeight - 0.032,
    [0, headerY, wide ? 0.2565 : 0.2015], "CORNER SHOP", wide ? "PANTRY & HOUSEHOLD" : "EVERYDAY ESSENTIALS");
};

function gondola(scene: Scene, root: TransformNode, id: "gondola-low" | "gondola-tall"): void {
  const tall = id === "gondola-tall";
  const m = equipmentMaterials(scene);
  const [width, height, depth] = EQUIPMENT_ASSETS[id].size;
  const shelfWidth = tall ? 1.884 : 1.280;
  const shelfDepth = tall ? 0.426 : 0.380;
  const shelfCenter = tall ? 0.262 : 0.252;
  const railZ = tall ? 0.482 : 0.445;
  const postX = tall ? 0.974 : 0.672;
  const columns = tall ? 6 : 4;
  plinth(scene, root, id, width, depth, tall ? 0.150 : 0.132, m);
  if (tall) {
    for (let slat = 0; slat < 8; slat += 1) {
      box(scene, root, `${id}-central-birch-slat-${slat}`, [0.226, 1.690, 0.028], [(slat - 3.5) * 0.234, 0.999, 0], m.wood);
    }
    box(scene, root, `${id}-centre-spine-reinforcement`, [0.045, 1.810, 0.070], [0, 1.045, 0], m.green);
  } else {
    for (let panel = 0; panel < 4; panel += 1) {
      box(scene, root, `${id}-cream-spine-panel-${panel}`, [0.310, 1.280, 0.034], [(panel - 1.5) * 0.320, 0.798, 0], m.cream);
    }
  }
  for (const side of [-1, 1]) {
    adjustablePost(scene, root, `${id}-end-spine-${side}`, side * postX, 0, 0.125, height - 0.025, tall ? 0.046 : 0.043, 0.078, m.sage, m.dark);
  }
  for (const [row, y] of shelfHeights(id).entries()) for (const side of [-1, 1] as const) {
    const thickness = tall ? 0.031 : 0.026;
    box(scene, root, `${id}-shelf-${row}-${side}`, [shelfWidth, thickness, shelfDepth],
      [0, y - thickness / 2, side * shelfCenter], tall ? m.cream : m.white);
    shelfBrackets(scene, root, `${id}-shelf-${row}-${side}`, tall ? 0.914 : 0.620, y, side * 0.049, side * (railZ - 0.030), m);
    priceRail(scene, root, `${id}-shelf-${row}-${side}`, shelfWidth + 0.008, y, side * railZ, columns, m, side);
    // Back lips remain between the shelf envelope and the central spine.
    box(scene, root, `${id}-rear-shelf-lip-${row}-${side}`, [shelfWidth, 0.025, 0.009],
      [0, y + 0.004, side * (shelfCenter - shelfDepth / 2 + 0.005)], m.sage);
  }
  if (tall) {
    box(scene, root, `${id}-replaceable-category-header`, [1.914, 0.158, 0.088], [0, 1.881, 0], m.green);
    for (const side of [-1, 1] as const) {
      equipmentSign(scene, root, `${id}-category-sign-${side}`, 1.830, 0.114, [0, 1.881, side * 0.0447],
        "CORNER SHOP", "PANTRY  /  EVERYDAY GOODS", [0, side === -1 ? 0 : Math.PI, 0]);
      // Long cabinet ends have separate full-height frame rails, unlike the low rack.
      for (const end of [-1, 1]) {
        tube(scene, root, `${id}-end-outline-${side}-${end}`,
          [[end * 0.991, 0.156, side * 0.420], [end * 0.991, 1.735, side * 0.420], [end * 0.991, 1.849, side * 0.050]], 0.012, m.sage, 8);
      }
    }
  } else {
    box(scene, root, `${id}-low-sightline-cap`, [1.380, 0.068, 0.105], [0, 1.466, 0], m.sage);
    for (const side of [-1, 1] as const) {
      equipmentSign(scene, root, `${id}-small-category-sign-${side}`, 0.990, 0.050, [0, 1.467, side * 0.0532],
        "CORNER SHOP  ·  EVERYDAY", "", [0, side === -1 ? 0 : Math.PI, 0], true);
    }
    for (const end of [-1, 1]) {
      tube(scene, root, `${id}-open-end-guard-${end}`,
        [[end * 0.683, 0.19, -0.387], [end * 0.683, 1.25, -0.387], [end * 0.683, 1.36, 0], [end * 0.683, 1.25, 0.387], [end * 0.683, 0.19, 0.387]], 0.011, m.sage, 8);
    }
  }
}

const produceTiered: EquipmentBuilder = (scene, root) => {
  const id = "produce-tiered";
  const m = equipmentMaterials(scene);
  floorPads(scene, root, id, 1.44, 0.90, m.rubber, 0.074);
  for (const side of [-1, 1]) {
    box(scene, root, `${id}-floor-runner-${side}`, [0.105, 0.065, 0.870], [side * 0.646, 0.0565, 0], m.green);
    box(scene, root, `${id}-rear-wood-post-${side}`, [0.064, 1.391, 0.064], [side * 0.645, 0.7845, 0.401], m.woodEdge);
    const brace = box(scene, root, `${id}-diagonal-side-frame-${side}`, [0.057, Math.hypot(1.030, 0.690), 0.052],
      [side * 0.645, 0.654, 0], m.wood);
    brace.rotation.x = Math.atan2(0.690, 1.030);
  }
  box(scene, root, `${id}-low-cross-member`, [1.282, 0.070, 0.060], [0, 0.143, 0.364], m.woodEdge);
  const heights = shelfHeights(id);
  for (const [tier, y] of heights.entries()) {
    const z = (tier - 1) * 0.23;
    // Open below each tray. A full riser here would cut through the lower tier's
    // 290 mm deep product envelopes where successive tiers overlap in plan.
    box(scene, root, `${id}-tray-floor-${tier}`, [1.220, 0.028, 0.352], [0, y - 0.014, z], m.wood);
    for (const side of [-1, 1]) {
      box(scene, root, `${id}-tray-support-${tier}-${side}`, [0.083, 0.052, 0.387], [side * 0.612, y - 0.054, z], m.woodEdge);
      box(scene, root, `${id}-crate-end-${tier}-${side}`, [0.018, 0.140, 0.352], [side * 0.601, y + 0.070, z], m.woodEdge);
    }
    for (const side of [-1, 1]) {
      box(scene, root, `${id}-crate-front-back-${tier}-${side}`, [1.204, side === -1 ? 0.076 : 0.118, 0.018],
        [0, y + (side === -1 ? 0.038 : 0.059), z + side * 0.167], m.wood);
      box(scene, root, `${id}-crate-rim-${tier}-${side}`, [1.218, 0.014, 0.024],
        [0, y + (side === -1 ? 0.076 : 0.118), z + side * 0.167], m.woodEdge);
    }
    for (let divider = 0; divider < 3; divider += 1) {
      box(scene, root, `${id}-wood-cell-divider-${tier}-${divider}`, [0.015, 0.110, 0.327],
        [(divider - 1) * 0.29, y + 0.055, z], m.woodEdge);
    }
    for (let column = 0; column < 4; column += 1) {
      const x = (column - 1.5) * 0.29;
      box(scene, root, `${id}-individual-price-holder-${tier}-${column}`, [0.130, 0.039, 0.009], [x, y + 0.038, z - 0.181], m.green);
      box(scene, root, `${id}-blank-price-card-${tier}-${column}`, [0.111, 0.026, 0.001], [x, y + 0.039, z - 0.186], m.cream);
      // A shallow routed groove visually separates the four crate fronts.
      box(scene, root, `${id}-crate-front-joint-${tier}-${column}`, [0.003, 0.057, 0.0008], [x + 0.137, y + 0.037, z - 0.1765], m.woodEdge);
    }
  }
  box(scene, root, `${id}-header-board`, [1.353, 0.164, 0.041], [0, 1.398, 0.408], m.green);
  equipmentSign(scene, root, `${id}-produce-sign`, 1.256, 0.116, [0, 1.398, 0.387], "CORNER SHOP", "FRESH PRODUCE");
};

const bakeryGlass: EquipmentBuilder = (scene, root) => {
  const id = "bakery-glass";
  const m = equipmentMaterials(scene);
  floorPads(scene, root, id, 1.72, 0.72, m.rubber, 0.075);
  box(scene, root, `${id}-inset-kick-base`, [1.630, 0.098, 0.596], [0, 0.073, 0], m.dark);
  box(scene, root, `${id}-closed-birch-plinth`, [1.712, 0.145, 0.675], [0, 0.1935, 0], m.wood);
  box(scene, root, `${id}-plinth-lower-trim`, [1.720, 0.020, 0.681], [0, 0.132, 0], m.woodEdge);
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    box(scene, root, `${id}-cabinet-corner-${x}-${z}`, [0.057, 1.290, 0.056], [x * 0.816, 0.910, z * 0.307], m.woodEdge);
  }
  for (const side of [-1, 1]) {
    box(scene, root, `${id}-glass-side-panel-${side}`, [0.006, 1.256, 0.568], [side * 0.816, 0.903, 0], m.glass);
    box(scene, root, `${id}-side-top-frame-${side}`, [0.062, 0.041, 0.669], [side * 0.816, 1.5475, 0], m.woodEdge);
  }
  box(scene, root, `${id}-glass-back-panel`, [1.585, 1.256, 0.006], [0, 0.903, 0.308], m.glass);
  box(scene, root, `${id}-back-top-cross-member`, [1.651, 0.041, 0.044], [0, 1.5475, 0.307], m.woodEdge);
  for (const [tier, y] of shelfHeights(id).entries()) {
    box(scene, root, `${id}-wide-bread-tray-${tier}`, [1.576, 0.030, 0.568], [0, y - 0.015, 0], m.wood);
    box(scene, root, `${id}-tray-rear-edge-${tier}`, [1.576, 0.025, 0.014], [0, y + 0.005, 0.281], m.woodEdge);
    for (const side of [-1, 1]) {
      box(scene, root, `${id}-tray-side-runner-${tier}-${side}`, [0.018, 0.026, 0.568], [side * 0.778, y + 0.005, 0], m.woodEdge);
      box(scene, root, `${id}-tray-metal-support-${tier}-${side}`, [0.049, 0.020, 0.552], [side * 0.784, y - 0.040, 0], m.steel);
    }
    priceRail(scene, root, `${id}-bread-tray-${tier}`, 1.573, y, -0.291, 4, m);
  }
  // Two closed, separately framed front doors. Their handles remain within the
  // 720 mm base footprint and all glass stays outside the 480 mm slot depth.
  const doorBottom = 0.269;
  const doorTop = 1.526;
  const doorHeight = doorTop - doorBottom;
  for (const side of [-1, 1]) {
    const centerX = side * 0.396;
    box(scene, root, `${id}-front-glass-door-${side}`, [0.758, doorHeight - 0.035, 0.006], [centerX, (doorBottom + doorTop) / 2, -0.315], m.glass);
    for (const edge of [-1, 1]) {
      box(scene, root, `${id}-door-vertical-frame-${side}-${edge}`, [0.018, doorHeight, 0.016],
        [centerX + edge * 0.386, (doorBottom + doorTop) / 2, -0.315], m.woodEdge);
      box(scene, root, `${id}-door-horizontal-frame-${side}-${edge}`, [0.790, 0.021, 0.016],
        [centerX, edge === -1 ? doorBottom + 0.0105 : doorTop - 0.0105, -0.315], m.woodEdge);
    }
    for (const [hinge, y] of [0.416, 0.937, 1.405].entries()) {
      box(scene, root, `${id}-door-hinge-leaf-${side}-${hinge}`, [0.031, 0.052, 0.008], [side * 0.790, y, -0.327], m.steel);
      cylinder(scene, root, `${id}-door-hinge-pin-${side}-${hinge}`, 0.014, 0.014, 0.057, [side * 0.790, y, -0.332], m.steel, 12);
    }
    tube(scene, root, `${id}-door-pull-${side}`,
      [[side * 0.057, 0.839, -0.324], [side * 0.057, 0.866, -0.348], [side * 0.057, 1.048, -0.348], [side * 0.057, 1.075, -0.324]], 0.007, m.steel, 10);
  }
  box(scene, root, `${id}-door-center-catch`, [0.023, 0.028, 0.007], [0, 0.958, -0.331], m.steel);
  // The cream fascia ends at the underside of the wooden cap, not its top face.
  box(scene, root, `${id}-cream-canopy`, [1.720, 0.085, 0.679], [0, 1.5985, 0], m.cream);
  box(scene, root, `${id}-canopy-birch-top`, [1.720, 0.019, 0.688], [0, 1.6505, 0], m.wood);
  equipmentSign(scene, root, `${id}-bakery-sign`, 1.380, 0.060, [0, 1.5985, -0.3402], "CORNER SHOP  ·  BAKERY", "", [0, 0, 0], true);
};

/** A closed thin metal sheet with octagonal through-holes, not dark painted dots. */
function perforatedPanel(scene: Scene, root: TransformNode, id: string, mat: PBRMaterial): void {
  const positions: number[] = []; const normals: number[] = []; const uvs: number[] = []; const indices: number[] = [];
  const quad = (a: Point, b: Point, c: Point, d: Point, normal: Point): void => {
    const first = positions.length / 3;
    for (const point of [a, b, c, d]) { positions.push(...point); normals.push(...normal) }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const dot = (ab[1]! * ac[2]! - ab[2]! * ac[1]!) * normal[0]
      + (ab[2]! * ac[0]! - ab[0]! * ac[2]!) * normal[1]
      + (ab[0]! * ac[1]! - ab[1]! * ac[0]!) * normal[2];
    // Babylon's default left-handed triangle winding is opposite the RH cross.
    if (dot > 0) indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
    else indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  };
  const columns = 14; const rows = 17; const pitch = 0.09;
  const front = 0.131; const back = 0.149; const radius = 0.0075;
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const centerX = (column - (columns - 1) / 2) * pitch;
    const centerY = 0.282 + row * pitch;
    const ring = (angle: number, inner: boolean, z: number): Point => {
      const cos = Math.cos(angle); const sin = Math.sin(angle);
      const r = inner ? radius : pitch / 2 / Math.max(Math.abs(cos), Math.abs(sin));
      return [centerX + cos * r, centerY + sin * r, z];
    };
    for (let segment = 0; segment < 8; segment += 1) {
      const a = segment * Math.PI / 4; const b = (segment + 1) * Math.PI / 4;
      quad(ring(a, false, front), ring(b, false, front), ring(b, true, front), ring(a, true, front), [0, 0, -1]);
      quad(ring(a, false, back), ring(a, true, back), ring(b, true, back), ring(b, false, back), [0, 0, 1]);
      quad(ring(a, true, front), ring(b, true, front), ring(b, true, back), ring(a, true, back),
        [-Math.cos((a + b) / 2), -Math.sin((a + b) / 2), 0]);
    }
  }
  const left = -columns * pitch / 2; const right = -left;
  const bottom = 0.282 - pitch / 2; const top = 0.282 + (rows - 1) * pitch + pitch / 2;
  quad([left, bottom, front], [right, bottom, front], [right, bottom, back], [left, bottom, back], [0, -1, 0]);
  quad([left, top, front], [left, top, back], [right, top, back], [right, top, front], [0, 1, 0]);
  quad([left, bottom, front], [left, bottom, back], [left, top, back], [left, top, front], [-1, 0, 0]);
  quad([right, bottom, front], [right, top, front], [right, top, back], [right, bottom, back], [1, 0, 0]);
  const data = new VertexData();
  data.positions = positions; data.normals = normals; data.indices = indices; data.uvs = uvs;
  const mesh = new Mesh(`${root.name}-${id}-true-perforated-metal`, scene);
  data.applyToMesh(mesh);
  finish(mesh, root, mat);
}

const pegboardSnacks: EquipmentBuilder = (scene, root) => {
  const id = "pegboard-snacks";
  const m = equipmentMaterials(scene);
  for (const side of [-1, 1]) {
    box(scene, root, `${id}-t-foot-rubber-${side}`, [0.120, 0.021, 0.560], [side * 0.600, 0.0105, 0], m.rubber);
    box(scene, root, `${id}-t-foot-steel-${side}`, [0.099, 0.061, 0.541], [side * 0.600, 0.0505, 0], m.green);
    box(scene, root, `${id}-upright-${side}`, [0.036, 1.793, 0.048], [side * 0.642, 0.9775, 0.145], m.sage);
    tube(scene, root, `${id}-foot-brace-${side}`, [[side * 0.613, 0.079, -0.195], [side * 0.613, 0.418, 0.145]], 0.015, m.steel, 8);
  }
  box(scene, root, `${id}-lower-cross-bar`, [1.270, 0.062, 0.061], [0, 0.224, 0.140], m.green);
  perforatedPanel(scene, root, id, m.cream);
  for (const [index, slot] of EQUIPMENT_ASSETS[id].placementSlots.entries()) {
    const x = slot.position[0];
    const hookY = slot.position[1] + slot.maxSize[1] + 0.012;
    // Two pins sit on real 90 mm grid holes. All hardware is above the maximum
    // bag envelope; no rod cuts through a product's declared clear volume.
    box(scene, root, `${id}-hook-mount-plate-${index}`, [0.043, 0.116, 0.009], [x, hookY + 0.045, 0.125], m.steel);
    tube(scene, root, `${id}-bent-display-hook-${index}`,
      [[x, hookY + 0.090, 0.152], [x, hookY + 0.090, 0.114], [x, hookY, 0.114], [x, hookY, -0.174], [x, hookY + 0.026, -0.199]], 0.004, m.steel, 8);
    tube(scene, root, `${id}-hook-lower-locating-pin-${index}`,
      [[x, hookY, 0.114], [x, hookY, 0.152]], 0.0035, m.steel, 8);
    cylinder(scene, root, `${id}-hook-safety-tip-${index}`, 0.011, 0.010, 0.012, [x, hookY + 0.029, -0.199], m.green, 10);
    tube(scene, root, `${id}-hook-price-holder-clip-${index}`,
      [[x, hookY + 0.023, -0.196], [x, hookY + 0.052, -0.197]], 0.0025, m.steel, 8);
    box(scene, root, `${id}-hook-price-holder-${index}`, [0.114, 0.030, 0.008], [x, hookY + 0.061, -0.201], m.green);
    box(scene, root, `${id}-hook-blank-price-card-${index}`, [0.097, 0.020, 0.001], [x, hookY + 0.061, -0.2055], m.cream);
  }
  box(scene, root, `${id}-header-fascia`, [1.320, 0.173, 0.063], [0, 1.8535, 0.145], m.green);
  equipmentSign(scene, root, `${id}-snack-sign`, 1.220, 0.124, [0, 1.8535, 0.1127], "CORNER SHOP", "SNACKS & SMALL ESSENTIALS");
};

export const DISPLAY_BUILDERS = {
  "wall-shelf-narrow": (scene, root) => wallShelf(scene, root, "wall-shelf-narrow"),
  "wall-shelf-wide": (scene, root) => wallShelf(scene, root, "wall-shelf-wide"),
  "gondola-low": (scene, root) => gondola(scene, root, "gondola-low"),
  "gondola-tall": (scene, root) => gondola(scene, root, "gondola-tall"),
  "produce-tiered": produceTiered,
  "bakery-glass": bakeryGlass,
  "pegboard-snacks": pegboardSnacks,
} satisfies Record<DisplayId, EquipmentBuilder>;
