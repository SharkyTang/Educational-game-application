import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicTexture, NullEngine, PBRMaterial, Ray, Scene, Vector3, VertexBuffer } from "@babylonjs/core";
import { createStreet, setDeliveryTruckStatus, setStreetVenueStatus, type StreetEnvironment } from "../../src/sim3d/street";

/** Spatial, interaction and allocation contracts; appearance still needs WebGL QA. */
describe("high-street assets", () => {
  let engine: NullEngine;
  let scene: Scene;
  let street: StreetEnvironment;

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
    street = createStreet(scene);
    for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  });

  afterEach(() => {
    scene?.dispose();
    engine?.dispose();
    vi.restoreAllMocks();
  });

  function obstructed(x: number, z: number, radius = 0.24): boolean {
    return street.colliders.some((collider) => x > collider.minX - radius && x < collider.maxX + radius && z > collider.minZ - radius && z < collider.maxZ + radius);
  }

  it("leaves the shop entrance, crossing and each venue's inspection point accessible", () => {
    for (const z of [-4.85, -5.4, -6.4, -7.55]) expect(obstructed(0, z), `shop exit at ${z}`).toBe(false);
    for (const z of [-8.6, -9.9, -11, -12.6, -14.25]) expect(obstructed(-1.2, z), `crossing at ${z}`).toBe(false);
    const venues = street.targets.filter((target) => target.kind === "venue");
    expect(new Set(venues.map((target) => target.venueId))).toEqual(new Set(["cafe", "restaurant", "supermarket"]));
    for (const target of venues) {
      expect(obstructed(target.position.x, -15.8), `${target.venueId} inspection point`).toBe(false);
      expect(obstructed(target.position.x, target.position.z - 0.3), `${target.venueId} closed entrance`).toBe(true);
    }
    const pads = street.targets.filter((target) => target.kind === "drop-zone");
    expect(pads).toHaveLength(2);
    for (const pad of pads) {
      expect(pad.position.x).toBeGreaterThan(1);
      expect(pad.position.z).toBeLessThan(-4.7);
      expect(obstructed(pad.position.x, pad.position.z)).toBe(false);
    }
  });

  it("presents outward-facing, physically pickable plaques at eye level", () => {
    for (const target of street.targets.filter((entry) => entry.kind === "venue")) {
      const plaque = scene.getMeshByName(`street-${target.venueId}-status`)!;
      expect(plaque.isDescendantOf(target.mesh)).toBe(true);
      const normal = Vector3.TransformNormal(new Vector3(0, 0, -1), plaque.computeWorldMatrix(true)).normalize();
      expect(normal.z).toBeGreaterThan(0.99);
      const ray = new Ray(new Vector3(target.position.x, plaque.getAbsolutePosition().y, -15.8), new Vector3(0, 0, -1), 2.6);
      const pick = scene.pickWithRay(ray, (mesh) => mesh.isPickable && mesh.isEnabled());
      expect(pick?.hit, `${target.venueId} plaque ray`).toBe(true);
      expect(pick?.pickedMesh).toBe(plaque);
    }
  });

  it("updates each plaque independently without reallocating textures on repeated sync", () => {
    const cafe = scene.getMeshByName("street-cafe-status")!;
    const restaurant = scene.getMeshByName("street-restaurant-status")!;
    const cafeTexture = (cafe.material as PBRMaterial).albedoTexture as DynamicTexture;
    const restaurantTexture = (restaurant.material as PBRMaterial).albedoTexture as DynamicTexture;
    expect(cafeTexture).not.toBe(restaurantTexture);
    const cafeUpdate = vi.spyOn(cafeTexture, "update");
    const restaurantUpdate = vi.spyOn(restaurantTexture, "update");
    const textureCount = scene.textures.length;
    const materialCount = scene.materials.length;
    setStreetVenueStatus(scene, "cafe", "目标已达成", "Lv.3 · 初次营业", true);
    setStreetVenueStatus(scene, "cafe", "目标已达成", "Lv.3 · 初次营业", true);
    expect(cafeUpdate).toHaveBeenCalledTimes(1);
    expect(restaurantUpdate).not.toHaveBeenCalled();
    expect(cafeTexture.getContext().fillText).toHaveBeenCalledWith("目标已达成", expect.any(Number), expect.any(Number), expect.any(Number));
    setStreetVenueStatus(scene, "cafe", "目标已达成", "Lv.3 · 下一段练习", true);
    expect(cafeUpdate).toHaveBeenCalledTimes(2);
    setStreetVenueStatus(scene, "restaurant", "暂未开放", "Lv.5 · 稳定经营", false);
    expect(restaurantUpdate).toHaveBeenCalledTimes(1);
    expect(scene.textures).toHaveLength(textureCount);
    expect(scene.materials).toHaveLength(materialCount);
  });

  it("moves a complete vehicle and its delivery target together while wheels rotate independently", () => {
    const delivery = street.targets.find((target) => target.kind === "delivery")!;
    expect(delivery.mesh.isDescendantOf(street.truck)).toBe(true);
    expect(street.wheels).toHaveLength(4);
    const initial = street.truck.getHierarchyBoundingVectors(true);
    const size = initial.max.subtract(initial.min);
    expect(size.x).toBeGreaterThan(4);
    expect(size.x).toBeLessThan(4.9);
    expect(size.z).toBeLessThan(2.25);
    expect(initial.min.y).toBeGreaterThan(-0.03);
    expect(initial.max.y).toBeLessThan(2.6);
    const from = delivery.mesh.getAbsolutePosition().clone();
    street.truck.position.x -= 22;
    street.truck.computeWorldMatrix(true);
    for (const mesh of street.truck.getChildMeshes()) mesh.computeWorldMatrix(true);
    expect(delivery.mesh.getAbsolutePosition().x - from.x).toBeCloseTo(-22);
    for (const wheel of street.wheels) {
      expect(wheel.parent).toBe(street.truck);
      expect(wheel.getChildMeshes().length).toBeGreaterThan(1);
      const axlePosition = wheel.position.clone();
      wheel.rotation.z -= 2;
      expect(wheel.position.equals(axlePosition)).toBe(true);
    }
    // A returning vehicle is animated at runtime; no parked truck is baked into scenery colliders.
    expect(obstructed(3, -9.1)).toBe(false);
    const status = scene.getMeshByName("delivery-truck-status")!;
    expect(status.isDescendantOf(street.truck)).toBe(true);
    const texture = (status.material as PBRMaterial).albedoTexture as DynamicTexture;
    const update = vi.spyOn(texture, "update");
    setDeliveryTruckStatus(scene, "第 2 天 · 已送达");
    setDeliveryTruckStatus(scene, "第 2 天 · 已送达");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps local procedural scenery within a draw-call budget and contains only finite geometry", () => {
    expect(street.root.getChildMeshes().length).toBeLessThan(500);
    expect(scene.materials.length).toBeLessThan(75);
    // Babylon also owns its embedded BRDF lookup; all visible surface maps here are generated locally.
    expect(scene.materials.filter((material) => material instanceof PBRMaterial).every((material) => !material.albedoTexture || material.albedoTexture instanceof DynamicTexture)).toBe(true);
    let vertices = 0;
    for (const mesh of street.root.getChildMeshes()) {
      vertices += mesh.getTotalVertices();
      for (const value of mesh.getVerticesData(VertexBuffer.PositionKind) ?? []) expect(Number.isFinite(value)).toBe(true);
      for (const value of mesh.getVerticesData(VertexBuffer.NormalKind) ?? []) expect(Number.isFinite(value)).toBe(true);
    }
    expect(vertices).toBeGreaterThan(10_000);
    expect(vertices).toBeLessThan(200_000);
    // Floor batches must still be identifiable so the world's shadow pass can omit them.
    expect(scene.meshes.some((mesh) => /street-static-floor/.test(mesh.name))).toBe(true);
    for (const collider of street.colliders) {
      expect(collider.minX).toBeLessThan(collider.maxX);
      expect(collider.minZ).toBeLessThan(collider.maxZ);
    }
  });
});
