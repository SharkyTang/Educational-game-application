import { waitForDelivery, receiveAllDeliveries } from "../helpers/sim3dDelivery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capacityFor, countAt, createFirstDayState, createInitialSimState, DELIVERY_DROP_POINTS, getCheckoutTotal, getCustomerOrder, getDeliverySummary, PRODUCTS, PRODUCT_IDS, reduceSim, validateSimState, type PlayerPose, type ProductId, type PurchaseLine, type SimCommand, type SimState } from "../../src/sim3d/domain";
import { SIM_BACKUP_KEY, SIM_STORAGE_KEY, type SimLockManager, type StorageLike } from "../../src/sim3d/persistence";
import type { InteractionTarget, WorldCallbacks } from "../../src/sim3d/world";
import { SPEECH_CLIPS } from "../../src/sim3d/speechClips";
import { customerProfileFor, customerSpeechFor, cashTenderSpeechFor, type CustomerVoice } from "../../src/sim3d/customerSelection";
import { BUSINESS_DURATION_MS } from "../../src/sim3d/businessTime";
import { CASH_DENOMINATIONS_PENCE, cashChangeDuePence, cashPiecesForAmount } from "../../src/sim3d/cashPayment";
import { payScannedCheckout } from "../helpers/sim3dPayment";

const doubles = vi.hoisted(() => {
  class World {
    static instances: World[] = [];
    readonly callbacks: WorldCallbacks;
    private readonly pose: PlayerPose;
    private customer: SimState["customer"];
    private approaching: boolean;
    private finish!: () => void;
    private readonly loading = new Promise<void>((resolve) => { this.finish = resolve });
    readonly setActive = vi.fn();
    readonly dispose = vi.fn();
    readonly setSensitivity = vi.fn();
    readonly setQuality = vi.fn();
    readonly setReducedMotion = vi.fn();
    readonly inspect = vi.fn();
    readonly requestPointerLock = vi.fn();
    readonly setCursorFree = vi.fn();
    readonly setDeliveryState = vi.fn();
    readonly isDeliveryBlocked = vi.fn(() => false);
    readonly setState = vi.fn((state: SimState) => {
      if (state.customer.phase !== "to-milk") this.approaching = false;
      else if (this.customer.phase !== "to-milk" || this.customer.number !== state.customer.number) this.approaching = true;
      this.customer = { ...state.customer };
    });
    readonly restorePose = vi.fn();
    constructor(_canvas: HTMLCanvasElement, state: SimState, callbacks: WorldCallbacks) {
      this.callbacks = callbacks;
      this.pose = { ...state.playerPose };
      this.customer = { ...state.customer };
      this.approaching = state.customer.phase === "to-milk";
      World.instances.push(this);
    }
    init(): Promise<void> { return this.loading }
    getPose(): PlayerPose { return this.pose }
    isCustomerApproaching(): boolean { return this.approaching }
    /** Simulate only crossing the doorway, never reaching a shelf or advancing an order. */
    enterShop(): void { this.approaching = false; this.callbacks.onCustomerEnter?.() }
    complete(): void { this.callbacks.onStatus("模型就绪"); this.finish() }
  }
  class ShopAudio {
    static instances: ShopAudio[] = [];
    readonly unlock = vi.fn();
    readonly setActive = vi.fn();
    readonly setSettings = vi.fn();
    readonly setSpeechActive = vi.fn();
    readonly playEffect = vi.fn();
    readonly dispose = vi.fn();
    constructor(readonly options: { onStatus?: (status: string) => void } = {}) { ShopAudio.instances.push(this) }
  }
  return { World, ShopAudio, layoutEditors: [] as { hasUnsavedChanges: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> }[] };
});

vi.mock("../../src/sim3d/world", () => ({ ShopWorld: doubles.World }));
vi.mock("../../src/sim3d/shopAudio", () => ({ ShopAudio: doubles.ShopAudio }));
// The SVG editor and growth panel have their own real-browser coverage. These
// startup tests keep their existing minimal DOM and isolate widget rendering.
vi.mock("../../src/sim3d/layoutEditor", () => ({
  LayoutEditor: class {
    constructor(host: HTMLElement) {
      host.innerHTML = '<select id="s3-layout-select"></select>';
      doubles.layoutEditors.push(this);
    }
    readonly setState = vi.fn();
    readonly hasUnsavedChanges = vi.fn(() => false);
    readonly discard = vi.fn();
    readonly dispose = vi.fn();
  },
}));
vi.mock("../../src/sim3d/developmentPanel", () => ({
  DevelopmentPanel: class {
    readonly render = vi.fn();
    readonly dispose = vi.fn();
    constructor(private readonly host: HTMLElement) {
      host.innerHTML = '<section id="s3-extension-confirm" hidden></section>';
    }
    cancelConfirmation(): void { this.host.querySelector<HTMLElement>("#s3-extension-confirm")!.hidden = true }
  },
}));
import { App3D } from "../../src/sim3d/App3D";

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void { this.writes += 1; this.data.set(key, value) }
}

class ExclusiveLocks implements SimLockManager {
  held = false;
  async request(_name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: object | null) => Promise<void>): Promise<void> {
    if (this.held) { await callback(null); return }
    this.held = true;
    try { await callback({}) }
    finally { this.held = false }
  }
}

/** Minimal DOM surface for App3D's real startup/event wiring, not a second UI implementation. */
class ElementDouble extends EventTarget {
  textContent = "";
  hidden = false;
  disabled = false;
  open = false;
  checked = false;
  value = "";
  private source = "";
  volume = 1;
  muted = false;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  paused = true;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  readonly play = vi.fn(async () => { this.paused = false });
  readonly pause = vi.fn(() => { this.paused = true });
  files: Array<{ name: string; size: number; text: () => Promise<string> }> | null = null;
  readonly classList = { toggle: vi.fn() };
  readonly focus = vi.fn();
  readonly elements = new Map<string, ElementDouble>();
  readonly attributes = new Map<string, string>();
  private markup = "";
  get src(): string { return this.source }
  set src(value: string) {
    this.source = value;
    // Loading a new media resource resets the current rate to its default.
    // This reproduces the real Chromium regression that a plain field missed.
    this.playbackRate = this.defaultPlaybackRate;
  }
  get innerHTML(): string { return this.markup }
  set innerHTML(markup: string) {
    this.markup = markup;
    this.elements.clear();
    for (const match of markup.matchAll(/<[a-z][a-z\d-]*\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const attributes = match[1]!;
      const element = new ElementDouble();
      for (const attribute of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1]!, attribute[2]!);
      element.hidden = /\bhidden(?:\s|$)/.test(attributes);
      element.disabled = /\bdisabled(?:\s|$)/.test(attributes);
      element.open = /\bopen(?:\s|$)/.test(attributes);
      element.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? "";
      element.checked = /\bchecked(?:\s|$)/.test(attributes);
      this.elements.set(match[2]!, element);
    }
  }
  querySelector(selector: string): ElementDouble | null {
    return this.elements.get(selector.slice(1))
      ?? [...this.elements.values()].map((element) => element.querySelector(selector)).find((element) => element !== null)
      ?? null;
  }
  querySelectorAll(): ElementDouble[] { return [] }
  replaceChildren(): void { this.innerHTML = "" }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click")) }
  close(): void { this.open = false }
  showModal(): void { this.open = true }
}

const settle = async (): Promise<void> => { for (let index = 0; index < 12; index += 1) await Promise.resolve() };
let storage: MemoryStorage;
let locks: ExclusiveLocks;
let windowDouble: EventTarget;
let documentDouble: EventTarget & { hidden: boolean };
let apps: App3D[];

function mount(root = new ElementDouble()) {
  const app = new App3D(root as unknown as HTMLElement);
  apps.push(app);
  return { app, root, shopAudio: doubles.ShopAudio.instances.at(-1)!, element: (id: string) => root.elements.get(id)! };
}

function enterComputer(view: ReturnType<typeof mount>): void {
  if (view.element("s3-pause").open && !view.element("s3-pause-options").hidden) view.element("s3-resume").click();
  if (view.element("s3-pause").open) return;
  const world = (view as ReturnType<typeof mount> & { world?: InstanceType<typeof doubles.World> }).world ?? doubles.World.instances.at(-1)!;
  world.callbacks.onTarget({ id: "shop-computer", kind: "computer", label: "店内电脑", action: "打开电脑", inspectable: false, distance: 1.2 });
  world.callbacks.onInteract();
}

function openComputerApp(view: ReturnType<typeof mount>, section: string): void {
  enterComputer(view);
  view.element(`s3-computer-${section}`).click();
}

beforeEach(() => {
  storage = new MemoryStorage();
  locks = new ExclusiveLocks();
  windowDouble = new EventTarget();
  documentDouble = Object.assign(new EventTarget(), { hidden: false, pointerLockElement: null, activeElement: null });
  vi.stubGlobal("window", windowDouble);
  vi.stubGlobal("document", documentDouble);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { locks });
  doubles.World.instances = [];
  doubles.ShopAudio.instances = [];
  doubles.layoutEditors.length = 0;
  apps = [];
});

afterEach(async () => {
  await Promise.all(apps.map((app) => app.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function paidSnapshot(): SimState {
  let state = createInitialSimState();
  for (const productId of ["milk", "bread"] as const) {
    state = reduceSim(state, { type: "TAKE_ITEM", itemId: `${productId}-1` }).state;
    state = reduceSim(state, { type: "STOCK", productId, slot: 0 }).state;
  }
  state = reduceSim(state, { type: "OPEN_STORE" }).state;
  for (let index = 0; index < 3; index += 1) state = reduceSim(state, { type: "CUSTOMER_ADVANCE" }).state;
  for (const itemId of ["milk-1", "bread-1"]) state = reduceSim(state, { type: "SCAN", itemId }).state;
  return reduceSim(state, { type: "PAY", success: true }).state;
}

function act(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  expect(result.changed, `${command.type}: ${result.message ?? ""}`).toBe(true);
  expect(validateSimState(result.state)).toBe(true);
  return result.state;
}

function stockedFirstDay(pairs: 3 | 4 = 3): SimState {
  let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", pairs: 3, orderId: "first-day-three" });
  if (pairs === 4) state = act(state, { type: "PURCHASE_STOCK", pairs: 1, orderId: "one-extra-pair" });
  state = receiveAllDeliveries(state);
  for (const productId of ["milk", "bread"] as const) {
    for (let slot = 0; slot < pairs; slot += 1) {
      const item = state.items.find((entry) => entry.productId === productId && entry.location.kind === "crate")!;
      state = act(state, { type: "TAKE_ITEM", itemId: item.id });
      state = act(state, { type: "STOCK", productId, slot });
    }
  }
  return state;
}

function completeOrder(state: SimState, leave = true): SimState {
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
  for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  state = payScannedCheckout(state);
  return leave ? act(state, { type: "CUSTOMER_ADVANCE" }) : state;
}

function beforeCheckout(paidCustomers = 0): SimState {
  let state = stockedFirstDay();
  for (let count = 0; count < paidCustomers; count += 1) state = completeOrder(state);
  state = act(state, { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" });
  state = act(state, { type: "CUSTOMER_ADVANCE" });
  return act(state, { type: "CUSTOMER_ADVANCE" });
}

function savedState(): SimState {
  const value: unknown = JSON.parse(storage.getItem(SIM_STORAGE_KEY)!);
  expect(validateSimState(value)).toBe(true);
  return value as SimState;
}

/** Drive the real frame hook with active frames, not a device-suspension-sized jump. */
function frameTime() {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    skip: (elapsedMs: number): void => { now += elapsedMs },
    advance: (view: { world: { callbacks: WorldCallbacks } }, elapsedMs: number): void => {
      const pose = savedState().playerPose;
      for (let remaining = elapsedMs; remaining > 0;) {
        const step = Math.min(100, remaining);
        now += step;
        remaining -= step;
        view.world.callbacks.onFrame?.(60, pose);
      }
    },
  };
}

function stubCustomerEntropy(seed: number) {
  const getRandomValues = vi.fn((words: Uint32Array): Uint32Array => { words[0] = seed; return words });
  vi.stubGlobal("crypto", { getRandomValues, randomUUID: crypto.randomUUID.bind(crypto) });
  return getRandomValues;
}

function checkoutWithLegacyPhrase(voice: CustomerVoice): SimState {
  const base = beforeCheckout();
  for (let seed = 0; seed < 512; seed += 1) {
    const state = { ...base, customerSeed: seed };
    if (customerProfileFor(state).voice === voice && customerSpeechFor(state, "checkout").text === SPEECH_CLIPS.card.text) return state;
  }
  throw new Error(`No ${voice} legacy-text collision fixture found in the bounded seed search.`);
}

async function readyGame(state = createFirstDayState()) {
  expect(validateSimState(state)).toBe(true);
  storage.setItem(SIM_STORAGE_KEY, JSON.stringify(state));
  const view = mount();
  const loading = view.app.init();
  await settle();
  const world = doubles.World.instances.at(-1)!;
  world.complete();
  await loading;
  view.element("s3-start-button").click();
  await settle();
  const audio = view.element("s3-word-audio");
  // Test each subsequent event independently from Start's priming/restored greeting.
  audio.play.mockClear();
  world.requestPointerLock.mockClear();
  world.setCursorFree.mockClear();
  return { ...view, world, audio };
}

function key(code: string, shiftKey = false): Event {
  const event = Object.assign(new Event("keydown", { cancelable: true }), { code, shiftKey, repeat: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false });
  windowDouble.dispatchEvent(event);
  return event;
}

function deliveryTarget(distance = 1.3): InteractionTarget {
  return { id: "delivery-truck", kind: "delivery", label: "每日送货车", action: "签收送货", inspectable: false, distance };
}

function venueTarget(venueId: "cafe" | "restaurant" | "supermarket", distance = 1.3): InteractionTarget {
  return { id: `venue-${venueId}`, kind: "venue", venueId, label: "未来商铺", action: "查看开放条件", inspectable: false, distance };
}

function setQuantity(view: { element: (id: string) => ElementDouble }, productId: ProductId, quantity: string | number): void {
  const input = view.element(`s3-quantity-${productId}`);
  input.value = String(quantity);
  input.dispatchEvent(new Event("input"));
}

function stockedSelection(lines: PurchaseLine[]): SimState {
  let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "self-selected-stock", lines });
  state = receiveAllDeliveries(state);
  for (const line of lines) {
    for (let slot = 0; slot < line.quantity; slot += 1) {
      const item = state.items.find((entry) => entry.productId === line.productId && entry.location.kind === "crate")!;
      state = act(state, { type: "TAKE_ITEM", itemId: item.id });
      state = act(state, { type: "STOCK", productId: line.productId, slot });
    }
  }
  return state;
}

function selectedCheckout(lines: PurchaseLine[]): SimState {
  let state = act(stockedSelection(lines), { type: "OPEN_STORE" });
  for (let step = 0; step < 3 && state.customer.phase !== "checkout"; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
  expect(state.customer.phase).toBe("checkout");
  return state;
}

describe("3D application startup and lifecycle", () => {
  it("enables Start after the model is ready while retaining the lifetime Web Lock", async () => {
    const view = mount();
    const loading = view.app.init();
    await settle();
    expect(doubles.World.instances).toHaveLength(1);
    expect(locks.held).toBe(true);
    expect(view.element("s3-start-button").disabled).toBe(true);
    doubles.World.instances[0]!.complete();
    await loading;
    expect(view.element("s3-loading").textContent).toBe("小店准备好了 · 键盘与鼠标操作");
    expect(view.element("s3-start-button").disabled).toBe(false);
    expect(locks.held).toBe(true);
    view.element("s3-start-button").click();
    expect(view.element("s3-start").hidden).toBe(true);
    expect(doubles.World.instances[0]!.setActive).toHaveBeenLastCalledWith(true);
  });

  it("renders the second page as read-only and allows takeover only after the writer leaves", async () => {
    const first = mount();
    const firstLoading = first.app.init();
    await settle();
    doubles.World.instances[0]!.complete();
    await firstLoading;
    const second = mount();
    const secondLoading = second.app.init();
    await settle();
    doubles.World.instances[1]!.complete();
    await secondLoading;
    expect(second.element("s3-start-button").disabled).toBe(true);
    expect(second.element("s3-start-button").textContent).toBe("此页面只读");
    expect(second.element("s3-readonly-note").hidden).toBe(false);
    expect(second.element("s3-readonly-note").textContent).toContain("另一页面");
    const priorWrites = storage.writes;
    second.element("s3-start-button").click();
    second.element("s3-volume").dispatchEvent(new Event("input"));
    expect(storage.writes).toBe(priorWrites);
    first.app.dispose();
    await settle();
    second.element("s3-takeover").click();
    await settle();
    doubles.World.instances[2]!.complete();
    await settle();
    expect(second.element("s3-start-button").disabled).toBe(false);
    expect(second.element("s3-readonly-note").hidden).toBe(true);
  });

  it("coalesces overlapping admission work so a duplicate init cannot create two live worlds", async () => {
    const view = mount();
    const first = view.app.init();
    const latest = view.app.init();
    await settle();
    expect(doubles.World.instances).toHaveLength(1);
    doubles.World.instances[0]!.complete();
    await Promise.all([first, latest]);
    expect(view.element("s3-start-button").disabled).toBe(false);
  });

  it("ignores an earlier world's late readiness when a newer initialization is still loading", async () => {
    const view = mount();
    const first = view.app.init();
    await settle();
    const oldWorld = doubles.World.instances[0]!;
    const latest = view.app.init();
    await settle();
    expect(oldWorld.dispose).toHaveBeenCalledOnce();
    oldWorld.complete();
    await first;
    expect(view.element("s3-start-button").disabled).toBe(true);
    expect(view.element("s3-loading").textContent).toContain("正在载入");
    doubles.World.instances[1]!.complete();
    await latest;
    expect(view.element("s3-start-button").disabled).toBe(false);
  });

  it("disposes a previous mount on the same root and blocks its late callbacks from changing the new UI", async () => {
    const first = mount();
    const firstLoading = first.app.init();
    await settle();
    const oldWorld = doubles.World.instances[0]!;
    const replacement = mount(first.root);
    const replacementLoading = replacement.app.init();
    await settle();
    expect(oldWorld.dispose).toHaveBeenCalledOnce();
    oldWorld.complete();
    oldWorld.callbacks.onGuide?.("旧场景不应再更新界面");
    await firstLoading;
    expect(replacement.element("s3-loading").textContent).toContain("正在载入");
    expect(replacement.element("s3-guide").textContent).not.toContain("旧场景");
    doubles.World.instances[1]!.complete();
    await replacementLoading;
    expect(replacement.element("s3-start-button").disabled).toBe(false);
  });

  it("releases on pagehide, ignores an unfinished world and reacquires a fresh snapshot on BFCache return", async () => {
    const view = mount();
    const loading = view.app.init();
    await settle();
    windowDouble.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(locks.held).toBe(false);
    doubles.World.instances[0]!.complete();
    await loading;
    expect(view.element("s3-start-button").disabled).toBe(true);
    const restored = Object.assign(new Event("pageshow"), { persisted: true });
    windowDouble.dispatchEvent(restored);
    await settle();
    doubles.World.instances[1]!.complete();
    await settle();
    expect(view.element("s3-start-button").disabled).toBe(false);
    expect(locks.held).toBe(true);
  });

  it("surfaces a failed lock request instead of displaying an unexplained disabled start button", async () => {
    vi.stubGlobal("navigator", { locks: { request: () => Promise.reject(new Error("SecurityError")) } });
    const view = mount();
    const loading = view.app.init();
    await settle();
    doubles.World.instances[0]!.complete();
    await loading;
    expect(view.element("s3-start-button").disabled).toBe(true);
    expect(view.element("s3-start-button").textContent).toBe("此页面只读");
    expect(view.element("s3-readonly-note").hidden).toBe(false);
    expect(view.element("s3-readonly-note").textContent).toContain("写入权限");
    expect(view.element("s3-loading").textContent).toContain("不会写入");
  });

  it("stops speech on focus loss and visibility loss even while inspecting an item", async () => {
    const view = await inspectWord();
    view.element("s3-speak-word").click();
    view.audio.onplaying?.();
    expect(view.element("s3-inspection").hidden).toBe(false);
    view.audio.pause.mockClear();
    windowDouble.dispatchEvent(new Event("blur"));
    expect(view.audio.pause).toHaveBeenCalledOnce();
    documentDouble.hidden = true;
    documentDouble.dispatchEvent(new Event("visibilitychange"));
    expect(view.audio.pause).toHaveBeenCalledTimes(2);
    expect(view.element("s3-inspection").hidden).toBe(false);
  });

  it("reads a native file selection without changing progress, then imports only after explicit confirmation", async () => {
    const view = mount();
    const loading = view.app.init();
    await settle();
    doubles.World.instances[0]!.complete();
    await loading;
    view.element("s3-start-button").click();
    view.element("s3-pause-button").click();
    const original = storage.getItem(SIM_STORAGE_KEY);
    const raw = JSON.stringify(paidSnapshot());
    const input = view.element("s3-import-file");
    input.files = [{ name: "paid.json", size: raw.length, text: async () => raw }];
    input.dispatchEvent(new Event("change"));
    await settle();
    expect(view.element("s3-import-confirm").hidden).toBe(false);
    expect(view.element("s3-import-summary").textContent).toContain("£4.00");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(original);
    view.element("s3-import-confirm-button").click();
    await settle();
    expect(view.element("s3-start-button").disabled).toBe(true);
    expect(doubles.World.instances).toHaveLength(2);
    doubles.World.instances[1]!.complete();
    await settle();
    expect(view.element("s3-start-button").disabled).toBe(false);
    expect(view.element("s3-start-note").textContent).toContain("£4.00");
    expect(view.element("s3-start-note").textContent).toContain("不另加本金");
    expect(JSON.parse(storage.getItem(SIM_STORAGE_KEY)!)).toEqual(paidSnapshot());
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(original);
  });

  it("keeps the original snapshot when an import is cancelled or fails validation", async () => {
    const view = mount();
    const loading = view.app.init();
    await settle();
    doubles.World.instances[0]!.complete();
    await loading;
    view.element("s3-start-button").click();
    view.element("s3-pause-button").click();
    const original = storage.getItem(SIM_STORAGE_KEY);
    const raw = JSON.stringify(paidSnapshot());
    const input = view.element("s3-import-file");
    input.files = [{ name: "paid.json", size: raw.length, text: async () => raw }];
    input.dispatchEvent(new Event("change"));
    await settle();
    view.element("s3-import-cancel").click();
    expect(view.element("s3-import-confirm").hidden).toBe(true);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(original);
    input.files = [{ name: "bad.json", size: 8, text: async () => "{broken}" }];
    input.dispatchEvent(new Event("change"));
    await settle();
    expect(view.element("s3-import-confirm").hidden).toBe(true);
    expect(view.element("s3-toast").textContent).toContain("不是可读取的 JSON");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(original);
    expect(doubles.World.instances).toHaveLength(1);
  });
});

async function inspectWord(productId: "milk" | "bread" = "milk") {
  // The product-inspection regression uses a real legacy grant fixture, not the
  // default first day (whose crates are intentionally empty before procurement).
  storage.setItem(SIM_STORAGE_KEY, JSON.stringify(createInitialSimState()));
  const view = mount();
  const loading = view.app.init();
  await settle();
  const world = doubles.World.instances.at(-1)!;
  world.complete();
  await loading;
  view.element("s3-start-button").click();
  await settle();
  // Exclude the deliberately muted Start-click audio priming from word-play assertions.
  view.element("s3-word-audio").play.mockClear();
  world.callbacks.onTarget({ id: `${productId}-crate`, kind: "crate", crateId: `${productId}-crate`, productId, label: productId, action: "抱起货箱", inspectable: true, distance: 1 });
  world.callbacks.onInspect();
  return { ...view, world, audio: view.element("s3-word-audio") };
}

describe("built-in British word recordings", () => {
  it.each(["milk", "bread"] as const)("plays local %s without a system voice, respecting volume and reporting completion only on ended", async (productId) => {
    const view = await inspectWord(productId);
    view.element("s3-speak-word").click();
    expect(view.audio.src).toBe(`/assets/sim3d/audio/${productId}.ogg`);
    expect(view.audio.volume).toBe(0.7);
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.element("s3-speech-status").textContent).not.toContain("已播放");
    view.audio.onplaying?.();
    expect(view.element("s3-speech-status").textContent).toContain("正在播放英式发音");
    view.audio.onended?.();
    expect(view.element("s3-speech-status").textContent).toContain(`已播放英式发音：${productId}`);
    expect(view.root.innerHTML).toContain("Judith Franck / Shtooka");
    expect(view.root.innerHTML).toContain("/assets/sim3d/audio/audio-SOURCES.md");
  });

  it("does not claim completion when media playback is rejected or emits an error", async () => {
    const view = await inspectWord();
    view.audio.play.mockRejectedValueOnce(new Error("NotAllowedError"));
    view.element("s3-speak-word").click();
    await settle();
    expect(view.element("s3-speech-status").textContent).toContain("未能播放");
    view.audio.onplaying?.();
    view.audio.onerror?.();
    view.audio.onended?.();
    expect(view.element("s3-speech-status").textContent).toContain("未能播放");
    expect(view.element("s3-speech-status").textContent).not.toContain("已播放");
  });

  it.each(["blur", "hidden", "close", "pause"] as const)("pauses and rewinds the local recording on %s and ignores late completion", async (reason) => {
    const view = await inspectWord();
    view.element("s3-speak-word").click();
    view.audio.onplaying?.();
    view.audio.currentTime = 0.4;
    const lateEnd = view.audio.onended;
    if (reason === "blur") windowDouble.dispatchEvent(new Event("blur"));
    else if (reason === "hidden") { documentDouble.hidden = true; documentDouble.dispatchEvent(new Event("visibilitychange")) }
    else if (reason === "close") view.element("s3-close-inspect").click();
    else view.world.callbacks.onPause();
    expect(view.audio.paused).toBe(true);
    expect(view.audio.currentTime).toBe(0);
    expect(view.audio.onended).toBeNull();
    lateEnd?.();
    expect(view.element("s3-speech-status").textContent).not.toContain("已播放英式发音");
    expect(view.audio.play).toHaveBeenCalledOnce();
  });

  it.each(["milk", "bread"] as const)("uses a dedicated local %s phrase without system voices", async (productId) => {
    const view = await inspectWord(productId);
    view.element("s3-speak-phrase").click();
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.audio.src).toBe(`/assets/sim3d/audio/${productId}-phrase.wav`);
    expect(view.audio.playbackRate).toBe(1);
    expect(view.element("s3-speech-status").textContent).toContain("正在准备本地英式合成语音");
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.element("s3-speech-status").textContent).toContain("语音播放结束");
  });

  it("honours a muted volume setting instead of starting an inaudible recording", async () => {
    const view = await inspectWord();
    view.element("s3-close-inspect").click();
    view.element("s3-pause-button").click();
    view.element("s3-volume").value = "0";
    view.element("s3-volume").dispatchEvent(new Event("input"));
    view.element("s3-resume").click();
    view.world.callbacks.onInspect();
    view.element("s3-speak-word").click();
    expect(view.audio.play).not.toHaveBeenCalled();
    expect(view.element("s3-speech-status").textContent).toContain("音量当前为 0");
  });
});

describe("cursor access and nearby computer business panels", () => {
  it("requires the nearby computer and keeps ordinary pause menus free of business applications", async () => {
    const view = await readyGame();
    expect(view.root.innerHTML).not.toContain('class="s3-business-nav"');
    expect(view.root.innerHTML.match(/class="s3-desktop-icon"/g)).toHaveLength(6);
    const ids = [...view.root.innerHTML.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const distance of [3, Infinity, -1]) {
      view.world.callbacks.onTarget({ id: "computer", kind: "computer", label: "电脑", action: "打开", inspectable: false, distance });
      view.world.callbacks.onInteract();
      expect(view.element("s3-pause").open).toBe(false);
    }
    view.element("s3-pause-button").click();
    expect(view.element("s3-pause-options").hidden).toBe(false);
    expect(view.element("s3-computer-desktop").hidden).toBe(true);
    expect(view.element("s3-computer-apps").hidden).toBe(true);
    const before = savedState();
    view.element("s3-computer-upgrade").dispatchEvent(new Event("click"));
    view.element("s3-upgrade").dispatchEvent(new Event("click"));
    key("KeyB");
    expect(view.element("s3-panel-supply").hidden).toBe(true);
    expect(savedState()).toEqual(before);
  });

  it("keeps held merchandise and returns from an app to the desktop before exiting the computer", async () => {
    const state = act(createInitialSimState(), { type: "PICK_CRATE", crateId: "milk-crate" });
    const view = await readyGame(state);
    enterComputer(view);
    expect(view.element("s3-computer-desktop").hidden).toBe(false);
    expect(view.element("s3-pause-options").hidden).toBe(true);
    expect(view.element("s3-resume").textContent).toBe("退出电脑");
    view.element("s3-computer-supply").click();
    expect(view.element("s3-computer-back").hidden).toBe(false);
    key("Escape");
    expect(view.element("s3-pause").open).toBe(true);
    expect(view.element("s3-computer-desktop").hidden).toBe(false);
    expect(view.element("s3-panel-supply").hidden).toBe(true);
    key("Escape");
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.world.setActive).toHaveBeenLastCalledWith(true);
    expect(savedState().held).toEqual(state.held);
    expect(savedState().items).toEqual(state.items);
    key("KeyB");
    expect(view.element("s3-pause").open).toBe(false);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT", "contenteditable"])("does not switch computer apps while editing %s", async (tagName) => {
    const view = await readyGame();
    openComputerApp(view, "supply");
    Object.assign(documentDouble, { activeElement: { tagName, isContentEditable: tagName === "contenteditable" } });
    key("KeyU");
    expect(view.element("s3-panel-supply").hidden).toBe(false);
    expect(view.element("s3-panel-upgrade").hidden).toBe(true);
    Object.assign(documentDouble, { activeElement: null });
    key("KeyU");
    expect(view.element("s3-panel-upgrade").hidden).toBe(false);
  });

  it("opens and starts a stocked shop from the business application and exits so time can advance", async () => {
    const view = await readyGame(stockedFirstDay());
    openComputerApp(view, "day");
    expect(view.element("s3-computer-open-shop").disabled).toBe(false);
    view.element("s3-computer-open-shop").click();
    expect(savedState().day.phase).toBe("open");
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.world.setActive).toHaveBeenLastCalledWith(true);
  });

  it.each(["supply", "day", "upgrade", "equipment", "layout", "street"])("opens the %s desktop icon as one application window", async (section) => {
    const view = await readyGame();
    openComputerApp(view, section);
    expect(view.element(`s3-panel-${section}`).hidden).toBe(false);
    for (const other of ["supply", "day", "cash", "upgrade", "development", "equipment", "layout", "street"]) {
      if (other !== section) expect(view.element(`s3-panel-${other}`).hidden).toBe(true);
    }
    expect(view.element("s3-computer-back").hidden).toBe(false);
    view.element("s3-computer-back").click();
    expect(view.element("s3-computer-desktop").hidden).toBe(false);
    expect(view.element(`s3-panel-${section}`).hidden).toBe(true);
  });

  it("protects an unsaved layout when returning to the desktop, switching applications, or exiting", async () => {
    const view = await readyGame();
    openComputerApp(view, "layout");
    const editor = doubles.layoutEditors.at(-1)!;
    editor.hasUnsavedChanges.mockReturnValue(true);
    editor.discard.mockImplementation(() => editor.hasUnsavedChanges.mockReturnValue(false));
    for (const action of [() => view.element("s3-computer-back").click(), () => key("KeyB"), () => view.element("s3-resume").click()]) {
      action();
      expect(view.element("s3-layout-exit-confirm").hidden).toBe(false);
      expect(view.element("s3-panel-layout").hidden).toBe(false);
      expect(view.element("s3-pause").open).toBe(true);
      view.element("s3-layout-exit-keep").click();
      expect(editor.discard).not.toHaveBeenCalled();
    }
    view.element("s3-computer-back").click();
    view.element("s3-layout-exit-discard").click();
    expect(editor.discard).toHaveBeenCalledOnce();
    expect(view.element("s3-computer-desktop").hidden).toBe(false);
    expect(view.element("s3-pause").open).toBe(true);
  });

  it("uses Tab to free the pointer without pausing, and a second intentional Tab requests look control", async () => {
    const view = await readyGame();
    view.world.callbacks.onPointerMode?.("locked");
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(view.world.setCursorFree).toHaveBeenLastCalledWith(true);
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.world.setActive).toHaveBeenLastCalledWith(true);
    view.world.callbacks.onPointerMode?.("free");
    expect(view.element("s3-drag-hint").textContent).toContain("鼠标可点击");
    expect(view.element("s3-capture").hidden).toBe(false);
    key("Tab");
    expect(view.world.setCursorFree).toHaveBeenLastCalledWith(false);
    view.element("s3-capture").click();
    expect(view.world.requestPointerLock).toHaveBeenCalledOnce();
  });

  it.each([["KeyB", "supply"], ["KeyU", "upgrade"], ["KeyM", "street"], ["KeyP", "layout"]] as const)("opens %s only within a computer session and returns with clickable pointer", async (code, section) => {
    const view = await readyGame();
    view.world.callbacks.onPointerMode?.("locked");
    expect(key(code).defaultPrevented).toBe(true);
    expect(view.element("s3-pause").open).toBe(false);
    enterComputer(view);
    expect(key(code).defaultPrevented).toBe(true);
    expect(view.element("s3-pause").open).toBe(true);
    expect(view.element(`s3-panel-${section}`).hidden).toBe(false);
    expect(view.element("s3-computer-desktop").hidden).toBe(true);
    expect(view.world.setCursorFree).toHaveBeenLastCalledWith(true);
    expect(view.world.setActive).toHaveBeenLastCalledWith(false);
    view.world.callbacks.onPointerMode?.("free");
    view.element("s3-resume").click();
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.world.setActive).toHaveBeenLastCalledWith(true);
    expect(view.world.requestPointerLock).not.toHaveBeenCalled();
    expect(view.element("s3-capture").hidden).toBe(false);
  });

  it("keeps drag fallback available and does not capture the pointer after closing inspection", async () => {
    const view = await inspectWord();
    view.world.requestPointerLock.mockClear();
    view.world.callbacks.onPointerMode?.("drag");
    view.element("s3-close-inspect").click();
    expect(view.element("s3-capture").hidden).toBe(true);
    expect(view.element("s3-drag-hint").hidden).toBe(false);
    expect(view.element("s3-drag-hint").textContent).toContain("拖动观察");
    expect(view.world.requestPointerLock).not.toHaveBeenCalled();
    openComputerApp(view, "supply");
    expect(view.element("s3-pause").open).toBe(true);
  });
});

describe("automatic customer voice and manual replay wiring", () => {
  it("primes the same local media element muted during Start and restores it without claiming speech success", async () => {
    const view = mount();
    const loading = view.app.init();
    await settle();
    doubles.World.instances[0]!.complete();
    await loading;
    const audio = view.element("s3-word-audio");
    audio.play.mockImplementationOnce(async () => {
      expect(audio.muted).toBe(true);
      expect(audio.src).toBe(SPEECH_CLIPS.greeting.src);
      audio.paused = false;
    });
    view.element("s3-start-button").click();
    await settle();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.muted).toBe(false);
    expect(audio.paused).toBe(true);
    expect(view.element("s3-customer-audio-status").textContent).not.toContain("播放结束");
  });

  it.each([0, 1, 2])("speaks the correct checkout request after %i paid orders and releases the cursor", async (paidCustomers) => {
    const view = await readyGame(beforeCheckout(paidCustomers));
    view.world.callbacks.onPointerMode?.("locked");
    view.world.callbacks.onCustomerArrive();
    const clip = customerSpeechFor(savedState(), "checkout");
    const profile = customerProfileFor(savedState());
    expect(savedState().customer.phase).toBe("checkout");
    expect(view.audio.src).toBe(clip.src);
    expect(view.audio.src).toContain(`/customers/${profile.voice}/`);
    expect(view.element("s3-customer-name").textContent).toBe(`${profile.name} · 第 ${paidCustomers + 1} 位顾客`);
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.audio.muted).toBe(false);
    expect(view.element("s3-customer-line").textContent).toContain(clip.text);
    expect(view.element("s3-customer-zh").textContent).toBe(clip.zh);
    expect(view.element("s3-receipt").open).toBe(true);
    expect(view.world.setCursorFree).toHaveBeenLastCalledWith(true);
    expect(view.element("s3-pause").open).toBe(false);
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.element("s3-customer-audio-status").textContent).toContain("播放结束");
    expect(key("KeyR").defaultPrevented).toBe(true);
    expect(view.audio.play).toHaveBeenCalledTimes(2);
    expect(view.audio.src).toBe(clip.src);
    expect(savedState().transactions).toHaveLength(paidCustomers);
  });

  it("turns automatic speech off without removing subtitles, pointer release or manual R replay", async () => {
    const view = await readyGame(beforeCheckout());
    const clip = customerSpeechFor(savedState(), "checkout");
    view.element("s3-pause-button").click();
    view.element("s3-auto-speech").checked = false;
    view.element("s3-auto-speech").dispatchEvent(new Event("input"));
    view.element("s3-resume").click();
    view.world.callbacks.onCustomerArrive();
    expect(view.audio.play).not.toHaveBeenCalled();
    expect(view.element("s3-customer-line").textContent).toContain(clip.text);
    expect(view.element("s3-customer-audio-status").textContent).toContain("字幕始终保留");
    expect(view.world.setCursorFree).toHaveBeenLastCalledWith(true);
    expect(JSON.parse(storage.getItem("english-high-street:sim3d:settings:v1")!).autoSpeech).toBe(false);
    key("KeyR");
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.audio.src).toBe(clip.src);
  });

  it("reports rejected autoplay honestly, ignores false completion and allows explicit replay", async () => {
    const view = await readyGame(beforeCheckout());
    const clip = customerSpeechFor(savedState(), "checkout");
    view.audio.play.mockRejectedValueOnce(new Error("NotAllowedError"));
    view.world.callbacks.onCustomerArrive();
    view.audio.onended?.();
    expect(view.element("s3-customer-audio-status").textContent).not.toContain("播放结束");
    await settle();
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.element("s3-customer-audio-status").textContent).toContain("语音未能播放");
    expect(view.element("s3-customer-line").textContent).toContain(clip.text);
    expect(savedState().cashPence).toBe(510);
    view.element("s3-read-customer").click();
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.element("s3-customer-audio-status").textContent).toContain("播放结束");
    expect(view.audio.play).toHaveBeenCalledTimes(2);
    expect(view.audio.src).toBe(clip.src);
  });

  it("plays a polite repeat request followed only after real completion by the slower customer sentence", async () => {
    const view = await readyGame(beforeCheckout());
    const clip = customerSpeechFor(savedState(), "checkout");
    view.world.callbacks.onCustomerArrive();
    view.audio.play.mockClear();
    view.element("s3-repeat-customer").click();
    expect(view.audio.src).toBe(SPEECH_CLIPS.repeatRequest.src);
    expect(view.audio.playbackRate).toBe(1);
    expect(view.element("s3-customer-line").textContent).toContain(SPEECH_CLIPS.repeatRequest.text);
    view.audio.onended?.();
    expect(view.audio.play).toHaveBeenCalledOnce();
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.audio.play).toHaveBeenCalledTimes(2);
    expect(view.audio.src).toBe(clip.src);
    expect(view.audio.defaultPlaybackRate).toBe(0.84);
    expect(view.audio.playbackRate).toBe(0.84);
    view.audio.playbackRate = 1;
    view.audio.onloadedmetadata?.();
    expect(view.audio.playbackRate).toBe(0.84);
    expect(view.element("s3-customer-line").textContent).toContain(`顾客：“${clip.text}”`);
    expect(view.element("s3-customer-zh").textContent).toContain(clip.zh);
    expect(view.element("s3-customer-zh").textContent).toContain("这次慢一点说");
    expect(savedState().transactions).toHaveLength(0);
  });

  it("does not let stale metadata from an earlier clip overwrite a newer playback rate", async () => {
    const view = await readyGame(beforeCheckout());
    const clip = customerSpeechFor(savedState(), "checkout");
    view.world.callbacks.onCustomerArrive();
    const regularMetadata = view.audio.onloadedmetadata;
    view.element("s3-repeat-customer").click();
    view.audio.onplaying?.();
    view.audio.onended?.();
    const slowerMetadata = view.audio.onloadedmetadata;
    expect(view.audio.playbackRate).toBe(0.84);
    regularMetadata?.();
    expect(view.audio.playbackRate).toBe(0.84);
    key("KeyR");
    expect(view.audio.defaultPlaybackRate).toBe(1);
    expect(view.audio.playbackRate).toBe(1);
    expect(view.audio.src).toBe(clip.src);
    slowerMetadata?.();
    expect(view.audio.playbackRate).toBe(1);
    view.element("s3-pause-button").click();
    expect(view.audio.onloadedmetadata).toBeNull();
    slowerMetadata?.();
    expect(view.audio.playbackRate).toBe(1);
  });

  it("restores the customer subtitles when R interrupts a repeat request and ignores the request's stale completion", async () => {
    const view = await readyGame(beforeCheckout());
    const clip = customerSpeechFor(savedState(), "checkout");
    view.world.callbacks.onCustomerArrive();
    view.audio.play.mockClear();
    view.element("s3-repeat-customer").click();
    view.audio.onplaying?.();
    const interruptedRequestEnd = view.audio.onended;
    expect(view.audio.src).toBe(SPEECH_CLIPS.repeatRequest.src);
    expect(view.element("s3-customer-line").textContent).toContain(SPEECH_CLIPS.repeatRequest.text);
    expect(view.element("s3-customer-zh").textContent).toBe(SPEECH_CLIPS.repeatRequest.zh);

    key("KeyR");
    expect(view.audio.src).toBe(clip.src);
    expect(view.audio.playbackRate).toBe(1);
    expect(view.element("s3-customer-line").textContent).toContain(clip.text);
    expect(view.element("s3-customer-line").textContent).not.toContain(SPEECH_CLIPS.repeatRequest.text);
    expect(view.element("s3-customer-zh").textContent).toBe(clip.zh);

    interruptedRequestEnd?.();
    expect(view.audio.play).toHaveBeenCalledTimes(2);
    expect(view.audio.src).toBe(clip.src);
    expect(view.audio.playbackRate).toBe(1);
    expect(view.element("s3-customer-line").textContent).toContain(clip.text);
    expect(view.element("s3-customer-zh").textContent).toBe(clip.zh);
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.element("s3-customer-audio-status").textContent).toContain("播放结束");
    expect(view.audio.play).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending slower reply when the player pauses before the request finishes", async () => {
    const view = await readyGame(beforeCheckout());
    view.world.callbacks.onCustomerArrive();
    view.audio.play.mockClear();
    view.element("s3-repeat-customer").click();
    view.audio.onplaying?.();
    const lateEnd = view.audio.onended;
    view.element("s3-pause-button").click();
    lateEnd?.();
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.audio.paused).toBe(true);
    expect(view.element("s3-pause").open).toBe(true);
  });
});

describe("customer doorway cues are separate from shopping progress", () => {
  it("waits through the approach and pause/resume, then rings and greets without taking stock or saving an order step", async () => {
    frameTime();
    const view = await readyGame({ ...stockedFirstDay(), customerSeed: 31 });
    view.world.callbacks.onTarget({ id: "open-sign", kind: "open-sign", label: "营业牌", action: "开门营业", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    expect(view.world.isCustomerApproaching()).toBe(true);
    expect(view.element("s3-receipt-title").textContent).toBe("顾客正从街上走来");
    expect(view.element("s3-objective").textContent).toContain("正沿人行道走来");
    expect(view.element("s3-customer-audio-status").textContent).toContain("进店后会打招呼");
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    expect(view.audio.play).not.toHaveBeenCalled();

    view.element("s3-pause-button").click();
    view.element("s3-resume").click();
    expect(view.world.isCustomerApproaching()).toBe(true);
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    expect(view.audio.play).not.toHaveBeenCalled();
    const before = savedState();
    const saved = storage.getItem(SIM_STORAGE_KEY);
    const writes = storage.writes;
    const greeting = customerSpeechFor(before, "greeting");
    view.world.setState.mockClear();

    view.world.enterShop();
    expect(view.world.isCustomerApproaching()).toBe(false);
    expect(view.element("s3-receipt-title").textContent).toBe("顾客进店了");
    expect(view.element("s3-objective").textContent).toContain("正在挑选");
    expect(view.element("s3-customer-line").textContent).toContain(greeting.text);
    expect(view.audio.src).toBe(greeting.src);
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
    expect(savedState()).toEqual(before);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(saved);
    expect(storage.writes).toBe(writes);
    expect(view.world.setState).not.toHaveBeenCalled();
    expect(countAt(savedState(), "milk", "basket")).toBe(0);
    expect(countAt(savedState(), "milk", "shelf")).toBe(3);

    view.element("s3-pause-button").click();
    view.element("s3-resume").click();
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
    view.world.callbacks.onCustomerArrive();
    expect(savedState().customer.phase).toBe("to-bread");
    expect(countAt(savedState(), "milk", "basket")).toBe(1);
    expect(countAt(savedState(), "milk", "shelf")).toBe(2);
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
  });

  it("restores a saved street approach silently and greets its unchanged visitor only after the new doorway crossing", async () => {
    frameTime();
    const state = act({ ...stockedFirstDay(), customerSeed: 31 }, { type: "OPEN_STORE" });
    const view = await readyGame(state);
    expect(view.world.isCustomerApproaching()).toBe(true);
    expect(view.element("s3-receipt-title").textContent).toBe("顾客正从街上走来");
    expect(view.audio.src).toBe(SPEECH_CLIPS.greeting.src); // Only Start's muted media unlock has loaded audio.
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    expect(view.audio.play).not.toHaveBeenCalled();
    const before = savedState();

    view.world.enterShop();
    expect(view.audio.src).toBe(customerSpeechFor(before, "greeting").src);
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
    expect(savedState()).toEqual(before);
  });

  it("keeps the entrance bell and subtitles with automatic speech disabled and leaves manual greeting replay available", async () => {
    const view = await readyGame(stockedFirstDay());
    view.element("s3-pause-button").click();
    view.element("s3-auto-speech").checked = false;
    view.element("s3-auto-speech").dispatchEvent(new Event("input"));
    view.element("s3-resume").click();
    view.world.callbacks.onTarget({ id: "open-sign", kind: "open-sign", label: "营业牌", action: "开门营业", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    expect(view.audio.play).not.toHaveBeenCalled();
    view.world.enterShop();
    const greeting = customerSpeechFor(savedState(), "greeting");
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
    expect(view.audio.play).not.toHaveBeenCalled();
    expect(view.element("s3-customer-line").textContent).toContain(greeting.text);
    expect(view.element("s3-customer-zh").textContent).toBe(greeting.zh);
    expect(view.element("s3-customer-audio-status").textContent).toContain("字幕始终保留");
    key("KeyR");
    expect(view.audio.src).toBe(greeting.src);
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
  });

  it("ignores a replaced world's late entrance even after the new world starts, and ignores entry after disposal", async () => {
    frameTime();
    const view = await readyGame(act(stockedFirstDay(), { type: "OPEN_STORE" }));
    const oldWorld = view.world;
    const loading = view.app.init();
    await settle();
    const currentWorld = doubles.World.instances.at(-1)!;
    expect(currentWorld).not.toBe(oldWorld);
    expect(oldWorld.dispose).toHaveBeenCalledOnce();
    currentWorld.complete();
    await loading;
    view.element("s3-start-button").click();
    await settle();
    view.audio.play.mockClear();
    const before = savedState();
    const writes = storage.writes;
    expect(currentWorld.isCustomerApproaching()).toBe(true);

    oldWorld.enterShop();
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    expect(view.audio.play).not.toHaveBeenCalled();
    expect(view.element("s3-receipt-title").textContent).toBe("顾客正从街上走来");
    expect(savedState()).toEqual(before);
    expect(storage.writes).toBe(writes);
    currentWorld.enterShop();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.audio.src).toBe(customerSpeechFor(before, "greeting").src);
    expect(savedState()).toEqual(before);
    await view.app.dispose();
    currentWorld.callbacks.onCustomerEnter?.();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
    expect(view.audio.play).toHaveBeenCalledOnce();
  });
});

describe("customer identity, dialogue continuity and saved seeds", () => {
  it("keeps three visibly named customers and both voice sets consistent through greeting, scanning, payment and departure", async () => {
    const clock = frameTime();
    const view = await readyGame({ ...stockedFirstDay(), customerSeed: 31 });
    const profileIds = new Set<string>();
    const voices = new Set<CustomerVoice>();
    const greetingIds = new Set<string>();
    const checkoutIds = new Set<string>();
    const thanksIds = new Set<string>();
    view.world.callbacks.onTarget({ id: "open-sign", kind: "open-sign", label: "营业牌", action: "开门营业", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();

    for (let number = 1; number <= 3; number += 1) {
      const shopping = savedState();
      const profile = customerProfileFor(shopping);
      const greeting = customerSpeechFor(shopping, "greeting");
      profileIds.add(profile.id);
      voices.add(profile.voice);
      greetingIds.add(greeting.id);
      expect(shopping.customer).toEqual({ number, phase: "to-milk", shoppingList: ["milk", "bread"], contentVersion: 2 });
      expect(view.element("s3-customer-name").textContent).toBe(`${profile.name} · 第 ${number} 位顾客`);
      expect(view.world.isCustomerApproaching()).toBe(true);
      expect(view.element("s3-receipt-title").textContent).toBe("顾客正从街上走来");
      expect(view.audio.play).not.toHaveBeenCalled();
      view.world.enterShop();
      expect(view.element("s3-receipt-title").textContent).toBe("顾客进店了");
      expect(view.element("s3-customer-line").textContent).toContain(greeting.text);
      expect(view.element("s3-customer-zh").textContent).toBe(greeting.zh);
      expect(view.audio.src).toBe(greeting.src);
      expect(view.audio.src).toContain(`/customers/${profile.voice}/`);
      expect(view.audio.play).toHaveBeenCalledOnce();

      view.audio.play.mockClear();
      view.world.callbacks.onCustomerArrive();
      view.world.callbacks.onCustomerArrive();
      expect(view.audio.play).not.toHaveBeenCalled(); // Walking between shelves is not a new greeting.
      view.world.callbacks.onCustomerArrive();
      const checkout = customerSpeechFor(savedState(), "checkout");
      checkoutIds.add(checkout.id);
      expect(savedState().customer.phase).toBe("checkout");
      expect(customerProfileFor(savedState())).toEqual(profile);
      expect(view.audio.src).toBe(checkout.src);
      expect(view.element("s3-customer-line").textContent).toContain(checkout.text);
      expect(view.element("s3-customer-zh").textContent).toBe(checkout.zh);
      expect(view.audio.play).toHaveBeenCalledOnce();

      view.world.callbacks.onTarget({ id: "counter", kind: "counter", label: "收银台", action: "扫码收款", inspectable: false, distance: 1 });
      view.world.callbacks.onInteract();
      view.world.callbacks.onInteract();
      expect(savedState().scannedIds).toHaveLength(2);
      expect(view.audio.play).toHaveBeenCalledOnce(); // Scanning must not select/repeat another checkout line.
      expect(view.audio.src).toBe(checkout.src);
      expect(view.element("s3-customer-line").textContent).toContain(checkout.text);
      const scanned = savedState();
      const expectedVoicePlays = scanned.payment?.method === "cash" ? 3 : 2;
      view.world.callbacks.onInteract();
      if (scanned.payment?.method === "cash") {
        expect(view.element("s3-cash-dialog").open).toBe(true);
        expect(view.audio.src).toBe(cashTenderSpeechFor(scanned)?.src);
        expect(view.audio.src).toContain(`/customers/${profile.voice}/`);
        view.element("s3-cash-receive").click();
        let change = cashChangeDuePence(scanned.payment, getCheckoutTotal(scanned));
        for (const denomination of [...CASH_DENOMINATIONS_PENCE].reverse()) {
          while (change >= denomination) { view.element(`s3-cash-add-${denomination}`).click(); change -= denomination }
        }
        view.element("s3-cash-confirm").click();
        expect(view.element("s3-cash-dialog").open).toBe(false);
      }
      const thanks = customerSpeechFor(savedState(), "thanks");
      thanksIds.add(thanks.id);
      expect(savedState().customer.phase).toBe("leaving");
      expect(savedState().transactions).toHaveLength(number);
      expect(savedState().cashPence).toBe(510 + number * 400);
      expect(customerProfileFor(savedState())).toEqual(profile);
      expect(view.audio.src).toBe(thanks.src);
      expect(view.element("s3-customer-line").textContent).toContain(thanks.text);
      expect(view.element("s3-customer-zh").textContent).toBe(thanks.zh);
      expect(view.audio.play).toHaveBeenCalledTimes(expectedVoicePlays);
      view.world.callbacks.onCustomerArrive();
      expect(savedState().customer.phase).toBe("complete");
      expect(view.audio.play).toHaveBeenCalledTimes(expectedVoicePlays); // Departure is not a second thank-you.
      view.audio.play.mockClear();
      const afterDeparture = savedState();
      clock.advance(view, afterDeparture.day.nextCustomerAtMs! - afterDeparture.day.elapsedOpenMs);
    }

    expect(profileIds.size).toBe(3);
    expect([...voices].sort()).toEqual(["female", "male"]);
    expect(greetingIds.size).toBe(3);
    expect(checkoutIds.size).toBe(3);
    expect(thanksIds.size).toBe(3);
    expect(savedState().customer).toEqual({ number: 3, phase: "complete", shoppingList: ["milk", "bread"], contentVersion: 2 });
    expect(view.element("s3-pause").open).toBe(false);
    expect(savedState().day.phase).toBe("open");
    openComputerApp(view, "day");
    expect(view.element("s3-settle-day").hidden).toBe(true);
    expect(view.audio.play).not.toHaveBeenCalled();
  });

  it.each(["female", "male"] as const)("uses the %s customer's own file when its text exactly matches a legacy clip, including replay and slow reply", async (voice) => {
    const view = await readyGame(checkoutWithLegacyPhrase(voice));
    view.world.callbacks.onCustomerArrive();
    const state = savedState();
    const clip = customerSpeechFor(state, "checkout");
    expect(clip.text).toBe(SPEECH_CLIPS.card.text);
    expect(clip.src).not.toBe(SPEECH_CLIPS.card.src);
    expect(clip.src).toContain(`/customers/${voice}/`);
    expect(view.audio.src).toBe(clip.src);
    expect(view.audio.play).toHaveBeenCalledOnce();
    const snapshot = storage.getItem(SIM_STORAGE_KEY);
    key("KeyR");
    view.element("s3-read-customer").click();
    expect(view.audio.play).toHaveBeenCalledTimes(3);
    expect(view.audio.src).toBe(clip.src);
    expect(view.audio.playbackRate).toBe(1);
    expect(view.element("s3-customer-line").textContent).toContain(clip.text);
    expect(view.element("s3-customer-zh").textContent).toBe(clip.zh);
    view.element("s3-repeat-customer").click();
    expect(view.audio.src).toBe(SPEECH_CLIPS.repeatRequest.src); // The player's sentence still uses its dedicated recording.
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.audio.play).toHaveBeenCalledTimes(5);
    expect(view.audio.src).toBe(clip.src);
    expect(view.audio.defaultPlaybackRate).toBe(0.84);
    expect(view.audio.playbackRate).toBe(0.84);
    expect(view.element("s3-customer-line").textContent).toContain(`顾客：“${clip.text}”`);
    expect(view.element("s3-customer-zh").textContent).toBe(`${clip.zh} · 这次慢一点说`);
    expect(customerSpeechFor(savedState(), "checkout")).toEqual(clip);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(snapshot);
  });

  it("draws a new seed after writer admission, first saves it on Start and retains it across reload and takeover", async () => {
    const entropy = stubCustomerEntropy(0x1234abcd);
    const view = mount();
    expect(entropy).not.toHaveBeenCalled();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    const loading = view.app.init();
    await settle();
    expect(locks.held).toBe(true);
    expect(entropy).toHaveBeenCalledOnce();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull(); // Loading alone is not a started game.
    doubles.World.instances[0]!.complete();
    await loading;
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    view.element("s3-start-button").click();
    await settle();
    const firstSnapshot = savedState();
    expect(firstSnapshot.customerSeed).toBe(0x1234abcd);
    expect(firstSnapshot.cashPence).toBe(1200);
    expect(firstSnapshot.items).toEqual([]);
    await view.app.dispose();

    const restored = mount();
    const restoredLoading = restored.app.init();
    await settle();
    doubles.World.instances[1]!.complete();
    await restoredLoading;
    restored.element("s3-start-button").click();
    await settle();
    expect(entropy).toHaveBeenCalledOnce();
    expect(savedState().customerSeed).toBe(firstSnapshot.customerSeed);
    expect(customerProfileFor(savedState())).toEqual(customerProfileFor(firstSnapshot));
    expect(customerSpeechFor(savedState(), "greeting")).toEqual(customerSpeechFor(firstSnapshot, "greeting"));

    const observer = mount();
    const observerLoading = observer.app.init();
    await settle();
    doubles.World.instances.at(-1)!.complete();
    await observerLoading;
    expect(observer.element("s3-start-button").disabled).toBe(true);
    expect(observer.element("s3-start-button").textContent).toBe("此页面只读");
    expect(entropy).toHaveBeenCalledOnce();
    await restored.app.dispose();
    observer.element("s3-takeover").click();
    await settle();
    doubles.World.instances.at(-1)!.complete();
    await settle();
    observer.element("s3-start-button").click();
    await settle();
    expect(observer.element("s3-start").hidden).toBe(true);
    expect(entropy).toHaveBeenCalledOnce();
    expect(savedState().customerSeed).toBe(firstSnapshot.customerSeed);
    expect(customerProfileFor(savedState())).toEqual(customerProfileFor(firstSnapshot));
    expect(customerSpeechFor(savedState(), "greeting")).toEqual(customerSpeechFor(firstSnapshot, "greeting"));
  });

  it("does not draw or persist a seed on a read-only page with no existing snapshot", async () => {
    const entropy = stubCustomerEntropy(0xfedcba98);
    locks.held = true;
    const view = mount();
    const loading = view.app.init();
    await settle();
    doubles.World.instances[0]!.complete();
    await loading;
    view.element("s3-start-button").click();
    expect(view.element("s3-start-button").disabled).toBe(true);
    expect(view.element("s3-start-button").textContent).toBe("此页面只读");
    expect(entropy).not.toHaveBeenCalled();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBeNull();
    expect(storage.writes).toBe(0);
  });

  it.each([undefined, 0, 20260831])("retains seed %s, customer name and exact checkout voice after a real remount", async (seed) => {
    const entropy = stubCustomerEntropy(0xabcdef01);
    const state = beforeCheckout(1);
    if (seed !== undefined) state.customerSeed = seed;
    const view = await readyGame(state);
    view.world.callbacks.onCustomerArrive();
    const expectedState = savedState();
    const clip = customerSpeechFor(expectedState, "checkout");
    const profile = customerProfileFor(expectedState);
    const name = `${profile.name} · 第 2 位顾客`;
    expect(view.element("s3-customer-name").textContent).toBe(name);
    expect(view.audio.src).toBe(clip.src);
    await view.app.dispose();

    const restored = mount();
    const loading = restored.app.init();
    await settle();
    doubles.World.instances.at(-1)!.complete();
    await loading;
    restored.element("s3-start-button").click();
    await settle();
    expect(entropy).not.toHaveBeenCalled();
    expect(savedState().customerSeed).toBe(seed);
    expect(savedState().customer).toEqual(expectedState.customer);
    expect(savedState().transactions).toEqual(expectedState.transactions);
    expect(restored.element("s3-customer-name").textContent).toBe(name);
    expect(restored.element("s3-customer-line").textContent).toContain(clip.text);
    expect(restored.element("s3-customer-zh").textContent).toBe(clip.zh);
    expect(restored.element("s3-word-audio").src).toBe(clip.src);
    if (seed === undefined) {
      expect(savedState()).not.toHaveProperty("customerSeed");
      expect(clip).toEqual(customerSpeechFor({ ...expectedState, customerSeed: 31 }, "checkout"));
    }
  });

  it.each([undefined, 0, 827381])("imports seed %s without redrawing it and restores the imported customer's identity and audio", async (seed) => {
    const entropy = stubCustomerEntropy(0xdeadbeef);
    const view = await readyGame({ ...beforeCheckout(), customerSeed: 88 });
    view.element("s3-pause-button").click();
    const original = storage.getItem(SIM_STORAGE_KEY);
    const imported = act(beforeCheckout(2), { type: "CUSTOMER_ADVANCE" });
    if (seed !== undefined) imported.customerSeed = seed;
    const clip = customerSpeechFor(imported, "checkout");
    const profile = customerProfileFor(imported);
    const raw = JSON.stringify(imported);
    const input = view.element("s3-import-file");
    input.files = [{ name: "customer-seed.json", size: raw.length, text: async () => raw }];
    input.dispatchEvent(new Event("change"));
    await settle();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(original);
    view.element("s3-import-confirm-button").click();
    await settle();
    doubles.World.instances.at(-1)!.complete();
    await settle();
    expect(savedState()).toEqual(imported);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(original);
    view.element("s3-start-button").click();
    await settle();
    expect(entropy).not.toHaveBeenCalled();
    expect(savedState().customerSeed).toBe(seed);
    expect(view.element("s3-customer-name").textContent).toBe(`${profile.name} · 第 3 位顾客`);
    expect(view.element("s3-customer-line").textContent).toContain(clip.text);
    expect(view.element("s3-customer-zh").textContent).toBe(clip.zh);
    expect(view.audio.src).toBe(clip.src);
    key("KeyR");
    expect(view.audio.src).toBe(clip.src);
    expect(customerSpeechFor(savedState(), "checkout")).toEqual(clip);
    if (seed === undefined) expect(savedState()).not.toHaveProperty("customerSeed");
  });

  it("generates a replacement seed only after restart confirmation and preserves the old seed in backup", async () => {
    const entropy = stubCustomerEntropy(0x12345678);
    const view = await readyGame({ ...beforeCheckout(1), customerSeed: 77 });
    view.element("s3-pause-button").click();
    const original = storage.getItem(SIM_STORAGE_KEY);
    view.element("s3-restart").click();
    expect(view.element("s3-restart-confirm").hidden).toBe(false);
    expect(entropy).not.toHaveBeenCalled();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(original);
    view.element("s3-restart-cancel").click();
    expect(entropy).not.toHaveBeenCalled();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(original);
    view.element("s3-restart").click();
    view.element("s3-restart-confirm-button").click();
    const fresh = savedState();
    expect(entropy).toHaveBeenCalledOnce();
    expect(fresh.customerSeed).toBe(0x12345678);
    expect(fresh.customerSeed).not.toBe(77);
    expect(fresh.customer).toEqual({ number: 1, phase: "outside", shoppingList: [], contentVersion: 2 });
    expect(fresh.cashPence).toBe(1200);
    expect(fresh.transactions).toEqual([]);
    expect(storage.getItem(SIM_BACKUP_KEY)).toBe(original);
    expect(view.world.setState).toHaveBeenLastCalledWith(fresh);
    expect(view.element("s3-start").hidden).toBe(false);
    view.element("s3-start-button").click();
    await settle();
    expect(entropy).toHaveBeenCalledOnce();
    expect(savedState().customerSeed).toBe(fresh.customerSeed);
  });
});

describe("first-day management event wiring and persistence", () => {
  it("starts with an empty cart, buys only manually selected quantities and ignores duplicate clicks after return", async () => {
    const view = await readyGame();
    openComputerApp(view, "supply");
    expect(view.element("s3-panel-supply").hidden).toBe(false);
    expect(view.element("s3-supply-total").textContent).toBe("−£0.00");
    expect(view.element("s3-purchase").disabled).toBe(true);
    for (const productId of PRODUCT_IDS) expect(view.element(`s3-quantity-${productId}`).value).toBe("0");
    setQuantity(view, "milk", 3);
    setQuantity(view, "bread", 3);
    expect(view.element("s3-supply-total").textContent).toBe("−£6.90");
    expect(view.element("s3-supply-after").textContent).toBe("£5.10");
    expect(view.element("s3-purchase").disabled).toBe(false);
    view.element("s3-purchase").click();
    view.element("s3-purchase").click();
    const state = savedState();
    expect(state.cashPence).toBe(510);
    expect(state.purchases).toHaveLength(1);
    expect(state.purchases[0]?.lines).toEqual([{ productId: "milk", quantity: 3 }, { productId: "bread", quantity: 3 }]);
    expect(state.items).toHaveLength(6);
    expect(countAt(state, "milk", "crate")).toBe(0);
    expect(countAt(state, "bread", "crate")).toBe(0);
    expect(getDeliverySummary(state)).toMatchObject({ pendingOrders: 1, pendingUnits: 6, receivedToday: 0 });
    expect(view.element("s3-delivery-hud").hidden).toBe(false);
    expect(view.element("s3-delivery-hud").textContent).toContain("本单备货中");
    expect(view.world.setState).toHaveBeenLastCalledWith(state);
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.world.requestPointerLock).not.toHaveBeenCalled();
    expect(view.element("s3-toast").textContent).toContain("下单成功");
    expect(view.element("s3-toast").textContent).toContain("门口按 E 签收");
    openComputerApp(view, "supply");
    expect(view.element("s3-quantity-milk").value).toBe("0");
    expect(view.element("s3-quantity-bread").value).toBe("0");
    expect(view.element("s3-purchase").disabled).toBe(true);
  });

  it("disables unaffordable purchases with an explicit reason, and a smaller selection restores availability", async () => {
    const view = await readyGame();
    openComputerApp(view, "supply");
    setQuantity(view, "milk", 6);
    setQuantity(view, "bread", 6);
    expect(view.element("s3-purchase").disabled).toBe(true);
    expect(view.element("s3-supply-error").textContent).toContain("资金不足");
    expect(view.element("s3-supply-total").textContent).toBe("−£13.80");
    const before = storage.getItem(SIM_STORAGE_KEY);
    view.element("s3-purchase").click();
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(before);
    setQuantity(view, "milk", 1);
    setQuantity(view, "bread", 1);
    expect(view.element("s3-purchase").disabled).toBe(false);
    expect(view.element("s3-supply-total").textContent).toBe("−£2.30");
  });

  it("makes a funded £8 upgrade directly reachable, charges exactly once and creates no merchandise", async () => {
    const view = await readyGame();
    expect(view.element("s3-computer-upgrade").getAttribute("aria-label")).toContain("资金足够");
    enterComputer(view);
    key("KeyU");
    expect(view.element("s3-panel-upgrade").hidden).toBe(false);
    expect(view.element("s3-upgrade").disabled).toBe(false);
    expect(view.element("s3-upgrade-status").textContent).toContain("不需要答题解锁");
    view.element("s3-upgrade").click();
    view.element("s3-upgrade").click();
    const state = savedState();
    expect(state.cashPence).toBe(400);
    expect(state.upgraded).toBe(true);
    expect(capacityFor(state)).toBe(8);
    expect(state.items).toEqual([]);
    expect(state.inspectedProducts).toEqual([]);
    expect(view.element("s3-upgrade").disabled).toBe(true);
    expect(view.element("s3-capacity-now").textContent).toBe("8");
    expect(view.element("s3-day-investment").textContent).toBe("£8.00");
    expect(view.element("s3-cash").textContent).toBe("£4.00");
  });

  it("explains an insufficient upgrade balance instead of hiding the entry", async () => {
    const state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "starter", pairs: 3 });
    const view = await readyGame(state);
    openComputerApp(view, "upgrade");
    expect(view.element("s3-panel-upgrade").hidden).toBe(false);
    expect(view.element("s3-upgrade").disabled).toBe(true);
    expect(view.element("s3-upgrade-status").textContent).toContain("还差 £2.90");
    view.element("s3-upgrade").click();
    expect(savedState().cashPence).toBe(510);
    expect(savedState().upgraded).toBe(false);
  });

  it("waits for departure, settles once, expands and retains cash plus unsold inventory on the next day", async () => {
    let state = stockedFirstDay(4);
    state = completeOrder(completeOrder(state));
    state = completeOrder(state, false);
    const view = await readyGame(state);
    openComputerApp(view, "day");
    expect(view.element("s3-settle-day").hidden).toBe(true);
    view.element("s3-close-shop").click();
    view.element("s3-close-confirm-button").click();
    expect(view.element("s3-settle-day").disabled).toBe(true);
    expect(view.element("s3-day-reason").textContent).toContain("正在离店");
    expect(view.element("s3-day-revenue").textContent).toBe("£12.00");
    expect(view.element("s3-day-cogs").textContent).toBe("£6.90");
    expect(view.element("s3-day-profit").textContent).toBe("£5.10");
    expect(view.element("s3-day-procurement").textContent).toBe("£9.20");
    expect(view.element("s3-day-inventory").textContent).toBe("2 件 / £2.30");
    view.element("s3-settle-day").click();
    expect(savedState().settlements).toEqual([]);
    view.element("s3-resume").click();
    view.world.callbacks.onCustomerArrive();
    openComputerApp(view, "day");
    expect(view.element("s3-settle-day").disabled).toBe(false);
    view.element("s3-settle-day").click();
    view.element("s3-settle-day").click();
    expect(savedState().day.phase).toBe("settled");
    expect(savedState().cashPence).toBe(1480);
    expect(savedState().settlements).toHaveLength(1);
    expect(view.element("s3-day-title").textContent).toContain("日结完成");
    expect(view.element("s3-next-day").hidden).toBe(false);
    view.element("s3-day-to-upgrade").click();
    view.element("s3-upgrade").click();
    expect(savedState().cashPence).toBe(680);
    expect(savedState().settlements[0]?.upgradeSpendPence).toBe(800);
    view.element("s3-tab-day").click();
    const beforeNextDay = savedState();
    view.element("s3-next-day").click();
    const nextDay = savedState();
    expect(nextDay.day).toMatchObject({ number: 2, phase: "preparing", openingCashPence: 680, openingStockUnits: 2, openingInventoryValuePence: 230 });
    expect(nextDay.items).toEqual(beforeNextDay.items);
    expect(nextDay.transactions).toEqual(beforeNextDay.transactions);
    expect(nextDay.cashPence).toBe(680);
    expect(nextDay.upgraded).toBe(true);
    expect(view.element("s3-panel-supply").hidden).toBe(false);
    expect(view.element("s3-day-revenue").textContent).toBe("£0.00");
    expect(view.element("s3-day-investment").textContent).toBe("£0.00");
    expect(view.element("s3-cash").textContent).toBe("£6.80");
    expect(view.element("s3-phase").textContent).toContain("第 2 天");
  });

  it.each([1, 3])("automatically admits another guest after %i paid orders without a daily cap", async (paidCustomers) => {
    const clock = frameTime();
    let state = stockedFirstDay(4);
    for (let count = 0; count < paidCustomers; count += 1) state = completeOrder(state);
    const view = await readyGame(state);
    const delay = state.day.nextCustomerAtMs! - state.day.elapsedOpenMs;
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(4000);
    clock.advance(view, delay - 1);
    expect(savedState().customer.phase).toBe("complete");
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.audio.play).not.toHaveBeenCalled();
    clock.advance(view, 1);
    expect(savedState().customer).toEqual({ number: paidCustomers + 1, phase: "to-milk", shoppingList: ["milk", "bread"], contentVersion: 2 });
    expect(view.world.isCustomerApproaching()).toBe(true);
    expect(view.element("s3-receipt-title").textContent).toBe("顾客正从街上走来");
    expect(view.audio.play).not.toHaveBeenCalled();
    view.world.enterShop();
    expect(view.audio.src).toBe(customerSpeechFor(savedState(), "greeting").src);
    expect(view.audio.play).toHaveBeenCalledOnce();
    expect(view.element("s3-pause").open).toBe(false);
    expect(savedState().transactions).toHaveLength(paidCustomers);
    expect(savedState().day.phase).toBe("open");
  });
});

describe("doorstep delivery and high street management", () => {
  it("renders the collapsible per-order ledger only in the supply app and preserves the remaining queue after receipt", async () => {
    const clock = frameTime();
    let pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "list-apple", lines: [{ productId: "apple", quantity: 2 }] });
    pending = waitForDelivery(act(pending, { type: "PURCHASE_STOCK", orderId: "list-soap", lines: [{ productId: "soap", quantity: 1 }] }));
    const view = await readyGame(pending);
    const content = view.element("s3-purchase-orders-content");
    expect(content.innerHTML).toBe("");
    const writes = vi.spyOn(content, "innerHTML", "set");
    enterComputer(view);
    expect(writes).not.toHaveBeenCalled();
    openComputerApp(view, "supply");
    expect(view.element("s3-purchase-orders-summary").textContent).toContain("2 单待收货 / 显示 2 单");
    expect(content.innerHTML).toContain("苹果 × 2");
    expect(content.innerHTML).toContain("待签收");
    expect(content.innerHTML).toContain("前方 1 单");
    expect(writes).toHaveBeenCalledTimes(1);
    view.element("s3-purchase-orders").open = true;
    clock.advance(view, 1000);
    view.element("s3-computer-back").click();
    view.element("s3-computer-supply").click();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(view.element("s3-purchase-orders").open).toBe(true);
    view.element("s3-resume").click();
    view.world.callbacks.onTarget(deliveryTarget());
    view.world.callbacks.onInteract();
    expect(writes).toHaveBeenCalledTimes(1);
    openComputerApp(view, "supply");
    expect(writes).toHaveBeenCalledTimes(2);
    expect(view.element("s3-purchase-orders-summary").textContent).toContain("1 单待收货 / 显示 2 单");
    expect(content.innerHTML).toContain("已签收 · 货车驶离中");
    expect(content.innerHTML).toContain("前方 1 单");
    expect(savedState().purchases.map((order) => order.receivedDay)).toEqual([1, null]);
    view.element("s3-resume").click();
    clock.advance(view, 4000);
    expect(writes).toHaveBeenCalledTimes(2);
    openComputerApp(view, "supply");
    expect(content.innerHTML).toContain("备货中 · 约 12 秒后停稳");
    expect(content.innerHTML).not.toContain("前方 1 单");
  });

  it("advances one saved delivery independently during preparation and freezes it throughout a computer session", async () => {
    const clock = frameTime();
    const pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "delivery-clock", lines: [{ productId: "apple", quantity: 1 }] });
    const view = await readyGame(pending);
    view.world.setState.mockClear();
    clock.advance(view, 6000);
    expect(savedState().delivery).toMatchObject({ phase: "arriving", elapsedMs: 0 });
    expect(savedState().day.elapsedOpenMs).toBe(0);
    expect(view.world.setState).not.toHaveBeenCalled();
    expect(view.world.setDeliveryState).toHaveBeenCalled();
    enterComputer(view);
    const paused = savedState();
    clock.advance(view, 9000);
    expect(savedState()).toEqual(paused);
    expect(view.element("s3-computer-delivery").textContent).toContain("约 6 秒");
    key("Escape");
    clock.advance(view, 6000);
    expect(savedState().delivery.phase).toBe("ready");
    expect(view.element("s3-delivery-hud").textContent).toContain("本单 1 件已到门口");
    expect(savedState().day.elapsedOpenMs).toBe(0);
  });

  it("waits for a blocked vehicle and resumes the same phase after the road is clear", async () => {
    const clock = frameTime();
    const pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "traffic-delivery", lines: [{ productId: "apple", quantity: 1 }] });
    const view = await readyGame(pending);
    clock.advance(view, 6000);
    view.world.isDeliveryBlocked.mockReturnValue(true);
    clock.advance(view, 2500);
    expect(savedState().delivery).toMatchObject({ phase: "arriving", blocked: true, elapsedMs: 0 });
    expect(view.element("s3-delivery-hud").textContent).toContain("让行中");
    view.world.isDeliveryBlocked.mockReturnValue(false);
    clock.advance(view, 6000);
    expect(savedState().delivery).toMatchObject({ phase: "ready", blocked: false });
  });

  it("continues delivery during cash checkout, pauses for deliberate learning, and never gives queued goods early", async () => {
    const clock = frameTime();
    let state = act(cashCheckoutState(), { type: "PURCHASE_STOCK", orderId: "cash-checkout-delivery", lines: [{ productId: "apple", quantity: 1 }] });
    state = act(state, { type: "PURCHASE_STOCK", orderId: "cash-checkout-delivery-2", lines: [{ productId: "soap", quantity: 1 }] });
    const view = await readyGame(state);
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    clock.advance(view, 6000);
    expect(savedState().delivery.phase).toBe("arriving");
    key("KeyR");
    view.audio.onplaying?.();
    const paused = savedState().delivery;
    clock.advance(view, 4000);
    expect(savedState().delivery).toEqual(paused);
    view.audio.onended?.();
    clock.advance(view, 6000);
    expect(savedState().delivery.phase).toBe("ready");
    expect(view.element("s3-delivery-hud").textContent).toContain("后方 1 单排队");
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(2);
    expect(savedState().items.filter((item) => item.productId === "soap").every((item) => item.location.kind === "delivery")).toBe(true);
  });

  it("keeps paid deliveries pending until a nearby physical interaction, then preserves payment exactly once", async () => {
    const pending = waitForDelivery(act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "doorstep-order", pairs: 3 }));
    const view = await readyGame(pending);
    view.world.callbacks.onTarget(deliveryTarget(5));
    expect(view.element("s3-interact").disabled).toBe(true);
    view.world.callbacks.onInteract();
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(6);
    view.world.callbacks.onTarget(deliveryTarget());
    expect(view.element("s3-interact").disabled).toBe(false);
    expect(view.element("s3-target-action").textContent).toContain("签收本单 6 件");
    view.element("s3-interact").click();
    expect(savedState().cashPence).toBe(510);
    expect(getDeliverySummary(savedState())).toMatchObject({ pendingUnits: 0, receivedToday: 1 });
    expect(savedState().crates.map((crate) => crate.position)).toEqual(DELIVERY_DROP_POINTS.slice(0, 2));
    expect(view.element("s3-delivery-hud").textContent).toContain("货车驶离中");
    view.world.callbacks.onInteract();
    expect(view.element("s3-panel-supply").hidden).toBe(true);
    expect(view.element("s3-pause").open).toBe(false);
    expect(savedState().cashPence).toBe(510);
    expect(savedState().purchases).toHaveLength(1);
  });

  it("checks unloading space against the latest world pose before rejecting delivery", async () => {
    let pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "blocked-drop", pairs: 1 });
    pending = waitForDelivery(act(pending, { type: "SAVE_POSE", pose: { ...pending.playerPose, ...DELIVERY_DROP_POINTS[0]! } }));
    const view = await readyGame(pending);
    view.world.callbacks.onTarget(deliveryTarget());
    view.world.callbacks.onInteract();
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(2);
    expect(view.element("s3-toast").textContent).toContain("请先离开货箱位置");
    Object.assign(view.world.getPose(), { x: 0, z: -7.5 });
    view.world.callbacks.onInteract();
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(0);
    expect(savedState().cashPence).toBe(970);
  });

  it("ignores paused world interactions while allowing computer application shortcuts", async () => {
    const state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "paused-delivery", pairs: 1 });
    const view = await readyGame(state);
    openComputerApp(view, "street");
    const snapshot = storage.getItem(SIM_STORAGE_KEY);
    view.world.callbacks.onTarget(deliveryTarget());
    view.world.callbacks.onInteract();
    expect(view.element("s3-panel-street").hidden).toBe(false);
    key("KeyB");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(snapshot);
    expect(view.element("s3-panel-street").hidden).toBe(true);
    expect(view.element("s3-panel-supply").hidden).toBe(false);
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(2);
  });

  it("restores a pending paid order with a visible delivery reminder after remount", async () => {
    const pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "saved-delivery", pairs: 3 });
    const first = await readyGame(pending);
    await first.app.dispose();
    const restored = await readyGame(savedState());
    expect(restored.element("s3-delivery-hud").hidden).toBe(false);
    expect(restored.element("s3-delivery-hud").textContent).toContain("本单备货中");
    openComputerApp(restored, "supply");
    expect(restored.element("s3-delivery-summary").textContent).toContain("1 单、6 件待收货");
    expect(savedState().cashPence).toBe(510);
    expect(countAt(savedState(), "milk", "crate")).toBe(0);
  });

  it("shows delivery as the reason day settlement is blocked after all customers have left", async () => {
    const clock = frameTime();
    let state = stockedFirstDay();
    for (let count = 0; count < 3; count += 1) state = completeOrder(state);
    state = act(state, { type: "PURCHASE_STOCK", orderId: "tomorrow-order", pairs: 1 });
    state = act(state, { type: "CLOSE_STORE" });
    const view = await readyGame(state);
    openComputerApp(view, "day");
    expect(view.element("s3-settle-day").disabled).toBe(true);
    expect(view.element("s3-day-reason").textContent).toContain("2 件已付款商品待签收");
    expect(view.element("s3-day-reason").textContent).not.toContain("正在离店");
    view.element("s3-resume").click();
    clock.advance(view, 12_000);
    view.world.callbacks.onTarget(deliveryTarget());
    view.world.callbacks.onInteract();
    openComputerApp(view, "day");
    expect(view.element("s3-settle-day").disabled).toBe(true);
    expect(view.element("s3-day-reason").textContent).toContain("货车驶离后可日结");
    view.element("s3-resume").click();
    clock.advance(view, 4000);
    openComputerApp(view, "day");
    expect(view.element("s3-settle-day").disabled).toBe(false);
  });

  it("opens full street information on the computer and read-only signs in the world", async () => {
    const view = await readyGame();
    const funds = savedState().cashPence;
    openComputerApp(view, "street");
    expect(view.element("s3-pause").open).toBe(true);
    expect(view.element("s3-panel-street").hidden).toBe(false);
    expect(view.element("s3-street-level").textContent).toBe("Lv. 1");
    expect(view.element("s3-street-progress").getAttribute("aria-valuenow")).toBe("0");
    for (const venue of ["cafe", "restaurant", "supermarket"]) {
      expect(view.element(`s3-venue-status-${venue}`).textContent).toBe("暂未开放");
    }
    view.element("s3-venue-supermarket").click();
    expect(view.element("s3-venue-detail-supermarket").hidden).toBe(false);
    expect(view.element("s3-venue-detail-cafe").hidden).toBe(true);
    expect(view.element("s3-requirement-progress-supermarket-level").textContent).toBe("1 / 5");
    expect(view.element("s3-requirement-progress-supermarket-paid-orders").textContent).toBe("0 / 30");
    expect(view.element("s3-requirement-progress-supermarket-upgrade").textContent).toBe("0 / 1");
    view.element("s3-resume").click();
    view.world.callbacks.onTarget(venueTarget("restaurant", 4));
    view.world.callbacks.onInteract();
    expect(view.element("s3-pause").open).toBe(false);
    view.world.callbacks.onTarget(venueTarget("restaurant"));
    view.world.callbacks.onInteract();
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.element("s3-venue-info").hidden).toBe(false);
    expect(view.element("s3-venue-info-title").textContent).toContain("邻里餐厅");
    expect(view.element("s3-venue-info-body").textContent).toContain("累计完成 12 单");
    expect(view.world.setActive).toHaveBeenLastCalledWith(true);
    expect(savedState().cashPence).toBe(funds);
    expect(savedState().inspectedProducts).toEqual([]);
  });

  it("announces achieved shop conditions as preparation while keeping interiors unavailable", async () => {
    let state = stockedFirstDay();
    for (let count = 0; count < 3; count += 1) state = completeOrder(state);
    state = act(state, { type: "CLOSE_STORE" });
    state = act(state, { type: "SETTLE_DAY" });
    const view = await readyGame(state);
    openComputerApp(view, "street");
    expect(view.element("s3-street-level").textContent).toBe("Lv. 2");
    expect(view.element("s3-street-progress").getAttribute("aria-valuenow")).toBe("0");
    expect(view.element("s3-venue-status-cafe").textContent).toBe("条件已达成·筹备中");
    expect(view.element("s3-requirement-progress-cafe-settlement").textContent).toBe("1 / 1 · 已达成");
    expect(view.element("s3-venue-note-cafe").textContent).toContain("内部经营尚未开放");
    expect(view.element("s3-venue-status-restaurant").textContent).toBe("暂未开放");
    expect(view.element("s3-venue-status-supermarket").textContent).toBe("暂未开放");
  });
});

describe("self-selected catalogue procurement", () => {
  it("offers all 30 pictured products without default quantities and buys only the chosen new SKUs", async () => {
    const view = await readyGame();
    openComputerApp(view, "supply");
    expect(view.element("s3-supply-visible").textContent).toContain("30 / 30");
    for (const productId of PRODUCT_IDS) {
      expect(view.element(`s3-supply-product-${productId}`).hidden).toBe(false);
      expect(view.element(`s3-quantity-${productId}`).value).toBe("0");
      expect(view.root.innerHTML).toContain(`/assets/sim3d/products/${productId}.png`);
    }
    const before = storage.getItem(SIM_STORAGE_KEY);
    view.element("s3-purchase").dispatchEvent(new Event("click"));
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(before);
    setQuantity(view, "apple", 2);
    view.element("s3-quantity-add-soap").click();
    const cost = PRODUCTS.apple.costPence * 2 + PRODUCTS.soap.costPence;
    expect(view.element("s3-supply-summary").textContent).toBe("已选 2 种商品 · 共 3 件");
    expect(view.element("s3-supply-total").textContent).toBe(`−£${(cost / 100).toFixed(2)}`);
    expect(view.element("s3-supply-after").textContent).toBe(`£${((1200 - cost) / 100).toFixed(2)}`);
    view.element("s3-purchase").click();
    const bought = savedState();
    expect(bought.cashPence).toBe(1200 - cost);
    expect(bought.purchases).toHaveLength(1);
    expect(bought.purchases[0]?.lines).toEqual([{ productId: "apple", quantity: 2 }, { productId: "soap", quantity: 1 }]);
    expect(bought.items.map((item) => item.productId)).toEqual(["apple", "apple", "soap"]);
    expect(bought.items.every((item) => item.location.kind === "delivery")).toBe(true);
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.world.requestPointerLock).not.toHaveBeenCalled();
    openComputerApp(view, "supply");
    expect(view.element("s3-quantity-apple").value).toBe("0");
    expect(view.element("s3-quantity-soap").value).toBe("0");
    expect(view.element("s3-supply-pending-apple").textContent).toBe("待收 2");
    expect(view.element("s3-purchase").disabled).toBe(true);
  });

  it("retains selections through category, search, selected-only and pause-panel changes", async () => {
    const view = await readyGame();
    openComputerApp(view, "supply");
    setQuantity(view, "apple", 1);
    setQuantity(view, "soap", 2);
    view.element("s3-supply-category").value = "drinks";
    view.element("s3-supply-category").dispatchEvent(new Event("change"));
    expect(view.element("s3-supply-product-apple").hidden).toBe(true);
    expect(view.element("s3-supply-product-soap").hidden).toBe(true);
    view.element("s3-supply-search").value = "气泡水";
    view.element("s3-supply-search").dispatchEvent(new Event("input"));
    expect(view.element("s3-supply-product-water").hidden).toBe(false);
    expect(view.element("s3-supply-visible").textContent).toContain("1 / 30");
    expect(view.element("s3-supply-summary").textContent).toBe("已选 2 种商品 · 共 3 件");
    view.element("s3-supply-selected-only").checked = true;
    view.element("s3-supply-selected-only").dispatchEvent(new Event("change"));
    expect(view.element("s3-supply-empty").hidden).toBe(false);
    view.element("s3-supply-search").value = "";
    view.element("s3-supply-search").dispatchEvent(new Event("input"));
    view.element("s3-supply-category").value = "all";
    view.element("s3-supply-category").dispatchEvent(new Event("change"));
    expect(view.element("s3-supply-visible").textContent).toContain("2 / 30");
    expect(view.element("s3-quantity-apple").value).toBe("1");
    expect(view.element("s3-quantity-soap").value).toBe("2");
    openComputerApp(view, "street");
    openComputerApp(view, "supply");
    view.element("s3-resume").click();
    openComputerApp(view, "supply");
    expect(view.element("s3-quantity-soap").value).toBe("2");
    expect(view.element("s3-purchase").disabled).toBe(false);
    view.element("s3-clear-cart").click();
    expect(view.element("s3-quantity-apple").value).toBe("0");
    expect(view.element("s3-quantity-soap").value).toBe("0");
    expect(view.element("s3-purchase").disabled).toBe(true);
    expect(savedState().purchases).toEqual([]);
  });

  it.each(["", "1.5", "9"])("blocks a whole order for hidden invalid quantity %s instead of silently buying the valid lines", async (quantity) => {
    const view = await readyGame();
    openComputerApp(view, "supply");
    setQuantity(view, "milk", 1);
    setQuantity(view, "apple", quantity);
    view.element("s3-supply-category").value = "drinks";
    view.element("s3-supply-category").dispatchEvent(new Event("change"));
    expect(view.element("s3-supply-product-apple").hidden).toBe(true);
    expect(view.element("s3-quantity-apple").getAttribute("aria-invalid")).toBe("true");
    expect(view.element("s3-supply-error").textContent).toContain("苹果的数量无效");
    expect(view.element("s3-supply-total").textContent).toBe("请先修正数量");
    expect(view.element("s3-purchase").disabled).toBe(true);
    const before = storage.getItem(SIM_STORAGE_KEY);
    view.element("s3-purchase").dispatchEvent(new Event("click"));
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(before);
    expect(savedState().purchases).toEqual([]);
    setQuantity(view, "apple", 0);
    expect(view.element("s3-purchase").disabled).toBe(false);
    view.element("s3-purchase").click();
    expect(savedState().purchases[0]?.lines).toEqual([{ productId: "milk", quantity: 1 }]);
  });

  it("shows pending stock capacity and allows choosing another product after removing a blocked line", async () => {
    const pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "eight-milk", lines: [{ productId: "milk", quantity: 8 }] });
    const view = await readyGame(pending);
    openComputerApp(view, "supply");
    expect(view.element("s3-supply-pending-milk").textContent).toBe("待收 8");
    setQuantity(view, "milk", 1);
    expect(view.element("s3-purchase").disabled).toBe(true);
    expect(view.element("s3-supply-line-error-milk").hidden).toBe(false);
    view.element("s3-quantity-remove-milk").click();
    view.element("s3-quantity-add-apple").click();
    expect(view.element("s3-purchase").disabled).toBe(false);
    expect(view.element("s3-supply-summary").textContent).toBe("已选 1 种商品 · 共 1 件");
  });

  it("keeps editing controls and procurement disabled when the save is read-only", async () => {
    const owner = await readyGame();
    const preview = mount();
    const loading = preview.app.init();
    await settle();
    doubles.World.instances.at(-1)!.complete();
    await loading;
    const before = storage.getItem(SIM_STORAGE_KEY);
    expect(preview.element("s3-quantity-apple").disabled).toBe(true);
    openComputerApp(preview, "supply");
    setQuantity(preview, "apple", 3);
    preview.element("s3-purchase").dispatchEvent(new Event("click"));
    expect(preview.element("s3-pause").open).toBe(false);
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(before);
    expect(owner.element("s3-pause").open).toBe(false);
  });
});

describe("receipts for the products actually stocked", () => {
  it("shows, scans and pays a single new product with its real price and no milk or bread rows", async () => {
    const state = selectedCheckout([{ productId: "soap", quantity: 1 }]);
    expect(getCustomerOrder(state)).toEqual(["soap"]);
    const view = await readyGame(state);
    expect(view.element("s3-receipt-line-soap").hidden).toBe(false);
    expect(view.element("s3-receipt-line-milk").hidden).toBe(true);
    expect(view.element("s3-receipt-line-bread").hidden).toBe(true);
    expect(view.element("s3-receipt-count-soap").textContent).toBe("香皂 × 1");
    const price = `£${(PRODUCTS.soap.pricePence / 100).toFixed(2)}`;
    expect(view.element("s3-receipt-total").textContent).toBe(price);
    expect(view.element("s3-receipt-price-soap").textContent).toBe(price);
    expect(view.element("s3-customer-order").textContent).toContain("香皂");
    view.world.callbacks.onTarget({ id: "counter", kind: "counter", label: "收银台", action: "扫描", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    expect(view.element("s3-scan-soap").textContent).toBe("已扫描");
    expect(view.element("s3-receipt-help").textContent).toContain("1 件商品");
    view.world.callbacks.onInteract();
    expect(savedState().transactions[0]?.amountPence).toBe(PRODUCTS.soap.pricePence);
    expect(view.element("s3-toast").textContent).toContain(`收款成功 +${price}`);
    expect(view.element("s3-receipt-state").textContent).toBe("实收");
    view.world.callbacks.onInteract();
    expect(savedState().transactions).toHaveLength(1);
  });

  it("lists and scans both chosen SKUs and counts actual shelf stock in the HUD", async () => {
    const stocked = stockedSelection([{ productId: "apple", quantity: 2 }, { productId: "water", quantity: 2 }]);
    const view = await readyGame(stocked);
    expect(view.element("s3-shelf-stock").textContent).toBe("货架 2 种 · 4 件");
    expect(view.element("s3-crate-stock").textContent).toBe("箱内 0 件");
    view.world.callbacks.onTarget({ id: "open-sign", kind: "open-sign", label: "营业牌", action: "开门", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    expect(view.element("s3-customer-order").textContent).toContain("气泡水");
    expect(view.element("s3-receipt-help").textContent).toContain("sparkling water");
    for (let step = 0; step < 3; step += 1) view.world.callbacks.onCustomerArrive();
    expect(view.element("s3-receipt-line-water").hidden).toBe(false);
    expect(view.element("s3-receipt-line-apple").hidden).toBe(false);
    expect(view.element("s3-receipt-total").textContent).toBe(`£${((PRODUCTS.water.pricePence + PRODUCTS.apple.pricePence) / 100).toFixed(2)}`);
    view.world.callbacks.onTarget({ id: "counter", kind: "counter", label: "收银台", action: "扫描", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    const scanned = savedState().items.find((item) => savedState().scannedIds.includes(item.id))!;
    expect(view.element(`s3-scan-${scanned.productId}`).textContent).toBe("已扫描");
    const other = scanned.productId === "water" ? "apple" : "water";
    expect(view.element(`s3-scan-${other}`).textContent).toBe("未扫描");
    view.world.callbacks.onInteract();
    expect(view.element(`s3-scan-${other}`).textContent).toBe("已扫描");
    expect(view.element("s3-receipt-help").textContent).toContain("2 件商品");
  });

  it("automatically invites the next customer when only one new SKU remains on the shelf", async () => {
    const clock = frameTime();
    let state = selectedCheckout([{ productId: "soap", quantity: 3 }]);
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
    state = act(state, { type: "PAY", success: true });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    const view = await readyGame(state);
    clock.advance(view, state.day.nextCustomerAtMs! - state.day.elapsedOpenMs);
    expect(savedState().customer).toEqual({ number: 2, phase: "to-milk", shoppingList: ["soap"], contentVersion: 2 });
    expect(view.element("s3-customer-order").textContent).toContain("香皂");
    expect(view.element("s3-pause").open).toBe(false);
  });
});

function cashCheckoutState(scanned = true): SimState {
  let state = act(beforeCheckout(1), { type: "CUSTOMER_ADVANCE" });
  expect(state.payment).toEqual({
    method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true,
    received: false, selectedChange: [],
  });
  if (scanned) for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
  return state;
}

function counterTarget(distance = 1): InteractionTarget {
  return { id: "counter", kind: "counter", label: "收银台", action: "现金收款", inspectable: false, distance };
}

describe("durable cash management app wiring", () => {
  it("retains the float draft and world until a failed save can be retried successfully", async () => {
    const view = await readyGame();
    openComputerApp(view, "day");
    view.element("s3-tab-cash").click();
    const control = (suffix: string) => view.root.querySelector(`#s3-cash-management-${suffix}`)!;
    const before = savedState();
    control("float-200").value = "4";
    control("float-200").dispatchEvent(new Event("input"));
    const failure = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError") });
    control("float-save").click();
    expect(savedState()).toEqual(before);
    expect(control("float-200").value).toBe("4");
    expect(control("drawer").textContent).toBe("£31.60");
    expect(control("reserve").textContent).toBe("£0.00");
    expect(control("notice").textContent).toContain("尚未更改");
    failure.mockRestore();
    control("float-save").click();
    expect(savedState().cashJournal).toHaveLength(1);
    expect(savedState().cashReservePence).toBe(200);
    expect(savedState().cashPence).toBe(before.cashPence);
    expect(control("drawer").textContent).toBe("£29.60");
  });

  it("refunds only after durable save and updates the retained receipt without replaying payment audio", async () => {
    const state = act(paidSnapshot(), { type: "CUSTOMER_ADVANCE" });
    const view = await readyGame(state);
    openComputerApp(view, "day");
    view.element("s3-tab-cash").click();
    const control = (suffix: string) => view.root.querySelector(`#s3-cash-management-${suffix}`)!;
    const before = savedState();
    const transaction = before.transactions.at(-1)!;
    control(`refund-${transaction.id}`).click();
    expect(control("refund-confirm").hidden).toBe(false);
    view.shopAudio.playEffect.mockClear();
    const failure = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError") });
    control("refund-confirm-button").click();
    expect(savedState()).toEqual(before);
    expect(control("refund-confirm").hidden).toBe(false);
    expect(view.element("s3-receipt-title").textContent).toBe("本单已收款");
    failure.mockRestore();
    control("refund-confirm-button").click();
    expect(savedState().cashJournal).toHaveLength(1);
    expect(savedState().cashPence).toBe(before.cashPence - transaction.amountPence);
    expect(savedState().transactions).toEqual(before.transactions);
    expect(control("refund-confirm").hidden).toBe(true);
    expect(view.element("s3-receipt-title").textContent).toContain("退款");
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    control("refund-confirm-button").dispatchEvent(new Event("click"));
    expect(savedState().cashJournal).toHaveLength(1);
  });
});

describe("cash checkout app wiring and recoverable interaction", () => {
  it("requires both scans and a nearby counter, then commits one cash sale and one payment sound", async () => {
    const state = cashCheckoutState(false);
    const view = await readyGame(state);
    expect(view.element("s3-payment-method").textContent).toContain("现金");
    expect(view.element("s3-customer-line").textContent).toContain("cash");
    expect(view.element("s3-open-cash").hidden).toBe(true);
    view.world.callbacks.onTarget(counterTarget());
    view.world.callbacks.onInteract();
    expect(view.element("s3-cash-dialog").open).toBe(false);
    expect(view.element("s3-open-cash").hidden).toBe(true);
    view.world.callbacks.onInteract();
    expect(view.element("s3-open-cash").hidden).toBe(false);
    expect(view.element("s3-open-cash").disabled).toBe(false);
    view.world.callbacks.onTarget(counterTarget(3));
    expect(view.element("s3-open-cash").disabled).toBe(true);
    // The handler checks the live target even if a stale DOM event is delivered.
    view.element("s3-open-cash").dispatchEvent(new Event("click"));
    expect(view.element("s3-cash-dialog").open).toBe(false);
    view.world.callbacks.onTarget(null);
    view.element("s3-open-cash").dispatchEvent(new Event("click"));
    expect(view.element("s3-cash-dialog").open).toBe(false);
    view.world.callbacks.onTarget(counterTarget());
    view.world.callbacks.onInteract();
    expect(view.element("s3-cash-dialog").open).toBe(true);
    expect(view.world.setActive).toHaveBeenLastCalledWith(false);
    expect(view.world.setCursorFree).toHaveBeenLastCalledWith(true);
    expect(view.audio.src).toBe(cashTenderSpeechFor(state)?.src);
    expect(view.element("s3-cash-due").textContent).toBe("£4.00");
    expect(view.element("s3-cash-tendered").textContent).toBe("£5.00");
    expect(view.element("s3-cash-confirm").disabled).toBe(true);
    view.shopAudio.playEffect.mockClear();
    view.element("s3-cash-receive").click();
    view.element("s3-cash-add-50").click();
    expect(savedState().cashPence).toBe(state.cashPence);
    expect(savedState().transactions).toEqual(state.transactions);
    expect(view.element("s3-cash-feedback").textContent).toContain("还差 £0.50");
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    view.element("s3-cash-add-50").click();
    expect(view.element("s3-cash-confirm").disabled).toBe(false);
    view.element("s3-cash-confirm").click();
    expect(view.element("s3-cash-dialog").open).toBe(false);
    expect(savedState().cashPence).toBe(state.cashPence + 400);
    expect(savedState().transactions.at(-1)).toMatchObject({
      paymentMethod: "cash",
      amountPence: 400,
      tenderedPence: 500,
      changePence: 100,
      tenderedCash: [500],
      changeCash: [50, 50],
      tenderedCashRecorded: true,
      changeCashRecorded: true,
      cashDrawerTracked: true,
    });
    expect(view.element("s3-receipt-cash-breakdown").textContent).toBe(
      "交付 £5.00（£5） · 找零 £1.00（50p + 50p） · 本单入账 £4.00",
    );
    expect(view.world.setActive).toHaveBeenLastCalledWith(true);
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["payment"]]);
    view.element("s3-cash-confirm").dispatchEvent(new Event("click"));
    view.world.callbacks.onInteract();
    expect(savedState().transactions).toHaveLength(2);
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["payment"]]);
  });

  it("does not present canonical migration pieces as the actual tender or change on an old cash receipt", async () => {
    let state = cashCheckoutState();
    state = act(state, { type: "RECEIVE_CASH" });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 50 });
    state = act(state, { type: "ADD_CHANGE", denominationPence: 50 });
    state = act(state, { type: "CONFIRM_CASH" });
    const migrated: SimState = {
      ...state,
      cashDrawer: { ...state.cashDrawerOpening },
      cashDrawerTransactionStart: state.transactions.length,
      transactions: state.transactions.map((transaction) => ({
        ...transaction,
        cashDrawerTracked: false,
        tenderedCash: transaction.paymentMethod === "cash" ? cashPiecesForAmount(transaction.tenderedPence) : [],
        changeCash: transaction.paymentMethod === "cash" ? cashPiecesForAmount(transaction.changePence) : [],
        tenderedCashRecorded: false,
        changeCashRecorded: false,
      })),
    };
    expect(validateSimState(migrated)).toBe(true);

    const view = await readyGame(migrated);
    expect(view.element("s3-receipt-cash-breakdown").textContent).toBe(
      "交付 £5.00（旧版未记录面额） · 找零 £1.00（旧版未记录面额） · 本单入账 £4.00",
    );
    expect(view.element("s3-receipt-cash-breakdown").textContent).not.toContain("£5）");
    expect(view.element("s3-receipt-cash-breakdown").textContent).not.toContain("£1）");
  });

  it("replays the fixed tender slowly, blocks background actions, and Esc preserves partial change", async () => {
    const state = cashCheckoutState();
    const view = await readyGame(state);
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    view.element("s3-cash-receive").click();
    view.element("s3-cash-add-50").click();
    const pending = savedState();
    key("KeyR", true);
    expect(view.audio.src).toBe(cashTenderSpeechFor(pending)?.src);
    expect(view.audio.playbackRate).toBe(.84);
    for (const code of ["KeyE", "KeyF", "KeyG", "KeyB", "KeyU", "KeyM"]) expect(key(code).defaultPrevented).toBe(true);
    view.world.callbacks.onCustomerArrive();
    expect(savedState()).toEqual(pending);
    expect(view.element("s3-pause").open).toBe(false);
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(view.element("s3-cash-dialog").open).toBe(false);
    expect(view.element("s3-pause").open).toBe(false);
    expect(savedState().payment).toEqual(pending.payment);
    expect(view.world.requestPointerLock).not.toHaveBeenCalled();
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    expect(view.element("s3-cash-selected-total").textContent).toBe("£0.50");
    expect(view.element("s3-cash-receive").hidden).toBe(true);
    view.element("s3-cash-close").click();
    key("KeyB");
    view.element("s3-cancel-customer").click();
    expect(view.element("s3-toast").textContent).toContain("暂收现金已退回");
    expect(savedState().cashPence).toBe(state.cashPence);
    expect(savedState().payment).toBeNull();
    expect(savedState().transactions).toEqual(state.transactions);
    expect(savedState().items.some((item) => item.location.kind === "checkout")).toBe(false);
  });

  it("restores pending tender and selected coins after disposing and mounting a new app", async () => {
    const state = cashCheckoutState();
    const first = await readyGame(state);
    first.world.callbacks.onTarget(counterTarget());
    first.element("s3-open-cash").click();
    first.element("s3-cash-receive").click();
    first.element("s3-cash-add-50").click();
    first.world.setActive.mockClear();
    await first.app.dispose();
    expect(first.element("s3-cash-dialog").open).toBe(false);
    expect(first.world.setActive).not.toHaveBeenCalledWith(true);
    const restored = savedState();
    expect(restored.payment).toMatchObject({ received: true, selectedChange: [50] });
    const second = await readyGame(restored);
    second.world.callbacks.onTarget(counterTarget());
    second.element("s3-open-cash").click();
    expect(second.element("s3-cash-selected-total").textContent).toBe("£0.50");
    second.element("s3-cash-add-50").click();
    second.element("s3-cash-confirm").click();
    expect(savedState().cashPence).toBe(state.cashPence + 400);
    expect(savedState().transactions).toHaveLength(2);
  });

  it("closes without reactivating the world when another writer replaces an open cash checkout", async () => {
    const view = await readyGame(cashCheckoutState());
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    view.element("s3-cash-receive").click();
    const external = act(savedState(), { type: "ADD_CHANGE", denominationPence: 50 });
    const raw = JSON.stringify(external);
    storage.setItem(SIM_STORAGE_KEY, raw);
    view.world.setActive.mockClear();
    windowDouble.dispatchEvent(Object.assign(new Event("storage"), { key: SIM_STORAGE_KEY, newValue: raw }));
    expect(view.element("s3-cash-dialog").open).toBe(false);
    expect(view.element("s3-hud").hidden).toBe(true);
    expect(view.element("s3-start-button").disabled).toBe(true);
    expect(view.world.setActive).not.toHaveBeenCalledWith(true);
    expect(view.world.setActive).toHaveBeenLastCalledWith(false);
    view.element("s3-cash-confirm").dispatchEvent(new Event("click"));
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(raw);
  });

  it("shows save failures inside the modal instead of claiming pending cash was saved", async () => {
    const state = cashCheckoutState();
    const view = await readyGame(state);
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("storage full", "QuotaExceededError") });
    view.element("s3-cash-receive").click();
    expect(view.element("s3-cash-save-note").textContent).toContain("尚未保存");
    expect(view.element("s3-cash-save-note").getAttribute("data-error")).toBe("true");
    expect(view.element("s3-cash-dialog").open).toBe(true);
    expect(view.element("s3-cash").textContent).toBe(`£${(state.cashPence / 100).toFixed(2)}`);
    expect(savedState().payment).toMatchObject({ received: false });
  });

  it("pauses after leaving the cash window and requires explicit resume while preserving pending tender", async () => {
    const view = await readyGame(cashCheckoutState());
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
    view.audio.onplaying?.();
    expect(view.shopAudio.setSpeechActive).toHaveBeenLastCalledWith(true);
    expect(view.element("s3-cash-audio-status").textContent).toContain("正在播放");
    view.element("s3-cash-receive").click();
    view.element("s3-cash-add-50").click();
    const pending = savedState().payment;
    windowDouble.dispatchEvent(new Event("blur"));
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    expect(view.element("s3-cash-dialog").open).toBe(false);
    expect(view.element("s3-pause").open).toBe(true);
    expect(view.world.setActive).toHaveBeenLastCalledWith(false);
    windowDouble.dispatchEvent(new Event("focus"));
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    expect(view.world.setActive).toHaveBeenLastCalledWith(false);
    expect(savedState().payment).toEqual(pending);
    view.element("s3-resume").click();
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    expect(view.element("s3-cash-dialog").open).toBe(true);
    expect(view.element("s3-cash-selected-total").textContent).toBe("£0.50");
  });
});

describe("active-time business clock event wiring", () => {
  it("leaves preparation untimed and starts 09:00 only after explicitly opening the shop", async () => {
    const clock = frameTime();
    const view = await readyGame(stockedFirstDay());
    clock.advance(view, 20_000);
    expect(view.element("s3-business-time").textContent).toBe("08:30");
    expect(view.element("s3-clock-state").textContent).toBe("准备中");
    expect(savedState().day.elapsedOpenMs).toBe(0);
    expect(savedState().customer.phase).toBe("outside");
    view.world.callbacks.onTarget({ id: "open-sign", kind: "open-sign", label: "营业牌", action: "开门", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    expect(view.element("s3-business-time").textContent).toBe("09:00");
    expect(view.element("s3-clock-state").textContent).toBe("营业中");
    clock.advance(view, 7000);
    expect(view.element("s3-business-time").textContent).toBe("09:05");
    expect(view.element("s3-sold").textContent).toBe("今日 0 单 · 库存 6 件");
    openComputerApp(view, "day");
    expect(savedState().day.elapsedOpenMs).toBe(7000);
  });

  it.each(["supply", "day", "upgrade", "street"])("pauses in the %s management panel and resumes from the same moment", async (section) => {
    const clock = frameTime();
    const view = await readyGame(act(beforeCheckout(), { type: "CUSTOMER_ADVANCE" }));
    clock.advance(view, 1400);
    openComputerApp(view, section);
    const paused = savedState();
    expect(paused.day.elapsedOpenMs).toBe(1400);
    expect(view.element("s3-clock-state").textContent).toBe("管理暂停");
    clock.advance(view, 9000);
    expect(savedState()).toEqual(paused);
    expect(view.element("s3-business-time").textContent).toBe("09:01");
    view.element("s3-resume").click();
    clock.advance(view, 700);
    view.element("s3-pause-button").click();
    expect(savedState().day.elapsedOpenMs).toBe(2100);
    expect(savedState().payment).toEqual(paused.payment);
  });

  it("pauses for close inspection but not for releasing the mouse", async () => {
    const clock = frameTime();
    const state = act(beforeCheckout(), { type: "CUSTOMER_ADVANCE" });
    const view = await readyGame(state);
    key("Tab");
    clock.advance(view, 700);
    expect(view.element("s3-business-time").textContent).toBe("09:00");
    const item = state.items.find((entry) => entry.location.kind === "shelf")!;
    view.world.callbacks.onTarget({ id: item.id, kind: "item", itemId: item.id, productId: item.productId, label: "商品", action: "近看", inspectable: true, distance: 1 });
    view.world.callbacks.onInspect();
    expect(view.element("s3-inspection").hidden).toBe(false);
    const paused = savedState();
    clock.advance(view, 9000);
    expect(savedState().day.elapsedOpenMs).toBe(paused.day.elapsedOpenMs);
    view.element("s3-close-inspect").click();
    clock.advance(view, 700);
    view.element("s3-pause-button").click();
    expect(savedState().day.elapsedOpenMs).toBe(1400);
  });

  it("protects both the repeat request and the slow reply, then restores time without catch-up", async () => {
    const clock = frameTime();
    const state = act(beforeCheckout(), { type: "CUSTOMER_ADVANCE" });
    const view = await readyGame(state);
    clock.advance(view, 700);
    view.element("s3-repeat-customer").click();
    expect(view.element("s3-clock-state").textContent).toBe("学习暂停");
    expect(view.world.setActive).toHaveBeenLastCalledWith(false);
    view.audio.onplaying?.();
    clock.advance(view, 3000);
    view.audio.onended?.();
    expect(view.audio.playbackRate).toBe(.84);
    expect(view.element("s3-clock-state").textContent).toBe("学习暂停");
    view.audio.onplaying?.();
    clock.advance(view, 3000);
    expect(view.element("s3-business-time").textContent).toBe("09:00");
    view.audio.onended?.();
    expect(view.element("s3-clock-state").textContent).toBe("营业中");
    expect(view.world.setActive).toHaveBeenLastCalledWith(true);
    clock.advance(view, 700);
    view.element("s3-pause-button").click();
    expect(savedState().day.elapsedOpenMs).toBe(1400);
    expect(savedState().payment).toEqual(state.payment);
  });

  it.each(["error", "escape", "media-pause"])("releases learning protection safely on %s and ignores late speech completion", async (reason) => {
    const clock = frameTime();
    const view = await readyGame(act(beforeCheckout(), { type: "CUSTOMER_ADVANCE" }));
    key("KeyR");
    view.audio.onplaying?.();
    const lateEnd = view.audio.onended;
    clock.advance(view, 2000);
    if (reason === "error") view.audio.onerror?.();
    else if (reason === "media-pause") { view.audio.pause(); view.audio.onpause?.() }
    else {
      expect(key("Escape").defaultPrevented).toBe(true);
      expect(view.element("s3-pause").open).toBe(true);
      expect(view.world.setActive).toHaveBeenLastCalledWith(false);
      clock.advance(view, 2000);
      view.element("s3-resume").click();
    }
    lateEnd?.();
    expect(view.element("s3-clock-state").textContent).toBe("营业中");
    clock.advance(view, 700);
    view.element("s3-pause-button").click();
    expect(savedState().day.elapsedOpenMs).toBe(700);
  });

  it("releases protection if a recording never starts instead of freezing the business clock", async () => {
    const clock = frameTime();
    const view = await readyGame(act(beforeCheckout(), { type: "CUSTOMER_ADVANCE" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      key("KeyR");
      clock.advance(view, 4000);
      expect(view.element("s3-clock-state").textContent).toBe("学习暂停");
      vi.advanceTimersByTime(4000);
      expect(view.element("s3-clock-state").textContent).toBe("营业中");
      expect(view.element("s3-customer-audio-status").textContent).toContain("计时已恢复");
      clock.advance(view, 700);
      view.element("s3-pause-button").click();
      expect(savedState().day.elapsedOpenMs).toBe(700);
    } finally { vi.useRealTimers() }
  });

  it("ignores a queued pause from the previous audio source while a new learning replay is playing", async () => {
    const clock = frameTime();
    const view = await readyGame(act(beforeCheckout(), { type: "CUSTOMER_ADVANCE" }));
    key("KeyR");
    view.audio.onplaying?.();
    expect(view.audio.paused).toBe(false);
    view.audio.onpause?.();
    clock.advance(view, 2100);
    expect(view.element("s3-clock-state").textContent).toBe("学习暂停");
    expect(view.element("s3-business-time").textContent).toBe("09:00");
    view.audio.onended?.();
    clock.advance(view, 700);
    view.element("s3-pause-button").click();
    expect(savedState().day.elapsedOpenMs).toBe(700);
  });

  it.each(["blur", "hidden"] as const)("keeps %s time out of an unfinished cash order until explicit resume", async (reason) => {
    const clock = frameTime();
    const view = await readyGame(cashCheckoutState());
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    view.element("s3-cash-receive").click();
    view.element("s3-cash-add-50").click();
    clock.advance(view, 700);
    if (reason === "blur") windowDouble.dispatchEvent(new Event("blur"));
    else { documentDouble.hidden = true; documentDouble.dispatchEvent(new Event("visibilitychange")) }
    const paused = savedState();
    expect(view.element("s3-pause").open).toBe(true);
    expect(paused.payment).toMatchObject({ received: true, selectedChange: [50] });
    clock.advance(view, 12_000);
    if (reason === "blur") windowDouble.dispatchEvent(new Event("focus"));
    else { documentDouble.hidden = false; documentDouble.dispatchEvent(new Event("visibilitychange")) }
    clock.advance(view, 3000);
    expect(savedState().day.elapsedOpenMs).toBe(paused.day.elapsedOpenMs);
    view.element("s3-resume").click();
    clock.advance(view, 700);
    view.element("s3-pause-button").click();
    expect(savedState().day.elapsedOpenMs).toBe(paused.day.elapsedOpenMs + 700);
    expect(savedState().payment).toEqual(paused.payment);
  });

  it("does not infer business time from an offline reload or a suspended frame gap", async () => {
    const clock = frameTime();
    const initial = act(act(beforeCheckout(), { type: "CUSTOMER_ADVANCE" }), { type: "ADVANCE_BUSINESS_TIME", elapsedMs: 180_000 });
    const view = await readyGame(initial);
    clock.advance(view, 700);
    view.element("s3-pause-button").click();
    const paused = savedState();
    await view.app.dispose();
    clock.skip(86_400_000);
    const restored = await readyGame(paused);
    expect(savedState().day.elapsedOpenMs).toBe(paused.day.elapsedOpenMs);
    clock.skip(60_000);
    restored.world.callbacks.onFrame?.(60, paused.playerPose);
    expect(savedState().day.elapsedOpenMs).toBe(paused.day.elapsedOpenMs);
    clock.advance(restored, 700);
    restored.element("s3-pause-button").click();
    expect(savedState().day.elapsedOpenMs).toBe(paused.day.elapsedOpenMs + 700);
  });

  it("closes at 19:00 in normal cash-counting mode without interrupting received money or selected change", async () => {
    const clock = frameTime();
    const state = act(cashCheckoutState(), { type: "ADVANCE_BUSINESS_TIME", elapsedMs: BUSINESS_DURATION_MS - 700 });
    const view = await readyGame(state);
    view.world.callbacks.onTarget(counterTarget());
    view.element("s3-open-cash").click();
    view.element("s3-cash-receive").click();
    view.element("s3-cash-add-50").click();
    const pending = savedState();
    expect(view.element("s3-clock-state").textContent).toBe("营业中");
    clock.advance(view, 700);
    const closing = savedState();
    expect(closing.day).toMatchObject({ phase: "closing", elapsedOpenMs: BUSINESS_DURATION_MS, closeReason: "time", nextCustomerAtMs: null });
    expect(view.element("s3-business-time").textContent).toBe("19:00");
    expect(view.element("s3-clock-state").textContent).toBe("收尾中");
    expect(view.element("s3-cash-dialog").open).toBe(true);
    expect(view.element("s3-cash-business-clock").textContent).toContain("本单可以继续完成");
    expect(closing.payment).toEqual(pending.payment);
    expect(closing.transactions).toEqual(pending.transactions);
    expect(closing.scannedIds).toEqual(pending.scannedIds);
    view.element("s3-cash-add-50").click();
    view.element("s3-cash-confirm").click();
    expect(savedState().cashPence).toBe(state.cashPence + 400);
    expect(view.element("s3-pause").open).toBe(false);
    view.world.callbacks.onCustomerArrive();
    clock.advance(view, 100);
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.element("s3-toast").textContent).toContain("到店内电脑");
    openComputerApp(view, "day");
    expect(view.element("s3-settle-day").disabled).toBe(false);
    expect(savedState().customer.number).toBe(2);
  });

  it("does not start a scheduled visitor at the exact closing boundary", async () => {
    const clock = frameTime();
    let state = act(act(beforeCheckout(), { type: "CUSTOMER_ADVANCE" }), { type: "ADVANCE_BUSINESS_TIME", elapsedMs: BUSINESS_DURATION_MS - 700 });
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
    state = act(payScannedCheckout(state), { type: "CUSTOMER_ADVANCE" });
    expect(state.day.nextCustomerAtMs).toBe(BUSINESS_DURATION_MS);
    const view = await readyGame(state);
    clock.advance(view, 700);
    expect(savedState().day.phase).toBe("closing");
    expect(savedState().customer.number).toBe(1);
    expect(view.element("s3-panel-day").hidden).toBe(true);
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
  });

  it("requires confirmation for an early zero-order close, settles once and resets the next preparation day", async () => {
    const clock = frameTime();
    const view = await readyGame();
    openComputerApp(view, "day");
    view.element("s3-close-shop").click();
    expect(view.element("s3-close-confirm").hidden).toBe(false);
    key("Escape");
    expect(view.element("s3-close-confirm").hidden).toBe(true);
    expect(view.element("s3-pause").open).toBe(true);
    expect(savedState().day.phase).toBe("preparing");
    view.element("s3-close-shop").click();
    view.element("s3-close-confirm-button").click();
    expect(savedState().day.phase).toBe("closing");
    expect(view.element("s3-settle-day").hidden).toBe(false);
    expect(view.element("s3-settle-day").disabled).toBe(false);
    view.element("s3-settle-day").click();
    view.element("s3-settle-day").click();
    expect(savedState().settlements).toHaveLength(1);
    expect(savedState().settlements[0]).toMatchObject({ paidCustomers: 0, revenuePence: 0, targetCustomers: null });
    expect(savedState().cashPence).toBe(1200);
    view.element("s3-next-day").click();
    expect(savedState().day).toMatchObject({ number: 2, phase: "preparing", elapsedOpenMs: 0, nextCustomerAtMs: null, closeReason: null });
    view.element("s3-resume").click();
    clock.advance(view, 5000);
    expect(view.element("s3-business-time").textContent).toBe("08:30");
    expect(savedState().cashPence).toBe(1200);
  });
});

async function inspectNewProduct(productId: ProductId = "apple") {
  let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "inspect-new-product", lines: [{ productId, quantity: 1 }] });
  state = receiveAllDeliveries(state);
  const view = await readyGame(state);
  const crate = state.crates.find((entry) => entry.productId === productId)!;
  view.world.callbacks.onTarget({ id: crate.id, kind: "crate", crateId: crate.id, productId, label: PRODUCTS[productId].nameZh, action: "近看", inspectable: true, distance: 1 });
  view.world.callbacks.onInspect();
  return view;
}

function installBrowserVoice() {
  class Utterance {
    lang = "";
    rate = 1;
    volume = 1;
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly text: string) {}
  }
  const utterances: Utterance[] = [];
  const voice = { lang: "en-GB", name: "Device English", default: true, localService: true, voiceURI: "device-en" };
  const synthesis = {
    getVoices: vi.fn(() => [voice]),
    speak: vi.fn((utterance: Utterance) => { utterances.push(utterance) }),
    cancel: vi.fn(),
  };
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  Object.assign(windowDouble, { speechSynthesis: synthesis });
  return { utterances, synthesis, voice };
}

describe("honest browser speech for products without recorded audio", () => {
  it("keeps product names and phrases readable when the browser has no speech synthesis", async () => {
    const view = await inspectNewProduct("apple");
    expect(view.element("s3-inspect-word").textContent).toBe("apple");
    expect(view.element("s3-inspect-phrase").textContent).toBe("an apple");
    expect(view.element("s3-inspect-phrase-zh").textContent).toBe("一个苹果");
    expect(view.element("s3-inspect-audio-note").textContent).toContain("尚无本地录音");
    view.element("s3-speak-word").click();
    expect(view.audio.play).not.toHaveBeenCalled();
    expect(view.element("s3-speech-status").textContent).toContain("不支持合成发音");
    expect(view.audio.src).not.toContain("apple.ogg");
    view.element("s3-speak-phrase").click();
    expect(view.audio.src).not.toContain("apple-phrase");
    expect(view.element("s3-inspect-word").textContent).toBe("apple");
  });

  it("uses browser utterances for a new product and reports completion only after actual speech events", async () => {
    const browser = installBrowserVoice();
    const view = await inspectNewProduct("soap");
    view.element("s3-speak-word").click();
    expect(browser.synthesis.speak).toHaveBeenCalledOnce();
    expect(view.audio.play).not.toHaveBeenCalled();
    const utterance = browser.utterances[0]!;
    expect(utterance.text).toBe("soap");
    expect(utterance.voice).toEqual(browser.voice);
    expect(utterance.lang).toBe("en-GB");
    expect(utterance.volume).toBe(0.7);
    expect(view.element("s3-speech-status").textContent).toContain("正在尝试浏览器合成");
    utterance.onend?.();
    expect(view.element("s3-speech-status").textContent).not.toContain("发音结束");
    utterance.onstart?.();
    expect(view.element("s3-speech-status").textContent).toContain("非本地录音");
    utterance.onend?.();
    expect(view.element("s3-speech-status").textContent).toContain("浏览器合成发音结束");
    view.element("s3-speak-phrase").click();
    expect(browser.utterances[1]?.text).toBe("a bar of soap");
    expect(view.audio.src).not.toContain("soap");
  });

  it("cancels device speech when leaving inspection and ignores a late completion callback", async () => {
    const browser = installBrowserVoice();
    const view = await inspectNewProduct();
    view.element("s3-speak-word").click();
    const utterance = browser.utterances[0]!;
    utterance.onstart?.();
    const lateEnd = utterance.onend;
    view.element("s3-close-inspect").click();
    expect(browser.synthesis.cancel).toHaveBeenCalledOnce();
    expect(utterance.onstart).toBeNull();
    expect(utterance.onend).toBeNull();
    lateEnd?.();
    expect(view.element("s3-speech-status").textContent).not.toContain("发音结束");
    expect(view.element("s3-hud").hidden).toBe(false);
  });

  it("reports a device speech failure without inventing a missing recording or blocking inspection", async () => {
    const browser = installBrowserVoice();
    const view = await inspectNewProduct();
    browser.synthesis.speak.mockImplementationOnce(() => { throw new Error("VoiceUnavailable") });
    view.element("s3-speak-word").click();
    expect(view.element("s3-speech-status").textContent).toContain("浏览器合成发音未能播放");
    expect(view.audio.play).not.toHaveBeenCalled();
    expect(view.element("s3-inspection").hidden).toBe(false);
  });
});

describe("shop music settings and lifecycle wiring", () => {
  it("waits for Start, unlocks on real start/resume actions and relays music status to the accessible UI", async () => {
    const view = mount();
    const loading = view.app.init();
    await settle();
    doubles.World.instances.at(-1)!.complete();
    await loading;
    expect(view.shopAudio.unlock).not.toHaveBeenCalled();
    expect(view.shopAudio.setActive).not.toHaveBeenCalledWith(true);
    view.element("s3-start-button").click();
    expect(view.shopAudio.unlock).toHaveBeenCalledOnce();
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
    view.shopAudio.options.onStatus?.("Local Forecast · 循环播放中");
    expect(view.element("s3-music-status").textContent).toBe("Local Forecast · 循环播放中");
    expect(view.element("s3-music-status").getAttribute("role")).toBe("status");
    view.element("s3-pause-button").click();
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    view.element("s3-resume").click();
    expect(view.shopAudio.unlock).toHaveBeenCalledTimes(2);
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
  });

  it("adds music defaults to old v1 settings without resetting speech, then persists all three channels through a remount", async () => {
    const key = "english-high-street:sim3d:settings:v1";
    storage.setItem(key, JSON.stringify({ schemaVersion: 1, sensitivity: 1.4, quality: "low", reducedMotion: false, volume: 0.35, autoSpeech: false }));
    const view = await readyGame();
    expect(view.shopAudio.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      musicEnabled: true, musicVolume: 0.22, effectsVolume: 0.5,
      volume: 0.35, autoSpeech: false, sensitivity: 1.4, quality: "low", reducedMotion: false,
    }));
    expect(view.element("s3-music-enabled").checked).toBe(true);
    expect(view.element("s3-music-volume-value").textContent).toBe("22%");
    expect(view.element("s3-effects-volume-value").textContent).toBe("50%");
    view.element("s3-pause-button").click();
    view.element("s3-music-enabled").checked = false;
    view.element("s3-music-enabled").dispatchEvent(new Event("input"));
    view.element("s3-music-volume").value = "0.38";
    view.element("s3-music-volume").dispatchEvent(new Event("input"));
    view.element("s3-effects-volume").value = "0.25";
    view.element("s3-effects-volume").dispatchEvent(new Event("input"));
    const expected = { schemaVersion: 1, sensitivity: 1.4, quality: "low", reducedMotion: false, volume: 0.35, autoSpeech: false, musicEnabled: false, musicVolume: 0.38, effectsVolume: 0.25 };
    expect(JSON.parse(storage.getItem(key)!)).toEqual(expected);
    expect(view.shopAudio.setSettings).toHaveBeenLastCalledWith(expected);
    expect(view.element("s3-music-volume-value").textContent).toBe("38%");
    expect(view.element("s3-effects-volume-value").textContent).toBe("25%");
    await view.app.dispose();
    const restored = await readyGame(savedState());
    expect(restored.shopAudio.setSettings).toHaveBeenLastCalledWith(expected);
    expect(restored.element("s3-music-enabled").checked).toBe(false);
    expect(restored.element("s3-music-volume").value).toBe("0.38");
    expect(restored.element("s3-effects-volume").value).toBe("0.25");
    expect(restored.element("s3-volume").value).toBe("0.35");
    expect(restored.element("s3-auto-speech").checked).toBe(false);
  });

  it("bounds persisted music levels and retains explicit mute values", async () => {
    storage.setItem("english-high-street:sim3d:settings:v1", JSON.stringify({ schemaVersion: 1, musicEnabled: false, musicVolume: -3, effectsVolume: 7, volume: 0 }));
    const view = await readyGame();
    expect(view.shopAudio.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ musicEnabled: false, musicVolume: 0, effectsVolume: 1, volume: 0 }));
    expect(view.element("s3-music-volume-value").textContent).toBe("0%");
    expect(view.element("s3-effects-volume-value").textContent).toBe("100%");
  });

  it.each(["blur", "hidden"] as const)("keeps gameplay music stopped after %s until the player explicitly resumes", async (reason) => {
    const view = await readyGame();
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
    if (reason === "blur") windowDouble.dispatchEvent(new Event("blur"));
    else { documentDouble.hidden = true; documentDouble.dispatchEvent(new Event("visibilitychange")) }
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    expect(view.element("s3-pause").open).toBe(true);
    if (reason === "blur") windowDouble.dispatchEvent(new Event("focus"));
    else { documentDouble.hidden = false; documentDouble.dispatchEvent(new Event("visibilitychange")) }
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    view.element("s3-resume").click();
    expect(view.shopAudio.unlock).toHaveBeenCalledTimes(2);
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
  });

  it("allows music during inspection but silences it while inspection is in the background", async () => {
    const view = await inspectWord();
    expect(view.element("s3-inspection").hidden).toBe(false);
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
    windowDouble.dispatchEvent(new Event("blur"));
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    windowDouble.dispatchEvent(new Event("focus"));
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
    documentDouble.hidden = true;
    documentDouble.dispatchEvent(new Event("visibilitychange"));
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    documentDouble.hidden = false;
    documentDouble.dispatchEvent(new Event("visibilitychange"));
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
    view.element("s3-close-inspect").click();
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
  });

  it("stops on pagehide and awaits a new Start after a BFCache restoration", async () => {
    const view = await readyGame();
    windowDouble.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    windowDouble.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await settle();
    doubles.World.instances.at(-1)!.complete();
    await settle();
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    expect(view.shopAudio.unlock).toHaveBeenCalledOnce();
    view.element("s3-start-button").click();
    expect(view.shopAudio.unlock).toHaveBeenCalledTimes(2);
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(true);
  });

  it("never unlocks a read-only second page or accepts changes to its music settings", async () => {
    const owner = await readyGame();
    const preview = mount();
    const loading = preview.app.init();
    await settle();
    doubles.World.instances.at(-1)!.complete();
    await loading;
    const writes = storage.writes;
    preview.shopAudio.setSettings.mockClear();
    preview.element("s3-start-button").click();
    preview.element("s3-music-enabled").checked = false;
    preview.element("s3-music-enabled").dispatchEvent(new Event("input"));
    expect(preview.shopAudio.unlock).not.toHaveBeenCalled();
    expect(preview.shopAudio.setActive).not.toHaveBeenCalledWith(true);
    expect(preview.shopAudio.setSettings).not.toHaveBeenCalled();
    expect(storage.writes).toBe(writes);
    expect(owner.shopAudio.setActive).toHaveBeenLastCalledWith(true);
  });

  it("disposes the old audio engine exactly once on same-root remount and ignores its late status callbacks", async () => {
    const first = await readyGame();
    const replacement = mount(first.root);
    const loading = replacement.app.init();
    await settle();
    expect(first.shopAudio.dispose).toHaveBeenCalledOnce();
    doubles.World.instances.at(-1)!.complete();
    await loading;
    replacement.shopAudio.options.onStatus?.("新的播放器正在等待开始");
    first.shopAudio.options.onStatus?.("旧播放器的迟到事件");
    expect(replacement.element("s3-music-status").textContent).toBe("新的播放器正在等待开始");
    expect(replacement.shopAudio.setActive).not.toHaveBeenCalledWith(true);
    await first.app.dispose();
    expect(first.shopAudio.dispose).toHaveBeenCalledOnce();
    await replacement.app.dispose();
    expect(replacement.shopAudio.dispose).toHaveBeenCalledOnce();
  });
});

describe("accepted shop actions emit feedback once", () => {
  it("only plays the stocking sound after a successful stock command, never for empty hands, wrong products or duplicate attempts", async () => {
    const view = await readyGame(createInitialSimState());
    const target = (next: InteractionTarget): void => { view.world.callbacks.onTarget(next); view.world.callbacks.onInteract() };
    const shelf = (productId: ProductId): InteractionTarget => ({ id: `${productId}-shelf`, kind: "shelf", productId, label: "货架", action: "上架", inspectable: false, distance: 1 });
    target(shelf("milk"));
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    target({ id: "bread-1", itemId: "bread-1", productId: "bread", kind: "item", label: "面包", action: "拿起", inspectable: true, distance: 1 });
    target(shelf("milk"));
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    target(shelf("bread"));
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["stock"]]);
    expect(countAt(savedState(), "bread", "shelf")).toBe(1);
    target(shelf("bread"));
    target({ ...shelf("bread"), distance: 8 });
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["stock"]]);
  });

  it("does not ring the doorbell when the empty shop cannot open", async () => {
    const view = await readyGame();
    view.world.callbacks.onTarget({ id: "open-sign", kind: "open-sign", label: "营业牌", action: "开店", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    expect(savedState().customer.phase).toBe("outside");
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
  });

  it("rings for a new visitor and emits one scan per item and one payment, keeping retries, speech replay and departure silent", async () => {
    const view = await readyGame(stockedFirstDay());
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    view.world.callbacks.onTarget({ id: "open-sign", kind: "open-sign", label: "营业牌", action: "开店", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    view.world.enterShop();
    view.world.callbacks.onInteract();
    expect(view.element("s3-pause").open).toBe(false); // The sign only reports status; the computer owns management.
    view.element("s3-resume").click();
    view.element("s3-read-customer").click();
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
    for (let step = 0; step < 3; step += 1) view.world.callbacks.onCustomerArrive();
    const item = savedState().items.find((entry) => entry.location.kind === "checkout")!;
    view.world.callbacks.onTarget({ id: item.id, itemId: item.id, productId: item.productId, kind: "item", label: "收银商品", action: "扫描", inspectable: true, distance: 1 });
    view.world.callbacks.onInteract();
    view.world.callbacks.onInteract();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"], ["scan"]]);
    view.world.callbacks.onTarget({ id: "counter", kind: "counter", label: "收银台", action: "扫描收款", inspectable: false, distance: 1 });
    view.world.callbacks.onInteract();
    view.world.callbacks.onInteract();
    expect(savedState().transactions).toHaveLength(1);
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"], ["scan"], ["scan"], ["payment"]]);
    view.world.callbacks.onInteract();
    view.element("s3-read-customer").click();
    view.world.callbacks.onCustomerArrive();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"], ["scan"], ["scan"], ["payment"]]);
  });

  it.each(["greeting", "checkout", "thanks"] as const)("does not replay historical effects when restoring and rereading a saved %s", async (phase) => {
    let state = act(stockedFirstDay(), { type: "OPEN_STORE" });
    if (phase !== "greeting") for (let step = 0; step < 3; step += 1) state = act(state, { type: "CUSTOMER_ADVANCE" });
    if (phase === "thanks") {
      for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
      state = act(state, { type: "PAY", success: true });
    }
    const view = await readyGame(state);
    view.element("s3-read-customer").click();
    view.element("s3-pause-button").click();
    view.element("s3-resume").click();
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
  });

  it("rings only once for an automatically admitted next visitor", async () => {
    const clock = frameTime();
    const state = completeOrder(stockedFirstDay());
    const view = await readyGame(state);
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    clock.advance(view, state.day.nextCustomerAtMs! - state.day.elapsedOpenMs);
    expect(savedState().customer.number).toBe(2);
    expect(view.world.isCustomerApproaching()).toBe(true);
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
    view.world.enterShop();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
    clock.advance(view, 12_000);
    view.element("s3-read-customer").click();
    expect(view.shopAudio.playEffect.mock.calls).toEqual([["doorbell"]]);
  });

  it("stops music and suppresses feedback if a formerly valid interaction loses save ownership", async () => {
    const view = await readyGame(stockedFirstDay());
    view.world.callbacks.onTarget({ id: "open-sign", kind: "open-sign", label: "营业牌", action: "开店", inspectable: false, distance: 1 });
    storage.setItem(SIM_STORAGE_KEY, JSON.stringify(createFirstDayState()));
    view.world.callbacks.onInteract();
    expect(view.element("s3-start-button").textContent).toBe("此页面只读");
    expect(view.shopAudio.setActive).toHaveBeenLastCalledWith(false);
    expect(view.shopAudio.playEffect).not.toHaveBeenCalled();
  });
});

describe("speech ducking uses real playback events", () => {
  it.each(["ended", "error", "pause", "close", "blur", "hidden"] as const)("restores music when a local recording is stopped by %s", async (reason) => {
    const view = await inspectWord();
    view.shopAudio.setSpeechActive.mockClear();
    view.element("s3-speak-word").click();
    expect(view.shopAudio.setSpeechActive).not.toHaveBeenCalledWith(true);
    view.audio.onplaying?.();
    expect(view.shopAudio.setSpeechActive).toHaveBeenLastCalledWith(true);
    const lateStart = view.audio.onplaying;
    const lateEnd = view.audio.onended;
    if (reason === "ended") view.audio.onended?.();
    else if (reason === "error") view.audio.onerror?.();
    else if (reason === "pause") view.element("s3-pause-button").click();
    else if (reason === "close") view.element("s3-close-inspect").click();
    else if (reason === "blur") windowDouble.dispatchEvent(new Event("blur"));
    else { documentDouble.hidden = true; documentDouble.dispatchEvent(new Event("visibilitychange")) }
    expect(view.shopAudio.setSpeechActive).toHaveBeenLastCalledWith(false);
    if (reason !== "ended") {
      const calls = view.shopAudio.setSpeechActive.mock.calls.length;
      lateStart?.();
      lateEnd?.();
      expect(view.shopAudio.setSpeechActive.mock.calls).toHaveLength(calls);
    }
  });

  it("does not duck for blocked local media playback or a late event from that failed attempt", async () => {
    const view = await inspectWord();
    view.shopAudio.setSpeechActive.mockClear();
    view.audio.play.mockRejectedValueOnce(new Error("NotAllowedError"));
    view.element("s3-speak-word").click();
    await settle();
    view.audio.onplaying?.();
    view.audio.onended?.();
    expect(view.shopAudio.setSpeechActive).not.toHaveBeenCalledWith(true);
    expect(view.shopAudio.setSpeechActive).toHaveBeenLastCalledWith(false);
  });

  it.each(["ended", "error", "pause", "close", "blur"] as const)("restores music when browser speech is stopped by %s", async (reason) => {
    const browser = installBrowserVoice();
    const view = await inspectNewProduct();
    view.shopAudio.setSpeechActive.mockClear();
    view.element("s3-speak-word").click();
    const utterance = browser.utterances[0]!;
    expect(view.shopAudio.setSpeechActive).not.toHaveBeenCalledWith(true);
    utterance.onstart?.();
    expect(view.shopAudio.setSpeechActive).toHaveBeenLastCalledWith(true);
    const lateStart = utterance.onstart;
    const lateEnd = utterance.onend;
    if (reason === "ended") utterance.onend?.();
    else if (reason === "error") utterance.onerror?.();
    else if (reason === "pause") view.element("s3-pause-button").click();
    else if (reason === "close") view.element("s3-close-inspect").click();
    else windowDouble.dispatchEvent(new Event("blur"));
    expect(view.shopAudio.setSpeechActive).toHaveBeenLastCalledWith(false);
    if (reason !== "ended") {
      const calls = view.shopAudio.setSpeechActive.mock.calls.length;
      lateStart?.();
      lateEnd?.();
      expect(view.shopAudio.setSpeechActive.mock.calls).toHaveLength(calls);
    }
  });

  it("does not leave music ducked when the browser's synthesis call throws", async () => {
    const browser = installBrowserVoice();
    const view = await inspectNewProduct();
    view.shopAudio.setSpeechActive.mockClear();
    browser.synthesis.speak.mockImplementationOnce(() => { throw new Error("VoiceUnavailable") });
    view.element("s3-speak-word").click();
    browser.utterances[0]?.onstart?.();
    expect(view.shopAudio.setSpeechActive).not.toHaveBeenCalledWith(true);
    expect(view.shopAudio.setSpeechActive).toHaveBeenLastCalledWith(false);
  });
});
