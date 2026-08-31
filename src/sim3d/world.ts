import {
  AbstractMesh, AnimationGroup, Color3, Color4, DirectionalLight, Engine,
  HemisphericLight, ImageProcessingConfiguration, Mesh, MeshBuilder, PBRMaterial,
  PointLight, Scene, SceneLoader, ShadowGenerator, TransformNode, UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { placeCustomerVisual } from "./modelPlacement";
import { PointerAccess, type PointerMode } from "./pointerAccess";
import { createCrate, createPlayerHands, createProduct, createShop, setCheckoutDisplay, setShelfCapacity, setShopSignState } from "./assets";
import { createStreet, setDeliveryTruckStatus, setStreetVenueStatus, type StreetEnvironment } from "./street";
import { STREET_VENUES, getVenueProgress, type VenueId } from "./progression";
import {
  countAt, canSettleDay, getDaySummary, getDeliverySummary, isWalkablePosition, PRODUCTS, SAFE_DROP_POINTS, type CrateId, type CustomerPhase,
  type PlayerPose, type Position, type ProductId, type SimState,
} from "./domain";

export type Quality = "standard" | "low";
export interface InteractionTarget {
  id: string;
  kind: "crate" | "shelf" | "item" | "counter" | "open-sign" | "drop-zone" | "delivery" | "venue";
  productId?: ProductId;
  itemId?: string;
  crateId?: CrateId;
  venueId?: VenueId;
  position?: Position;
  label: string;
  action: string;
  inspectable: boolean;
  distance: number;
}
export interface WorldCallbacks {
  onTarget: (target: InteractionTarget | null) => void;
  onInteract: () => void;
  onInspect: () => void;
  onDrop: () => void;
  onPause: () => void;
  onCustomerArrive: () => void;
  onStatus: (text: string) => void;
  onFrame?: (fps: number, pose: PlayerPose) => void;
  onGuide?: (text: string) => void;
  onPointerMode?: (mode: PointerMode) => void;
}

type Collider = { minX: number; maxX: number; minZ: number; maxZ: number };
type TargetData = Omit<InteractionTarget, "label" | "action" | "inspectable" | "distance">;
const EYE_HEIGHT = 1.65;
const INTERACTION_RANGE = 2.6;
const KEY_CODES = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyI", "KeyJ", "KeyK", "KeyL", "KeyE", "KeyF", "KeyG", "Escape",
]);
const paths: Record<CustomerPhase, Position[]> = {
  outside: [],
  "to-milk": [{ x: 0, z: -3.8 }, { x: 0, z: -.65 }, { x: 0, z: 2.72 }],
  "to-bread": [{ x: .9, z: 2.25 }, { x: 1.65, z: .35 }],
  "to-checkout": [{ x: .15, z: -.65 }, { x: -.94, z: -2.15 }],
  checkout: [],
  leaving: [{ x: 0, z: -3.15 }, { x: 0, z: -5.3 }],
  complete: [],
};
const phaseStart: Record<CustomerPhase, Position> = {
  outside: { x: 0, z: -5.3 }, "to-milk": { x: 0, z: -4.35 },
  "to-bread": { x: 0, z: 2.72 }, "to-checkout": { x: 1.65, z: .35 },
  checkout: { x: -.94, z: -2.15 }, leaving: { x: -.94, z: -2.15 },
  complete: { x: 0, z: -5.3 },
};

/** Rendering and embodied input only; inventory and money live in the pure reducer. */
export class ShopWorld {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private readonly shadow: ShadowGenerator;
  private readonly street: StreetEnvironment;
  private truckPhase: "arriving" | "parked" | "departing" | "away" = "arriving";
  private state: SimState;
  private readonly colliders: Collider[] = [];
  private readonly crates = new Map<CrateId, TransformNode>();
  private readonly products = new Map<string, TransformNode>();
  private readonly shelfSlots: Record<ProductId, Vector3[]>;
  private readonly hands: TransformNode;
  private readonly customer: TransformNode;
  private readonly basket: TransformNode;
  private readonly inspection: Record<ProductId, TransformNode>;
  private customerAnimations: AnimationGroup[] = [];
  private walkAnimation: AnimationGroup | undefined;
  private idleAnimation: AnimationGroup | undefined;
  private playingAnimation: AnimationGroup | undefined;
  private customerPhase: CustomerPhase;
  private route: Position[] = [];
  private routeIndex = 0;
  private arrivalDelay = 0;
  private arrivedRevision = -1;
  private active = false;
  private disposed = false;
  private inspectionProduct: ProductId | null = null;
  private readonly keys = new Set<string>();
  private readonly lifetime = new AbortController();
  private drag: { x: number; y: number } | null = null;
  private sensitivity = 1;
  private reducedMotion = true;
  private targetMesh: AbstractMesh | null = null;
  private frameClock = 0;
  private viewClock = 0;
  private poseClock = 0;
  private readonly pointerAccess = new PointerAccess();
  private pointerRequestGeneration = 0;
  private canvasWasLost = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    initialState: SimState,
    private readonly callbacks: WorldCallbacks,
  ) {
    this.state = initialState;
    this.engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
    this.scene = new Scene(this.engine);
    this.scene.clearColor = Color4.FromHexString("#dceaf0ff");
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = Color3.FromHexString("#dceaf0");
    this.scene.fogStart = 38;
    this.scene.fogEnd = 68;
    this.scene.ambientColor = new Color3(.12, .14, .11);
    this.scene.imageProcessingConfiguration.toneMappingEnabled = true;
    this.scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.scene.imageProcessingConfiguration.exposure = 1.08;
    this.scene.imageProcessingConfiguration.contrast = 1.04;
    this.camera = new UniversalCamera("shop-eyes", new Vector3(0, EYE_HEIGHT, -3.5), this.scene);
    this.camera.minZ = .035;
    this.camera.maxZ = 60;
    this.camera.fov = .97;
    this.camera.inputs.clear();
    this.scene.activeCamera = this.camera;
    this.restorePose(initialState.playerPose);

    const sky = new HemisphericLight("soft-daylight", new Vector3(.2, 1, -.4), this.scene);
    sky.intensity = .62;
    sky.diffuse = new Color3(.94, .97, 1);
    sky.groundColor = new Color3(.47, .40, .31);
    const sun = new DirectionalLight("window-sun", new Vector3(.28, -.72, .52), this.scene);
    sun.position.set(-4, 8, -7);
    sun.intensity = 1.8;
    sun.diffuse = new Color3(1, .94, .80);
    this.shadow = new ShadowGenerator(1536, sun);
    this.shadow.usePercentageCloserFiltering = true;
    this.shadow.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadow.bias = .0006;
    this.shadow.normalBias = .035;
    this.shadow.setDarkness(.28);
    for (const z of [-2.4, 1.3]) {
      const light = new PointLight(`warm-ceiling-${z}`, new Vector3(0, 2.68, z), this.scene);
      light.intensity = 4;
      light.range = 6;
      light.diffuse = new Color3(1, .89, .71);
    }

    const shop = createShop(this.scene);
    this.colliders.push(...shop.colliders);
    this.street = createStreet(this.scene);
    this.colliders.push(...this.street.colliders);
    for (const target of this.street.targets) {
      this.tag(target.mesh, {
        id: target.id, kind: target.kind,
        ...(target.venueId ? { venueId: target.venueId } : {}),
        position: { x: target.position.x, z: target.position.z },
      });
    }
    // A delivery is physical interaction with the stopped vehicle, not an invisible trigger.
    this.tag(this.street.truck, { id: "daily-delivery", kind: "delivery" });
    this.resetTruck(initialState.day.phase === "settled" ? "away" : initialState.purchases.length > 0 || initialState.day.phase === "open" ? "parked" : "arriving");
    const slots = shop.root.metadata?.shelfSlots as Record<ProductId, Vector3[]> | undefined;
    this.shelfSlots = slots ?? {
      milk: Array.from({ length: 8 }, (_, i) => new Vector3(-.3 + (i % 4) * .2, i < 4 ? .94 : 1.4, 3.68)),
      bread: Array.from({ length: 8 }, (_, i) => new Vector3(2.65, i < 4 ? .82 : 1.3, -.21 + (i % 4) * .34)),
    };
    for (const target of shop.targets) {
      this.tag(target.mesh, {
        id: target.id, kind: target.kind,
        ...(target.productId ? { productId: target.productId } : {}),
        position: { x: target.position.x, z: target.position.z },
      });
    }
    for (const crate of initialState.crates) {
      const root = createCrate(this.scene, crate.productId, crate.id);
      this.crates.set(crate.id, root);
    }
    for (const item of initialState.items) {
      const root = createProduct(this.scene, item.productId, item.id);
      this.products.set(item.id, root);
    }
    this.hands = createPlayerHands(this.scene);
    this.hands.parent = this.camera;
    this.hands.position.set(0, -.39, .80);
    this.hands.setEnabled(false);
    this.setViewModel(this.hands, true);
    this.inspection = {
      milk: createProduct(this.scene, "milk", "inspect-milk"),
      bread: createProduct(this.scene, "bread", "inspect-bread"),
    };
    for (const [id, root] of Object.entries(this.inspection)) {
      root.parent = this.camera;
      root.position.set(-.10, id === "milk" ? -.17 : -.09, .60);
      root.scaling.setAll(id === "milk" ? 1.5 : 1.2);
      this.setViewModel(root, true);
      root.setEnabled(false);
    }
    this.layoutInspection();
    this.customer = new TransformNode("customer-path-root", this.scene);
    this.basket = this.createBasket();
    this.basket.parent = this.customer;
    this.basket.position.set(.34, .47, .04);
    this.customerPhase = initialState.customer.phase;
    this.setCustomerRoute(true);
    this.syncInventory();
    this.syncStreet();
    this.ensureSafePose();
    for (const mesh of this.scene.meshes) {
      if (mesh.renderingGroupId === 2) continue;
      mesh.receiveShadows = true;
      if (mesh.getTotalVertices() > 12 && !/glass|pane|floor|wall|ceiling|label|letter|drop-/i.test(mesh.name)) {
        this.shadow.addShadowCaster(mesh, false);
      }
    }
    this.installInput();
    this.engine.runRenderLoop(() => this.render());
    window.addEventListener("resize", () => { this.engine.resize(); this.layoutInspection(); }, { signal: this.lifetime.signal });
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.canvasWasLost = true;
      this.callbacks.onPause();
      this.callbacks.onStatus("画面连接中断，进度已保留。恢复后请继续；若仍黑屏，请刷新页面。");
    }, { signal: this.lifetime.signal });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.canvasWasLost = false;
      this.callbacks.onStatus("画面已恢复，可以继续营业。");
    }, { signal: this.lifetime.signal });
  }

  async init(): Promise<void> {
    const imported = await SceneLoader.ImportMeshAsync("", "/assets/sim3d/", "customer.glb", this.scene);
    if (this.disposed) return;
    const visual = new TransformNode("customer-visual", this.scene);
    for (const mesh of imported.meshes) {
      if (!mesh.parent) mesh.parent = visual;
      mesh.isPickable = true;
      mesh.receiveShadows = true;
      this.shadow.addShadowCaster(mesh, false);
    }
    placeCustomerVisual(visual, this.customer);
    this.customerAnimations = imported.animationGroups;
    this.walkAnimation = imported.animationGroups.find((group) => /walk/i.test(group.name));
    this.idleAnimation = imported.animationGroups.find((group) => /idle|breathe/i.test(group.name));
    for (const animation of this.customerAnimations) animation.stop();
    this.playCustomerAnimation(false);
    await this.scene.whenReadyAsync();
    this.callbacks.onStatus("小店已准备好 · 先查看进货单，再搬运商品开始营业。");
  }

  private tag(root: TransformNode | AbstractMesh, data: TargetData): void {
    if (root instanceof AbstractMesh) root.metadata = { ...root.metadata, interaction: data };
    for (const mesh of root.getChildMeshes()) {
      mesh.metadata = { ...mesh.metadata, interaction: data };
    }
  }

  private setViewModel(root: TransformNode, enabled: boolean): void {
    for (const mesh of root.getChildMeshes()) {
      mesh.isPickable = !enabled;
      mesh.renderingGroupId = enabled ? 2 : 0;
    }
  }

  setState(state: SimState): void {
    const phaseChanged = this.customerPhase !== state.customer.phase;
    const newDay = this.state.day.number !== state.day.number;
    const freshRun = state.revision < this.state.revision && state.purchases.length === 0 && state.transactions.length === 0;
    const closed = this.state.day.phase !== "settled" && state.day.phase === "settled";
    this.state = state;
    if (newDay || freshRun) this.resetTruck(state.day.phase === "settled" ? "away" : "arriving");
    else if (closed && this.truckPhase !== "away") this.truckPhase = "departing";
    if (phaseChanged) this.setCustomerRoute(false);
    this.syncInventory();
    this.syncStreet();
    this.ensureSafePose();
    this.updateTarget();
  }

  private syncInventory(): void {
    const state = this.state;
    const visibleIds = new Set(state.items.filter((item) => item.location.kind !== "sold" && item.location.kind !== "delivery").map((item) => item.id));
    for (const [id, root] of this.products) {
      if (visibleIds.has(id)) continue;
      for (const mesh of root.getChildMeshes()) this.shadow.removeShadowCaster(mesh, false);
      root.dispose(false, false);
      this.products.delete(id);
    }
    for (const crate of state.crates) {
      const root = this.crates.get(crate.id)!;
      const held = state.held.kind === "crate" && state.held.crateId === crate.id;
      root.parent = held ? this.camera : null;
      root.position.set(held ? 0 : crate.position.x, held ? -.39 : .025, held ? .80 : crate.position.z);
      root.rotation.set(0, 0, 0);
      root.setEnabled(!held || !this.inspectionProduct);
      this.setViewModel(root, held);
      this.tag(root, { id: crate.id, kind: "crate", crateId: crate.id, productId: crate.productId });
    }
    for (const item of state.items) {
      if (item.location.kind === "sold" || item.location.kind === "delivery") continue;
      let root = this.products.get(item.id);
      if (!root) {
        root = createProduct(this.scene, item.productId, item.id);
        this.products.set(item.id, root);
        for (const mesh of root.getChildMeshes()) {
          mesh.receiveShadows = true;
          if (mesh.getTotalVertices() > 12 && !/glass|label|letter/i.test(mesh.name)) this.shadow.addShadowCaster(mesh, false);
        }
      }
      const location = item.location;
      root.parent = null;
      root.rotation.set(0, 0, 0);
      root.scaling.setAll(1);
      root.setEnabled(true);
      this.setViewModel(root, false);
      this.tag(root, { id: item.id, kind: "item", itemId: item.id, productId: item.productId });
      if (location.kind === "crate") {
        const crate = this.crates.get(location.crateId)!;
        const siblings = state.items.filter((entry) => entry.location.kind === "crate" && entry.location.crateId === location.crateId);
        const index = siblings.findIndex((entry) => entry.id === item.id);
        const withinLayer = index % 4;
        const layer = Math.floor(index / 4);
        root.parent = crate;
        if (item.productId === "milk") root.position.set((withinLayer % 2 - .5) * .15, .025 + layer * .265, (Math.floor(withinLayer / 2) - .5) * .14);
        else root.position.set((withinLayer % 2 - .5) * .31, .025 + layer * .16, (Math.floor(withinLayer / 2) - .5) * .18);
        const isHeld = state.held.kind === "crate" && state.held.crateId === location.crateId;
        this.setViewModel(root, isHeld);
        this.tag(root, { id: location.crateId, kind: "crate", crateId: location.crateId, productId: item.productId });
      } else if (location.kind === "hand") {
        root.parent = this.camera;
        root.position.set(.20, -.37, .53);
        root.rotation.y = -.22;
        root.setEnabled(!this.inspectionProduct);
        this.setViewModel(root, true);
      } else if (location.kind === "shelf") {
        root.position.copyFrom(this.shelfSlots[item.productId][location.slot]!);
        if (item.productId === "bread") root.rotation.y = Math.PI / 2;
      } else if (location.kind === "basket") {
        root.parent = this.basket;
        root.position.set(item.productId === "milk" ? -.10 : .06, .045, 0);
        root.scaling.setAll(.8);
        if (item.productId === "bread") root.rotation.z = -.14;
      } else if (location.kind === "checkout") {
        const scanned = state.scannedIds.includes(item.id);
        root.position.set(scanned ? -2.30 : -1.77, 1.012, item.productId === "milk" ? -2.31 : -1.93);
        root.rotation.y = Math.PI / 2;
      }
    }
    this.hands.setEnabled(state.held.kind === "crate" && !this.inspectionProduct);
    const heldProduct = state.held.kind === "crate" ? state.crates.find((crate) => state.held.kind === "crate" && crate.id === state.held.crateId)?.productId : null;
    this.hands.scaling.x = heldProduct === "bread" ? .70 / .46 : 1;
    const transaction = state.transactions.find((sale) => sale.customerNumber === state.customer.number);
    const paid = !!transaction && (state.customer.phase === "leaving" || state.customer.phase === "complete");
    setShopSignState(this.scene, state.day.phase === "open");
    setCheckoutDisplay(this.scene, {
      scanned: paid ? 2 : state.scannedIds.length,
      totalPence: paid ? transaction.amountPence : state.items.filter((item) => state.scannedIds.includes(item.id)).reduce((total, item) => total + PRODUCTS[item.productId].pricePence, 0),
      paid,
    });
    setShelfCapacity(this.scene, state.upgraded);
  }

  private resetTruck(phase: "arriving" | "parked" | "away"): void {
    this.truckPhase = phase;
    this.street.truck.position.set(phase === "arriving" ? -25 : phase === "away" ? 25 : 3, 0, -9.1);
    this.street.truck.setEnabled(phase !== "away");
  }

  private syncStreet(): void {
    for (const venue of STREET_VENUES) {
      const progress = getVenueProgress(this.state, venue.id);
      const conditions = progress.requirements.map((entry) => entry.label).join(" · ");
      setStreetVenueStatus(this.scene, venue.id, progress.statusText, conditions, progress.eligible);
    }
    const delivery = getDeliverySummary(this.state);
    setDeliveryTruckStatus(this.scene, `第 ${this.state.day.number} 天 · ${delivery.pendingUnits > 0 ? `${delivery.pendingUnits} 件待签收` : delivery.receivedToday > 0 ? "今日货物已签收" : "每日配送 · 按需订货"}`);
  }

  private updateTruck(dt: number): void {
    if (this.truckPhase !== "arriving" && this.truckPhase !== "departing") return;
    const truck = this.street.truck;
    const destination = this.truckPhase === "arriving" ? 3 : 25;
    const step = Math.min(destination - truck.position.x, dt * 4.8);
    const nextX = truck.position.x + step;
    // Stop for the player instead of driving through them. The clear pavement stays accessible.
    if (Math.abs(this.camera.position.x - nextX) < 2.85 && Math.abs(this.camera.position.z - truck.position.z) < 1.45) return;
    truck.position.x = nextX;
    for (const wheel of this.street.wheels) wheel.rotation.z -= step / .38;
    if (Math.abs(destination - nextX) < .01) {
      if (this.truckPhase === "arriving") {
        this.truckPhase = "parked";
        this.callbacks.onStatus(`第 ${this.state.day.number} 天的送货车到店了。按 B 订货，走近车身按 E 签收，再把门口的货箱搬上货架。`);
      } else {
        this.truckPhase = "away";
        truck.setEnabled(false);
      }
    }
  }

  private setCustomerRoute(initial: boolean): void {
    const phase = this.state.customer.phase;
    const freshCustomer = phase === "to-milk";
    if (initial || freshCustomer) {
      const start = phaseStart[phase];
      this.customer.position.set(start.x, 0, start.z);
    }
    this.customerPhase = phase;
    this.customer.setEnabled(phase !== "outside" && phase !== "complete");
    this.route = paths[phase].map((point) => ({ ...point }));
    this.routeIndex = 0;
    this.arrivalDelay = 0;
    this.arrivedRevision = -1;
    if (phase === "checkout") this.customer.rotation.y = -Math.PI / 2;
  }

  private createBasket(): TransformNode {
    const root = new TransformNode("woven-shopping-basket", this.scene);
    const material = new PBRMaterial("basket-willow", this.scene);
    material.albedoColor = Color3.FromHexString("#ac8658");
    material.roughness = .96;
    const base = MeshBuilder.CreateBox("basket-base", { width: .34, height: .02, depth: .25 }, this.scene);
    base.parent = root;
    base.material = material;
    for (let row = 0; row < 5; row += 1) {
      const y = .025 + row * .034;
      for (const x of [-.18, .18]) {
        const slat = MeshBuilder.CreateBox(`basket-side-${row}-${x}`, { width: .012, height: .023, depth: .28 }, this.scene);
        slat.position.set(x, y, 0); slat.material = material; slat.parent = root;
      }
      for (const z of [-.14, .14]) {
        const slat = MeshBuilder.CreateBox(`basket-edge-${row}-${z}`, { width: .37, height: .023, depth: .012 }, this.scene);
        slat.position.set(0, y, z); slat.material = material; slat.parent = root;
      }
    }
    const handlePath = Array.from({ length: 17 }, (_, i) => new Vector3(-.18 * Math.cos(i * Math.PI / 16), .17 + .17 * Math.sin(i * Math.PI / 16), 0));
    const handle = MeshBuilder.CreateTube("basket-handle", { path: handlePath, radius: .012, tessellation: 8 }, this.scene);
    handle.parent = root; handle.material = material;
    return root;
  }

  private playCustomerAnimation(walking: boolean): void {
    const animation = walking ? this.walkAnimation : this.idleAnimation;
    if (animation === this.playingAnimation) return;
    this.playingAnimation?.stop();
    this.playingAnimation = animation;
    animation?.start(true, walking ? 1.05 : 1);
  }

  private updateCustomer(dt: number): void {
    if (!this.active || !this.customer.isEnabled()) return;
    const next = this.route[this.routeIndex];
    if (next) {
      const dx = next.x - this.customer.position.x;
      const dz = next.z - this.customer.position.z;
      const distance = Math.hypot(dx, dz);
      const playerDistance = Math.hypot(this.camera.position.x - this.customer.position.x, this.camera.position.z - this.customer.position.z);
      if (playerDistance < .56 && distance > .08) {
        this.playCustomerAnimation(false);
        return;
      }
      if (distance < .045) {
        this.routeIndex += 1;
      } else {
        const step = Math.min(distance, dt * .94);
        this.customer.position.x += dx / distance * step;
        this.customer.position.z += dz / distance * step;
        const yaw = Math.atan2(dx, dz);
        let angle = yaw - this.customer.rotation.y;
        angle = Math.atan2(Math.sin(angle), Math.cos(angle));
        this.customer.rotation.y += angle * Math.min(1, dt * 9);
        this.playCustomerAnimation(true);
      }
      return;
    }
    this.playCustomerAnimation(false);
    if (this.customerPhase === "to-milk") this.customer.rotation.y = 0;
    if (this.customerPhase === "to-bread") this.customer.rotation.y = Math.PI / 2;
    if (this.customerPhase === "checkout" || this.customerPhase === "to-checkout") this.customer.rotation.y = -Math.PI / 2;
    if (["to-milk", "to-bread", "to-checkout", "leaving"].includes(this.customerPhase)) {
      this.arrivalDelay += dt;
      if (this.arrivalDelay > 1.1 && this.arrivedRevision !== this.state.revision) {
        this.arrivedRevision = this.state.revision;
        this.arrivalDelay = 0;
        this.callbacks.onCustomerArrive();
      }
    }
  }

  private installInput(): void {
    const options = { signal: this.lifetime.signal };
    window.addEventListener("keydown", (event) => {
      if (!this.active || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName ?? "")) return;
      if (!KEY_CODES.has(event.code)) return;
      event.preventDefault();
      if (event.code === "Escape") { this.callbacks.onPause(); return; }
      if (event.repeat) return;
      if (event.code === "KeyE") this.callbacks.onInteract();
      else if (event.code === "KeyF") this.callbacks.onInspect();
      else if (event.code === "KeyG") this.callbacks.onDrop();
      else {
        this.keys.add(event.code);
        // A short key tap has a real, small movement; holding continues smoothly by frame time.
        this.movePlayer(.045);
      }
    }, options);
    window.addEventListener("keyup", (event) => this.keys.delete(event.code), options);
    window.addEventListener("blur", () => {
      this.keys.clear(); this.drag = null;
      if (this.active) this.callbacks.onPause();
    }, options);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.keys.clear(); if (this.active) this.callbacks.onPause(); }
    }, options);
    document.addEventListener("pointerlockchange", () => {
      this.drag = null; this.keys.clear();
      const result = this.pointerAccess.changed(document.pointerLockElement === this.canvas, this.active);
      this.callbacks.onPointerMode?.(result.mode);
      if (result.release) document.exitPointerLock();
      else if (result.pause) this.callbacks.onPause();
    }, options);
    document.addEventListener("pointerlockerror", () => this.enableDragLook(), options);
    this.canvas.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      this.canvas.focus();
      if (this.inspectionProduct) { this.drag = { x: event.clientX, y: event.clientY }; return; }
      if (!this.active) return;
      if (document.pointerLockElement === this.canvas) this.callbacks.onInteract();
      // Free cursor stays free: a click on the scene only begins drag-look.
      // Capturing it again requires the visible control or the Tab shortcut.
      else this.drag = { x: event.clientX, y: event.clientY };
    }, options);
    window.addEventListener("mouseup", () => { this.drag = null; }, options);
    window.addEventListener("mousemove", (event) => {
      if (this.inspectionProduct && this.drag) {
        const root = this.inspection[this.inspectionProduct];
        root.rotation.y += (event.clientX - this.drag.x) * .011;
        root.rotation.x = Math.max(-.75, Math.min(.75, root.rotation.x + (event.clientY - this.drag.y) * .006));
        this.drag = { x: event.clientX, y: event.clientY };
      } else if (this.active && (document.pointerLockElement === this.canvas || this.drag)) {
        const dx = this.drag ? event.clientX - this.drag.x : event.movementX;
        const dy = this.drag ? event.clientY - this.drag.y : event.movementY;
        this.camera.rotation.y += dx * .0023 * this.sensitivity;
        this.camera.rotation.x = Math.max(-1.15, Math.min(1.12, this.camera.rotation.x + dy * .0023 * this.sensitivity));
        if (this.drag) this.drag = { x: event.clientX, y: event.clientY };
      }
    }, options);
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault(), options);
  }

  private enableDragLook(): void {
    if (this.disposed) return;
    const previous = this.pointerAccess.mode;
    this.pointerAccess.rejected();
    this.callbacks.onPointerMode?.("drag");
    if (previous !== "drag") this.callbacks.onStatus("鼠标可直接点击界面；按住画面拖动视角，或用 I/J/K/L 转头，E 操作。");
  }

  requestPointerLock(): void {
    if (!this.active) return;
    const generation = ++this.pointerRequestGeneration;
    this.pointerAccess.requestLock();
    this.canvas.focus();
    if (!this.canvas.requestPointerLock) { this.enableDragLook(); return; }
    try {
      const request = this.canvas.requestPointerLock();
      if (request && typeof request.catch === "function") void request.catch(() => {
        if (generation === this.pointerRequestGeneration && this.active) this.enableDragLook();
      });
    } catch { this.enableDragLook(); }
  }

  setCursorFree(free: boolean): void {
    if (!free) { this.requestPointerLock(); return; }
    this.pointerRequestGeneration += 1;
    const locked = document.pointerLockElement === this.canvas;
    this.pointerAccess.releaseForUi(locked);
    this.drag = null;
    this.keys.clear();
    this.callbacks.onPointerMode?.(this.pointerAccess.mode);
    if (locked) document.exitPointerLock();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.keys.clear(); this.drag = null;
    this.scene.animationsEnabled = active;
    if (!active) this.setCursorFree(true);
    if (!active) this.callbacks.onTarget(null);
  }

  inspect(productId: ProductId | null): void {
    this.inspectionProduct = productId;
    for (const [id, root] of Object.entries(this.inspection)) {
      root.setEnabled(id === productId);
      if (id === productId) root.rotation.set(-.04, -.16, 0);
    }
    this.syncInventory();
  }

  private layoutInspection(): void {
    const wide = this.canvas.clientWidth >= 760;
    for (const id of ["milk", "bread"] as const) {
      const root = this.inspection[id];
      root.position.set(wide ? .115 : 0, wide ? (id === "milk" ? -.14 : -.06) : (id === "milk" ? .055 : .095), wide ? .64 : .74);
      root.scaling.setAll(wide ? (id === "milk" ? 1.4 : 1.12) : (id === "milk" ? 1.1 : .94));
    }
  }

  setSensitivity(value: number): void { this.sensitivity = Math.max(.25, Math.min(2, value)); }
  setReducedMotion(value: boolean): void { this.reducedMotion = value; }
  setQuality(value: Quality): void {
    this.engine.setHardwareScalingLevel(value === "low" ? 1.25 : 1 / Math.min(window.devicePixelRatio || 1, 1.5));
    this.shadow.filteringQuality = value === "low" ? ShadowGenerator.QUALITY_LOW : ShadowGenerator.QUALITY_MEDIUM;
    this.scene.shadowsEnabled = value !== "low";
  }
  getPose(): PlayerPose {
    return { x: this.camera.position.x, z: this.camera.position.z, yaw: this.camera.rotation.y, pitch: this.camera.rotation.x };
  }
  restorePose(pose: PlayerPose): void {
    this.camera.position.set(pose.x, EYE_HEIGHT, pose.z);
    this.camera.rotation.set(pose.pitch, pose.yaw, 0);
    this.ensureSafePose();
  }

  private ensureSafePose(): void {
    if (this.isFree(this.camera.position.x, this.camera.position.z)) return;
    // Older/corrupted positioning or a crate below the player must never trap a saved run.
    const origin = { x: this.camera.position.x, z: this.camera.position.z };
    for (let ring = .25; ring < 3; ring += .25) {
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
        const x = origin.x + Math.sin(angle) * ring;
        const z = origin.z + Math.cos(angle) * ring;
        if (this.isFree(x, z)) { this.camera.position.set(x, EYE_HEIGHT, z); return; }
      }
    }
    this.camera.position.set(0, EYE_HEIGHT, -3.5);
  }
  getNearestDrop(): Position | null {
    if (this.state.held.kind !== "crate") return null;
    const heldCrateId = this.state.held.crateId;
    const candidates = SAFE_DROP_POINTS.filter((point) => !this.state.crates.some((crate) => crate.id !== heldCrateId && Math.hypot(crate.position.x - point.x, crate.position.z - point.z) < .1))
      .map((point) => ({ point, distance: Math.hypot(point.x - this.camera.position.x, point.z - this.camera.position.z) }))
      .filter((entry) => entry.distance < 1.8 && entry.distance > .78).sort((a, b) => a.distance - b.distance);
    return candidates[0] ? { ...candidates[0].point } : null;
  }

  private isFree(x: number, z: number): boolean {
    const radius = .24;
    if (!isWalkablePosition({ x, z }, radius)) return false;
    for (const box of this.colliders) {
      if (x > box.minX - radius && x < box.maxX + radius && z > box.minZ - radius && z < box.maxZ + radius) return false;
    }
    for (const crate of this.state.crates) {
      if (this.state.held.kind === "crate" && this.state.held.crateId === crate.id) continue;
      const halfWidth = crate.productId === "milk" ? .23 : .35;
      if (Math.abs(x - crate.position.x) < halfWidth + radius && Math.abs(z - crate.position.z) < .20 + radius) return false;
    }
    if (this.street && this.truckPhase !== "away"
      && Math.abs(x - this.street.truck.position.x) < 2.45 + radius
      && Math.abs(z - this.street.truck.position.z) < .96 + radius) return false;
    return true;
  }

  private movePlayer(dt: number): void {
    const down = (...keys: string[]): number => keys.some((key) => this.keys.has(key)) ? 1 : 0;
    this.camera.rotation.y += (down("KeyL") - down("KeyJ")) * dt * 1.6;
    this.camera.rotation.x = Math.max(-1.15, Math.min(1.12, this.camera.rotation.x + (down("KeyK") - down("KeyI")) * dt * 1.25));
    const forward = down("KeyW", "ArrowUp") - down("KeyS", "ArrowDown");
    const side = down("KeyD", "ArrowRight") - down("KeyA", "ArrowLeft");
    if (!forward && !side) return;
    const length = Math.hypot(forward, side);
    const speed = this.state.held.kind === "crate" ? 1.45 : 1.85;
    const yaw = this.camera.rotation.y;
    const dx = (Math.sin(yaw) * forward + Math.cos(yaw) * side) / length * speed * dt;
    const dz = (Math.cos(yaw) * forward - Math.sin(yaw) * side) / length * speed * dt;
    if (this.isFree(this.camera.position.x + dx, this.camera.position.z)) this.camera.position.x += dx;
    if (this.isFree(this.camera.position.x, this.camera.position.z + dz)) this.camera.position.z += dz;
  }

  private decorateTarget(data: TargetData, distance: number): InteractionTarget {
    const product = data.productId ? PRODUCTS[data.productId] : null;
    let label = "";
    let action = "";
    let inspectable = !!product;
    if (data.kind === "crate") {
      const remaining = this.state.items.filter((item) => item.location.kind === "crate" && item.location.crateId === data.crateId).length;
      label = `${product?.nameEn} · ${product?.nameZh}货箱 · ${remaining} 件`;
      action = this.state.held.kind === "none" ? "抱起货箱" : "先放下手里的货物";
      inspectable = remaining > 0;
    } else if (data.kind === "shelf") {
      label = data.productId === "milk" ? "Milk · 冷藏区" : "Bread · 面包架";
      action = this.state.held.kind === "none" ? "先抱起对应货箱" : `摆放一${data.productId === "milk" ? "盒牛奶" : "袋面包"}`;
      inspectable = !!data.productId && countAt(this.state, data.productId, "shelf") > 0;
    } else if (data.kind === "item") {
      const item = this.state.items.find((entry) => entry.id === data.itemId);
      label = `${product?.nameEn} · ${product?.nameZh}`;
      if (item?.location.kind === "checkout") {
        const scanned = this.state.scannedIds.includes(item.id);
        action = scanned ? "已扫描，不会重复计费" : "扫描商品";
        inspectable = false;
      } else if (this.state.held.kind !== "none" && item?.location.kind === "shelf") {
        return this.decorateTarget({ id: `${item.productId}-shelf`, kind: "shelf", productId: item.productId }, distance);
      } else action = "拿起商品";
    } else if (data.kind === "counter") {
      label = "Checkout · 收银台";
      if (this.state.customer.phase !== "checkout") action = "等待顾客带商品结账";
      else action = this.state.scannedIds.length < 2 ? "扫描下一件商品" : "刷卡收款 · £4.00";
      inspectable = false;
    } else if (data.kind === "open-sign") {
      label = "Open / Closed · 营业牌";
      action = this.state.day.phase === "settled" ? "查看日结 / 开始下一天" : canSettleDay(this.state) ? "结束营业并查看账目" : getDaySummary(this.state).paidCustomers >= this.state.day.targetCustomers ? "查看日结前的收尾事项" : this.state.customer.phase === "outside" ? "开门营业" : this.state.customer.phase === "complete" ? "接待下一位顾客" : "正在营业";
      inspectable = false;
    } else if (data.kind === "delivery") {
      const delivery = getDeliverySummary(this.state);
      label = `Daily delivery · 第 ${this.state.day.number} 天送货车`;
      action = delivery.pendingUnits > 0 ? delivery.canReceive ? `签收 ${delivery.pendingUnits} 件货物` : delivery.reason ?? "请先腾出收货空间" : "查看今日进货单";
      inspectable = false;
    } else if (data.kind === "venue") {
      const venue = STREET_VENUES.find((entry) => entry.id === data.venueId);
      label = venue ? `${venue.nameEn} · ${venue.nameZh}` : "High Street · 商业街";
      action = data.venueId ? `${getVenueProgress(this.state, data.venueId).statusText} · 查看条件` : "查看开放条件";
      inspectable = false;
    } else {
      label = "Delivery · 安全卸货点";
      action = this.state.held.kind === "crate" ? "放下货箱" : "搬货箱到这里放稳";
      inspectable = false;
    }
    return { ...data, distance, label, action, inspectable };
  }

  private updateTarget(): void {
    if (!this.active) return;
    const ray = this.camera.getForwardRay(INTERACTION_RANGE);
    const hit = this.scene.pickWithRay(ray, (mesh) => mesh.isPickable && mesh.isVisible && mesh.isEnabled() && mesh.renderingGroupId !== 2);
    if (this.targetMesh && this.targetMesh instanceof Mesh) this.targetMesh.renderOutline = false;
    this.targetMesh = null;
    const data = hit?.pickedMesh?.metadata?.interaction as TargetData | undefined;
    if (hit?.hit && hit.distance <= INTERACTION_RANGE && data && (data.kind !== "delivery" || this.truckPhase === "parked")) {
      const target = this.decorateTarget(data, hit.distance);
      this.targetMesh = hit.pickedMesh;
      if (hit.pickedMesh instanceof Mesh) {
        hit.pickedMesh.renderOutline = true;
        hit.pickedMesh.outlineWidth = data.kind === "item" ? .003 : .009;
        hit.pickedMesh.outlineColor = new Color3(.95, .73, .30);
      }
      this.callbacks.onTarget(target);
    } else this.callbacks.onTarget(null);
  }

  private updateGuide(): void {
    const state = this.state;
    const delivery = getDeliverySummary(state);
    let point: Position;
    let title: string;
    if (state.day.phase === "settled" || canSettleDay(state)) {
      this.callbacks.onGuide?.(state.day.phase === "settled" ? "今日已日结 · 点“营业 / 日结”开始下一天" : "三单已完成 · 点“营业 / 日结”查看今天的收支");
      return;
    }
    if (state.customer.phase === "checkout" || state.customer.phase === "to-checkout") {
      point = { x: -2.2, z: -1.0 }; title = "收银台内侧";
    } else if (state.held.kind === "crate") {
      const crate = state.crates.find((entry) => state.held.kind === "crate" && entry.id === state.held.crateId)!;
      if (!state.items.some((item) => item.location.kind === "crate" && item.location.crateId === crate.id)) {
        point = this.getNearestDrop() ?? SAFE_DROP_POINTS[2]!; title = "安全落箱点 · 按 G";
      } else {
        point = crate.productId === "milk" ? { x: 0, z: 3.6 } : { x: 2.65, z: .3 };
        title = crate.productId === "milk" ? "Milk 牛奶冰柜" : "Bread 面包架";
      }
    } else if (delivery.pendingUnits > 0) {
      if (this.truckPhase === "arriving") {
        this.callbacks.onGuide?.(`送货车正在靠边 · ${delivery.pendingUnits} 件货待签收 · 请留出车道`);
        return;
      }
      point = { x: this.street.truck.position.x, z: this.street.truck.position.z + 1 };
      title = `门口送货车 · 按 E 签收 ${delivery.pendingUnits} 件`;
    } else if (state.customer.phase === "outside" || state.customer.phase === "complete") {
      const productId = (["milk", "bread"] as ProductId[]).find((id) => countAt(state, id, "shelf") === 0);
      if (productId) {
        if (!state.items.some((item) => item.productId === productId && item.location.kind !== "sold")) {
          this.callbacks.onGuide?.("按 B 进货 · 每份牛奶与面包 £2.30");
          return;
        }
        point = state.crates.find((crate) => crate.productId === productId)!.position;
        title = `${PRODUCTS[productId].nameZh}货箱 · 向下看`;
      } else if (state.day.phase === "open") {
        this.callbacks.onGuide?.("货架已备好 · 下一位顾客即将进店");
        return;
      } else { point = { x: .65, z: -4.48 }; title = "门口营业牌"; }
    } else {
      point = { x: this.customer.position.x, z: this.customer.position.z };
      title = "顾客正在购物 · 留出通道";
    }
    const dx = point.x - this.camera.position.x;
    const dz = point.z - this.camera.position.z;
    const angle = Math.atan2(Math.sin(Math.atan2(dx, dz) - this.camera.rotation.y), Math.cos(Math.atan2(dx, dz) - this.camera.rotation.y));
    const direction = Math.abs(angle) > 2.6 ? "回头" : angle > .28 ? "向右 →" : angle < -.28 ? "← 向左" : "前方 ↑";
    this.callbacks.onGuide?.(`${direction}  ${title}  ·  ${Math.hypot(dx, dz).toFixed(1)} m`);
  }

  private render(): void {
    if (this.disposed || this.canvasWasLost) return;
    const dt = Math.min(.05, this.engine.getDeltaTime() / 1000);
    this.frameClock += dt;
    this.viewClock += dt;
    this.poseClock += dt;
    if (this.active) {
      this.movePlayer(dt);
      this.updateTruck(dt);
      this.updateCustomer(dt);
      if (!this.reducedMotion && this.state.held.kind === "crate") {
        const root = this.crates.get(this.state.held.crateId)!;
        root.position.y = -.39 + (this.keys.size > 0 ? Math.sin(this.frameClock * 8) * .008 : 0);
      }
    }
    if (this.viewClock >= .1) {
      this.viewClock = 0;
      this.updateTarget();
      if (this.active) this.updateGuide();
    }
    if (this.poseClock >= 1) {
      this.poseClock = 0;
      this.callbacks.onFrame?.(Math.round(this.engine.getFps()), this.getPose());
    }
    this.scene.render();
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.lifetime.abort();
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
