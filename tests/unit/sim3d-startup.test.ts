import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialSimState, reduceSim, type PlayerPose, type SimState } from "../../src/sim3d/domain";
import { SIM_BACKUP_KEY, SIM_STORAGE_KEY, type SimLockManager, type StorageLike } from "../../src/sim3d/persistence";
import type { WorldCallbacks } from "../../src/sim3d/world";

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
  src = "";
  volume = 1;
  currentTime = 0;
  paused = true;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly play = vi.fn(async () => { this.paused = false });
  readonly pause = vi.fn(() => { this.paused = true });
  files: Array<{ name: string; size: number; text: () => Promise<string> }> | null = null;
  readonly classList = { toggle: vi.fn() };
  readonly focus = vi.fn();
  readonly elements = new Map<string, ElementDouble>();
  private markup = "";
  get innerHTML(): string { return this.markup }
  set innerHTML(markup: string) {
    this.markup = markup;
    this.elements.clear();
    for (const match of markup.matchAll(/<[a-z][a-z\d-]*\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const attributes = match[1]!;
      const element = new ElementDouble();
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
    const speech = { cancel: vi.fn() };
    Object.assign(windowDouble, { speechSynthesis: speech });
    vi.stubGlobal("speechSynthesis", speech);
    const view = mount();
    const loading = view.app.init();
    await settle();
    const world = doubles.World.instances[0]!;
    world.complete();
    await loading;
    view.element("s3-start-button").click();
    world.callbacks.onTarget({ id: "milk-crate", kind: "crate", crateId: "milk-crate", productId: "milk", label: "牛奶", action: "抱起货箱", inspectable: true, distance: 1 });
    world.callbacks.onInspect();
    expect(view.element("s3-inspection").hidden).toBe(false);
    speech.cancel.mockClear();
    windowDouble.dispatchEvent(new Event("blur"));
    expect(speech.cancel).toHaveBeenCalledOnce();
    documentDouble.hidden = true;
    documentDouble.dispatchEvent(new Event("visibilitychange"));
    expect(speech.cancel).toHaveBeenCalledTimes(2);
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
    expect(view.element("s3-start-note").textContent).toContain("2 件已售出");
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
  const view = mount();
  const loading = view.app.init();
  await settle();
  const world = doubles.World.instances.at(-1)!;
  world.complete();
  await loading;
  view.element("s3-start-button").click();
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

  it("does not play a word recording as a substitute for an unavailable phrase", async () => {
    const view = await inspectWord();
    view.element("s3-speak-phrase").click();
    expect(view.audio.play).not.toHaveBeenCalled();
    expect(view.element("s3-speech-status").textContent).toBe("这段搭配暂无可用朗读，单词可正常听。");
    view.element("s3-read-customer").click();
    expect(view.audio.play).not.toHaveBeenCalled();
    expect(view.element("s3-speech-status").textContent).toContain("这句顾客话暂无可用朗读");
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
