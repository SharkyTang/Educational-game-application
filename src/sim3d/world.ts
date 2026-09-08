import {
  AbstractMesh, Color3, Color4, DirectionalLight, Engine,
  HemisphericLight, ImageProcessingConfiguration, Mesh, MeshBuilder, PBRMaterial,
  PointLight, Scene, ShadowGenerator, TransformNode, UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import { CustomerActors } from "./customerActors";
import { StreetNeighbourActors } from "./streetNeighbourActors";
import { STREET_NEIGHBOUR_PROFILES, type StreetNeighbourId } from "./streetNeighbourContent";
import { CUSTOMER_EXIT_STOP_SECONDS, CUSTOMER_STOP_SECONDS, CUSTOMER_WALK_SPEED, CUSTOMER_STREET_WALK_SPEED } from "./customerSelection";
import { deliveryTruckX, DELIVERY_PREPARE_MS, DELIVERY_ARRIVE_MS, DELIVERY_DEPART_MS } from "./delivery";
import { createWorkstation } from "./workstationAsset";
import { WORKSTATION_ID, workstationServicePoint } from "./workstation";
import { CUSTOMER_DOORSTEP, customerArrivalOrigins, customerJourneyRoute } from "./customerJourney";
import { PointerAccess, type PointerMode } from "./pointerAccess";
import { playerMovementSpeed } from "./playerMovement";
import { createCrate, createPlayerHands, createShop, setCheckoutDisplay, setShelfCapacity, setShopSignState, type ShopEnvironment } from "./assets";
import { createCatalogFixtures, createReceivingPads, type CatalogFixtures } from "./productFixtures";
import { basketPlacement, checkoutPlacement, crateDimensions, cratePlacement, fitProduct, PRODUCT_DISPLAYS, type ProductDisplay } from "./productLayout";
import { CHECKOUT_CLERK_POINT, CHECKOUT_CUSTOMER_POINT, furnitureForProduct, layoutEquals, transformLayoutPoint, type ShopLayout } from "./shopLayout";
import { crateRestingHeight, measureCrateSupport, ProductVisuals, productDimensions, type CrateSupport } from "./productPresentation";
import { createStreet, setDeliveryTruckStatus, setStreetVenueStatus, type StreetEnvironment } from "./street";
import { createRecyclingStation, RECYCLING_POINT } from "./recyclingStation";
import { STREET_VENUES, getVenueProgress, type VenueId } from "./progression";
import { EQUIPMENT_COMMERCE_CATALOG } from "./equipmentCommerce";
import { createEquipmentSceneFixtures, type EquipmentSceneFixtures } from "./equipmentScene";
import { findFirstEmptyShelfSlot, shelfSlotKey, type ShelfStockLocation } from "./equipmentStock";
import {
  countAt, countOnShelf, canSettleDay, canStartCustomer, getCheckoutTotal, getCustomerOrder, getShoppingProduct, getShoppingShelfLocation, getDeliverySummary, getRecyclingOffer, getRecyclingSummary, isWalkablePosition, shelfCapacityAt, PRODUCTS, PRODUCT_IDS, SAFE_DROP_POINTS, type CrateId, type CustomerPhase,
  type PlayerPose, type Position, type ProductId, type SimState,
} from "./domain";

export type Quality = "standard" | "low";
export interface InteractionTarget {
  id: string;
  kind: "crate" | "shelf" | "item" | "counter" | "open-sign" | "drop-zone" | "delivery" | "venue" | "recycling" | "street-neighbour" | "computer";
  productId?: ProductId;
  /** Present for a purchased fixture; absent for the original built-in display. */
  equipmentId?: string;
  itemId?: string;
  crateId?: CrateId;
  venueId?: VenueId;
  streetNeighbourId?: StreetNeighbourId;
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
  /** Presentation only: crossing the doorway does not collect any stock. */
  onCustomerEnter?: () => void;
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
export const STOCK_HOLD_DELAY_MS = 400;
export const STOCK_HOLD_INTERVAL_MS = 180;
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
  private readonly shop: ShopEnvironment;
  private readonly catalogFixtures: CatalogFixtures;
  private readonly equipmentFixtures: EquipmentSceneFixtures;
  private readonly workstation: ReturnType<typeof createWorkstation>;
  private readonly expansionLight: PointLight;
  private readonly secondExpansionLight: PointLight;
  private readonly fixedColliders: Collider[] = [];
  private truckPhase: "arriving" | "parked" | "departing" | "away" = "arriving";
  private state: SimState;
  private readonly colliders: Collider[] = [];
  private readonly crates = new Map<CrateId, TransformNode>();
  private readonly products = new Map<string, TransformNode>();
  private readonly productVisuals: ProductVisuals;
  private readonly occupiedCrates = new Set<CrateId>();
  private readonly crateSupports: CrateSupport[] = [];
  private readonly shelfSlots: Record<ProductId, Vector3[]>;
  private readonly displays: Record<ProductId, ProductDisplay>;
  private readonly hands: TransformNode;
  private readonly customer: TransformNode;
  private readonly customerActors: CustomerActors;
  private readonly streetNeighbourActors: StreetNeighbourActors;
  private readonly basket: TransformNode;
  private readonly inspection = new Map<ProductId, TransformNode>();
  private customerPhase: CustomerPhase;
  private route: Position[] = [];
  private routeIndex = 0;
  private arrivalDelay = 0;
  private arrivedRevision = -1;
  private customerRouteBlocked = false;
  private customerObstacleSignature = "";
  private customerShoppingTargetSignature = "";
  private customerEntryAnnounced = false;
  private active = false;
  private disposed = false;
  private inspectionProduct: ProductId | null = null;
  private readonly keys = new Set<string>();
  private readonly lifetime = new AbortController();
  private drag: { x: number; y: number } | null = null;
  private sensitivity = 1;
  private reducedMotion = true;
  private targetMesh: AbstractMesh | null = null;
  private currentTarget: InteractionTarget | null = null;
  private stockHoldTimer: ReturnType<typeof setTimeout> | undefined;
  private stockHoldActive = false;
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
    // Our mouse listeners handle focus, drag-look and stocking. Cancelling
    // pointerdown suppresses their compatibility mouse events in Chromium.
    this.scene.preventDefaultOnPointerDown = false;
    this.scene.preventDefaultOnPointerUp = false;
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

    this.expansionLight = new PointLight("warm-expanded-shop", new Vector3(0, 2.68, 5.5), this.scene);
    this.expansionLight.intensity = 4;
    this.expansionLight.range = 6;
    this.expansionLight.diffuse = new Color3(1, .89, .71);
    this.expansionLight.setEnabled(initialState.renovation.layout.expansion >= 1);
    this.secondExpansionLight = new PointLight("warm-second-expanded-shop", new Vector3(0, 2.68, 8.5), this.scene);
    this.secondExpansionLight.intensity = 4;
    this.secondExpansionLight.range = 6;
    this.secondExpansionLight.diffuse = new Color3(1, .89, .71);
    this.secondExpansionLight.setEnabled(initialState.renovation.layout.expansion >= 2);

    const shop = createShop(this.scene, { catalogFixtures: true, layout: initialState.renovation.layout });
    this.shop = shop;
    this.colliders.push(...shop.colliders);
    const fixtures = createCatalogFixtures(this.scene, PRODUCTS, initialState.renovation.layout);
    this.catalogFixtures = fixtures;
    this.colliders.push(...fixtures.colliders);
    this.equipmentFixtures = createEquipmentSceneFixtures(this.scene, initialState.equipment, initialState.renovation.layout.equipment);
    this.colliders.push(...this.equipmentFixtures.colliders);
    this.workstation = createWorkstation(this.scene, initialState.renovation.layout.workstation);
    this.colliders.push(this.workstation.collider);
    this.tag(this.workstation.interactionMesh, { id: WORKSTATION_ID, kind: "computer" });
    this.street = createStreet(this.scene);
    this.colliders.push(...this.street.colliders);
    const recycling = createRecyclingStation(this.scene);
    this.colliders.push(recycling.collider);
    this.fixedColliders.push(...this.street.colliders, recycling.collider);
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
    this.syncDeliveryTruck();
    this.displays = this.createDisplays(initialState.renovation.layout);
    this.shelfSlots = Object.fromEntries(PRODUCT_IDS.map((id) => [id, this.displays[id].slots.map((point) => new Vector3(point.x, point.y, point.z))])) as Record<ProductId, Vector3[]>;
    for (const target of [...shop.targets, ...fixtures.targets, ...createReceivingPads(this.scene, SAFE_DROP_POINTS)]) {
      this.tag(target.mesh, {
        id: target.id, kind: target.kind,
        ...("productId" in target && target.productId ? { productId: target.productId } : {}),
        position: { x: target.position.x, z: target.position.z },
      });
      if (target.kind === "drop-zone") this.crateSupports.push(measureCrateSupport(target.position, target.mesh));
    }
    this.tagEquipmentTargets();
    this.hands = createPlayerHands(this.scene);
    this.hands.parent = this.camera;
    this.hands.position.set(0, -.39, .80);
    this.hands.setEnabled(false);
    this.setViewModel(this.hands, true);
    this.customer = new TransformNode("customer-path-root", this.scene);
    this.customerActors = new CustomerActors(this.scene, this.shadow, this.customer);
    this.streetNeighbourActors = new StreetNeighbourActors(this.scene, this.shadow);
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
    await Promise.all([this.customerActors.init(this.state), this.streetNeighbourActors.init(this.state)]);
    if (this.disposed) return;
    for (const target of this.streetNeighbourActors.targets) {
      this.tag(target.root, { id: `street-neighbour-${target.id}`, kind: "street-neighbour", streetNeighbourId: target.id });
    }
    // A restored visitor may already be on the pavement. Replan only after
    // today's neighbour and any companion dog have real collision bounds.
    this.setCustomerRoute(false);
    // Older saves can restore the player inside a newly introduced neighbour
    // or dog collider. Resolve that pose after those real bounds exist.
    this.ensureSafePose();
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
    const freshRun = state.revision < this.state.revision && state.purchases.length === 0 && state.transactions.length === 0;
    const layoutChanged = !layoutEquals(this.state.renovation.layout, state.renovation.layout)
      || JSON.stringify(this.state.renovation.layout.equipment) !== JSON.stringify(state.renovation.layout.equipment);
    this.state = state;
    if (layoutChanged) this.syncShopLayout();
    this.customerActors.select(state);
    const streetNeighbourChanged = this.streetNeighbourActors?.select(state) ?? false;
    this.syncDeliveryTruck();
    this.syncInventory();
    const obstacles = this.crateObstacleSignature();
    const shoppingTargetChanged = this.shoppingTargetSignature() !== this.customerShoppingTargetSignature;
    if (phaseChanged || newCustomer || freshRun || layoutChanged || streetNeighbourChanged
      || obstacles !== this.customerObstacleSignature || shoppingTargetChanged) {
      this.setCustomerRoute(freshRun || newCustomer || layoutChanged);
    }
    this.syncStreet();
    this.ensureSafePose();
    this.updateTarget();
  }

  private createDisplays(layout: ShopLayout): Record<ProductId, ProductDisplay> {
    return Object.fromEntries(PRODUCT_IDS.map((productId) => {
      const base = PRODUCT_DISPLAYS[productId];
      const furnitureId = furnitureForProduct(productId);
      const turns = layout.placements.find((placement) => placement.id === furnitureId)!.rotation;
      return [productId, {
        ...base,
        slots: base.slots.map((point) => transformLayoutPoint(layout, furnitureId, point)),
        approach: transformLayoutPoint(layout, furnitureId, base.approach),
        yaw: base.yaw + turns * Math.PI / 2,
      }];
    })) as Record<ProductId, ProductDisplay>;
  }

  /** Apply one committed plan to visuals, goods, interaction positions and navigation together. */
  private syncShopLayout(): void {
    const layout = this.state.renovation.layout;
    this.shop.applyLayout(layout);
    this.catalogFixtures.applyLayout(layout);
    this.equipmentFixtures?.apply(this.state.equipment, layout.equipment);
    this.workstation?.apply(layout.workstation);
    this.colliders.splice(0, this.colliders.length, ...this.shop.colliders, ...this.catalogFixtures.colliders,
      ...(this.equipmentFixtures?.colliders ?? []), ...(this.workstation ? [this.workstation.collider] : []), ...this.fixedColliders);
    const displays = this.createDisplays(layout);
    for (const productId of PRODUCT_IDS) {
      this.displays[productId] = displays[productId];
      this.shelfSlots[productId] = displays[productId].slots.map((point) => new Vector3(point.x, point.y, point.z));
    }
    for (const target of [...this.shop.targets, ...this.catalogFixtures.targets]) {
      this.tag(target.mesh, {
        id: target.id, kind: target.kind,
        ...("productId" in target && target.productId ? { productId: target.productId } : {}),
        position: { x: target.position.x, z: target.position.z },
      });
    }
    this.tagEquipmentTargets();
    for (const target of this.equipmentFixtures?.targets ?? []) for (const mesh of target.root.getChildMeshes()) {
      mesh.receiveShadows = true;
      if (mesh.getTotalVertices() > 12 && !/glass|label|letter/i.test(mesh.name)) this.shadow.addShadowCaster(mesh, false);
    }
    this.expansionLight.setEnabled(layout.expansion >= 1);
    this.secondExpansionLight?.setEnabled(layout.expansion >= 2);
  }

  private tagEquipmentTargets(): void {
    for (const target of this.equipmentFixtures?.targets ?? []) {
      this.tag(target.root, {
        id: target.id,
        kind: target.kind,
        productId: target.productId,
        equipmentId: target.equipmentId,
        position: { x: target.position.x, z: target.position.z },
      });
    }
  }

  private checkoutPoint(): Position {
    return transformLayoutPoint(this.state.renovation.layout, "checkout-counter", CHECKOUT_CUSTOMER_POINT);
  }

  private checkoutYaw(): number {
    return this.state.renovation.layout.placements.find((placement) => placement.id === "checkout-counter")!.rotation * Math.PI / 2;
  }

  private shelfLocationForProduct(productId: ProductId): ShelfStockLocation | null {
    const item = this.state.items.find((candidate) => candidate.productId === productId && candidate.location.kind === "shelf");
    return item?.location.kind === "shelf" ? item.location : null;
  }

  private shelfApproach(productId: ProductId, location: ShelfStockLocation | null = this.shelfLocationForProduct(productId)): Position {
    if (location?.equipmentId) {
      const service = this.equipmentFixtures?.servicePoint(location.equipmentId, location.slot);
      if (service) return { x: service.position.x, z: service.position.z };
    }
    return this.displays[productId].approach;
  }

  private shelfFacingPoint(productId: ProductId, location: ShelfStockLocation | null): Position {
    if (location?.equipmentId) {
      const slot = this.equipmentFixtures?.slot(location.equipmentId, location.slot);
      if (slot) return { x: slot.position.x, z: slot.position.z };
    }
    const base = this.displays[productId].slots[location?.slot ?? 0] ?? this.displays[productId].slots[0]!;
    return { x: base.x, z: base.z };
  }

  /** The stock slot and its live service point both determine where an in-flight shopper must walk. */
  private shoppingTargetSignature(): string {
    const productId = getShoppingProduct(this.state);
    if (!productId) return `${this.state.customer.phase}:none`;
    const location = getShoppingShelfLocation(this.state);
    if (!location) return `${this.state.customer.phase}:${productId}:missing`;
    const approach = this.shelfApproach(productId, location);
    return `${this.state.customer.phase}:${productId}:${shelfSlotKey(location)}:${approach.x}:${approach.z}`;
  }

  private shelfName(productId: ProductId, equipmentId?: string): string {
    if (equipmentId) {
      const instance = this.state.equipment.instances.find((candidate) => candidate.id === equipmentId);
      if (instance) return `${EQUIPMENT_COMMERCE_CATALOG[instance.assetId].nameZh} · ${PRODUCTS[productId].nameZh}`;
    }
    return this.displays[productId].shelfName;
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
        const equipmentSlot = location.equipmentId
          ? this.equipmentFixtures?.slot(location.equipmentId, location.slot) ?? null : null;
        if (location.equipmentId && !equipmentSlot) {
          // A persisted item must never float at the origin if its equipment
          // cannot be rendered. Validation normally prevents this fallback.
          root.setEnabled(false);
        } else if (equipmentSlot) {
          root.position.copyFrom(equipmentSlot.position);
          root.rotation.y = equipmentSlot.yaw;
          root.scaling.setAll(fitProduct(dimensions, equipmentSlot.maxSize));
        } else {
          root.position.copyFrom(this.shelfSlots[item.productId][location.slot]!);
          const display = this.displays[item.productId];
          root.rotation.y = display.yaw;
          root.scaling.setAll(fitProduct(dimensions, display.maxSize));
        }
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
        const position = transformLayoutPoint(state.renovation.layout, "checkout-counter", layout.position);
        root.position.set(position.x, position.y, position.z);
        root.scaling.setAll(layout.scale); root.rotation.y = layout.yaw + this.checkoutYaw();
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

  /** A lightweight clock update; avoid rebuilding shelves or selecting actors every frame. */
  setDeliveryState(state: SimState): void {
    const before = this.state.delivery;
    this.state = state;
    this.syncDeliveryTruck();
    if (this.street && (before.phase !== state.delivery.phase || before.orderId !== state.delivery.orderId
      || before.blocked !== state.delivery.blocked)) this.syncDeliveryStatus();
  }

  /** Sweep the next movement segment so a long frame cannot drive through the player. */
  isDeliveryBlocked(elapsedMs: number): boolean {
    let delivery = this.state.delivery;
    if (!delivery || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return false;
    // A frame can finish preparation and already move into the road. Check
    // that portion too, before committing either the clock or van position.
    if (delivery.phase === "preparing") {
      elapsedMs -= DELIVERY_PREPARE_MS - delivery.elapsedMs;
      if (elapsedMs <= 0) return false;
      delivery = { ...delivery, phase: "arriving", elapsedMs: 0 };
    }
    if (delivery.phase !== "arriving" && delivery.phase !== "departing") return false;
    const duration = delivery.phase === "arriving" ? DELIVERY_ARRIVE_MS : DELIVERY_DEPART_MS;
    const currentX = deliveryTruckX(delivery);
    const nextX = deliveryTruckX({ ...delivery, elapsedMs: Math.min(duration, delivery.elapsedMs + Math.max(0, elapsedMs)) });
    return Math.abs(this.camera.position.z + 9.1) < 1.45
      && this.camera.position.x > Math.min(currentX, nextX) - 2.85
      && this.camera.position.x < Math.max(currentX, nextX) + 2.85;
  }

  private syncDeliveryTruck(): void {
    // Some renderer unit harnesses only construct the customer part of the scene.
    if (!this.street || !this.state.delivery) return;
    const delivery = this.state.delivery;
    this.truckPhase = delivery.phase === "ready" ? "parked"
      : delivery.phase === "arriving" || delivery.phase === "departing" ? delivery.phase : "away";
    const x = deliveryTruckX(delivery);
    const oldX = this.street.truck.position.x;
    this.street.truck.position.set(x, 0, -9.1);
    this.street.truck.setEnabled(this.truckPhase !== "away");
    if (this.truckPhase !== "away") for (const wheel of this.street.wheels) wheel.rotation.z -= (x - oldX) / .38;
  }

  private syncStreet(): void {
    for (const venue of STREET_VENUES) {
      const progress = getVenueProgress(this.state, venue.id);
      const conditions = progress.requirements.map((entry) => entry.label).join(" · ");
      setStreetVenueStatus(this.scene, venue.id, progress.statusText, conditions, progress.eligible);
    }
    this.syncDeliveryStatus();
  }

  private syncDeliveryStatus(): void {
    const delivery = getDeliverySummary(this.state);
    setDeliveryTruckStatus(this.scene, delivery.phase === "ready"
      ? `本单 ${delivery.readyUnits} 件待签收 · 后方 ${delivery.queuedOrders} 单`
      : delivery.blocked ? "请让出车道 · 配送暂停"
        : delivery.pendingOrders ? `配送中 · 共 ${delivery.pendingOrders} 单` : "按单配送 · 到店内电脑订货");
  }

  private setCustomerRoute(initial: boolean): void {
    const phase = this.state.customer.phase;
    const order = getCustomerOrder(this.state);
    const freshCustomer = phase === "to-milk" && this.customerPhase !== "to-milk";
    const arrivalOrigins = (initial || freshCustomer) && phase === "to-milk" ? customerArrivalOrigins(this.state) : null;
    if (initial || freshCustomer) {
      this.customerEntryAnnounced = phase !== "to-milk";
      const first = order[0] ? this.shelfApproach(order[0]) : this.displays.milk.approach;
      const lastProduct = order.at(-1);
      const last = lastProduct ? this.shelfApproach(lastProduct) : first;
      const start = arrivalOrigins ? arrivalOrigins[0]!
        : phase === "to-bread" ? first : phase === "to-checkout" ? last
          : phase === "checkout" || phase === "leaving" ? this.checkoutPoint() : CUSTOMER_DOORSTEP;
      this.customer.position.set(start.x, 0, start.z);
    }
    this.customerPhase = phase;
    this.customer.setEnabled(phase !== "outside" && phase !== "complete");
    const product = getShoppingProduct(this.state);
    const shoppingLocation = getShoppingShelfLocation(this.state);
    const destination = product ? this.shelfApproach(product, shoppingLocation)
      : phase === "to-checkout" ? this.checkoutPoint()
        : phase === "leaving" ? CUSTOMER_DOORSTEP : null;
    const obstacles = this.customerColliders();
    const plan = (from: Position) => destination ? customerJourneyRoute(from, destination, obstacles, this.state.renovation.layout.expansion) : [];
    let route = plan(this.customer.position);
    // A stocked unloading area may temporarily obstruct one end of the street.
    // Choose another distant start only before a new visitor is first displayed.
    if (route === null && arrivalOrigins) {
      for (const origin of arrivalOrigins.slice(1)) {
        const alternative = plan(origin);
        if (alternative === null) continue;
        this.customer.position.set(origin.x, 0, origin.z);
        route = alternative;
        break;
      }
    }
    this.customerRouteBlocked = route === null;
    this.route = route ?? [];
    this.customerObstacleSignature = this.crateObstacleSignature();
    this.customerShoppingTargetSignature = this.shoppingTargetSignature();
    if (this.customerRouteBlocked) this.callbacks.onStatus("顾客通道被货箱挡住了。先把箱子搬到安全卸货点，顾客会继续前往对应货架。");
    this.routeIndex = 0;
    this.arrivalDelay = 0;
    this.arrivedRevision = -1;
    if ((initial || freshCustomer) && route?.[0]) {
      this.customer.rotation.y = Math.atan2(route[0].x - this.customer.position.x, route[0].z - this.customer.position.z);
    }
    if (phase === "checkout") this.customer.rotation.y = -Math.PI / 2 + this.checkoutYaw();
  }

  private crateObstacleSignature(): string {
    return this.state.crates.filter((crate) => this.occupiedCrates.has(crate.id) && !(this.state.held.kind === "crate" && this.state.held.crateId === crate.id))
      .map((crate) => `${crate.id}:${crate.position.x}:${crate.position.z}`).join("|");
  }

  private customerColliders(): Collider[] {
    const boxes = [...this.colliders, ...(this.streetNeighbourActors?.colliders ?? [])];
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
    if (!walking) this.customerActors.play(false);
    else this.customerActors.play(true, this.customer.position.z < -4.5 ? CUSTOMER_STREET_WALK_SPEED / CUSTOMER_WALK_SPEED : 1);
  }

  isCustomerApproaching(): boolean {
    return this.customerPhase === "to-milk" && this.customer.position.z < -4.5;
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
      if (distance < 1e-7) {
        // Finish the corner before turning, rather than cutting diagonally
        // inside the planned clearance around a tree, lamp or shelf.
        this.customer.position.set(next.x, 0, next.z);
        this.routeIndex += 1;
      } else {
        const speed = this.customer.position.z < -4.5 ? CUSTOMER_STREET_WALK_SPEED : CUSTOMER_WALK_SPEED;
        const step = Math.min(distance, dt * speed);
        this.customer.position.x += dx / distance * step;
        this.customer.position.z += dz / distance * step;
        const yaw = Math.atan2(dx, dz);
        let angle = yaw - this.customer.rotation.y;
        angle = Math.atan2(Math.sin(angle), Math.cos(angle));
        this.customer.rotation.y += angle * Math.min(1, dt * 9);
        this.playCustomerAnimation(true);
      }
      if (!this.customerEntryAnnounced && this.customerPhase === "to-milk" && !this.isCustomerApproaching()) {
        this.customerEntryAnnounced = true;
        this.callbacks.onCustomerEnter?.();
      }
      return;
    }
    this.playCustomerAnimation(false);
    const shoppingProduct = getShoppingProduct(this.state);
    if (shoppingProduct) {
      const shelf = this.shelfFacingPoint(shoppingProduct, getShoppingShelfLocation(this.state));
      this.customer.rotation.y = Math.atan2(shelf.x - this.customer.position.x, shelf.z - this.customer.position.z);
    }
    if (this.customerPhase === "checkout" || this.customerPhase === "to-checkout") this.customer.rotation.y = -Math.PI / 2 + this.checkoutYaw();
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
      this.keys.clear(); this.drag = null; this.stopStockHold();
      if (this.active) this.callbacks.onPause();
    }, options);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.keys.clear(); this.stopStockHold(); if (this.active) this.callbacks.onPause(); }
    }, options);
    document.addEventListener("pointerlockchange", () => {
      this.drag = null; this.keys.clear(); this.stopStockHold();
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
      if (document.pointerLockElement === this.canvas) {
        if (this.stockHoldActive) return;
        // Freeze the pre-click target so picking up a box cannot turn the same
        // held press into stocking when the ray target changes synchronously.
        const wasRepeatableStocking = this.canRepeatStocking();
        this.callbacks.onInteract();
        if (wasRepeatableStocking) this.startStockHold();
      }
      // Free cursor stays free: a click on the scene only begins drag-look.
      // Capturing it again requires the visible control or the Tab shortcut.
      else this.drag = { x: event.clientX, y: event.clientY };
    }, options);
    window.addEventListener("mouseup", (event) => {
      this.drag = null;
      if (event.button === 0) this.stopStockHold();
    }, options);
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

  /** Only shelf stocking repeats; all one-shot interactions keep click-once semantics. */
  private canRepeatStocking(): boolean {
    const target = this.currentTarget;
    const held = this.state.held;
    if (!this.active || this.disposed || document.pointerLockElement !== this.canvas
      || !target || target.kind !== "shelf" || !target.productId || held.kind !== "crate") return false;
    const crate = this.state.crates.find((candidate) => candidate.id === held.crateId);
    return crate?.productId === target.productId
      && countOnShelf(this.state, target.productId, target.equipmentId)
        < shelfCapacityAt(this.state, target.productId, target.equipmentId)
      && this.state.items.some((item) => item.productId === target.productId
        && item.location.kind === "crate" && item.location.crateId === held.crateId);
  }

  private startStockHold(): void {
    this.stopStockHold();
    if (!this.canRepeatStocking()) return;
    this.stockHoldActive = true;
    const repeat = (): void => {
      this.stockHoldTimer = undefined;
      if (!this.stockHoldActive || !this.canRepeatStocking()) { this.stopStockHold(); return; }
      this.callbacks.onInteract();
      if (!this.stockHoldActive || !this.canRepeatStocking()) { this.stopStockHold(); return; }
      this.stockHoldTimer = setTimeout(repeat, STOCK_HOLD_INTERVAL_MS);
    };
    this.stockHoldTimer = setTimeout(repeat, STOCK_HOLD_DELAY_MS);
  }

  private stopStockHold(): void {
    this.stockHoldActive = false;
    if (this.stockHoldTimer !== undefined) clearTimeout(this.stockHoldTimer);
    this.stockHoldTimer = undefined;
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
    this.stopStockHold();
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
    this.keys.clear(); this.drag = null; this.stopStockHold();
    this.scene.animationsEnabled = active;
    if (!active) this.setCursorFree(true);
    if (!active) { this.currentTarget = null; this.callbacks.onTarget(null); }
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
    if (!isWalkablePosition({ x, z }, radius, this.state.renovation.layout.expansion)) return false;
    for (const box of this.colliders) {
      if (x > box.minX - radius && x < box.maxX + radius && z > box.minZ - radius && z < box.maxZ + radius) return false;
    }
    for (const box of this.streetNeighbourActors?.colliders ?? []) {
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
      label = data.productId ? `${product?.nameEn} · ${this.shelfName(data.productId, data.equipmentId)}` : "商品货架";
      action = this.state.held.kind === "none" ? "先抱起对应货箱" : `摆放一件${product?.nameZh ?? "商品"}`;
      if (getRecyclingOffer(this.state).allowed) action = "货箱已空 · 送往门旁绿色回收点";
      inspectable = !!data.productId && countOnShelf(this.state, data.productId, data.equipmentId) > 0;
    } else if (data.kind === "item") {
      const item = this.state.items.find((entry) => entry.id === data.itemId);
      label = `${product?.nameEn} · ${product?.nameZh}`;
      if (item?.location.kind === "checkout") {
        const scanned = this.state.scannedIds.includes(item.id);
        action = scanned ? "已扫描，不会重复计费" : "扫描商品";
        inspectable = false;
      } else if (this.state.held.kind !== "none" && item?.location.kind === "shelf") {
        return this.decorateTarget({ id: item.location.equipmentId ? `${item.location.equipmentId}-shelf` : `${item.productId}-shelf`,
          kind: "shelf", productId: item.productId,
          ...(item.location.equipmentId ? { equipmentId: item.location.equipmentId } : {}) }, distance);
      } else action = "拿起商品";
    } else if (data.kind === "counter") {
      label = "Checkout · 收银台";
      if (this.state.customer.phase !== "checkout") action = "等待顾客带商品结账";
      else action = this.state.scannedIds.length < getCustomerOrder(this.state).length ? "扫描下一件商品"
        : `${this.state.payment?.method === "cash" ? this.state.payment.received ? "现金 · 继续找零" : "现金收款" : "刷卡收款"} · £${(getCheckoutTotal(this.state) / 100).toFixed(2)}`;
      inspectable = false;
    } else if (data.kind === "computer") {
      label = "Shop computer · 店内电脑";
      action = "打开电脑桌面";
      inspectable = false;
    } else if (data.kind === "open-sign") {
      label = "Open / Closed · 营业牌";
      action = this.state.day.phase === "settled" ? "今日已日结 · 到电脑开始下一天"
        : this.state.day.phase === "closing" ? canSettleDay(this.state) ? "收尾完成 · 到电脑日结" : "打烊收尾中"
          : this.state.day.phase === "preparing" ? "开门营业 · 09:00 开始计时" : "营业中 · 到电脑管理营业";
      inspectable = false;
    } else if (data.kind === "delivery") {
      const delivery = getDeliverySummary(this.state);
      label = `Order delivery · 第 ${this.state.day.number} 天配送`;
      action = delivery.pendingUnits > 0 ? delivery.canReceive ? `签收本单 ${delivery.readyUnits} 件货物` : delivery.reason ?? "请先腾出收货空间" : "到店内电脑订货";
      inspectable = false;
    } else if (data.kind === "venue") {
      const venue = STREET_VENUES.find((entry) => entry.id === data.venueId);
      label = venue ? `${venue.nameEn} · ${venue.nameZh}` : "High Street · 商业街";
      action = data.venueId ? `${getVenueProgress(this.state, data.venueId).statusText} · 查看条件` : "查看开放条件";
      inspectable = false;
    } else if (data.kind === "street-neighbour") {
      const profile = STREET_NEIGHBOUR_PROFILES.find((entry) => entry.id === data.streetNeighbourId);
      const supported = !!profile && this.state.streetSupportRecords.some((record) =>
        record.dayNumber === this.state.day.number && record.neighbourId === profile.id);
      label = profile ? `${profile.name}${profile.dog ? ` & ${profile.dog.name}` : ""} · 街头邻居` : "Neighbour · 街头邻居";
      action = supported ? "今天已帮助过 · 仍可聊天" : "打个招呼 · 可自愿帮助";
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
      this.currentTarget = target;
      this.targetMesh = hit.pickedMesh;
      if (hit.pickedMesh instanceof Mesh) {
        hit.pickedMesh.renderOutline = true;
        hit.pickedMesh.outlineWidth = data.kind === "item" ? .003 : .009;
        hit.pickedMesh.outlineColor = new Color3(.95, .73, .30);
      }
      this.callbacks.onTarget(target);
    } else {
      this.currentTarget = null;
      this.callbacks.onTarget(null);
    }
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
    } else if (state.day.phase === "closing" && state.delivery.phase === "departing" && delivery.pendingOrders === 0
      && ["outside", "complete"].includes(state.customer.phase)) {
      this.callbacks.onGuide?.("最后一单已签收 · 货车驶离后到电脑日结");
      return;
    } else if (state.day.phase === "settled" || canSettleDay(state)) {
      point = workstationServicePoint(state.renovation.layout.workstation);
      title = state.day.phase === "settled" ? "店内电脑 · 开始下一天" : "店内电脑 · 完成日结";
    } else if (state.customer.phase === "checkout" || state.customer.phase === "to-checkout") {
      point = transformLayoutPoint(state.renovation.layout, "checkout-counter", CHECKOUT_CLERK_POINT); title = "收银台内侧";
    } else if (state.held.kind === "crate") {
      const crate = state.crates.find((entry) => state.held.kind === "crate" && entry.id === state.held.crateId)!;
      const openSlot = findFirstEmptyShelfSlot(state.items, crate.productId, state.upgraded,
        state.equipment, state.renovation.layout.equipment);
      point = this.shelfApproach(crate.productId, openSlot);
      title = `${PRODUCTS[crate.productId].nameEn} · ${this.shelfName(crate.productId, openSlot?.equipmentId)}`;
    } else if (delivery.pendingUnits > 0) {
      if (delivery.phase !== "ready") {
        this.callbacks.onGuide?.(delivery.blocked ? "送货车等待让行 · 请离开车道"
          : delivery.phase === "departing" ? `货车正在驶离 · 后续 ${delivery.pendingOrders} 单排队`
            : `本单配送中 · ${Math.ceil(delivery.remainingMs / 1000)} 秒后到店 · 后方 ${delivery.queuedOrders} 单`);
        return;
      }
      point = { x: this.street.truck.position.x, z: this.street.truck.position.z + 1 };
      title = `门口送货车 · 按 E 签收本单 ${delivery.readyUnits} 件`;
    } else if (state.customer.phase === "outside" || state.customer.phase === "complete") {
      const productId = PRODUCT_IDS.find((id) => countAt(state, id, "crate") > 0 && countAt(state, id, "shelf") === 0);
      if (productId) {
        point = state.crates.find((crate) => crate.productId === productId)!.position;
        title = `${PRODUCTS[productId].nameZh}货箱 · 向下看`;
      } else if (!canStartCustomer(state)) {
        point = workstationServicePoint(state.renovation.layout.workstation);
        title = "店内电脑 · 选择商品进货，签收后上架";
      } else if (state.day.phase === "open") {
        this.callbacks.onGuide?.("货架已备好 · 下一位顾客即将进店");
        return;
      } else { point = { x: .65, z: -4.48 }; title = "门口营业牌"; }
    } else {
      point = { x: this.customer.position.x, z: this.customer.position.z };
      title = this.isCustomerApproaching()
        ? "顾客正从街上走来 · 留出店门" : "顾客正在购物 · 留出通道";
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
    this.stopStockHold();
    this.lifetime.abort();
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.engine.stopRenderLoop();
    this.customerActors.dispose();
    this.streetNeighbourActors?.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
