import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, Ray, Scene, Vector3 } from "@babylonjs/core";
import { GetEnvironmentBRDFTexture } from "@babylonjs/core/Misc/brdfTextureTools";
import { createWorkstation } from "../../src/sim3d/workstationAsset";
import { DEFAULT_WORKSTATION_PLACEMENT, FALLBACK_WORKSTATION_PLACEMENT, workstationServicePoint } from "../../src/sim3d/workstation";

describe("physical management computer asset", () => {
  let engine: NullEngine; let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => ({ width, height, remove: vi.fn(), getContext: () => ({
      fillRect: vi.fn(), fillText: vi.fn(), clearRect: vi.fn(), fillStyle: "", font: "", textAlign: "",
    }) } as unknown as ReturnType<NullEngine["createCanvas"]>));
    scene = new Scene(engine);
    // Babylon owns this shared PBR lookup texture for the entire scene.
    GetEnvironmentBRDFTexture(scene);
  });
  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); });

  it("has a grounded wood desk, tower, monitor, keyboard and mouse contained by its footprint", () => {
    const asset = createWorkstation(scene, DEFAULT_WORKSTATION_PLACEMENT);
    for (const part of ["desktop", "computer-tower", "monitor-bezel", "monitor-screen", "keyboard", "mouse"]) {
      const mesh = scene.getMeshByName(`management-workstation-${part}`);
      expect(mesh, part).not.toBeNull(); expect(mesh!.isDescendantOf(asset.root)).toBe(true);
    }
    const { min, max } = asset.root.getHierarchyBoundingVectors(true);
    expect(min.y).toBeCloseTo(0, 5); expect(max.y).toBeCloseTo(1.345, 5);
    expect(min.x).toBeCloseTo(asset.collider.minX, 5); expect(max.x).toBeCloseTo(asset.collider.maxX, 5);
    expect(min.z).toBeCloseTo(asset.collider.minZ, 5); expect(max.z).toBeCloseTo(asset.collider.maxZ, 5);
    expect(asset.root.metadata.free).toBe(true);
  });

  it("moves and rotates the whole computer with stable interaction and collision references", () => {
    const asset = createWorkstation(scene, DEFAULT_WORKSTATION_PLACEMENT);
    const point = asset.interactionPoint; const collider = asset.collider;
    const resources = [scene.meshes.length, scene.materials.length, scene.textures.length];
    for (const rotation of [0, 1, 2, 3] as const) {
      const placement = { x: 1, z: 5, rotation };
      asset.apply(placement);
      expect(asset.interactionPoint).toBe(point); expect(asset.collider).toBe(collider);
      const screen = asset.interactionMesh.getAbsolutePosition();
      expect(Vector3.Distance(screen, point)).toBeLessThan(.001);
      const { min, max } = asset.root.getHierarchyBoundingVectors(true);
      expect(min.x).toBeCloseTo(collider.minX, 5); expect(max.x).toBeCloseTo(collider.maxX, 5);
      expect(min.z).toBeCloseTo(collider.minZ, 5); expect(max.z).toBeCloseTo(collider.maxZ, 5);
      const service = workstationServicePoint(placement);
      const origin = new Vector3(service.x, 1.65, service.z);
      const ray = new Ray(origin, point.subtract(origin).normalize(), 2.6);
      const hit = scene.pickWithRay(ray, (mesh) => mesh.isDescendantOf(asset.root));
      expect(hit?.hit).toBe(true); expect(hit?.pickedMesh).toBe(asset.interactionMesh);
      expect([scene.meshes.length, scene.materials.length, scene.textures.length]).toEqual(resources);
    }
    asset.apply(FALLBACK_WORKSTATION_PLACEMENT);
    expect(asset.root.position.z).toBe(-5.25);
  });

  it("disposes its complete asset once and can create a fresh computer in the same scene", () => {
    const before = [scene.meshes.length, scene.transformNodes.length, scene.materials.length, scene.textures.length];
    const asset = createWorkstation(scene, DEFAULT_WORKSTATION_PLACEMENT);
    asset.dispose(); asset.dispose(); asset.apply(FALLBACK_WORKSTATION_PLACEMENT);
    expect([scene.meshes.length, scene.transformNodes.length, scene.materials.length, scene.textures.length]).toEqual(before);
    const fresh = createWorkstation(scene, FALLBACK_WORKSTATION_PLACEMENT);
    expect(fresh.interactionMesh.isDisposed()).toBe(false);
    expect(scene.materials).toContain(fresh.interactionMesh.material);
    fresh.dispose();
    expect([scene.meshes.length, scene.transformNodes.length, scene.materials.length, scene.textures.length]).toEqual(before);
  });
});
