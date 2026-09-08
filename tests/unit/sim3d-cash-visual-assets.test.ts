import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicTexture, NullEngine, PBRMaterial, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import {
  CASH_DRAWER_DIMENSIONS, CASH_PIECE_DIMENSIONS, createCashDrawerAsset, createCashPieceAsset,
} from "../../src/sim3d/cashVisualAssets";
import { CASH_DENOMINATIONS_PENCE, type CashDenominationPence } from "../../src/sim3d/cashPayment";

describe("cash visual assets", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    scene = new Scene(engine);
  });
  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); });

  // Babylon lazily creates its own default material and shared BRDF lookup. Count
  // the cash assets' owned resources separately from those Scene-wide internals.
  function resources(): number[] { return [scene.meshes.length, scene.transformNodes.length,
    scene.materials.filter((material) => material.name.startsWith("cash-visual-")).length,
    scene.textures.filter((texture) => texture.name.startsWith("cash-print-")).length]; }
  function bounds(node: TransformNode): { min: Vector3; max: Vector3 } {
    for (const mesh of node.getChildMeshes()) mesh.computeWorldMatrix(true);
    return node.getHierarchyBoundingVectors(true);
  }
  function canvasContext() {
    const context = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), clearRect: vi.fn(),
      fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "left", textBaseline: "alphabetic" };
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => ({ width, height, getContext: () => context, remove: vi.fn() }) as unknown as ReturnType<NullEngine["createCanvas"]>);
    return context;
  }

  it("creates ten empty, labelled compartments and no unearned currency geometry", () => {
    const parent = new TransformNode("counter", scene);
    const drawer = createCashDrawerAsset(scene, parent, "till");
    expect(drawer.root.parent).toBe(parent);
    expect(drawer.shell.parent).toBe(drawer.root);
    expect(drawer.slidingDrawer.parent).toBe(drawer.root);
    expect([...drawer.compartmentsMap.keys()].sort((a, b) => a - b)).toEqual(CASH_DENOMINATIONS_PENCE);
    for (const denomination of CASH_DENOMINATIONS_PENCE) {
      const compartment = drawer.compartmentsMap.get(denomination)!;
      expect(compartment.root.parent).toBe(drawer.slidingDrawer);
      expect(compartment.root.metadata).toMatchObject({ denomination, visualOnly: true });
      expect(compartment.floor.parent).toBe(compartment.root);
      expect(compartment.floor.position.y).toBe(-.001);
      expect(compartment.floor.getBoundingInfo().boundingBox.maximum.y + compartment.floor.position.y).toBeCloseTo(0);
      const dimensions = CASH_PIECE_DIMENSIONS[denomination];
      expect(compartment.innerWidth).toBeGreaterThan(dimensions.width);
      expect(compartment.innerDepth).toBeGreaterThan(dimensions.depth);
    }
    expect(drawer.compartmentsMap.get(500)!.root.position.z).toBeLessThan(drawer.compartmentsMap.get(1)!.root.position.z);
    expect(drawer.compartmentsMap.get(1000)!.root.position.z).toBeLessThan(drawer.compartmentsMap.get(200)!.root.position.z);
    expect(scene.transformNodes.some((node) => node.metadata?.kind === "cash-piece")).toBe(false);
    expect(drawer.root.getChildMeshes().every((mesh) => !mesh.isPickable)).toBe(true);
  });

  it("fits the original POS base height and slides only the drawer towards the shopkeeper", () => {
    const drawer = createCashDrawerAsset(scene, null, "sliding-till");
    const closed = bounds(drawer.root);
    expect(closed.max.x - closed.min.x).toBeCloseTo(.52, 5);
    expect(closed.max.y - closed.min.y).toBeCloseTo(.075, 5);
    expect(closed.max.z - closed.min.z).toBeCloseTo(.40, 5);
    expect(closed.min.y).toBeCloseTo(-.0375, 5);
    const shellBounds = bounds(drawer.shell);
    const anchor = drawer.compartmentsMap.get(50)!.root;
    const before = anchor.getAbsolutePosition().clone();
    drawer.setOpenRatio(.5);
    anchor.computeWorldMatrix(true);
    expect(drawer.slidingDrawer.position.z).toBeCloseTo(.135);
    expect(anchor.getAbsolutePosition().z - before.z).toBeCloseTo(.135);
    drawer.setOpenRatio(1);
    const open = bounds(drawer.root);
    expect(open.max.z).toBeCloseTo(.47, 5);
    expect(bounds(drawer.shell)).toEqual(shellBounds);
    expect(drawer.slidingDrawer.position.x).toBe(0);
    expect(drawer.slidingDrawer.position.y).toBe(0);
    expect(CASH_DRAWER_DIMENSIONS.slideDistance).toBe(.27);
  });

  it("bounds open ratios and does not allocate meshes or resources while opening", () => {
    const drawer = createCashDrawerAsset(scene, null);
    const allocated = resources();
    drawer.setOpenRatio(9);
    expect(drawer.slidingDrawer.position.z).toBe(.27);
    drawer.setOpenRatio(-3);
    expect(drawer.slidingDrawer.position.z).toBe(0);
    drawer.setOpenRatio(Number.NaN);
    expect(drawer.slidingDrawer.position.z).toBe(0);
    for (let step = 0; step <= 100; step += 1) drawer.setOpenRatio(step / 100);
    expect(resources()).toEqual(allocated);
    drawer.dispose();
    expect(() => drawer.setOpenRatio(1)).not.toThrow();
  });

  it.each(CASH_DENOMINATIONS_PENCE)("makes a lightweight bottom-anchored %ip piece with appearance-only metadata", (denomination) => {
    const parent = new TransformNode("display-stack", scene);
    const piece = createCashPieceAsset(scene, parent, denomination);
    const dimensions = CASH_PIECE_DIMENSIONS[denomination];
    expect(piece.parent).toBe(parent);
    expect(piece.metadata).toEqual({ kind: "cash-piece", denomination, playMoney: true, visualOnly: true });
    const measured = bounds(piece);
    expect(measured.min.y).toBeCloseTo(0, 5);
    expect(measured.max.y).toBeCloseTo(dimensions.height, 5);
    expect(measured.max.x - measured.min.x).toBeLessThanOrEqual(dimensions.width + .000001);
    expect(measured.max.z - measured.min.z).toBeLessThanOrEqual(dimensions.depth + .000001);
    expect(piece.getChildMeshes().length).toBeLessThanOrEqual(3);
    expect(piece.getChildMeshes().every((mesh) => mesh.metadata.denomination === denomination && mesh.metadata.visualOnly)).toBe(true);
    expect(piece.getChildMeshes().reduce((count, mesh) => count + mesh.getTotalVertices(), 0)).toBeLessThan(400);
  });

  it("keeps copper, silver and bi-metal denominations visually distinct", () => {
    const copper = createCashPieceAsset(scene, null, 1, "copper");
    const silver = createCashPieceAsset(scene, null, 5, "silver");
    const pounds = createCashPieceAsset(scene, null, 200, "pounds");
    const material = (name: string) => scene.getMeshByName(name)!.material as PBRMaterial;
    expect(material("copper-coin").albedoColor.equals(material("silver-coin").albedoColor)).toBe(false);
    expect(material("pounds-coin").albedoColor.equals(material("pounds-centre").albedoColor)).toBe(false);
    copper.dispose(); silver.dispose(); pounds.dispose();
  });

  it("prints prominent teaching labels from canvas and never loads banknote image files", () => {
    const context = canvasContext();
    createCashDrawerAsset(scene, null);
    createCashPieceAsset(scene, null, 500);
    createCashPieceAsset(scene, null, 1000);
    createCashPieceAsset(scene, null, 20);
    const text = context.fillText.mock.calls.map((call) => call[0]);
    expect(text.filter((value) => value === "PLAY MONEY")).toHaveLength(2);
    expect(text).toContain("£5");
    expect(text).toContain("£10");
    expect(text).toContain("20p");
    expect(text).toContain("CORNER SHOP · LEARNING NOTE");
    expect(scene.textures.length).toBeGreaterThan(0);
    expect(scene.materials.filter((material) => material.name.startsWith("cash-visual-")).every((material) =>
      !(material as PBRMaterial).albedoTexture || (material as PBRMaterial).albedoTexture instanceof DynamicTexture)).toBe(true);
  });

  it("disposes one copy without invalidating another copy's shared materials or labels", () => {
    canvasContext();
    const before = resources();
    const first = createCashDrawerAsset(scene, null, "first-till");
    const firstCoin = createCashPieceAsset(scene, first.compartmentsMap.get(200)!.root, 200);
    const second = createCashDrawerAsset(scene, null, "second-till");
    const secondCoin = createCashPieceAsset(scene, second.compartmentsMap.get(200)!.root, 200);
    const firstMaterial = firstCoin.getChildMeshes()[0]!.material;
    const secondMaterial = secondCoin.getChildMeshes()[0]!.material;
    expect(firstMaterial).toBe(secondMaterial);
    const survivors = second.root.getChildMeshes().map((mesh) => ({ mesh, material: mesh.material }));
    const liveTextureCount = scene.textures.length;
    first.dispose();
    expect(firstCoin.isDisposed()).toBe(true);
    expect(secondCoin.isDisposed()).toBe(false);
    for (const { mesh, material } of survivors) {
      expect(mesh.isDisposed()).toBe(false);
      expect(mesh.material).toBe(material);
      expect(scene.materials).toContain(material);
    }
    expect(scene.textures.length).toBe(liveTextureCount);
    second.dispose();
    first.dispose(); second.dispose();
    expect(resources()).toEqual(before);
  });

  it("releases all piece resources with normal parent disposal and can recreate cleanly", () => {
    canvasContext();
    const before = resources();
    const parent = new TransformNode("cash-group", scene);
    for (let piece = 0; piece < 12; piece += 1) createCashPieceAsset(scene, parent, 500);
    expect(scene.textures.filter((texture) => texture.name.startsWith("cash-print-"))).toHaveLength(1);
    expect(scene.materials.filter((material) => material.name.startsWith("cash-visual-"))).toHaveLength(2);
    parent.dispose();
    expect(resources()).toEqual(before);
    const recreated = createCashPieceAsset(scene, null, 500);
    expect(recreated.getChildMeshes().every((mesh) => scene.materials.includes(mesh.material!))).toBe(true);
    recreated.dispose();
    expect(resources()).toEqual(before);
  });

  it("rejects an unsupported denomination before allocating scene objects", () => {
    const before = resources();
    expect(() => createCashPieceAsset(scene, null, 300 as CashDenominationPence)).toThrow("Unsupported");
    expect(resources()).toEqual(before);
  });
});
