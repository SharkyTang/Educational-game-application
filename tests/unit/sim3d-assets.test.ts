import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicTexture, NullEngine, PBRMaterial, Scene, Vector3, VertexBuffer } from "@babylonjs/core";
import { createCrate, createPlayerHands, createProduct, createShop, setCheckoutDisplay, setShelfCapacity, setShopSignState } from "../../src/sim3d/assets";

/** Geometry/placement contracts only. Real WebGL appearance is checked in browser. */
describe("3D shop asset contracts", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const context = {
        fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), clearRect: vi.fn(),
        drawImage: vi.fn(), fillStyle: "", strokeStyle: "", lineWidth: 1,
        textAlign: "left", font: "12px Arial",
      };
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene?.dispose();
    engine?.dispose();
    vi.restoreAllMocks();
  });

  it("keeps milk and bread at recognisable, different real-world proportions", () => {
    const milk = createProduct(scene, "milk", "milk-test");
    const bread = createProduct(scene, "bread", "bread-test");
    milk.computeWorldMatrix(true);
    bread.computeWorldMatrix(true);
    const milkBounds = milk.getHierarchyBoundingVectors(true);
    const breadBounds = bread.getHierarchyBoundingVectors(true);
    const milkSize = milkBounds.max.subtract(milkBounds.min);
    const breadSize = breadBounds.max.subtract(breadBounds.min);
    expect(milkBounds.min.y).toBeCloseTo(0, 3);
    expect(milkSize.y).toBeGreaterThan(0.23);
    expect(milkSize.y).toBeLessThan(0.26);
    expect(milkSize.x).toBeGreaterThan(0.08);
    expect(milkSize.x).toBeLessThan(0.10);
    expect(breadSize.x).toBeGreaterThan(0.30);
    expect(breadSize.x).toBeLessThan(0.37);
    expect(breadSize.y).toBeGreaterThan(0.12);
    expect(breadSize.y).toBeLessThan(0.17);
    expect(breadSize.z).toBeGreaterThan(0.13);
    expect(breadSize.z).toBeLessThan(0.17);
    expect(milk.getChildMeshes().length).toBeLessThan(12);
    expect(bread.getChildMeshes().length).toBeLessThan(12);
  });

  it("gives the folded milk roof outward/upward normals instead of an invisible back face", () => {
    const milk = createProduct(scene, "milk", "milk-roof-test");
    let frontRoofVertices = 0;
    for (const mesh of milk.getChildMeshes()) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind) ?? [];
      const normals = mesh.getVerticesData(VertexBuffer.NormalKind) ?? [];
      for (let index = 0; index < positions.length; index += 3) {
        const y = positions[index + 1]!;
        const z = positions[index + 2]!;
        if (Math.abs(y - 0.182) < 0.0001 && z < -0.042 && normals[index + 1]! > 0.5 && normals[index + 2]! < -0.4) frontRoofVertices += 1;
      }
    }
    expect(frontRoofVertices).toBeGreaterThanOrEqual(2);
  });

  it("contains no non-finite vertices and preserves pickable constituent geometry", () => {
    const roots = [createProduct(scene, "milk", "finite-milk"), createProduct(scene, "bread", "finite-bread"), createCrate(scene, "milk", "finite-crate"), createPlayerHands(scene)];
    for (const root of roots) for (const mesh of root.getChildMeshes()) {
      expect(mesh.isPickable).toBe(true);
      expect(mesh.getTotalVertices()).toBeGreaterThan(0);
      for (const value of mesh.getVerticesData(VertexBuffer.PositionKind) ?? []) expect(Number.isFinite(value)).toBe(true);
      for (const value of mesh.getVerticesData(VertexBuffer.NormalKind) ?? []) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("returns usable interaction hierarchies, matching slot anchors and an accessible cashier side", () => {
    const shop = createShop(scene);
    expect(shop.targets.map((target) => target.id).sort()).toEqual(["bread-shelf", "counter", "drop-0", "drop-1", "drop-2", "drop-3", "milk-shelf", "open-sign"].sort());
    for (const id of ["bread-shelf", "milk-shelf", "counter"]) {
      const target = shop.targets.find((entry) => entry.id === id)!;
      expect(target.mesh.getChildMeshes().length).toBeGreaterThan(6);
      expect(target.mesh.isPickable).toBe(true);
    }
    const slots = shop.root.metadata.shelfSlots as Record<"milk" | "bread", Vector3[]>;
    expect(slots.milk).toHaveLength(8);
    expect(slots.bread).toHaveLength(8);
    expect(slots.milk[0]!.y).toBeCloseTo(0.94);
    expect(slots.bread[0]!.y).toBeCloseTo(0.82);
    expect(shop.root.metadata.counterTop).toBe(1);
    // This point can be reached from the main aisle; it is behind, not inside, the counter.
    const cashier = { x: -2.2, z: -1.0 };
    const radius = 0.24;
    const collides = shop.colliders.some((box) => cashier.x > box.minX - radius && cashier.x < box.maxX + radius && cashier.z > box.minZ - radius && cashier.z < box.maxZ + radius);
    expect(collides).toBe(false);
    const milk = createCrate(scene, "milk", "dimensions-milk-crate");
    const bread = createCrate(scene, "bread", "dimensions-bread-crate");
    expect(milk.metadata.width).toBe(0.46);
    expect(bread.metadata.width).toBe(0.70);
  });

  it("updates physical signs/screens only when their displayed state changes", () => {
    createShop(scene);
    const openSign = scene.getMeshByName("open-sign")!;
    const texture = (openSign.material as PBRMaterial).albedoTexture as DynamicTexture;
    const signUpdate = vi.spyOn(texture, "update");
    setShopSignState(scene, false);
    setShopSignState(scene, false);
    expect(signUpdate).toHaveBeenCalledTimes(1);
    expect(openSign.metadata.displayState).toBe("closed");
    setShopSignState(scene, true);
    expect(signUpdate).toHaveBeenCalledTimes(2);
    expect(openSign.metadata.displayState).toBe("open");

    const screen = scene.getMeshByName("pos-screen")!;
    const posTexture = (screen.material as PBRMaterial).albedoTexture as DynamicTexture;
    const tillUpdate = vi.spyOn(posTexture, "update");
    setCheckoutDisplay(scene, { scanned: 1, totalPence: 160, paid: false });
    setCheckoutDisplay(scene, { scanned: 1, totalPence: 160, paid: false });
    expect(tillUpdate).toHaveBeenCalledTimes(1);
    setCheckoutDisplay(scene, { scanned: 2, totalPence: 400, paid: true });
    expect(tillUpdate).toHaveBeenCalledTimes(2);
    expect(screen.metadata.displayState).toBe("2:400:true");
    expect(scene.getMeshByName("reader-screen")!.metadata.displayState).toBe("2:400:true");
  });

  it("removes the physical reserved-shelf cards after a capacity upgrade", () => {
    createShop(scene);
    setShelfCapacity(scene, false);
    expect(scene.getMeshByName("milk-capacity-note")!.isEnabled()).toBe(true);
    expect(scene.getMeshByName("bread-capacity-note")!.isEnabled()).toBe(true);
    setShelfCapacity(scene, true);
    expect(scene.getMeshByName("milk-capacity-note")!.isEnabled()).toBe(false);
    expect(scene.getMeshByName("bread-capacity-note")!.isEnabled()).toBe(false);
  });

  it("prints the same opening state on both readable faces of the street entrance sign", () => {
    createShop(scene);
    const inward = scene.getMeshByName("open-sign")!;
    const outward = scene.getMeshByName("open-sign-exterior")!;
    const inwardNormal = Vector3.TransformNormal(new Vector3(0, 0, -1), inward.computeWorldMatrix(true)).normalize();
    const outwardNormal = Vector3.TransformNormal(new Vector3(0, 0, -1), outward.computeWorldMatrix(true)).normalize();
    expect(inwardNormal.z).toBeCloseTo(1);
    expect(outwardNormal.z).toBeCloseTo(-1);
    expect(outward.isDescendantOf(inward)).toBe(true);
    expect(outward.material).toBe(inward.material);
    expect(inward.material!.backFaceCulling).toBe(true);
    setShopSignState(scene, true);
    expect(inward.metadata.displayState).toBe("open");
  });
});
