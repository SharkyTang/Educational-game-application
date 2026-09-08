import { Color3, DynamicTexture, Mesh, PBRMaterial, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { box, ellipsoid, labelPlane } from "./equipment-library/geometry";
import type { LayoutCollider } from "./productLayout";
import { WORKSTATION_ID, workstationBounds, workstationInteractionPoint, type WorkstationPlacement } from "./workstation";

export interface WorkstationAsset {
  root: TransformNode;
  interactionMesh: Mesh;
  /** Stable objects, updated in place when the complete desk moves. */
  interactionPoint: Vector3;
  collider: LayoutCollider;
  apply(placement: WorkstationPlacement): void;
  dispose(): void;
}

/** Locally authored furniture; its screen is decoration and the accessible desktop belongs to App3D. */
export function createWorkstation(scene: Scene, placement: WorkstationPlacement): WorkstationAsset {
  const root = new TransformNode(WORKSTATION_ID, scene);
  root.metadata = { furnitureId: WORKSTATION_ID, assetType: "management-computer", free: true };
  const ownedMaterials: PBRMaterial[] = [];
  const makeMaterial = (name: string, color: string, roughness: number, metallic = 0): PBRMaterial => {
    const mat = new PBRMaterial(`${WORKSTATION_ID}-${name}`, scene);
    mat.albedoColor = Color3.FromHexString(color); mat.roughness = roughness; mat.metallic = metallic;
    ownedMaterials.push(mat); return mat;
  };
  const oak = makeMaterial("oak", "#bda179", .83);
  const edge = makeMaterial("edge", "#8c704b", .83);
  const sage = makeMaterial("paint", "#62786b", .68, .1);
  const dark = makeMaterial("computer", "#253631", .62, .12);
  const keys = makeMaterial("keys", "#e3dfd1", .78);
  const glass = makeMaterial("screen", "#233f36", .4);
  const texture = new DynamicTexture(`${WORKSTATION_ID}-desktop`, { width: 768, height: 432 }, scene, false);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = "#29473c"; ctx.fillRect(0, 0, 768, 432);
  ctx.fillStyle = "#ede7d7"; ctx.font = "600 28px Arial, sans-serif"; ctx.textAlign = "left";
  ctx.fillText("CORNER SHOP", 30, 44);
  const iconLabels = ["SUPPLY", "BUSINESS", "EXPAND", "EQUIPMENT", "LAYOUT", "HIGH STREET"];
  for (let index = 0; index < iconLabels.length; index += 1) {
    const x = 80 + index % 3 * 252; const y = 91 + Math.floor(index / 3) * 140;
    ctx.fillStyle = ["#d7b86b", "#9ab5ae", "#bbaad0", "#a9c7b3", "#d4a386", "#91acc5"][index]!;
    ctx.fillRect(x, y, 64, 58);
    ctx.fillStyle = "#29473c"; ctx.font = "600 35px Arial, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(String(index + 1), x + 32, y + 42);
    ctx.fillStyle = "#f2ecdd"; ctx.font = "17px Arial, sans-serif";
    ctx.fillText(iconLabels[index]!, x + 32, y + 85);
  }
  ctx.fillStyle = "#d3dccd"; ctx.font = "21px Arial, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("E  ·  OPEN COMPUTER", 384, 410); texture.update();
  glass.albedoTexture = texture; glass.emissiveTexture = texture;
  glass.emissiveColor = new Color3(.28, .28, .28);
  glass.backFaceCulling = false;
  box(scene, root, "desktop", [1.2, .055, .55], [0, .77, 0], oak);
  box(scene, root, "desk-edge", [1.2, .025, .027], [0, .745, .2615], edge);
  for (const x of [-.53, .53]) for (const z of [-.205, .205]) {
    box(scene, root, `leg-${x}-${z}`, [.065, .7425, .065], [x, .37125, z], sage);
  }
  box(scene, root, "rear-brace", [1.08, .085, .04], [0, .39, -.215], sage);
  box(scene, root, "computer-tower", [.19, .43, .36], [.36, .215, -.025], dark);
  box(scene, root, "tower-face", [.173, .40, .011], [.36, .218, .1605], sage);
  for (let row = 0; row < 6; row += 1) box(scene, root, `tower-vent-${row}`, [.12, .006, .004], [.36, .12 + row * .026, .168], dark);
  ellipsoid(scene, root, "power-light", [.01, .01, .006], [.36, .385, .169], keys, 8);
  box(scene, root, "monitor-base", [.28, .025, .15], [0, .809, -.12], dark);
  box(scene, root, "monitor-neck", [.053, .22, .04], [0, .93, -.155], sage);
  box(scene, root, "monitor-bezel", [.66, .39, .04], [0, 1.15, -.112], dark);
  const interactionMesh = labelPlane(scene, root, "monitor-screen", .615, .346, [0, 1.15, -.0905], glass, [0, Math.PI, 0]);
  box(scene, root, "keyboard", [.41, .026, .125], [-.035, .812, .135], dark);
  for (let row = 0; row < 4; row += 1) for (let column = 0; column < 12; column += 1) {
    box(scene, root, `key-${row}-${column}`, [.026, .006, .019], [-.213 + column * .032, .828, .095 + row * .024], keys);
  }
  box(scene, root, "mouse-mat", [.17, .003, .18], [.31, .799, .12], sage);
  ellipsoid(scene, root, "mouse", [.059, .029, .096], [.31, .815, .12], keys, 12);
  box(scene, root, "mouse-wheel", [.008, .008, .018], [.31, .831, .109], dark);
  const interactionPoint = new Vector3();
  const collider = workstationBounds(placement);
  let disposed = false;
  const apply = (next: WorkstationPlacement): void => {
    if (disposed) return;
    root.position.set(next.x, 0, next.z); root.rotation.y = next.rotation * Math.PI / 2;
    root.computeWorldMatrix(true);
    for (const child of root.getChildMeshes()) child.computeWorldMatrix(true);
    const point = workstationInteractionPoint(next);
    interactionPoint.set(point.x, point.y, point.z);
    Object.assign(collider, workstationBounds(next));
  };
  apply(placement);
  return { root, interactionMesh, interactionPoint, collider, apply, dispose: () => {
    if (disposed) return;
    disposed = true; root.dispose(false, false);
    for (const mat of ownedMaterials) mat.dispose(false, false);
    texture.dispose();
  } };
}
