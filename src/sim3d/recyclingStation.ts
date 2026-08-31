import { Color3, DynamicTexture, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode } from "@babylonjs/core";
import type { Position } from "./domain";
import type { LayoutCollider } from "./productLayout";

/** Beside the right entrance pillar, clear of both delivery pads and the pavement route. */
export const RECYCLING_POINT: Readonly<Position> = { x: 3.5, z: -5.2 };

export interface RecyclingStation {
  root: TransformNode;
  collider: LayoutCollider;
}

/** A fixed-size collection point; decorative cardboard never grows with the recycling count. */
export function createRecyclingStation(scene: Scene): RecyclingStation {
  const root = new TransformNode("cardboard-recycling", scene);
  root.position.set(RECYCLING_POINT.x, 0.022, RECYCLING_POINT.z);
  const material = (name: string, color: string, metallic = 0): PBRMaterial => {
    const result = new PBRMaterial(`recycling-${name}`, scene);
    result.albedoColor = Color3.FromHexString(color);
    result.roughness = metallic ? 0.65 : 0.91;
    result.metallic = metallic;
    return result;
  };
  const green = material("green", "#3b7053", 0.12);
  const dark = material("dark", "#254b39", 0.12);
  const cardboard = material("cardboard", "#b59463");
  const cardboardEdge = material("cardboard-edge", "#8d704c");
  const box = (name: string, width: number, height: number, depth: number, x: number, y: number, z: number, mat: PBRMaterial): Mesh => {
    const mesh = MeshBuilder.CreateBox(`recycling-${name}`, { width, height, depth }, scene);
    mesh.parent = root;
    mesh.position.set(x, y, z);
    mesh.material = mat;
    mesh.isPickable = true;
    mesh.receiveShadows = true;
    return mesh;
  };

  box("base", 1.02, 0.10, 0.68, 0, 0.05, 0, dark);
  box("back", 1.02, 0.92, 0.045, 0, 0.55, 0.317, green);
  box("front", 1.02, 0.82, 0.045, 0, 0.50, -0.317, green);
  for (const side of [-1, 1]) {
    box(`side-${side}`, 0.045, 0.92, 0.68, side * 0.487, 0.55, 0, green);
    box(`rim-${side}`, 0.075, 0.055, 0.72, side * 0.487, 1.03, 0, dark);
    box(`signpost-${side}`, 0.044, 1.68, 0.048, side * 0.47, 0.88, -0.305, dark);
  }
  box("front-rim", 1.07, 0.055, 0.075, 0, 0.94, -0.317, dark);
  box("back-rim", 1.07, 0.055, 0.075, 0, 1.03, 0.317, dark);

  // Three folded sheets communicate cardboard recycling without creating more loose crates.
  for (let sheet = 0; sheet < 3; sheet += 1) {
    const flattened = box(`flattened-cardboard-${sheet}`, 0.76, 0.030, 0.44, (sheet - 1) * 0.025, 0.88 + sheet * 0.036, 0.035, cardboard);
    flattened.rotation.y = (sheet - 1) * 0.075;
    box(`cardboard-fold-${sheet}`, 0.013, 0.031, 0.42, (sheet - 1) * 0.025, 0.88 + sheet * 0.036, 0.035, cardboardEdge);
  }

  box("signboard", 1.08, 0.58, 0.045, 0, 1.53, -0.325, dark);
  const texture = new DynamicTexture("recycling-sign-print", { width: 1024, height: 544 }, scene, true);
  const context = texture.getContext() as CanvasRenderingContext2D;
  context.fillStyle = "#254b39";
  context.fillRect(0, 0, 1024, 544);
  context.strokeStyle = "#b8c69c";
  context.lineWidth = 5;
  context.strokeRect(18, 18, 988, 508);
  context.textAlign = "center";
  context.fillStyle = "#f5f0df";
  context.font = "600 79px Arial, 'PingFang SC', sans-serif";
  context.fillText("Cardboard recycling", 512, 156, 940);
  context.font = "600 123px 'PingFang SC', 'Microsoft YaHei', sans-serif";
  context.fillText("空箱回收", 512, 321, 924);
  context.font = "48px Arial, 'PingFang SC', sans-serif";
  context.fillText("Empty boxes only · 仅限空箱", 512, 439, 940);
  texture.update();
  texture.anisotropicFilteringLevel = 4;
  const signMaterial = material("sign", "#ffffff");
  signMaterial.albedoTexture = texture;
  // Babylon planes face -z by default: the sign faces the street and the approach point.
  const sign = MeshBuilder.CreatePlane("recycling-sign-label", { width: 1.065, height: 0.568 }, scene);
  sign.parent = root;
  sign.position.set(0, 1.53, -0.350);
  sign.material = signMaterial;
  sign.isPickable = true;

  return {
    root,
    collider: { minX: RECYCLING_POINT.x - 0.54, maxX: RECYCLING_POINT.x + 0.54, minZ: RECYCLING_POINT.z - 0.36, maxZ: RECYCLING_POINT.z + 0.36 },
  };
}
