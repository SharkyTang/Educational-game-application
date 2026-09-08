import {
  AbstractMesh, Color3, DynamicTexture, Mesh, MeshBuilder, PBRMaterial,
  Scene, StandardMaterial, TransformNode,
} from "@babylonjs/core";
import type { CashDenominationPence } from "./cashPayment";
import {
  CASH_PIECE_DIMENSIONS, createCashDrawerAsset, createCashPieceAsset,
} from "./cashVisualAssets";
import {
  cashVisualPickCommand, MAX_VISIBLE_CASH_STACK_PIECES,
  type CashVisualCommand, type CashVisualPick, type CashVisualSnapshot, type CashVisualStack,
} from "./cashVisualState";

type Position = { x: number; y: number; z: number };
export interface CashDrawerVisualOptions {
  name?: string;
  reducedMotion?: boolean;
  tenderPosition?: Position;
  changePosition?: Position;
  /** Commands still pass through the host's existing live cashier guards. */
  onAction?: (command: CashVisualCommand) => boolean;
}

interface Label {
  mesh: Mesh;
  texture: DynamicTexture;
  text: string;
}

interface PieceGroup {
  root: TransformNode;
  pieces: TransformNode[];
  label: Label;
}

interface Tray {
  root: TransformNode;
  floor: Mesh;
  label: Label;
  groups: Map<CashDenominationPence, PieceGroup>;
}

const ANIMATION_MS = 240;
const TRAY_WIDTH = .32;
const TRAY_DEPTH = .24;
const denominationLabel = (denomination: number): string => denomination < 100 ? `${denomination}p` : `£${denomination / 100}`;

/**
 * Two hosts may render the same projection: a counter object and an enlarged dialog.
 * This class owns geometry only. No payment state or balance is changed by rendering.
 */
export class CashDrawerVisual {
  readonly root: TransformNode;
  readonly slidingDrawer: TransformNode;
  readonly tenderAnchor: TransformNode;
  readonly changeAnchor: TransformNode;
  private readonly drawerAsset: ReturnType<typeof createCashDrawerAsset>;
  private readonly drawerGroups = new Map<CashDenominationPence, PieceGroup>();
  private readonly tenderTray: Tray;
  private readonly changeTray: Tray;
  private readonly ownedMaterials = new Set<PBRMaterial | StandardMaterial>();
  private picks = new WeakMap<AbstractMesh, CashVisualPick>();
  private snapshot: CashVisualSnapshot | null = null;
  private signature = "";
  private disposed = false;
  private reducedMotion: boolean;
  private ratio = 0;
  private targetRatio = 0;

  constructor(
    private readonly scene: Scene,
    parent: TransformNode | null,
    private readonly options: CashDrawerVisualOptions = {},
  ) {
    if (parent && parent.getScene() !== scene) throw new Error("钱箱与父节点必须属于同一场景。");
    this.reducedMotion = options.reducedMotion ?? true;
    this.root = new TransformNode(options.name ?? "cash-drawer-visual", scene);
    this.root.parent = parent;
    this.root.metadata = { kind: "cash-drawer-visual", playMoney: true };
    this.drawerAsset = createCashDrawerAsset(scene, this.root, `${this.root.name}-asset`);
    // A close-up ray must stop at the solid housing, not reach money behind it.
    // These meshes intentionally have no action mapping; world hosts can opt out
    // by marking their entire visual hierarchy non-pickable.
    for (const mesh of this.drawerAsset.shell.getChildMeshes()) mesh.isPickable = true;
    this.slidingDrawer = this.drawerAsset.slidingDrawer;
    this.tenderTray = this.createTray("tender", options.tenderPosition ?? { x: .46, y: -.02, z: .03 });
    this.changeTray = this.createTray("change", options.changePosition ?? { x: 0, y: -.02, z: .63 });
    this.tenderAnchor = this.tenderTray.root;
    this.changeAnchor = this.changeTray.root;
    for (const [denomination, compartment] of this.drawerAsset.compartmentsMap) {
      const group = this.createGroup(compartment.root, `drawer-${denomination}`, Math.min(compartment.innerWidth, .14), .032);
      group.label.mesh.position.z = compartment.innerDepth / 2 + (compartment.root.position.z > .1 ? .015 : -.012);
      // Front-row labels sit above the high front lip rather than behind it.
      group.label.mesh.position.y = compartment.root.position.z > .1 ? .05 : .025;
      this.drawerGroups.set(denomination, group);
    }
    this.writeLabel(this.tenderTray.label, ["顾客交款", "确认收款前不会入钱箱"]);
    this.writeLabel(this.changeTray.label, ["找零托盘", "选择钱币后在这里核对"]);
    this.applyRatio(0);
  }

  get openRatio(): number { return this.ratio }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    if (value && !this.disposed) this.applyRatio(this.targetRatio);
  }

  update(snapshot: CashVisualSnapshot): void {
    if (this.disposed) return;
    const signature = JSON.stringify(snapshot);
    if (signature === this.signature) return;
    this.signature = signature;
    // Store our own projection so a caller reusing mutable arrays cannot redirect a pick.
    this.snapshot = structuredClone(snapshot);
    this.picks = new WeakMap();
    this.targetRatio = snapshot.open ? 1 : 0;
    if (this.reducedMotion) this.applyRatio(this.targetRatio);
    this.root.metadata = { kind: "cash-drawer-visual", playMoney: true, stage: snapshot.stage,
      drawerOpen: snapshot.open, tenderSource: snapshot.tenderSource };

    for (const slot of snapshot.drawer) {
      const compartment = this.drawerAsset.compartmentsMap.get(slot.denominationPence);
      const group = this.drawerGroups.get(slot.denominationPence);
      if (!compartment || !group) continue;
      this.renderPieces(group, slot.denominationPence, slot.stackCount, 1);
      group.root.metadata = { kind: "cash-drawer-stock", denominationPence: slot.denominationPence,
        actualCount: slot.actualCount, drawerCount: slot.drawerCount, reservedCount: slot.reservedCount,
        displayedCount: Math.min(slot.stackCount, MAX_VISIBLE_CASH_STACK_PIECES) };
      this.writeLabel(group.label, [`${denominationLabel(slot.denominationPence)} × ${slot.actualCount}`,
        slot.actualCount > MAX_VISIBLE_CASH_STACK_PIECES ? `堆叠示意 ${MAX_VISIBLE_CASH_STACK_PIECES} 件` : slot.actualCount === 0 ? "已用完" : `预留 ${slot.reservedCount} 件`]);
      const pick: CashVisualPick = { kind: "add", denominationPence: slot.denominationPence };
      this.bind(compartment.floor, pick);
      this.bind(group.label.mesh, pick);
      for (const piece of group.pieces) this.bindHierarchy(piece, pick);
    }
    this.writeLabel(this.tenderTray.label, [snapshot.stage === "received" ? "暂收区 · 尚未入账" : "顾客交款",
      snapshot.tenderSourceLabel || "确认收款前不会入钱箱"]);
    this.writeLabel(this.changeTray.label, ["找零托盘", snapshot.change.length
      ? `实际 ${snapshot.change.length} 件 · 更多请用辅助列表` : "选择钱币后在这里核对"]);
    this.renderTray(this.tenderTray, snapshot.tenderStacks, "tender");
    this.renderTray(this.changeTray, snapshot.changeStacks, "change");
    this.bind(this.tenderTray.floor, { kind: "receive" });
    this.bind(this.tenderTray.label.mesh, { kind: "receive" });
  }

  tick(deltaMs: number): void {
    if (this.disposed || !Number.isFinite(deltaMs) || deltaMs <= 0 || this.ratio === this.targetRatio) return;
    if (this.reducedMotion) { this.applyRatio(this.targetRatio); return; }
    const distance = Math.min(Math.abs(this.targetRatio - this.ratio), deltaMs / ANIMATION_MS);
    this.applyRatio(this.ratio + Math.sign(this.targetRatio - this.ratio) * distance);
  }

  /** Resolve only meshes owned by this instance, using its current interaction projection. */
  pick(mesh: AbstractMesh | null | undefined): CashVisualPick | false {
    if (this.disposed || !mesh || mesh.isDisposed() || !mesh.isEnabled() || !mesh.isPickable
      || !mesh.isDescendantOf(this.root) || !this.snapshot) return false;
    const pick = this.picks.get(mesh);
    if (pick?.kind === "add" && this.ratio < .98) return false;
    return pick && cashVisualPickCommand(this.snapshot, pick) !== null ? { ...pick } : false;
  }

  /** Optional convenience for hosts that dispatch directly through CashRegisterController. */
  activate(mesh: AbstractMesh | null | undefined): boolean {
    const pick = this.pick(mesh);
    if (!pick || !this.snapshot || !this.options.onAction) return false;
    const command = cashVisualPickCommand(this.snapshot, pick);
    return command !== null && this.options.onAction(command) === true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.snapshot = null;
    this.picks = new WeakMap();
    this.drawerAsset.dispose();
    this.root.dispose();
    for (const material of this.ownedMaterials) material.dispose(false, true);
    this.ownedMaterials.clear();
    this.drawerGroups.clear();
    this.tenderTray.groups.clear();
    this.changeTray.groups.clear();
  }

  private applyRatio(ratio: number): void {
    this.ratio = Math.max(0, Math.min(1, ratio));
    this.drawerAsset.setOpenRatio(this.ratio);
    // The opaque closed housing already hides these pieces. Skip their draw calls
    // while retaining the inventory projection and all reusable geometry.
    for (const compartment of this.drawerAsset.compartmentsMap.values()) compartment.root.setEnabled(this.ratio > 0);
  }

  private bind(mesh: AbstractMesh, pick: CashVisualPick): void {
    const allowed = this.snapshot !== null && cashVisualPickCommand(this.snapshot, pick) !== null;
    mesh.isPickable = allowed;
    if (allowed) this.picks.set(mesh, { ...pick });
  }

  private bindHierarchy(node: TransformNode, pick: CashVisualPick): void {
    for (const mesh of node.getChildMeshes()) this.bind(mesh, pick);
  }

  private createTray(name: string, position: Position): Tray {
    const root = new TransformNode(`${this.root.name}-${name}`, this.scene);
    root.parent = this.root;
    root.position.set(position.x, position.y, position.z);
    root.metadata = { kind: `cash-${name}-tray`, width: TRAY_WIDTH, depth: TRAY_DEPTH };
    const material = new PBRMaterial(`${root.name}-material`, this.scene);
    material.albedoColor = Color3.FromHexString(name === "tender" ? "#d8ccab" : "#9fbda5");
    material.roughness = .88;
    this.ownedMaterials.add(material);
    const floor = this.box(`${root.name}-floor`, root, TRAY_WIDTH, .008, TRAY_DEPTH, 0, 0, 0, material);
    for (const direction of [-1, 1]) {
      this.box(`${root.name}-rim-x-${direction}`, root, .007, .016, TRAY_DEPTH,
        direction * (TRAY_WIDTH - .007) / 2, .004, 0, material);
      this.box(`${root.name}-rim-z-${direction}`, root, TRAY_WIDTH, .016, .007,
        0, .004, direction * (TRAY_DEPTH - .007) / 2, material);
    }
    const label = this.createLabel(root, `${name}-heading`, TRAY_WIDTH - .02, .037);
    label.mesh.position.set(0, .013, -TRAY_DEPTH / 2 + .025);
    return { root, floor, label, groups: new Map() };
  }

  private createGroup(parent: TransformNode, name: string, labelWidth: number, labelDepth: number): PieceGroup {
    const root = new TransformNode(`${this.root.name}-${name}-stack`, this.scene);
    root.parent = parent;
    const label = this.createLabel(root, `${name}-count`, labelWidth, labelDepth);
    return { root, pieces: [], label };
  }

  private renderPieces(group: PieceGroup, denomination: CashDenominationPence, requestedCount: number, scale: number): void {
    const count = Number.isSafeInteger(requestedCount) ? Math.max(0, Math.min(MAX_VISIBLE_CASH_STACK_PIECES, requestedCount)) : 0;
    while (group.pieces.length < count) {
      group.pieces.push(createCashPieceAsset(this.scene, group.root, denomination, `${group.root.name}-piece-${group.pieces.length}`));
    }
    const dimensions = CASH_PIECE_DIMENSIONS[denomination];
    for (const [index, piece] of group.pieces.entries()) {
      piece.setEnabled(index < count);
      piece.scaling.setAll(scale);
      piece.position.set(index * .0006 * scale, index * (dimensions.height + .0003) * scale + .005, 0);
    }
  }

  private renderTray(tray: Tray, stacks: readonly CashVisualStack[], kind: "tender" | "change"): void {
    const active = new Set(stacks.map((stack) => stack.denominationPence));
    for (const [denomination, group] of tray.groups) group.root.setEnabled(active.has(denomination));
    const columns = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(stacks.length * TRAY_WIDTH / TRAY_DEPTH))));
    const rows = Math.max(1, Math.ceil(stacks.length / columns));
    const cellWidth = (TRAY_WIDTH - .02) / columns;
    const cellDepth = (TRAY_DEPTH - .06) / rows;
    for (const [stackIndex, stack] of stacks.entries()) {
      let group = tray.groups.get(stack.denominationPence);
      if (!group) {
        group = this.createGroup(tray.root, `${kind}-${stack.denominationPence}`, .14, .026);
        tray.groups.set(stack.denominationPence, group);
      }
      group.root.setEnabled(true);
      group.root.position.set(-TRAY_WIDTH / 2 + .01 + (stackIndex % columns + .5) * cellWidth,
        0, -TRAY_DEPTH / 2 + .06 + (Math.floor(stackIndex / columns) + .5) * cellDepth);
      const dimensions = CASH_PIECE_DIMENSIONS[stack.denominationPence];
      const scale = Math.min(1, (cellWidth - .009) / (dimensions.width + .004), (cellDepth - .032) / dimensions.depth);
      this.renderPieces(group, stack.denominationPence, stack.stackCount, Math.max(.1, scale));
      group.label.mesh.scaling.x = Math.min(1, (cellWidth - .004) / .14);
      group.label.mesh.position.set(0, .010, cellDepth / 2 - .016);
      group.root.metadata = { kind: `cash-${kind}-stack`, denominationPence: stack.denominationPence,
        actualCount: stack.actualCount, displayedCount: stack.stackCount,
        indices: [...stack.indices], visibleIndices: [...stack.visibleIndices],
        hiddenCount: stack.actualCount - stack.stackCount };
      this.writeLabel(group.label, [`${denominationLabel(stack.denominationPence)} × ${stack.actualCount}`,
        stack.actualCount > stack.stackCount ? `示意 ${stack.stackCount} 件 · 辅助列表可逐件操作` : kind === "change" ? "点按可撤回" : "教学钱币"]);
      for (const [pieceIndex, piece] of group.pieces.entries()) {
        const pick: CashVisualPick = kind === "tender" ? { kind: "receive" }
          : { kind: "remove", index: stack.visibleIndices[pieceIndex] ?? -1 };
        this.bindHierarchy(piece, pick);
      }
      if (kind === "tender") this.bind(group.label.mesh, { kind: "receive" });
      else this.bind(group.label.mesh, { kind: "remove", index: stack.visibleIndices.at(-1) ?? -1 });
    }
  }

  private box(name: string, parent: TransformNode, width: number, height: number, depth: number,
    x: number, y: number, z: number, material: PBRMaterial): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, this.scene);
    mesh.parent = parent;
    mesh.position.set(x, y, z);
    mesh.material = material;
    mesh.isPickable = false;
    return mesh;
  }

  private createLabel(parent: TransformNode, name: string, width: number, depth: number): Label {
    const texture = new DynamicTexture(`${this.root.name}-${name}-texture`, { width: 768, height: 192 }, this.scene, false);
    const material = new StandardMaterial(`${this.root.name}-${name}-material`, this.scene);
    material.diffuseTexture = texture;
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    this.ownedMaterials.add(material);
    const mesh = MeshBuilder.CreatePlane(`${this.root.name}-${name}`, { width, height: depth }, this.scene);
    mesh.parent = parent;
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.y = Math.PI;
    mesh.material = material;
    mesh.isPickable = false;
    return { mesh, texture, text: "" };
  }

  private writeLabel(label: Label, lines: readonly string[]): void {
    const text = lines.join("\n");
    if (label.text === text) return;
    label.text = text;
    label.mesh.metadata = { kind: "cash-visual-label", text };
    const context = label.texture.getContext() as CanvasRenderingContext2D;
    context.fillStyle = "#f5f1df";
    context.fillRect(0, 0, 768, 192);
    context.fillStyle = "#223e31";
    context.textAlign = "center";
    // One large line stays legible at actual game scale. Secondary explanations
    // remain in the accessible close-up caption and complete mesh metadata.
    context.textBaseline = "middle";
    context.font = "bold 134px Arial, sans-serif";
    context.fillText(lines[0] ?? "", 384, 102, 744);
    label.texture.update();
  }
}
