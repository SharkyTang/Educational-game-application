import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capacityFor, countAt, createFirstDayState, createInitialSimState, DELIVERY_DROP_POINTS, getCustomerOrder, getDeliverySummary, PRODUCTS, PRODUCT_IDS, reduceSim, validateSimState, type PlayerPose, type ProductId, type PurchaseLine, type SimCommand, type SimState } from "../../src/sim3d/domain";
import { SIM_BACKUP_KEY, SIM_STORAGE_KEY, type SimLockManager, type StorageLike } from "../../src/sim3d/persistence";
import type { InteractionTarget, WorldCallbacks } from "../../src/sim3d/world";
import { SPEECH_CLIPS } from "../../src/sim3d/speechClips";
import { customerProfileFor, customerSpeechFor, NEXT_CUSTOMER_SECONDS, type CustomerVoice } from "../../src/sim3d/customerSelection";

const doubles = vi.hoisted(() => {
  class World {
    static instances: World[] = [];
    readonly callbacks: WorldCallbacks;
    private readonly pose: PlayerPose;
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
    readonly setState = vi.fn();
    readonly restorePose = vi.fn();
    constructor(_canvas: HTMLCanvasElement, state: SimState, callbacks: WorldCallbacks) {
      this.callbacks = callbacks;
      this.pose = { ...state.playerPose };
      World.instances.push(this);
    }
    init(): Promise<void> { return this.loading }
    getPose(): PlayerPose { return this.pose }
    complete(): void { this.callbacks.onStatus("模型就绪"); this.finish() }
  }
  return { World };
});

vi.mock("../../src/sim3d/world", () => ({ ShopWorld: doubles.World }));
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
  querySelector(selector: string): ElementDouble | null { return this.elements.get(selector.slice(1)) ?? null }
  querySelectorAll(): ElementDouble[] { return [] }
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

function mount(root = new ElementDouble()): { app: App3D; root: ElementDouble; element: (id: string) => ElementDouble } {
  const app = new App3D(root as unknown as HTMLElement);
  apps.push(app);
  return { app, root, element: (id) => root.elements.get(id)! };
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
  state = act(state, { type: "RECEIVE_DELIVERY" });
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
  state = act(state, { type: "PAY", success: true });
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

function key(code: string): Event {
  const event = Object.assign(new Event("keydown", { cancelable: true }), { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false });
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
  state = act(state, { type: "RECEIVE_DELIVERY" });
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

describe("cursor access and directly reachable business panels", () => {
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

  it.each([["KeyB", "supply"], ["KeyU", "upgrade"], ["KeyM", "street"]] as const)("opens %s directly and returns with clickable pointer", async (code, section) => {
    const view = await readyGame();
    view.world.callbacks.onPointerMode?.("locked");
    expect(key(code).defaultPrevented).toBe(true);
    expect(view.element("s3-pause").open).toBe(true);
    expect(view.element(`s3-panel-${section}`).hidden).toBe(false);
    expect(view.element(`s3-tab-${section}`).getAttribute("aria-pressed")).toBe("true");
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
    view.element("s3-open-supply").click();
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

describe("customer identity, dialogue continuity and saved seeds", () => {
  it("keeps three visibly named customers and both voice sets consistent through greeting, scanning, payment and departure", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
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
      expect(shopping.customer).toEqual({ number, phase: "to-milk", shoppingList: ["milk", "bread"] });
      expect(view.element("s3-customer-name").textContent).toBe(`${profile.name} · 第 ${number} 位顾客`);
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
      view.world.callbacks.onInteract();
      const thanks = customerSpeechFor(savedState(), "thanks");
      thanksIds.add(thanks.id);
      expect(savedState().customer.phase).toBe("leaving");
      expect(savedState().transactions).toHaveLength(number);
      expect(savedState().cashPence).toBe(510 + number * 400);
      expect(customerProfileFor(savedState())).toEqual(profile);
      expect(view.audio.src).toBe(thanks.src);
      expect(view.element("s3-customer-line").textContent).toContain(thanks.text);
      expect(view.element("s3-customer-zh").textContent).toBe(thanks.zh);
      expect(view.audio.play).toHaveBeenCalledTimes(2);
      view.world.callbacks.onCustomerArrive();
      expect(savedState().customer.phase).toBe("complete");
      expect(view.audio.play).toHaveBeenCalledTimes(2); // Departure is not a second thank-you.
      view.audio.play.mockClear();
      now += 650;
      view.world.callbacks.onFrame?.(60, shopping.playerPose);
    }

    expect(profileIds.size).toBe(3);
    expect([...voices].sort()).toEqual(["female", "male"]);
    expect(greetingIds.size).toBe(3);
    expect(checkoutIds.size).toBe(3);
    expect(thanksIds.size).toBe(3);
    expect(savedState().customer).toEqual({ number: 3, phase: "complete", shoppingList: ["milk", "bread"] });
    expect(view.element("s3-panel-day").hidden).toBe(false);
    expect(view.element("s3-pause").open).toBe(true);
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
    expect(fresh.customer).toEqual({ number: 1, phase: "outside", shoppingList: [] });
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
    view.element("s3-open-supply").click();
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
    expect(view.element("s3-delivery-hud").textContent).toContain("6 件待签收");
    expect(view.world.setState).toHaveBeenLastCalledWith(state);
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.world.requestPointerLock).not.toHaveBeenCalled();
    expect(view.element("s3-toast").textContent).toContain("下单成功");
    expect(view.element("s3-toast").textContent).toContain("门口货车旁按 E 签收");
    view.element("s3-open-supply").click();
    expect(view.element("s3-quantity-milk").value).toBe("0");
    expect(view.element("s3-quantity-bread").value).toBe("0");
    expect(view.element("s3-purchase").disabled).toBe(true);
  });

  it("disables unaffordable purchases with an explicit reason, and a smaller selection restores availability", async () => {
    const view = await readyGame();
    key("KeyB");
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
    expect(view.element("s3-open-upgrade").getAttribute("aria-label")).toContain("资金足够");
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
    view.element("s3-open-upgrade").click();
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
    view.element("s3-open-day").click();
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
    view.element("s3-open-day").click();
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

  it.each([1, 3])("automatically follows %i paid orders with the next guest or the day report, never a fourth guest", async (paidCustomers) => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let state = stockedFirstDay();
    for (let count = 0; count < paidCustomers; count += 1) state = completeOrder(state);
    const view = await readyGame(state);
    expect(NEXT_CUSTOMER_SECONDS).toBe(0.65);
    now += 649;
    view.world.callbacks.onFrame?.(60, state.playerPose);
    expect(savedState().customer.phase).toBe("complete");
    expect(view.element("s3-pause").open).toBe(false);
    expect(view.audio.play).not.toHaveBeenCalled();
    now += 1;
    view.world.callbacks.onFrame?.(60, state.playerPose);
    if (paidCustomers === 1) {
      expect(savedState().customer).toEqual({ number: 2, phase: "to-milk", shoppingList: ["milk", "bread"] });
      expect(view.audio.src).toBe(customerSpeechFor(savedState(), "greeting").src);
      expect(view.audio.play).toHaveBeenCalledOnce();
      expect(view.element("s3-pause").open).toBe(false);
    } else {
      expect(savedState().customer).toEqual({ number: 3, phase: "complete", shoppingList: ["milk", "bread"] });
      expect(view.element("s3-pause").open).toBe(true);
      expect(view.element("s3-panel-day").hidden).toBe(false);
      expect(view.element("s3-settle-day").disabled).toBe(false);
      expect(view.audio.play).not.toHaveBeenCalled();
      now += 10_000;
      view.world.callbacks.onFrame?.(60, state.playerPose);
      expect(savedState().customer).toEqual({ number: 3, phase: "complete", shoppingList: ["milk", "bread"] });
      expect(savedState().transactions).toHaveLength(3);
      expect(view.audio.play).not.toHaveBeenCalled();
    }
  });
});

describe("doorstep delivery and high street management", () => {
  it("keeps paid deliveries pending until a nearby physical interaction, then preserves payment exactly once", async () => {
    const pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "doorstep-order", pairs: 3 });
    const view = await readyGame(pending);
    view.world.callbacks.onTarget(deliveryTarget(5));
    expect(view.element("s3-interact").disabled).toBe(true);
    view.world.callbacks.onInteract();
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(6);
    view.world.callbacks.onTarget(deliveryTarget());
    expect(view.element("s3-interact").disabled).toBe(false);
    expect(view.element("s3-target-action").textContent).toContain("签收 6 件");
    view.element("s3-interact").click();
    expect(savedState().cashPence).toBe(510);
    expect(getDeliverySummary(savedState())).toMatchObject({ pendingUnits: 0, receivedToday: 1 });
    expect(savedState().crates.map((crate) => crate.position)).toEqual(DELIVERY_DROP_POINTS.slice(0, 2));
    expect(view.element("s3-delivery-hud").hidden).toBe(true);
    view.world.callbacks.onInteract();
    expect(view.element("s3-panel-supply").hidden).toBe(false);
    expect(view.element("s3-pause").open).toBe(true);
    expect(savedState().cashPence).toBe(510);
    expect(savedState().purchases).toHaveLength(1);
  });

  it("checks unloading space against the latest world pose before rejecting delivery", async () => {
    let pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "blocked-drop", pairs: 1 });
    pending = act(pending, { type: "SAVE_POSE", pose: { ...pending.playerPose, ...DELIVERY_DROP_POINTS[0]! } });
    const view = await readyGame(pending);
    view.world.callbacks.onTarget(deliveryTarget());
    view.world.callbacks.onInteract();
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(2);
    expect(view.element("s3-toast").textContent).toContain("离开门外的卸货点");
    Object.assign(view.world.getPose(), { x: 0, z: -7.5 });
    view.world.callbacks.onInteract();
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(0);
    expect(savedState().cashPence).toBe(970);
  });

  it("does not unload or open another management panel from a paused world interaction", async () => {
    const state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "paused-delivery", pairs: 1 });
    const view = await readyGame(state);
    view.element("s3-open-street").click();
    const snapshot = storage.getItem(SIM_STORAGE_KEY);
    view.world.callbacks.onTarget(deliveryTarget());
    view.world.callbacks.onInteract();
    key("KeyB");
    expect(storage.getItem(SIM_STORAGE_KEY)).toBe(snapshot);
    expect(view.element("s3-panel-street").hidden).toBe(false);
    expect(view.element("s3-panel-supply").hidden).toBe(true);
    expect(getDeliverySummary(savedState()).pendingUnits).toBe(2);
  });

  it("restores a pending paid order with a visible delivery reminder after remount", async () => {
    const pending = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "saved-delivery", pairs: 3 });
    const first = await readyGame(pending);
    await first.app.dispose();
    const restored = await readyGame(savedState());
    expect(restored.element("s3-delivery-hud").hidden).toBe(false);
    expect(restored.element("s3-delivery-hud").textContent).toContain("6 件待签收");
    key("KeyB");
    expect(restored.element("s3-delivery-summary").textContent).toContain("1 笔已付款订单");
    expect(savedState().cashPence).toBe(510);
    expect(countAt(savedState(), "milk", "crate")).toBe(0);
  });

  it("shows delivery as the reason day settlement is blocked after all customers have left", async () => {
    let state = stockedFirstDay();
    for (let count = 0; count < 3; count += 1) state = completeOrder(state);
    state = act(state, { type: "PURCHASE_STOCK", orderId: "tomorrow-order", pairs: 1 });
    const view = await readyGame(state);
    view.element("s3-open-day").click();
    expect(view.element("s3-settle-day").disabled).toBe(true);
    expect(view.element("s3-day-reason").textContent).toContain("2 件已付款商品待签收");
    expect(view.element("s3-day-reason").textContent).not.toContain("正在离店");
    view.element("s3-resume").click();
    view.world.callbacks.onTarget(deliveryTarget());
    view.world.callbacks.onInteract();
    view.element("s3-open-day").click();
    expect(view.element("s3-settle-day").disabled).toBe(false);
  });

  it("uses the public street button and shop signs to select concrete goals while pausing the world", async () => {
    const view = await readyGame();
    const funds = savedState().cashPence;
    view.element("s3-open-street").click();
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
    expect(view.element("s3-pause").open).toBe(true);
    expect(view.element("s3-venue-restaurant").getAttribute("aria-pressed")).toBe("true");
    expect(view.element("s3-venue-detail-restaurant").hidden).toBe(false);
    expect(view.element("s3-venue-detail-supermarket").hidden).toBe(true);
    expect(view.world.setActive).toHaveBeenLastCalledWith(false);
    expect(savedState().cashPence).toBe(funds);
    expect(savedState().inspectedProducts).toEqual([]);
  });

  it("announces achieved shop conditions as preparation while keeping interiors unavailable", async () => {
    let state = stockedFirstDay();
    for (let count = 0; count < 3; count += 1) state = completeOrder(state);
    state = act(state, { type: "SETTLE_DAY" });
    const view = await readyGame(state);
    key("KeyM");
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
    key("KeyB");
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
    key("KeyB");
    expect(view.element("s3-quantity-apple").value).toBe("0");
    expect(view.element("s3-quantity-soap").value).toBe("0");
    expect(view.element("s3-supply-pending-apple").textContent).toBe("待收 2");
    expect(view.element("s3-purchase").disabled).toBe(true);
  });

  it("retains selections through category, search, selected-only and pause-panel changes", async () => {
    const view = await readyGame();
    key("KeyB");
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
    view.element("s3-tab-street").click();
    view.element("s3-tab-supply").click();
    view.element("s3-resume").click();
    key("KeyB");
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
    key("KeyB");
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
    key("KeyB");
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
    preview.element("s3-open-supply").click();
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
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let state = selectedCheckout([{ productId: "soap", quantity: 3 }]);
    for (const item of state.items.filter((entry) => entry.location.kind === "checkout")) state = act(state, { type: "SCAN", itemId: item.id });
    state = act(state, { type: "PAY", success: true });
    state = act(state, { type: "CUSTOMER_ADVANCE" });
    const view = await readyGame(state);
    now += (NEXT_CUSTOMER_SECONDS + 0.05) * 1000;
    view.world.callbacks.onFrame?.(60, state.playerPose);
    expect(savedState().customer).toEqual({ number: 2, phase: "to-milk", shoppingList: ["soap"] });
    expect(view.element("s3-customer-order").textContent).toContain("香皂");
    expect(view.element("s3-pause").open).toBe(false);
  });
});

async function inspectNewProduct(productId: ProductId = "apple") {
  let state = act(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "inspect-new-product", lines: [{ productId, quantity: 1 }] });
  state = act(state, { type: "RECEIVE_DELIVERY" });
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
