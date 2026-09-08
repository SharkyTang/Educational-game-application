import {
  Color3, DynamicTexture, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3,
} from "@babylonjs/core";
import { CASH_DENOMINATIONS_PENCE, isCashDenomination, type CashDenominationPence } from "./cashPayment";

/** Metres; the housing origin is its centre and +z points towards the shopkeeper. */
export const CASH_DRAWER_DIMENSIONS = Object.freeze({ width: .52, depth: .40, height: .075, slideDistance: .27 });

export interface CashPieceDimensions {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly kind: "coin" | "note";
}

const coin = (diameter: number, height = .0028): CashPieceDimensions => Object.freeze({ width: diameter, depth: diameter, height, kind: "coin" });
const note = (width: number, depth: number): CashPieceDimensions => Object.freeze({ width, depth, height: .001, kind: "note" });

/** Deliberately legible teaching pieces, not dimensionally exact replicas of British currency. */
export const CASH_PIECE_DIMENSIONS: Readonly<Record<CashDenominationPence, CashPieceDimensions>> = Object.freeze({
  1: coin(.032), 2: coin(.036), 5: coin(.030), 10: coin(.034),
  20: coin(.033), 50: coin(.038), 100: coin(.035, .0031), 200: coin(.043, .0032),
  500: note(.180, .078), 1000: note(.195, .086),
});

export interface CashCompartmentAsset {
  /** Bottom-surface anchor; add visual pieces here without changing their parent again. */
  readonly root: TransformNode;
  readonly floor: Mesh;
  readonly denomination: CashDenominationPence;
  readonly innerWidth: number;
  readonly innerDepth: number;
}

export interface CashDrawerAsset {
  readonly root: TransformNode;
  readonly shell: TransformNode;
  readonly slidingDrawer: TransformNode;
  readonly compartmentsMap: ReadonlyMap<CashDenominationPence, CashCompartmentAsset>;
  setOpenRatio(ratio: number): void;
  dispose(): void;
}

interface MaterialEntry {
  material: PBRMaterial;
  texture: DynamicTexture | null;
  references: number;
}
const materialPools = new WeakMap<Scene, Map<string, MaterialEntry>>();
let assetSequence = 0;

/** Resources are shared only within one Scene; each asset holds one lease per material. */
class AssetMaterials {
  private readonly acquired = new Map<string, MaterialEntry>();
  private disposed = false;

  constructor(private readonly scene: Scene, root: TransformNode) {
    root.onDisposeObservable.addOnce(() => this.dispose());
  }

  get(key: string, color: string, metallic = 0, roughness = .72,
    print?: { width: number; height: number; transparent?: boolean; draw(context: CanvasRenderingContext2D): void }): PBRMaterial {
    const held = this.acquired.get(key);
    if (held) return held.material;
    let pool = materialPools.get(this.scene);
    if (!pool) { pool = new Map(); materialPools.set(this.scene, pool); }
    let entry = pool.get(key);
    if (!entry) {
      const material = new PBRMaterial(`cash-visual-${key}`, this.scene);
      material.albedoColor = Color3.FromHexString(color);
      material.metallic = metallic;
      material.roughness = roughness;
      let texture: DynamicTexture | null = null;
      if (print) {
        // NullEngine/Node can have no canvas implementation. The same physical geometry
        // remains available for headless layout and lifecycle tests without inventing text.
        try {
          const canvas = this.scene.getEngine().createCanvas(print.width, print.height);
          const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
          if (context) {
            print.draw(context);
            texture = new DynamicTexture(`cash-print-${key}`, canvas, this.scene, false);
            texture.hasAlpha = !!print.transparent;
            texture.anisotropicFilteringLevel = 4;
            texture.update();
            material.albedoTexture = texture;
            material.albedoColor = Color3.White();
            if (print.transparent) {
              material.useAlphaFromAlbedoTexture = true;
              material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
            }
          }
        } catch {
          texture?.dispose();
          texture = null;
        }
      }
      entry = { material, texture, references: 0 };
      pool.set(key, entry);
    }
    entry.references += 1;
    this.acquired.set(key, entry);
    return entry.material;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pool = materialPools.get(this.scene);
    for (const [key, entry] of this.acquired) {
      entry.references -= 1;
      if (entry.references !== 0) continue;
      if (pool?.get(key) === entry) pool.delete(key);
      entry.material.dispose(false, false);
      entry.texture?.dispose();
    }
    this.acquired.clear();
    if (pool?.size === 0) materialPools.delete(this.scene);
  }
}

function box(scene: Scene, parent: TransformNode, name: string, width: number, height: number,
  depth: number, position: Vector3, material: PBRMaterial): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene);
  mesh.parent = parent;
  mesh.position.copyFrom(position);
  mesh.material = material;
  mesh.receiveShadows = true;
  mesh.isPickable = false;
  return mesh;
}

function topPrint(scene: Scene, parent: TransformNode, name: string, width: number, depth: number,
  position: Vector3, material: PBRMaterial): Mesh {
  const mesh = MeshBuilder.CreateGround(name, { width, height: depth }, scene);
  mesh.parent = parent;
  // The drawer opens toward +z, where the cashier reads the denomination.
  mesh.rotation.y = Math.PI;
  mesh.position.copyFrom(position);
  mesh.material = material;
  mesh.receiveShadows = true;
  mesh.isPickable = false;
  return mesh;
}

function denominationLabel(denomination: CashDenominationPence): string {
  return denomination < 100 ? `${denomination}p` : `£${denomination / 100}`;
}

function compartmentLabel(materials: AssetMaterials, denomination: CashDenominationPence): PBRMaterial {
  return materials.get(`slot-label-${denomination}`, "#eee7d7", 0, .9, {
    width: 256, height: 96,
    draw(context) {
      context.fillStyle = "#eee7d7"; context.fillRect(0, 0, 256, 96);
      context.fillStyle = "#244a38"; context.font = "700 64px Arial, sans-serif";
      context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText(denominationLabel(denomination), 128, 51, 224);
    },
  });
}

/** Empty geometry only: compartments never populate themselves or alter cash inventory. */
export function createCashDrawerAsset(scene: Scene, parent: TransformNode | null, name = `cash-drawer-${++assetSequence}`): CashDrawerAsset {
  const root = new TransformNode(name, scene);
  root.parent = parent;
  root.metadata = { kind: "cash-drawer-asset", visualOnly: true };
  const materials = new AssetMaterials(scene, root);
  const dark = materials.get("housing", "#25312c", .22, .54);
  const edge = materials.get("housing-edge", "#435349", .18, .58);
  const inside = materials.get("drawer-interior", "#303a35", 0, .93);
  const felt = materials.get("drawer-felt", "#172e24", 0, .98);
  const handle = materials.get("drawer-handle", "#d9d1bb", .4, .43);
  const shell = new TransformNode(`${name}-shell`, scene);
  shell.parent = root;
  shell.metadata = { kind: "cash-drawer-shell", visualOnly: true };
  // The fixed housing supports the existing POS stand. No part grows above its top.
  box(scene, shell, `${name}-roof`, .52, .009, .40, new Vector3(0, .033, 0), dark);
  box(scene, shell, `${name}-underbody`, .52, .006, .40, new Vector3(0, -.0345, 0), dark);
  for (const side of [-1, 1]) box(scene, shell, `${name}-side-${side}`, .009, .060, .40,
    new Vector3(side * .2555, -.0015, 0), dark);
  box(scene, shell, `${name}-back`, .502, .060, .009, new Vector3(0, -.0015, -.1955), dark);

  const slidingDrawer = new TransformNode(`${name}-sliding`, scene);
  slidingDrawer.parent = root;
  slidingDrawer.metadata = { kind: "cash-drawer-tray", visualOnly: true, openRatio: 0 };
  box(scene, slidingDrawer, `${name}-base`, .496, .006, .372, new Vector3(0, -.025, 0), inside);
  box(scene, slidingDrawer, `${name}-front`, .502, .060, .012, new Vector3(0, -.0015, .186), edge);
  box(scene, slidingDrawer, `${name}-handle`, .176, .010, .008, new Vector3(0, .002, .196), handle);
  for (const side of [-1, 1]) box(scene, slidingDrawer, `${name}-tray-side-${side}`, .005, .030, .36,
    new Vector3(side * .2445, -.007, -.002), inside);
  box(scene, slidingDrawer, `${name}-tray-back`, .486, .030, .005, new Vector3(0, -.007, -.180), inside);

  const compartments = new Map<CashDenominationPence, CashCompartmentAsset>();
  const layout: Array<{ denomination: CashDenominationPence; x: number; z: number; width: number; depth: number }> = [
    { denomination: 500, x: -.121, z: -.050, width: .235, depth: .136 },
    { denomination: 1000, x: .121, z: -.050, width: .235, depth: .136 },
    ...CASH_DENOMINATIONS_PENCE.filter((denomination) => denomination < 500).map((denomination, index) => ({
      denomination, x: -.183 + (index % 4) * .122, z: index < 4 ? .060 : .140, width: .113, depth: .071,
    })),
  ];
  for (const slot of layout) {
    const compartment = new TransformNode(`${name}-compartment-${slot.denomination}`, scene);
    compartment.parent = slidingDrawer;
    compartment.position.set(slot.x, -.020, slot.z);
    compartment.metadata = { kind: "cash-compartment", denomination: slot.denomination, visualOnly: true };
    const floor = box(scene, compartment, `${name}-floor-${slot.denomination}`, slot.width, .002,
      slot.depth, new Vector3(0, -.001, 0), felt);
    floor.metadata = { kind: "cash-compartment-floor", denomination: slot.denomination, visualOnly: true };
    for (const side of [-1, 1]) box(scene, compartment, `${name}-divider-${slot.denomination}-${side}`, .003, .014,
      slot.depth, new Vector3(side * (slot.width + .003) / 2, .007, 0), inside);
    box(scene, compartment, `${name}-lip-${slot.denomination}`, slot.width, .012, .003,
      new Vector3(0, .006, slot.depth / 2), inside);
    const label = topPrint(scene, compartment, `${name}-label-${slot.denomination}`,
      slot.denomination >= 500 ? .059 : .044, .016, new Vector3(0, .0123, slot.depth / 2 - .009), compartmentLabel(materials, slot.denomination));
    label.metadata = { kind: "cash-compartment-label", denomination: slot.denomination, visualOnly: true };
    compartments.set(slot.denomination, { root: compartment, floor, denomination: slot.denomination, innerWidth: slot.width, innerDepth: slot.depth });
  }

  return {
    root, shell, slidingDrawer, compartmentsMap: compartments,
    setOpenRatio(ratio) {
      if (root.isDisposed()) return;
      const bounded = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
      slidingDrawer.position.z = bounded * CASH_DRAWER_DIMENSIONS.slideDistance;
      slidingDrawer.metadata.openRatio = bounded;
    },
    dispose() { if (!root.isDisposed()) root.dispose(false, false); },
  };
}

function coinPrint(materials: AssetMaterials, denomination: CashDenominationPence): PBRMaterial {
  return materials.get(`coin-face-${denomination}`, denomination <= 2 ? "#b7855f" : "#d5d6c9", .42, .48, {
    width: 256, height: 256, transparent: true,
    draw(context) {
      context.clearRect(0, 0, 256, 256);
      context.fillStyle = "#1b3026"; context.textAlign = "center"; context.textBaseline = "middle";
      context.font = `700 ${denominationLabel(denomination).length > 2 ? 91 : 110}px Arial, sans-serif`;
      context.fillText(denominationLabel(denomination), 128, 108, 230);
      context.font = "700 32px Arial, sans-serif";
      context.fillText("PLAY", 128, 191, 180);
    },
  });
}

function banknotePrint(materials: AssetMaterials, denomination: CashDenominationPence): PBRMaterial {
  return materials.get(`note-face-${denomination}`, "#e6dec8", 0, .9, {
    width: 768, height: 352,
    draw(context) {
      const five = denomination === 500;
      context.fillStyle = five ? "#d7e2c8" : "#ecdcbb"; context.fillRect(0, 0, 768, 352);
      context.fillStyle = five ? "#315b43" : "#6f522f"; context.fillRect(0, 0, 72, 352);
      context.strokeStyle = five ? "#74886a" : "#ad9165"; context.lineWidth = 5;
      context.strokeRect(93, 20, 651, 312);
      context.fillStyle = "#213b2d"; context.textAlign = "center"; context.textBaseline = "middle";
      context.font = "700 36px Arial, sans-serif"; context.fillText("PLAY MONEY", 415, 63, 588);
      context.font = "700 178px Georgia, serif"; context.fillText(denominationLabel(denomination), 416, 191, 580);
      context.font = "700 24px Arial, sans-serif"; context.fillText("CORNER SHOP · LEARNING NOTE", 415, 293, 580);
    },
  });
}

/** One bottom-anchored visual piece. Metadata describes appearance; it never grants money. */
export function createCashPieceAsset(scene: Scene, parent: TransformNode | null, denomination: CashDenominationPence,
  name = `cash-piece-${denomination}-${++assetSequence}`): TransformNode {
  if (!isCashDenomination(denomination)) throw new Error("Unsupported cash visual denomination.");
  const root = new TransformNode(name, scene);
  root.parent = parent;
  root.metadata = { kind: "cash-piece", denomination, playMoney: true, visualOnly: true };
  const materials = new AssetMaterials(scene, root);
  const dimensions = CASH_PIECE_DIMENSIONS[denomination];
  const meshes: Mesh[] = [];
  if (dimensions.kind === "note") {
    const paperHeight = dimensions.height - .00006;
    meshes.push(box(scene, root, `${name}-paper`, dimensions.width, paperHeight, dimensions.depth,
      new Vector3(0, paperHeight / 2, 0), materials.get("paper-edge", "#ece5d0", 0, .94)));
    const printed = banknotePrint(materials, denomination);
    meshes.push(topPrint(scene, root, `${name}-print`, dimensions.width * .995, dimensions.depth * .99,
      new Vector3(0, dimensions.height, 0), printed));
  } else {
    const bimetal = denomination === 100 || denomination === 200;
    const metal = materials.get(denomination <= 2 ? "copper" : bimetal ? "brass" : "silver",
      denomination <= 2 ? "#b6764c" : bimetal ? "#bda15c" : "#c1cbc5", .72, .36);
    const sides = denomination === 20 || denomination === 50 ? 7 : denomination === 100 ? 12 : 24;
    const bodyHeight = dimensions.height - .00024;
    const body = MeshBuilder.CreateCylinder(`${name}-coin`, { diameter: dimensions.width, height: bodyHeight, tessellation: sides }, scene);
    body.parent = root; body.position.y = bodyHeight / 2; body.material = metal;
    body.isPickable = false; body.receiveShadows = true; meshes.push(body);
    if (bimetal) {
      const centre = MeshBuilder.CreateCylinder(`${name}-centre`, { diameter: dimensions.width * .68, height: .00012, tessellation: 24 }, scene);
      centre.parent = root; centre.position.y = bodyHeight + .00006;
      centre.material = materials.get("silver", "#c1cbc5", .72, .36);
      centre.isPickable = false; meshes.push(centre);
    }
    meshes.push(topPrint(scene, root, `${name}-print`, dimensions.width * .76, dimensions.depth * .76,
      new Vector3(0, dimensions.height, 0), coinPrint(materials, denomination)));
  }
  for (const mesh of meshes) mesh.metadata = { kind: "cash-piece-surface", denomination, playMoney: true, visualOnly: true };
  return root;
}
