import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Animation, AnimationGroup, MeshBuilder, NullEngine, Scene, SceneLoader, UniversalCamera, Vector3, type ShadowGenerator,
} from "@babylonjs/core";
import { StreetNeighbourActors } from "../../src/sim3d/streetNeighbourActors";
import { STREET_NEIGHBOUR_PROFILES, streetNeighbourForDay } from "../../src/sim3d/streetNeighbourContent";
import { createFirstDayState, type SimState } from "../../src/sim3d/domain";
import { ShopWorld } from "../../src/sim3d/world";

interface InitWorldHarness {
  state: SimState;
  disposed: boolean;
  scene: Scene;
  camera: UniversalCamera;
  colliders: never[];
  occupiedCrates: Set<string>;
  streetNeighbourActors: StreetNeighbourActors;
  customerActors: { init: ReturnType<typeof vi.fn> };
  callbacks: { onStatus: ReturnType<typeof vi.fn> };
  setCustomerRoute: ReturnType<typeof vi.fn>;
  init(): Promise<void>;
  isFree(x: number, z: number): boolean;
}

describe("street-neighbour actor ownership", () => {
  let engine: NullEngine;
  let scene: Scene;
  let actors: StreetNeighbourActors;
  let imports: ReturnType<typeof vi.spyOn>;
  const groups = new Map<string, AnimationGroup>();

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: 800, renderHeight: 600, textureSize: 256,
      deterministicLockstep: false, lockstepMaxSteps: 4,
    });
    scene = new Scene(engine);
    const shadow = { addShadowCaster: vi.fn(), removeShadowCaster: vi.fn() } as unknown as ShadowGenerator;
    actors = new StreetNeighbourActors(scene, shadow);
    groups.clear();
    imports = vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation(async (_names, _root, model) => {
      const dog = model === "street-dog-patch.glb";
      const height = dog ? .5 : 1.8;
      const mesh = MeshBuilder.CreateBox(String(model), { width: dog ? .7 : .45, height, depth: dog ? .25 : .28 }, scene);
      mesh.position.y = height / 2;
      const animationGroups: AnimationGroup[] = [];
      if (!dog) {
        const animation = new Animation("idle", "rotation.y", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
        animation.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: .03 }]);
        const group = new AnimationGroup("idle", scene);
        group.addTargetedAnimation(animation, mesh);
        vi.spyOn(group, "start");
        vi.spyOn(group, "stop");
        groups.set(String(model), group);
        animationGroups.push(group);
      }
      return {
        meshes: [mesh], animationGroups, particleSystems: [], skeletons: [], transformNodes: [],
        geometries: [], lights: [], spriteManagers: [],
      };
    });
  });

  afterEach(() => {
    actors.dispose();
    scene.dispose();
    engine.dispose();
    vi.restoreAllMocks();
  });

  it("loads two real people plus Sam's dog, enables only today's profile and alternates on the next day", async () => {
    const first = { ...createFirstDayState(), customerSeed: 31 };
    expect(streetNeighbourForDay({ customerSeed: 31, dayNumber: 1 }).id).toBe("sam");
    await actors.init(first);

    expect(imports.mock.calls.map((call: unknown[]) => call[2])).toEqual(expect.arrayContaining([
      "customer-male-04.glb", "street-dog-patch.glb", "customer-female-04.glb",
    ]));
    expect(actors.targets.map((target) => target.id).sort()).toEqual(["ellis", "sam"]);
    expect(scene.getTransformNodeByName("street-neighbour-sam")!.isEnabled()).toBe(true);
    expect(scene.getTransformNodeByName("street-neighbour-ellis")!.isEnabled()).toBe(false);
    expect(scene.getTransformNodeByName("street-neighbour-visual-sam-dog")).not.toBeNull();
    expect(actors.colliders).toHaveLength(2);
    expect(groups.get("customer-male-04.glb")!.isPlaying).toBe(true);
    expect(groups.get("customer-female-04.glb")!.isPlaying).toBe(false);

    expect(actors.select({ ...first, day: { ...first.day, number: 2 } })).toBe(true);
    expect(scene.getTransformNodeByName("street-neighbour-sam")!.isEnabled()).toBe(false);
    expect(scene.getTransformNodeByName("street-neighbour-ellis")!.isEnabled()).toBe(true);
    expect(actors.colliders).toHaveLength(1);
    expect(groups.get("customer-male-04.glb")!.isPlaying).toBe(false);
    expect(groups.get("customer-female-04.glb")!.isPlaying).toBe(true);
    expect(actors.select({ ...first, day: { ...first.day, number: 2 } })).toBe(false);
    expect(imports).toHaveBeenCalledTimes(3);
  });

  it("keeps configured positions and clears imported scene resources on disposal", async () => {
    await actors.init({ ...createFirstDayState(), customerSeed: 31 });
    for (const profile of STREET_NEIGHBOUR_PROFILES) {
      const root = scene.getTransformNodeByName(`street-neighbour-${profile.id}`)!;
      expect(root.position.x).toBeCloseTo(profile.position.x, 6);
      expect(root.position.z).toBeCloseTo(profile.position.z, 6);
      expect(root.rotation.y).toBeCloseTo(profile.yaw, 6);
    }
    expect(scene.meshes).toHaveLength(3);
    actors.dispose();
    expect(scene.meshes).toHaveLength(0);
    expect(scene.animationGroups).toHaveLength(0);
    expect(scene.transformNodes.filter((node) => node.name.startsWith("street-neighbour-"))).toEqual([]);
  });

  it.each([
    { name: "Sam", dayNumber: 1, part: "person" as const },
    { name: "Patch", dayNumber: 1, part: "dog" as const },
    { name: "Ellis", dayNumber: 2, part: "person" as const },
  ])("moves an imported old-save pose out of $name's newly loaded collider", async ({ dayNumber, part }) => {
    const base = createFirstDayState();
    const state = { ...base, customerSeed: 31, day: { ...base.day, number: dayNumber } };
    const profile = streetNeighbourForDay({ customerSeed: state.customerSeed, dayNumber });
    let blocked = { ...profile.position };
    if (part === "dog") {
      if (!profile.dog) throw new Error("The Patch fixture must select Sam's dog");
      const cos = Math.cos(profile.yaw);
      const sin = Math.sin(profile.yaw);
      blocked = {
        x: profile.position.x + profile.dog.position.x * cos + profile.dog.position.z * sin,
        z: profile.position.z - profile.dog.position.x * sin + profile.dog.position.z * cos,
      };
    }
    state.playerPose = { ...state.playerPose, ...blocked };
    const world = Object.create(ShopWorld.prototype) as InitWorldHarness;
    Object.assign(world, {
      state, disposed: false, scene,
      camera: new UniversalCamera("old-save-eyes", new Vector3(blocked.x, 1.65, blocked.z), scene),
      colliders: [], occupiedCrates: new Set(), streetNeighbourActors: actors,
      customerActors: { init: vi.fn(async () => undefined) },
      callbacks: { onStatus: vi.fn() }, setCustomerRoute: vi.fn(),
    });

    // The actor collider does not exist until init finishes loading the GLBs.
    expect(world.isFree(blocked.x, blocked.z)).toBe(true);
    await world.init();
    expect(world.isFree(blocked.x, blocked.z)).toBe(false);
    expect(world.isFree(world.camera.position.x, world.camera.position.z)).toBe(true);
    expect(Math.hypot(world.camera.position.x - blocked.x, world.camera.position.z - blocked.z)).toBeGreaterThan(.5);
  });
});
