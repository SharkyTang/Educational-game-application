import { AnimationGroup, Scene, SceneLoader, ShadowGenerator, TransformNode } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { placeCustomerVisual } from "./modelPlacement";
import { CUSTOMER_PROFILES, CUSTOMER_WALK_ANIMATION_RATE, customerProfileFor } from "./customerSelection";
import type { SimState } from "./domain";

type ImportedCustomer = Awaited<ReturnType<typeof SceneLoader.ImportMeshAsync>>;
interface Actor {
  root: TransformNode;
  imported: ImportedCustomer;
  walk: AnimationGroup;
  idle: AnimationGroup;
}

/** One cached mesh per neighbour; only the current visitor is visible or animated. */
export class CustomerActors {
  private readonly actors = new Map<string, Actor>();
  private active: Actor | undefined;
  private playing: AnimationGroup | undefined;
  private disposed = false;

  constructor(private readonly scene: Scene, private readonly shadow: ShadowGenerator, private readonly pathRoot: TransformNode) {}

  async init(state: SimState): Promise<void> {
    try {
      await Promise.all(CUSTOMER_PROFILES.map(async (profile) => {
        const imported = await SceneLoader.ImportMeshAsync("", "/assets/sim3d/", profile.model, this.scene);
        if (this.disposed) { this.release(imported); return }
        const root = new TransformNode(`customer-visual-${profile.id}`, this.scene);
        try {
          root.metadata = { customerId: profile.id, voice: profile.voice };
          for (const mesh of imported.meshes) {
            if (!mesh.parent) mesh.parent = root;
            mesh.isPickable = true;
            mesh.receiveShadows = true;
            this.shadow.addShadowCaster(mesh, false);
          }
          for (const animation of imported.animationGroups) { animation.stop(); animation.reset() }
          const walk = imported.animationGroups.find((group) => group.name === "walk");
          const idle = imported.animationGroups.find((group) => group.name === "idle");
          if (!walk || !idle) throw new Error(`顾客 ${profile.name} 缺少站立或行走动画。`);
          placeCustomerVisual(root, this.pathRoot, profile.height);
          root.setEnabled(false);
          this.actors.set(profile.id, { root, imported, walk, idle });
        } catch (error) {
          this.release(imported, root);
          throw error;
        }
      }));
    } catch (error) {
      // Stop the whole batch, including any sibling imports that finish later.
      this.dispose();
      throw error;
    }
    if (!this.disposed) this.select(state);
  }

  select(state: SimState): void {
    const actor = this.actors.get(customerProfileFor(state).id);
    if (!actor || actor === this.active || this.disposed) return;
    this.playing?.stop();
    this.playing = undefined;
    this.active?.root.setEnabled(false);
    this.active = actor;
    actor.root.setEnabled(true);
    this.play(false);
  }

  play(walking: boolean, speedRatio = 1): void {
    if (!this.active || this.disposed) return;
    const animation = walking ? this.active.walk : this.active.idle;
    const rate = walking ? CUSTOMER_WALK_ANIMATION_RATE * speedRatio : 1;
    if (animation === this.playing) { animation.speedRatio = rate; return; }
    this.playing?.stop();
    this.playing = animation;
    animation.start(true, rate);
  }

  dispose(): void {
    this.disposed = true;
    this.playing = undefined;
    this.active = undefined;
    for (const actor of this.actors.values()) this.release(actor.imported, actor.root);
    this.actors.clear();
  }

  private release(imported: ImportedCustomer, root?: TransformNode): void {
    for (const animation of imported.animationGroups) animation.dispose();
    for (const skeleton of imported.skeletons) skeleton.dispose();
    for (const mesh of imported.meshes) this.shadow.removeShadowCaster(mesh, false);
    root?.dispose(false, true);
    for (const mesh of imported.meshes) if (!mesh.isDisposed()) mesh.dispose(false, true);
    for (const node of imported.transformNodes) if (!node.isDisposed()) node.dispose(false, true);
    for (const geometry of imported.geometries) geometry.dispose();
    for (const light of imported.lights) light.dispose();
    for (const particle of imported.particleSystems) particle.dispose();
    for (const manager of imported.spriteManagers) manager.dispose();
  }
}
