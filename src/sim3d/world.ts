import {
  AbstractMesh, Color3, Color4, DirectionalLight, Engine,
  HemisphericLight, ImageProcessingConfiguration, Mesh, MeshBuilder, PBRMaterial,
  PointLight, Scene, ShadowGenerator, TransformNode, UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import { CustomerActors } from "./customerActors";
import { CUSTOMER_EXIT_STOP_SECONDS, CUSTOMER_STOP_SECONDS, CUSTOMER_WALK_SPEED } from "./customerSelection";
import { PointerAccess, type PointerMode } from "./pointerAccess";
import { playerMovementSpeed } from "./playerMovement";
import { createCrate, createPlayerHands, createShop, setCheckoutDisplay, setShelfCapacity, setShopSignState } from "./assets";
import { createCatalogFixtures, createReceivingPads } from "./productFixtures";
import { basketPlacement, checkoutPlacement, crateDimensions, cratePlacement, findCustomerRoute, fitProduct, PRODUCT_DISPLAYS } from "./productLayout";
import { crateRestingHeight, measureCrateSupport, ProductVisuals, productDimensions, type CrateSupport } from "./productPresentation";
import { createStreet, setDeliveryTruckStatus, setStreetVenueStatus, type StreetEnvironment } from "./street";
import { createRecyclingStation, RECYCLING_POINT } from "./recyclingStation";
import { STREET_VENUES, getVenueProgress, type VenueId } from "./progression";
import {
  countAt, canSettleDay, canStartCustomer, getCheckoutTotal, getCustomerOrder, getShoppingProduct, getDaySummary, getDeliverySummary, getRecyclingOffer, getRecyclingSummary, isWalkablePosition, PRODUCTS, PRODUCT_IDS, SAFE_DROP_POINTS, type CrateId, type CustomerPhase,
  type PlayerPose, type Position, type ProductId, type SimState,
} from "./domain";

export type Quality = "standard" | "low";
export interface InteractionTarget {
  id: string;
  kind: "crate" | "shelf" | "item" | "counter" | "open-sign" | "drop-zone" | "delivery" | "venue" | "recycling";
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
  "ShiftLeft", "ShiftRight",
]);

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
  private readonly productVisuals: ProductVisuals;
  private readonly occupiedCrates = new Set<CrateId>();
  private readonly crateSupports: CrateSupport[] = [];
  private readonly shelfSlots: Record<ProductId, Vector3[]>;
  private readonly hands: TransformNode;
  private readonly customer: TransformNode;
  private readonly customerActors: CustomerActors;
  private readonly basket: TransformNode;
  private readonly inspection = new Map<ProductId, TransformNode>();
  private customerPhase: CustomerPhase;
  private route: Position[] = [];
  private routeIndex = 0;
  private arrivalDelay = 0;
  private arrivedRevision = -1;
  private customerRouteBlocked = false;
  private customerObstacleSignature = "";
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
    this.productVisuals = new ProductVisuals(this.scene);
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

    const shop = createShop(this.scene, { catalogFixtures: true });
    this.colliders.push(...shop.colliders);
    const fixtures = createCatalogFixtures(this.scene, PRODUCTS);
    this.colliders.push(...fixtures.colliders);
    this.street = createStreet(this.scene);
    this.colliders.push(...this.street.colliders);
    const recycling = createRecyclingStation(this.scene);
    this.colliders.push(recycling.collider);
    this.tag(recycling.root, { id: "cardboard-recycling", kind: "recycling", position: { ...RECYCLING_POINT } });
    for (const target of this.street.targets) {
      this.tag(target.mesh, {
        id: target.id, kind: target.kind,
        ...(target.venueId ? { venueId: target.venueId } : {}),
        position: { x: target.position.x, z: target.position.z },
      });
      if (target.kind === "drop-zone") this.crateSupports.push(measureCrateSupport(target.position, target.mesh));
    }
    // A delivery is physical interaction with the stopped vehicle, not an invisible trigger.
    this.tag(this.street.truck, { id: "daily-delivery", kind: "delivery" });
    this.resetTruck(initialState.day.phase === "settled" ? "away" : initialState.purchases.length > 0 || initialState.day.phase === "open" ? "parked" : "arriving");
    this.shelfSlots = Object.fromEntries(PRODUCT_IDS.map((id) => [id, PRODUCT_DISPLAYS[id].slots.map((point) => new Vector3(point.x, point.y, point.z))])) as Record<ProductId, Vector3[]>;
    for (const target of [...shop.targets, ...fixtures.targets, ...createReceivingPads(this.scene, SAFE_DROP_POINTS)]) {
      this.tag(target.mesh, {
        id: target.id, kind: target.kind,
        ...("productId" in target && target.productId ? { productId: target.productId } : {}),
        position: { x: target.position.x, z: target.position.z },
      });
      if (target.kind === "drop-zone") this.crateSupports.push(measureCrateSupport(target.position, target.mesh));
    }
    this.hands = createPlayerHands(this.scene);
    this.hands.parent = this.camera;
    this.hands.position.set(0, -.39, .80);
    this.hands.setEnabled(false);
    this.setViewModel(this.hands, true);
    this.customer = new TransformNode("customer-path-root", this.scene);
    this.customerActors = new CustomerActors(this.scene, this.shadow, this.customer);
    this.basket = this.createBasket();
    this.basket.parent = this.customer;
    this.basket.position.set(.34, .47, .04);
    this.customerPhase = initialState.customer.phase;
    this.syncInventory();
    this.setCustomerRoute(true);
    this.syncStreet();
    this.ensureSafePose();
    for (const mesh of this.scene.meshes) {
      if (mesh.renderingGroupId === 2 || !mesh.isEnabled()) continue;
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
    await this.customerActors.init(this.state);
    if (this.disposed) return;
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
    const newCustomer = this.state.customer.number !== state.customer.number;
    const newDay = this.state.day.number !== state.day.number;
    const freshRun = state.revision < this.state.revision && state.purchases.length === 0 && state.transactions.length === 0;
    const closed = this.state.day.phase !== "settled" && state.day.phase === "settled";
    this.state = state;
    this.customerActors.select(state);
    if (newDay || freshRun) this.resetTruck(state.day.phase === "settled" ? "away" : "arriving");
    else if (closed && this.truckPhase !== "away") this.truckPhase = "departing";
    this.syncInventory();
    const obstacles = this.crateObstacleSignature();
    if (phaseChanged || newCustomer || freshRun || obstacles !== this.customerObstacleSignature) this.setCustomerRoute(freshRun || newCustomer);
    this.syncStreet();
    this.ensureSafePose();
    this.updateTarget();
  }

  private syncInventory(): void {
    const state = this.state;
    // Old transactions can contain thousands of sold items. They never create scene models.
    const activeItems = state.items.filter((item) => item.location.kind !== "sold" && item.location.kind !== "delivery");
    const visibleIds = new Set(activeItems.map((item) => item.id));
    const crateContents = new Map<CrateId, typeof activeItems>();
    const basketItems = activeItems.filter((item) => item.location.kind === "basket");
    const checkoutItems = activeItems.filter((item) => item.location.kind === "checkout");
    // Keep used empty boxes available after dropping or reloading; opening placeholders stay hidden.
    const receivedProducts = new Set<ProductId>();
    for (const item of state.items) if (item.location.kind !== "delivery") receivedProducts.add(item.productId);
    this.occupiedCrates.clear();
    for (const item of activeItems) if (item.location.kind === "crate") {
      const siblings = crateContents.get(item.location.crateId) ?? [];
      siblings.push(item); crateContents.set(item.location.crateId, siblings);
      this.occupiedCrates.add(item.location.crateId);
    }
    for (const [id, root] of this.products) {
      if (visibleIds.has(id)) { root.parent = null; continue; }
      for (const mesh of root.getChildMeshes()) this.shadow.removeShadowCaster(mesh, false);
      root.dispose(false, false);
      this.products.delete(id);
    }
    const crateIds = new Set(state.crates.map((crate) => crate.id));
    for (const [id, root] of this.crates) if (!crateIds.has(id)) {
      for (const mesh of root.getChildMeshes()) this.shadow.removeShadowCaster(mesh, false);
      root.dispose(false, false); this.crates.delete(id);
    }
    for (const crate of state.crates) {
      const held = state.held.kind === "crate" && state.held.crateId === crate.id;
      const visible = receivedProducts.has(crate.productId) || held;
      let root = this.crates.get(crate.id);
      if (!root && !visible) continue;
      if (!root) {
        root = createCrate(this.scene, crate.productId, crate.id);
        this.crates.set(crate.id, root);
        for (const mesh of root.getChildMeshes()) if (mesh.getTotalVertices() > 12) this.shadow.addShadowCaster(mesh, false);
      }
      root.parent = held ? this.camera : null;
      root.position.set(held ? 0 : crate.position.x, held ? -.39 : crateRestingHeight(crate.position, this.crateSupports), held ? .80 : crate.position.z);
      root.rotation.set(0, 0, 0);
      root.setEnabled(visible && (!held || !this.inspectionProduct));
      this.setViewModel(root, held);
      this.tag(root, { id: crate.id, kind: "crate", crateId: crate.id, productId: crate.productId });
    }
    for (const item of activeItems) {
      let root = this.products.get(item.id);
      if (!root) {
        root = this.productVisuals.create(item.productId, item.id);
        this.products.set(item.id, root);
        for (const mesh of root.getChildMeshes()) {
          mesh.receiveShadows = true;
          if (mesh.getTotalVertices() > 12 && !/glass|label|letter/i.test(mesh.name)) this.shadow.addShadowCaster(mesh, false);
        }
      }
      const dimensions = productDimensions(root);
      const location = item.location;
      root.parent = null;
      root.rotation.set(0, 0, 0);
      root.scaling.setAll(1);
      root.setEnabled(true);
      this.setViewModel(root, false);
      this.tag(root, { id: item.id, kind: "item", itemId: item.id, productId: item.productId });
      if (location.kind === "crate") {
        const crate = this.crates.get(location.crateId)!;
        const siblings = crateContents.get(location.crateId)!;
        const index = siblings.findIndex((entry) => entry.id === item.id);
        const layout = cratePlacement(item.productId, dimensions, index);
        root.parent = crate;
        root.position.set(layout.position.x, layout.position.y, layout.position.z);
        root.scaling.setAll(layout.scale);
        const isHeld = state.held.kind === "crate" && state.held.crateId === location.crateId;
        this.setViewModel(root, isHeld);
        this.tag(root, { id: location.crateId, kind: "crate", crateId: location.crateId, productId: item.productId });
      } else if (location.kind === "hand") {
        root.parent = this.camera;
        root.position.set(.20, -.37, .53);
        root.rotation.y = -.22;
        root.scaling.setAll(fitProduct(dimensions, { width: .30, height: .34, depth: .30 }));
        root.setEnabled(!this.inspectionProduct);
        this.setViewModel(root, true);
      } else if (location.kind === "shelf") {
        root.position.copyFrom(this.shelfSlots[item.productId][location.slot]!);
        const layout = PRODUCT_DISPLAYS[item.productId];
        root.rotation.y = layout.yaw;
        root.scaling.setAll(fitProduct(dimensions, layout.maxSize));
      } else if (location.kind === "basket") {
        const layout = basketPlacement(dimensions, basketItems.findIndex((entry) => entry.id === item.id), basketItems.length);
        root.parent = this.basket;
        root.position.set(layout.position.x, layout.position.y, layout.position.z);
        root.scaling.setAll(layout.scale);
        root.rotation.y = layout.yaw;
        // Goods in an NPC's basket are not a free source for the player's inventory.
        for (const mesh of root.getChildMeshes()) mesh.isPickable = false;
      } else if (location.kind === "checkout") {
        const scanned = state.scannedIds.includes(item.id);
        const order = getCustomerOrder(state);
        const index = Math.max(0, order.length ? order.indexOf(item.productId) : checkoutItems.findIndex((entry) => entry.id === item.id));
        const layout = checkoutPlacement(dimensions, index, scanned);
        root.position.set(layout.position.x, layout.position.y, layout.position.z);
        root.scaling.setAll(layout.scale); root.rotation.y = layout.yaw;
      }
    }
    this.hands.setEnabled(state.held.kind === "crate" && !this.inspectionProduct);
    const heldProduct = state.held.kind === "crate" ? state.crates.find((crate) => state.held.kind === "crate" && crate.id === state.held.crateId)?.productId : null;
    this.hands.scaling.x = heldProduct ? crateDimensions(heldProduct).width / .46 : 1;
    this.hands.scaling.z = heldProduct ? crateDimensions(heldProduct).depth / .36 : 1;
    const transaction = state.transactions.find((sale) => sale.customerNumber === state.customer.number);
    const paid = !!transaction && (state.customer.phase === "leaving" || state.customer.phase === "complete");
    setShopSignState(this.scene, state.day.phase === "open");
    setCheckoutDisplay(this.scene, {
      scanned: paid ? transaction.itemIds.length : state.scannedIds.length,
      totalPence: paid ? transaction.amountPence : state.items.filter((item) => state.scannedIds.includes(item.id)).reduce((total, item) => total + PRODUCTS[item.productId].pricePence, 0),
      paid,
      itemCount: paid ? transaction.itemIds.length : getCustomerOrder(state).length,
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
    const order = getCustomerOrder(this.state);
    const freshCustomer = phase === "to-milk" && this.customerPhase !== "to-milk";
    if (initial || freshCustomer) {
      const first = order[0] ? PRODUCT_DISPLAYS[order[0]].approach : { x: 0, z: 2.72 };
      const lastProduct = order.at(-1);
      const last = lastProduct ? PRODUCT_DISPLAYS[lastProduct].approach : first;
      const start = phase === "to-milk" ? { x: 0, z: -4.35 }
        : phase === "to-bread" ? first : phase === "to-checkout" ? last
          : phase === "checkout" || phase === "leaving" ? { x: -.94, z: -2.15 } : { x: 0, z: -5.3 };
      this.customer.position.set(start.x, 0, start.z);
    }
    this.customerPhase = phase;
    this.customer.setEnabled(phase !== "outside" && phase !== "complete");
    const product = getShoppingProduct(this.state);
    const destination = product ? PRODUCT_DISPLAYS[product].approach
      : phase === "to-checkout" ? { x: -.94, z: -2.15 }
        : phase === "leaving" ? { x: 0, z: -5.3 } : null;
    const obstacles = this.customerColliders();
    const route = destination ? findCustomerRoute({ x: this.customer.position.x, z: this.customer.position.z }, destination, obstacles) : [];
    this.customerRouteBlocked = route === null;
    this.route = route ?? [];
    this.customerObstacleSignature = this.crateObstacleSignature();
    if (this.customerRouteBlocked) this.callbacks.onStatus("顾客通道被货箱挡住了。先把箱子搬到安全卸货点，顾客会继续前往对应货架。");
    this.routeIndex = 0;
    this.arrivalDelay = 0;
    this.arrivedRevision = -1;
    if (phase === "checkout") this.customer.rotation.y = -Math.PI / 2;
  }

  private crateObstacleSignature(): string {
    return this.state.crates.filter((crate) => this.occupiedCrates.has(crate.id) && !(this.state.held.kind === "crate" && this.state.held.crateId === crate.id))
      .map((crate) => `${crate.id}:${crate.position.x}:${crate.position.z}`).join("|");
  }

  private customerColliders(): Collider[] {
    const boxes = [...this.colliders];
    for (const crate of this.state.crates) {
      if (!this.occupiedCrates.has(crate.id) || this.state.held.kind === "crate" && this.state.held.crateId === crate.id) continue;
      const size = crateDimensions(crate.productId);
      boxes.push({ minX: crate.position.x - size.width / 2, maxX: crate.position.x + size.width / 2, minZ: crate.position.z - size.depth / 2, maxZ: crate.position.z + size.depth / 2 });
    }
    return boxes;
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
    this.customerActors.play(walking);
  }

  private updateCustomer(dt: number): void {
    if (!this.active || !this.customer.isEnabled()) return;
    if (this.customerRouteBlocked) { this.playCustomerAnimation(false); return; }
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
        const step = Math.min(distance, dt * CUSTOMER_WALK_SPEED);
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
    const shoppingProduct = getShoppingProduct(this.state);
    if (shoppingProduct) {
      const shelf = PRODUCT_DISPLAYS[shoppingProduct].slots[0]!;
      this.customer.rotation.y = Math.atan2(shelf.x - this.customer.position.x, shelf.z - this.customer.position.z);
    }
    if (this.customerPhase === "checkout" || this.customerPhase === "to-checkout") this.customer.rotation.y = -Math.PI / 2;
    if (["to-milk", "to-bread", "to-checkout", "leaving"].includes(this.customerPhase)) {
      this.arrivalDelay += dt;
      const stopSeconds = this.customerPhase === "leaving" ? CUSTOMER_EXIT_STOP_SECONDS : CUSTOMER_STOP_SECONDS;
      if (this.arrivalDelay >= stopSeconds && this.arrivedRevision !== this.state.revision) {
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
        // After a pause/Tab release, a fresh direction can still use a Shift
        // that is physically held; never restore a direction automatically.
        if (!event.shiftKey) this.keys.delete("Shift");
        else if (!this.keys.has("ShiftLeft") && !this.keys.has("ShiftRight")) this.keys.add("Shift");
        // A short key tap has a real, small movement; holding continues smoothly by frame time.
        // A modifier changes speed only: pressing Shift must not add an extra step.
        if (event.code !== "ShiftLeft" && event.code !== "ShiftRight") this.movePlayer(.045);
      }
    }, options);
    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
      if (!event.shiftKey) this.keys.delete("Shift");
      else if (this.active && !this.keys.has("ShiftLeft") && !this.keys.has("ShiftRight")) this.keys.add("Shift");
    }, options);
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
        const root = this.inspection.get(this.inspectionProduct)!;
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
    if (productId && !this.inspection.has(productId)) {
      const visual = this.productVisuals.create(productId, `inspect-${productId}-visual`);
      const dimensions = productDimensions(visual);
      const pivot = new TransformNode(`inspect-${productId}`, this.scene);
      pivot.parent = this.camera;
      pivot.metadata = { dimensions, productId };
      visual.parent = pivot; visual.position.y = -dimensions.height / 2;
      this.setViewModel(pivot, true);
      this.inspection.set(productId, pivot);
      this.layoutInspection();
    }
    for (const [id, root] of this.inspection) {
      root.setEnabled(id === productId);
      if (id === productId) root.rotation.set(-.04, -.16, 0);
    }
    this.syncInventory();
  }

  private layoutInspection(): void {
    const wide = this.canvas.clientWidth >= 760;
    for (const root of this.inspection.values()) {
      const dimensions = productDimensions(root);
      root.position.set(wide ? .115 : 0, wide ? .015 : .115, wide ? .64 : .74);
      root.scaling.setAll(fitProduct(dimensions, { width: wide ? .35 : .31, height: wide ? .35 : .30, depth: .30 }, 5));
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
    // Empty boxes remain pickable and reserve their bay, but do not block walking.
    for (const crate of this.state.crates) {
      if (!this.occupiedCrates.has(crate.id)) continue;
      if (this.state.held.kind === "crate" && this.state.held.crateId === crate.id) continue;
      const size = crateDimensions(crate.productId);
      if (Math.abs(x - crate.position.x) < size.width / 2 + radius && Math.abs(z - crate.position.z) < size.depth / 2 + radius) return false;
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
    const speed = playerMovementSpeed(this.keys, this.state.held.kind === "crate");
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
      label = remaining ? `${product?.nameEn} · ${product?.nameZh}货箱 · ${remaining} 件` : `Empty box · ${product?.nameZh}空箱 · 可回收`;
      action = this.state.held.kind === "none" ? remaining ? "抱起货箱" : "抱起空箱 · 送往回收点" : "先放下手里的货物";
      inspectable = remaining > 0;
    } else if (data.kind === "shelf") {
      label = data.productId ? `${product?.nameEn} · ${PRODUCT_DISPLAYS[data.productId].shelfName}` : "商品货架";
      action = this.state.held.kind === "none" ? "先抱起对应货箱" : `摆放一件${product?.nameZh ?? "商品"}`;
      if (getRecyclingOffer(this.state).allowed) action = "货箱已空 · 送往门旁绿色回收点";
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
      else action = this.state.scannedIds.length < getCustomerOrder(this.state).length ? "扫描下一件商品"
        : `${this.state.payment?.method === "cash" ? this.state.payment.received ? "现金 · 继续找零" : "现金收款" : "刷卡收款"} · £${(getCheckoutTotal(this.state) / 100).toFixed(2)}`;
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
    } else if (data.kind === "recycling") {
      const offer = getRecyclingOffer(this.state);
      const summary = getRecyclingSummary(this.state);
      label = `Cardboard recycling · 空箱回收 · 今日 ${summary.recycledToday} 箱`;
      action = offer.allowed ? offer.rewardPence > 0 ? `回收空箱 +£${(offer.rewardPence / 100).toFixed(2)}` : "回收空箱 · 无新奖励"
        : this.state.held.kind === "none" ? "抱起空箱后按 E 回收 · 不限量" : offer.reason ?? "请先把箱内商品全部上架";
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
    const recycling = getRecyclingOffer(state);
    let point: Position;
    let title: string;
    if (recycling.allowed) {
      point = RECYCLING_POINT;
      title = recycling.rewardPence > 0 ? `空箱回收点 · 按 E +£${(recycling.rewardPence / 100).toFixed(2)}` : "空箱回收点 · 按 E 清走";
    } else if (state.day.phase === "settled" || canSettleDay(state)) {
      this.callbacks.onGuide?.(state.day.phase === "settled" ? "今日已日结 · 点“营业 / 日结”开始下一天" : "三单已完成 · 点“营业 / 日结”查看今天的收支");
      return;
    } else if (state.customer.phase === "checkout" || state.customer.phase === "to-checkout") {
      point = { x: -2.2, z: -1.0 }; title = "收银台内侧";
    } else if (state.held.kind === "crate") {
      const crate = state.crates.find((entry) => state.held.kind === "crate" && entry.id === state.held.crateId)!;
      point = PRODUCT_DISPLAYS[crate.productId].approach;
      title = `${PRODUCTS[crate.productId].nameEn} · ${PRODUCT_DISPLAYS[crate.productId].shelfName}`;
    } else if (delivery.pendingUnits > 0) {
      if (this.truckPhase === "arriving") {
        this.callbacks.onGuide?.(`送货车正在靠边 · ${delivery.pendingUnits} 件货待签收 · 请留出车道`);
        return;
      }
      point = { x: this.street.truck.position.x, z: this.street.truck.position.z + 1 };
      title = `门口送货车 · 按 E 签收 ${delivery.pendingUnits} 件`;
    } else if (state.customer.phase === "outside" || state.customer.phase === "complete") {
      const productId = PRODUCT_IDS.find((id) => countAt(state, id, "crate") > 0 && countAt(state, id, "shelf") === 0);
      if (productId) {
        point = state.crates.find((crate) => crate.productId === productId)!.position;
        title = `${PRODUCTS[productId].nameZh}货箱 · 向下看`;
      } else if (!canStartCustomer(state)) {
        this.callbacks.onGuide?.("按 B 选择商品进货 · 签收后至少上架一种商品，再开门接客");
        return;
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
    const frameSeconds = Math.min(.25, Math.max(0, this.engine.getDeltaTime() / 1000));
    const dt = Math.min(.05, frameSeconds);
    this.frameClock += dt;
    this.viewClock += dt;
    this.poseClock += frameSeconds;
    if (this.active) {
      // Retain real-time player speed at low FPS, checking collisions at each
      // small step so sprinting cannot jump through counters, walls or crates.
      const playerSteps = Math.ceil(frameSeconds / .05);
      for (let step = 0; step < playerSteps; step += 1) this.movePlayer(frameSeconds / playerSteps);
      this.updateTruck(dt);
      // Keep NPC metres/second at low FPS, with bounded steps for route changes
      // and player clearance. A stalled/background frame cannot skip the shop.
      const customerSteps = Math.ceil(frameSeconds / .05);
      for (let step = 0; step < customerSteps; step += 1) this.updateCustomer(frameSeconds / customerSteps);
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
    if (this.poseClock >= .1) {
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
    this.customerActors.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
