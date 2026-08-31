import { Color3, type PBRMaterial, type Scene, type TransformNode } from "@babylonjs/core";
import { printedMaterial, surface, translucent, labelPlane, type Point } from "../product-library/geometry";

export { box, cylinder, ellipsoid, finish, labelPlane, lathe, mergeParts, printedMaterial, surface, translucent, tube } from "../product-library/geometry";
export type { Point } from "../product-library/geometry";
export type EquipmentBuilder = (scene: Scene, root: TransformNode) => void;

export function equipmentMaterials(scene: Scene) {
  return {
    sage: surface(scene, "equipment-sage", "#62786b", 0.62, 0.18),
    green: surface(scene, "equipment-forest", "#29483d", 0.58, 0.20),
    cream: surface(scene, "equipment-cream", "#e9e5d8", 0.60, 0.05),
    wood: surface(scene, "equipment-birch", "#bda179", 0.87),
    woodEdge: surface(scene, "equipment-birch-edge", "#8c704b", 0.88),
    steel: surface(scene, "equipment-steel", "#a6b2b2", 0.38, 0.72),
    dark: surface(scene, "equipment-dark", "#263332", 0.70, 0.18),
    rubber: surface(scene, "equipment-rubber", "#35403a", 0.95),
    glass: translucent(scene, "equipment-clear-glass", "#cde9e4", 0.15),
    white: surface(scene, "equipment-white", "#f0f0e9", 0.82),
  };
}

/** Screen graphics and cabinet signs are original and contain no real payment marks. */
export function equipmentSign(scene: Scene, root: TransformNode, key: string, width: number, height: number, position: Point, title: string, detail = "", rotation: Point = [0, 0, 0], light = false) {
  const pixelWidth = 768;
  const pixelHeight = Math.max(128, Math.round(pixelWidth * height / width));
  const mat = printedMaterial(scene, `equipment-${key}-${title}-${detail}-${light}`, pixelWidth, pixelHeight, (ctx) => {
    ctx.fillStyle = light ? "#eae6d5" : "#2c4a3e"; ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    ctx.strokeStyle = light ? "#b7a589" : "#95aa8c"; ctx.lineWidth = 3; ctx.strokeRect(8, 8, pixelWidth - 16, pixelHeight - 16);
    ctx.fillStyle = light ? "#29483d" : "#eee9d9"; ctx.textAlign = "center";
    ctx.font = `600 ${Math.round(pixelHeight * (detail ? 0.34 : 0.46))}px Arial, sans-serif`;
    ctx.fillText(title, pixelWidth / 2, pixelHeight * (detail ? 0.49 : 0.65), pixelWidth - 42);
    if (detail) { ctx.font = `${Math.round(pixelHeight * 0.21)}px Arial, sans-serif`; ctx.fillText(detail, pixelWidth / 2, pixelHeight * 0.80, pixelWidth - 42); }
  });
  return labelPlane(scene, root, key, width, height, position, mat, rotation);
}

export function litSurface(scene: Scene, key: string, colour: string, intensity = 0.32): PBRMaterial {
  const mat = surface(scene, `equipment-lit-${key}`, colour, 0.4);
  mat.emissiveColor = Color3.FromHexString(colour).scale(intensity);
  return mat;
}
