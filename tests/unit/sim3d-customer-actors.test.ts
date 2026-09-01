import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Animation, AnimationGroup, Bone, Matrix, MeshBuilder, NullEngine, Scene, SceneLoader, Skeleton, TransformNode, type ShadowGenerator } from "@babylonjs/core";
import { CustomerActors } from "../../src/sim3d/customerActors";
import { CUSTOMER_PROFILES, CUSTOMER_WALK_ANIMATION_RATE, customerProfileFor } from "../../src/sim3d/customerSelection";
import { createFirstDayState } from "../../src/sim3d/domain";

describe("cached customer model visibility and animation ownership", () => {
  let engine: NullEngine;
  let scene: Scene;
  let actors: CustomerActors;
  let path: TransformNode;
  let imports: ReturnType<typeof vi.spyOn>;
  let missingIdleModel: string | undefined;
  const groups = new Map<string, { walk: AnimationGroup; idle: AnimationGroup }>();

  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 4 });
    scene = new Scene(engine);
    path = new TransformNode("customer-path", scene);
    path.position.set(2, 0, -3);
    const shadow = { addShadowCaster: vi.fn(), removeShadowCaster: vi.fn() } as unknown as ShadowGenerator;
    actors = new CustomerActors(scene, shadow, path);
    groups.clear();
    missingIdleModel = undefined;
    imports = vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation(async (_names, _root, model) => {
      const mesh = MeshBuilder.CreateBox(String(model), { width: .45, height: 1.8, depth: .25 }, scene);
      mesh.position.y = .9;
      const skeleton = new Skeleton(`rig-${model}`, `rig-${model}`, scene);
      new Bone("root", skeleton, null, Matrix.Identity());
      mesh.skeleton = skeleton;
      const createGroup = (name: string): AnimationGroup => {
        const animation = new Animation(name, "rotation.y", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
        animation.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: .05 }]);
        const group = new AnimationGroup(name, scene);
        group.addTargetedAnimation(animation, mesh);
        vi.spyOn(group, "start");
        vi.spyOn(group, "stop");
        return group;
      };
      const pair = { walk: createGroup("walk"), idle: createGroup("idle") };
      groups.set(String(model), pair);
      const animationGroups = model === missingIdleModel ? [pair.walk] : [pair.walk, pair.idle];
      if (model === missingIdleModel) pair.idle.dispose();
      return { meshes: [mesh], animationGroups, particleSystems: [], skeletons: [skeleton], transformNodes: [], geometries: [], lights: [], spriteManagers: [] };
    });
  });

  afterEach(() => {
    actors.dispose();
    scene.dispose();
    engine.dispose();
    vi.restoreAllMocks();
  });

  it("loads every configured asset once, grounds its own proportions and enables only the current visitor", async () => {
    const state = createFirstDayState();
    await actors.init(state);
    expect(imports).toHaveBeenCalledTimes(CUSTOMER_PROFILES.length);
    for (const profile of CUSTOMER_PROFILES) {
      const root = scene.getTransformNodeByName(`customer-visual-${profile.id}`)!;
      expect(root.parent).toBe(path);
      expect(root.isEnabled()).toBe(profile.id === customerProfileFor(state).id);
      root.computeWorldMatrix(true);
      const bounds = root.getHierarchyBoundingVectors(true);
      expect(bounds.min.y).toBeCloseTo(0, 4);
      expect(bounds.max.y - bounds.min.y).toBeCloseTo(profile.height, 4);
      expect((bounds.min.x + bounds.max.x) / 2).toBeCloseTo(2, 4);
    }
    for (let number = 2; number <= 12; number += 1) {
      const next = { ...state, customer: { ...state.customer, number } };
      actors.select(next);
      const enabled = CUSTOMER_PROFILES.filter((profile) => scene.getTransformNodeByName(`customer-visual-${profile.id}`)!.isEnabled());
      expect(enabled.map((profile) => profile.id)).toEqual([customerProfileFor(next).id]);
    }
    expect(imports).toHaveBeenCalledTimes(CUSTOMER_PROFILES.length);
  });

  it("switches animation with the actor and does not restart the walk loop on every frame", async () => {
    const state = createFirstDayState();
    await actors.init(state);
    const first = groups.get(customerProfileFor(state).model)!;
    vi.mocked(first.walk.start).mockClear();
    actors.play(true);
    expect(first.walk.start).toHaveBeenLastCalledWith(true, CUSTOMER_WALK_ANIMATION_RATE);
    actors.play(true);
    expect(first.walk.start).toHaveBeenCalledOnce();
    actors.play(false);
    expect(first.walk.stop).toHaveBeenCalled();
    const next = { ...state, customer: { ...state.customer, number: 2 } };
    actors.select(next);
    expect(first.idle.isPlaying).toBe(false);
    const second = groups.get(customerProfileFor(next).model)!;
    expect(second.idle.isPlaying).toBe(true);
    actors.play(true);
    expect(second.walk.isPlaying).toBe(true);
    expect(first.walk.isPlaying).toBe(false);
  });

  it("does not enable a late-loading character after the world has been disposed", async () => {
    const pending = actors.init(createFirstDayState());
    actors.dispose();
    await pending;
    expect(scene.transformNodes.filter((root) => root.name.startsWith("customer-visual-"))).toEqual([]);
    expect(scene.meshes).toHaveLength(0);
    expect(scene.animationGroups).toHaveLength(0);
    expect(scene.skeletons).toHaveLength(0);
  });

  it("releases skeletons as well as mesh and animation resources on normal disposal", async () => {
    await actors.init(createFirstDayState());
    expect(scene.skeletons).toHaveLength(CUSTOMER_PROFILES.length);
    actors.dispose();
    expect(scene.meshes).toHaveLength(0);
    expect(scene.skeletons).toHaveLength(0);
    expect(scene.animationGroups).toHaveLength(0);
  });

  it("cleans up the entire batch when one asset is missing its required animation", async () => {
    missingIdleModel = CUSTOMER_PROFILES[0]!.model;
    await expect(actors.init(createFirstDayState())).rejects.toThrow("缺少站立或行走动画");
    expect(scene.meshes).toHaveLength(0);
    expect(scene.skeletons).toHaveLength(0);
    expect(scene.animationGroups).toHaveLength(0);
    expect(scene.transformNodes.filter((root) => root.name.startsWith("customer-visual-"))).toEqual([]);
  });
});
