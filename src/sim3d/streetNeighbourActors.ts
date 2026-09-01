import { AnimationGroup, Scene, SceneLoader, ShadowGenerator, TransformNode } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { placeCustomerVisual } from "./modelPlacement";
import {
  STREET_NEIGHBOUR_PROFILES, streetNeighbourForDay,
  type StreetNeighbourId, type StreetNeighbourProfile,
} from "./streetNeighbourContent";

type ImportedPart = Awaited<ReturnType<typeof SceneLoader.ImportMeshAsync>>;
type NeighbourState = { customerSeed?: number; day: { number: number } };

interface LoadedPart {
  imported: ImportedPart;
  visual: TransformNode;
  animation?: AnimationGroup;
}

interface LoadedNeighbour {
  profile: StreetNeighbourProfile;
  root: TransformNode;
  parts: LoadedPart[];
}

export interface StreetNeighbourCollider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface StreetNeighbourTarget {
  id: StreetNeighbourId;
  root: TransformNode;
}

/** Two named neighbours are cached once; only today's neighbour is visible and animated. */
export class StreetNeighbourActors {
  private readonly actors = new Map<StreetNeighbourId, LoadedNeighbour>();
  private active: LoadedNeighbour | undefined;
  private disposed = false;

  constructor(private readonly scene: Scene, private readonly shadow: ShadowGenerator) {}

  async init(state: NeighbourState): Promise<void> {
    try {
      await Promise.all(STREET_NEIGHBOUR_PROFILES.map(async (profile) => {
        const root = new TransformNode(`street-neighbour-${profile.id}`, this.scene);
        root.position.set(profile.position.x, 0, profile.position.z);
        root.rotation.y = profile.yaw;
        root.metadata = { streetNeighbourId: profile.id };
        const parts: LoadedPart[] = [];
        try {
          parts.push(await this.loadPart(profile.model, `${profile.id}-person`, profile.height, root, true));
          if (profile.dog) {
            const dog = await this.loadPart(profile.dog.model, `${profile.id}-dog`, profile.dog.height, root, false);
            dog.visual.position.x += profile.dog.position.x;
            dog.visual.position.z += profile.dog.position.z;
            dog.visual.rotation.y += profile.dog.yaw;
            parts.push(dog);
          }
          if (this.disposed) { for (const part of parts) this.release(part); root.dispose(false, true); return }
          root.setEnabled(false);
          this.actors.set(profile.id, { profile, root, parts });
        } catch (error) {
          for (const part of parts) this.release(part);
          root.dispose(false, true);
          throw error;
        }
      }));
    } catch (error) {
      this.dispose();
      throw error;
    }
    if (!this.disposed) this.select(state);
  }

  select(state: NeighbourState): boolean {
    if (this.disposed) return false;
    const profile = streetNeighbourForDay({ customerSeed: state.customerSeed, dayNumber: state.day.number });
    const actor = this.actors.get(profile.id);
    if (!actor || actor === this.active) return false;
    this.stop(this.active);
    this.active?.root.setEnabled(false);
    this.active = actor;
    actor.root.setEnabled(true);
    for (const part of actor.parts) part.animation?.start(true, 1);
    return true;
  }

  get targets(): readonly StreetNeighbourTarget[] {
    return [...this.actors.values()].map((actor) => ({ id: actor.profile.id, root: actor.root }));
  }

  get colliders(): readonly StreetNeighbourCollider[] {
    const actor = this.active;
    if (!actor) return [];
    const profile = actor.profile;
    const result: StreetNeighbourCollider[] = [this.collider(profile.position.x, profile.position.z, .31)];
    if (profile.dog) {
      const cos = Math.cos(profile.yaw);
      const sin = Math.sin(profile.yaw);
      const x = profile.position.x + profile.dog.position.x * cos + profile.dog.position.z * sin;
      const z = profile.position.z - profile.dog.position.x * sin + profile.dog.position.z * cos;
      result.push(this.collider(x, z, .34));
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop(this.active);
    this.active = undefined;
    for (const actor of this.actors.values()) {
      for (const part of actor.parts) this.release(part);
      if (!actor.root.isDisposed()) actor.root.dispose(false, true);
    }
    this.actors.clear();
  }

  private async loadPart(
    model: string, name: string, height: number, parent: TransformNode, human: boolean,
  ): Promise<LoadedPart> {
    const imported = await SceneLoader.ImportMeshAsync("", "/assets/sim3d/", model, this.scene);
    const visual = new TransformNode(`street-neighbour-visual-${name}`, this.scene);
    try {
      for (const mesh of imported.meshes) {
        if (!mesh.parent) mesh.parent = visual;
        mesh.isPickable = true;
        mesh.receiveShadows = true;
        this.shadow.addShadowCaster(mesh, false);
      }
      for (const animation of imported.animationGroups) { animation.stop(); animation.reset() }
      const animation = imported.animationGroups.find((entry) => /idle|stand/i.test(entry.name))
        ?? (!human ? imported.animationGroups[0] : undefined);
      if (human && !animation) throw new Error(`街头邻居模型 ${model} 缺少站立动画。`);
      placeCustomerVisual(visual, parent, height);
      return { imported, visual, ...(animation ? { animation } : {}) };
    } catch (error) {
      this.release({ imported, visual });
      throw error;
    }
  }

  private stop(actor: LoadedNeighbour | undefined): void {
    if (!actor) return;
    for (const part of actor.parts) part.animation?.stop();
  }

  private collider(x: number, z: number, radius: number): StreetNeighbourCollider {
    return { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius };
  }

  private release(part: LoadedPart): void {
    part.animation?.stop();
    for (const animation of part.imported.animationGroups) animation.dispose();
    for (const skeleton of part.imported.skeletons) skeleton.dispose();
    for (const mesh of part.imported.meshes) this.shadow.removeShadowCaster(mesh, false);
    if (!part.visual.isDisposed()) part.visual.dispose(false, true);
    for (const mesh of part.imported.meshes) if (!mesh.isDisposed()) mesh.dispose(false, true);
    for (const node of part.imported.transformNodes) if (!node.isDisposed()) node.dispose(false, true);
    for (const geometry of part.imported.geometries) geometry.dispose();
    for (const light of part.imported.lights) light.dispose();
    for (const particle of part.imported.particleSystems) particle.dispose();
    for (const manager of part.imported.spriteManagers) manager.dispose();
  }
}
