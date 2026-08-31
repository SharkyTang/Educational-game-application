import { Mesh, VertexData, type PBRMaterial, type Scene, type TransformNode } from "@babylonjs/core";
import { EQUIPMENT_ASSETS } from "./catalog";
import {
  box, cylinder, equipmentMaterials, equipmentSign, finish, surface, tube,
  type EquipmentBuilder, type Point,
} from "./geometry";

type ChillerId = "chest-chiller-compact" | "chest-chiller-wide" | "island-chiller";
type ChillerMaterials = ReturnType<typeof equipmentMaterials>;

interface ChillerStyle {
  id: ChillerId;
  panels: 2 | 3;
  lidBase: number;
  lidRise: number;
  wheelColumns: 2 | 3 | 4;
  body: "cream" | "sage";
  bumper: boolean;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 1_000_000) / 1_000_000))].sort((a, b) => a - b);
}

/** Closed, thin curved solids, with a real lower face and outward left-handed normals. */
function profileSlab(
  scene: Scene, root: TransformNode, name: string, width: number, depth: number, centreX: number,
  lower: (z: number) => number, upper: (z: number) => number, mat: PBRMaterial, segments = 20,
): Mesh {
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  const face = (input: Point[], outward: Point): void => {
    const points = [...input], a = points[0]!, b = points[1]!, c = points[2]!;
    const ab: Point = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cb: Point = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const normal: Point = [ab[1] * cb[2] - ab[2] * cb[1], ab[2] * cb[0] - ab[0] * cb[2], ab[0] * cb[1] - ab[1] * cb[0]];
    if (normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2] < 0) points.reverse();
    const start = positions.length / 3;
    for (let i = 0; i < points.length; i += 1) { positions.push(...points[i]!); uvs.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0); }
    for (let i = 1; i < points.length - 1; i += 1) indices.push(start, start + i, start + i + 1);
  };
  const left = centreX - width / 2, right = centreX + width / 2;
  for (let strip = 0; strip < segments; strip += 1) {
    const z0 = -depth / 2 + strip / segments * depth, z1 = -depth / 2 + (strip + 1) / segments * depth;
    const b0 = lower(z0), b1 = lower(z1), t0 = upper(z0), t1 = upper(z1);
    face([[left, t0, z0], [right, t0, z0], [right, t1, z1], [left, t1, z1]], [0, 1, 0]);
    face([[left, b0, z0], [right, b0, z0], [right, b1, z1], [left, b1, z1]], [0, -1, 0]);
    face([[left, b0, z0], [left, t0, z0], [left, t1, z1], [left, b1, z1]], [-1, 0, 0]);
    face([[right, b0, z0], [right, t0, z0], [right, t1, z1], [right, b1, z1]], [1, 0, 0]);
  }
  for (const side of [-1, 1]) {
    const z = side * depth / 2;
    face([[left, lower(z), z], [right, lower(z), z], [right, upper(z), z], [left, upper(z), z]], [0, 0, side]);
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions; data.indices = indices; data.normals = normals; data.uvs = uvs;
  const mesh = new Mesh(`${root.name}-${name}`, scene);
  data.applyToMesh(mesh);
  return finish(mesh, root, mat);
}

function wheel(
  scene: Scene, root: TransformNode, name: string, x: number, z: number, mat: ChillerMaterials,
): void {
  const tyre = cylinder(scene, root, `${name}-tyre`, 0.072, 0.072, 0.028, [x, 0.036, z], mat.rubber, 24);
  tyre.rotation.z = Math.PI / 2;
  const hub = cylinder(scene, root, `${name}-hub`, 0.030, 0.030, 0.031, [x, 0.036, z], mat.steel, 20);
  hub.rotation.z = Math.PI / 2;
  for (const side of [-1, 1]) box(scene, root, `${name}-fork-${side}`, [0.006, 0.048, 0.025], [x + side * 0.021, 0.065, z], mat.steel);
  box(scene, root, `${name}-fork-bridge`, [0.048, 0.012, 0.030], [x, 0.090, z], mat.steel);
  cylinder(scene, root, `${name}-swivel`, 0.038, 0.038, 0.019, [x, 0.1035, z], mat.dark, 24);
  box(scene, root, `${name}-mount`, [0.066, 0.009, 0.050], [x, 0.115, z], mat.steel);
}

/** Every catalogue envelope is inside a real cell, not just an arbitrary capacity number. */
function baskets(scene: Scene, root: TransformNode, id: ChillerId, mat: ChillerMaterials): void {
  const slots = EQUIPMENT_ASSETS[id].placementSlots;
  const xs = uniqueSorted(slots.map((slot) => slot.position[0]));
  const zs = uniqueSorted(slots.map((slot) => slot.position[2]));
  const heights = uniqueSorted(slots.map((slot) => slot.position[1]));
  const pitchX = xs[1]! - xs[0]!, pitchZ = zs[1]! - zs[0]!;
  const halfX = xs.length * pitchX / 2, halfZ = zs.length * pitchZ / 2;
  const boundariesX = Array.from({ length: xs.length + 1 }, (_, index) => -halfX + index * pitchX);
  const boundariesZ = Array.from({ length: zs.length + 1 }, (_, index) => -halfZ + index * pitchZ);
  const wire = surface(scene, "equipment-chiller-basket-wire", "#d8e1d8", 0.58, 0.26);
  const lowerWire = surface(scene, "equipment-chiller-lower-basket-wire", "#a9c0b9", 0.60, 0.32);
  const endX = halfX + 0.004, endZ = halfZ + 0.004;

  for (let layer = 0; layer < heights.length; layer += 1) {
    const y = heights[layer]!, layerSlots = slots.filter((slot) => Math.abs(slot.position[1] - y) < 0.00001);
    const envelopeHeight = Math.max(...layerSlots.map((slot) => slot.maxSize[1]));
    const top = y + envelopeHeight + 0.008, floor = y - 0.0028;
    const layerMat = layer === 0 ? lowerWire : wire;
    const prefix = `${id}-basket-layer-${layer + 1}`;
    const member = (name: string, start: Point, end: Point, radius = 0.0022): Mesh => tube(scene, root, `${prefix}-${name}`, [start, end], radius, layerMat, 6);

    // The top of a floor wire is 0.6 mm below the slot origin. Include every slot
    // centre explicitly, so a vertical support probe never lands in a mesh hole.
    const floorColumns = Math.ceil(halfX * 2 / 0.052), floorRows = Math.ceil(halfZ * 2 / 0.052);
    const floorXs = uniqueSorted([...xs, ...Array.from({ length: floorColumns + 1 }, (_, index) => -halfX + index / floorColumns * halfX * 2)]);
    const floorZs = uniqueSorted([...zs, ...Array.from({ length: floorRows + 1 }, (_, index) => -halfZ + index / floorRows * halfZ * 2)]);
    floorXs.forEach((x, index) => member(`floor-depth-${index}`, [x, floor, -endZ], [x, floor, endZ]));
    floorZs.forEach((z, index) => member(`floor-width-${index}`, [-endX, floor, z], [endX, floor, z]));

    for (let index = 0; index < boundariesX.length; index += 1) {
      const x = boundariesX[index]!;
      member(`column-top-${index}`, [x, top, -endZ], [x, top, endZ], 0.003);
      member(`column-bottom-${index}`, [x, y + 0.003, -endZ], [x, y + 0.003, endZ], 0.0027);
      for (const z of uniqueSorted([...boundariesZ, ...zs])) member(`column-upright-${index}-${z}`, [x, y + 0.003, z], [x, top, z]);
    }
    for (let index = 0; index < boundariesZ.length; index += 1) {
      const z = boundariesZ[index]!;
      member(`row-top-${index}`, [-endX, top, z], [endX, top, z], 0.003);
      member(`row-bottom-${index}`, [-endX, y + 0.003, z], [endX, y + 0.003, z], 0.0027);
      for (const x of xs) member(`row-upright-${index}-${x}`, [x, y + 0.003, z], [x, top, z]);
    }

    // Basket feet/side runners sit outside the display envelopes. Upper baskets
    // are removable in a real cabinet; this art asset intentionally has no animation.
    for (const side of [-1, 1]) {
      box(scene, root, `${prefix}-side-runner-${side}`, [0.018, 0.018, halfZ * 2 + 0.046], [side * (halfX + 0.012), y - 0.012, 0], mat.steel);
      for (const z of [-halfZ, halfZ]) box(scene, root, `${prefix}-runner-seat-${side}-${z}`, [0.040, 0.012, 0.026], [side * (halfX + 0.023), y - 0.022, z], mat.white);
    }
  }
}

function vent(
  scene: Scene, root: TransformNode, name: string, centreX: number, y: number, width: number,
  height: number, frontZ: number, mat: ChillerMaterials, rows = 8,
): void {
  box(scene, root, `${name}-recess`, [width, height, 0.004], [centreX, y, frontZ], mat.dark);
  for (let row = 0; row < rows; row += 1) {
    const slat = box(scene, root, `${name}-louvre-${row}`, [width - 0.024, 0.008, 0.006], [centreX, y - height / 2 + 0.014 + row * (height - 0.028) / (rows - 1), frontZ - 0.004], mat.steel);
    slat.rotation.x = -0.22;
  }
}

function screw(scene: Scene, root: TransformNode, name: string, position: Point, mat: ChillerMaterials): void {
  const head = cylinder(scene, root, name, 0.009, 0.009, 0.002, position, mat.steel, 12);
  head.rotation.x = -Math.PI / 2;
  box(scene, root, `${name}-slot`, [0.005, 0.0012, 0.0006], [position[0], position[1], position[2] - 0.0013], mat.dark);
}

function cabinet(scene: Scene, root: TransformNode, style: ChillerStyle, mat: ChillerMaterials): void {
  const asset = EQUIPMENT_ASSETS[style.id], [width, height, depth] = asset.size;
  const bodyTop = style.lidBase - 0.025, bottom = 0.118;
  const panelHeight = bodyTop - bottom;
  const front = -depth / 2 + 0.022;
  const body = mat[style.body];

  // Hollow insulated case: no solid placeholder cube through the placement bay.
  box(scene, root, `${style.id}-compressor-plinth`, [width - 0.076, 0.100, depth - 0.090], [0, 0.163, 0], mat.dark);
  box(scene, root, `${style.id}-insulated-floor`, [width - 0.080, 0.026, depth - 0.080], [0, 0.226, 0], mat.cream);
  for (const side of [-1, 1]) {
    box(scene, root, `${style.id}-outer-end-${side}`, [0.038, panelHeight, depth - 0.044], [side * (width / 2 - 0.041), (bottom + bodyTop) / 2, 0], body);
    box(scene, root, `${style.id}-outer-long-panel-${side}`, [width - 0.120, panelHeight, 0.038], [0, (bottom + bodyTop) / 2, side * (depth / 2 - 0.041)], body);
    box(scene, root, `${style.id}-inner-end-liner-${side}`, [0.008, bodyTop - 0.242, depth - 0.140], [side * (width / 2 - 0.065), (bodyTop + 0.242) / 2, 0], mat.white);
    box(scene, root, `${style.id}-inner-long-liner-${side}`, [width - 0.140, bodyTop - 0.242, 0.008], [0, (bodyTop + 0.242) / 2, side * (depth / 2 - 0.065)], mat.white);
    for (const zSide of [-1, 1]) {
      const x = side * (width / 2 - 0.028), z = zSide * (depth / 2 - 0.028);
      box(scene, root, `${style.id}-corner-post-${side}-${zSide}`, [0.036, panelHeight, 0.036], [x, (bottom + bodyTop) / 2, z], mat.cream);
    }
  }

  const wheelXs = Array.from({ length: style.wheelColumns }, (_, index) => -width / 2 + 0.115 + index / (style.wheelColumns - 1) * (width - 0.230));
  wheelXs.forEach((x, column) => { for (const side of [-1, 1]) wheel(scene, root, `${style.id}-caster-${column}-${side}`, x, side * (depth / 2 - 0.115), mat); });

  const trimY = style.lidBase - 0.106;
  box(scene, root, `${style.id}-front-brand-band`, [width - 0.084, 0.068, 0.005], [0, trimY, front - 0.003], mat.green);
  if (style.id === "island-chiller") box(scene, root, `${style.id}-rear-brand-band`, [width - 0.084, 0.068, 0.005], [0, trimY, -front + 0.003], mat.green);
  equipmentSign(scene, root, `${style.id}-capacity-plate`, Math.min(0.57, width * 0.38), 0.100,
    [0, height - 0.312, front - 0.007], "CORNER SHOP", `${asset.capacity} DISPLAY SPACES · 2 LEVELS`, [0, 0, 0], true);
  equipmentSign(scene, root, `${style.id}-temperature`, 0.135, 0.075,
    [width / 2 - 0.204, height - 0.218, front - 0.008], "4 °C", "CHILLED");
  box(scene, root, `${style.id}-control-bezel`, [0.150, 0.090, 0.008], [width / 2 - 0.204, height - 0.218, front - 0.001], mat.dark);

  if (style.id === "chest-chiller-compact") {
    vent(scene, root, `${style.id}-front-vent`, -0.225, 0.275, 0.420, 0.155, front - 0.005, mat, 8);
    equipmentSign(scene, root, `${style.id}-service-plate`, 0.245, 0.047, [0.261, 0.241, front - 0.007], "SERVICE", "KEEP VENT CLEAR", [0, 0, 0], true);
    box(scene, root, `${style.id}-bottom-sage-trim`, [width - 0.088, 0.033, 0.007], [0, 0.144, front - 0.003], mat.sage);
  } else {
    const serviceX = width / 2 - 0.330, serviceWidth = 0.476;
    box(scene, root, `${style.id}-compressor-access-panel`, [serviceWidth, 0.244, 0.006], [serviceX, 0.286, front - 0.003], mat.cream);
    vent(scene, root, `${style.id}-compressor-vent`, serviceX, 0.278, serviceWidth - 0.050, 0.148, front - 0.008, mat, 8);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) screw(scene, root, `${style.id}-access-screw-${sx}-${sy}`, [serviceX + sx * 0.217, 0.286 + sy * 0.104, front - 0.008], mat);
    vent(scene, root, `${style.id}-air-return`, -width / 2 + 0.365, 0.277, 0.520, 0.160, front - 0.005, mat, 9);
  }

  if (style.bumper) for (const side of [-1, 1]) {
    tube(scene, root, `${style.id}-bumper-rail-${side}`, [[-width / 2 + 0.061, 0.166, side * (depth / 2 - 0.011)], [width / 2 - 0.061, 0.166, side * (depth / 2 - 0.011)]], 0.011, mat.rubber, 8);
    for (const xSide of [-1, 1]) box(scene, root, `${style.id}-bumper-corner-${side}-${xSide}`, [0.080, 0.049, 0.044], [xSide * (width / 2 - 0.040), 0.166, side * (depth / 2 - 0.022)], mat.rubber);
  }
  if (style.id === "island-chiller") {
    for (const x of [-0.420, 0.420]) {
      box(scene, root, `${style.id}-front-panel-joint-${x}`, [0.009, 0.470, 0.002], [x, 0.588, front - 0.002], mat.steel);
      box(scene, root, `${style.id}-rear-panel-joint-${x}`, [0.009, 0.470, 0.002], [x, 0.588, -front + 0.002], mat.steel);
    }
    equipmentSign(scene, root, `${style.id}-rear-capacity-plate`, 0.57, 0.100, [0, height - 0.312, -front + 0.007], "CORNER SHOP", "72 DISPLAY SPACES · 2 LEVELS", [0, Math.PI, 0], true);
  }
}

function slidingCovers(scene: Scene, root: TransformNode, style: ChillerStyle, mat: ChillerMaterials): void {
  const [width, height, depth] = EQUIPMENT_ASSETS[style.id].size;
  const lidDepth = depth - 0.150, openingWidth = width - 0.170;
  const arc = (z: number): number => style.lidBase + style.lidRise * Math.max(0, 1 - (z * 2 / lidDepth) ** 2);
  const cuts = style.panels === 2 ? [-openingWidth / 2, 0, openingWidth / 2] : [-openingWidth / 2, -0.420, 0.420, openingWidth / 2];

  // The outer frame itself reaches the nominal x/z envelope; all signs and handles
  // remain inside it, so the bottom-centred origin remains horizontally symmetric.
  for (const side of [-1, 1]) {
    box(scene, root, `${style.id}-long-top-frame-${side}`, [width, 0.034, 0.045], [0, style.lidBase - 0.0185, side * (depth / 2 - 0.0225)], mat.steel);
    box(scene, root, `${style.id}-end-top-frame-${side}`, [0.045, 0.034, depth - 0.090], [side * (width / 2 - 0.0225), style.lidBase - 0.0185, 0], mat.steel);
    box(scene, root, `${style.id}-slider-track-${side}`, [openingWidth + 0.054, 0.008, 0.015], [0, style.lidBase + 0.002, side * (lidDepth / 2 + 0.021)], mat.dark);
    if (style.lidRise > 0) profileSlab(scene, root, `${style.id}-arched-end-cheek-${side}`, 0.038, depth - 0.060, side * (width / 2 - 0.019), () => style.lidBase - 0.022, (z) => arc(z) + 0.012, mat.cream);
  }

  for (let panel = 0; panel < style.panels; panel += 1) {
    const centreX = (cuts[panel]! + cuts[panel + 1]!) / 2, paneWidth = cuts[panel + 1]! - cuts[panel]! - 0.012;
    const offset = panel * 0.004;
    const glass = profileSlab(scene, root, `${style.id}-transparent-sliding-glass-${panel + 1}`, paneWidth - 0.017, lidDepth - 0.017,
      centreX, (z) => arc(z) + offset - 0.0025, (z) => arc(z) + offset + 0.0025, mat.glass, style.lidRise ? 20 : 1);
    glass.alphaIndex = 2;
    for (const side of [-1, 1]) {
      const railZ = side * (lidDepth / 2 - 0.007);
      box(scene, root, `${style.id}-pane-${panel + 1}-cross-rail-${side}`, [paneWidth, 0.012, 0.014], [centreX, arc(railZ) + offset, railZ], mat.steel);
      const x = centreX + side * (paneWidth / 2 - 0.007);
      tube(scene, root, `${style.id}-pane-${panel + 1}-curved-edge-${side}`, Array.from({ length: 21 }, (_, index) => {
        const z = -lidDepth / 2 + index / 20 * lidDepth;
        return [x, arc(z) + offset, z] as Point;
      }), 0.007, mat.steel, 8);
    }
    const handleZ = -lidDepth * 0.34, baseY = arc(handleZ) + offset + 0.007;
    const gripY = height - 0.006;
    tube(scene, root, `${style.id}-pane-${panel + 1}-raised-handle`, [
      [centreX - 0.066, baseY, handleZ], [centreX - 0.066, gripY - 0.012, handleZ],
      [centreX - 0.054, gripY, handleZ], [centreX + 0.054, gripY, handleZ],
      [centreX + 0.066, gripY - 0.012, handleZ], [centreX + 0.066, baseY, handleZ],
    ], 0.006, style.id === "chest-chiller-compact" ? mat.sage : mat.dark, 10);
    for (const side of [-1, 1]) box(scene, root, `${style.id}-pane-${panel + 1}-handle-foot-${side}`, [0.022, 0.006, 0.025], [centreX + side * 0.066, baseY - 0.003, handleZ], mat.steel);
  }
  for (let cut = 1; cut < cuts.length - 1; cut += 1) {
    tube(scene, root, `${style.id}-centre-track-${cut}`, Array.from({ length: 21 }, (_, index) => {
      const z = -lidDepth / 2 + index / 20 * lidDepth;
      return [cuts[cut]!, arc(z) - 0.004, z] as Point;
    }), 0.006, mat.rubber, 8);
  }
}

function chiller(scene: Scene, root: TransformNode, style: ChillerStyle): void {
  const mat = equipmentMaterials(scene);
  cabinet(scene, root, style, mat);
  baskets(scene, root, style.id, mat);
  slidingCovers(scene, root, style, mat);
}

export const REFRIGERATION_BUILDERS: Record<ChillerId, EquipmentBuilder> = {
  "chest-chiller-compact": (scene, root) => chiller(scene, root, { id: "chest-chiller-compact", panels: 2, lidBase: 0.950, lidRise: 0, wheelColumns: 2, body: "cream", bumper: false }),
  "chest-chiller-wide": (scene, root) => chiller(scene, root, { id: "chest-chiller-wide", panels: 2, lidBase: 0.958, lidRise: 0.029, wheelColumns: 3, body: "sage", bumper: true }),
  "island-chiller": (scene, root) => chiller(scene, root, { id: "island-chiller", panels: 3, lidBase: 0.972, lidRise: 0.034, wheelColumns: 4, body: "cream", bumper: true }),
};
