import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, type AbstractMesh, type PickingInfo, type Scene } from "@babylonjs/core";
import { createCashVisualRuntime, type CashVisualRuntime } from "../../src/sim3d/cashVisualViewport";
import { createDefaultCashDrawer } from "../../src/sim3d/cashDrawer";
import { deriveCashVisualState, type CashVisualSnapshot } from "../../src/sim3d/cashVisualState";

const engineInstances = vi.hoisted(() => [] as unknown[]);

// Keep Babylon Scene, camera, geometry, materials and CashDrawerVisual real. Only
// substitute the GPU engine and manually schedule its render callback.
vi.mock("@babylonjs/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonjs/core")>();
  class RuntimeNullEngine extends actual.NullEngine {
    frame: (() => void) | null = null;
    resizeCalls = 0;
    stopCalls = 0;
    scaling = 1;
    constructor(_canvas: HTMLCanvasElement) {
      super({ renderWidth: 900, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
      engineInstances.push(this);
    }
    override createCanvas(width: number, height: number): ReturnType<NullEngine["createCanvas"]> {
      const context = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
        fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "left", textBaseline: "middle", font: "12px Arial" };
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    }
    override setHardwareScalingLevel(value: number): void { this.scaling = value; }
    override getHardwareScalingLevel(): number { return this.scaling; }
    override resize(): void { this.resizeCalls += 1; }
    override runRenderLoop(callback: () => void): void { this.frame = callback; }
    override stopRenderLoop(): void { this.stopCalls += 1; this.frame = null; }
  }
  return { ...actual, Engine: RuntimeNullEngine };
});

interface TestEngine extends NullEngine {
  frame: (() => void) | null;
  resizeCalls: number;
  stopCalls: number;
  scaling: number;
}
class CanvasDouble extends EventTarget {
  isConnected = true;
  width = 900;
  height = 600;
  style = {};
  bounds = { left: 80, top: 40, width: 450, height: 300 };
  getBoundingClientRect() { return this.bounds; }
  setAttribute(): void {}
  focus(): void {}
  getContext(): null { return null; }
}
class MediaDouble extends EventTarget {
  matches = false;
  change(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(Object.assign(new Event("change"), { matches }));
  }
}

let canvas: CanvasDouble;
let media: MediaDouble;
let windowDouble: EventTarget & { devicePixelRatio: number; matchMedia: () => MediaDouble };
let documentDouble: EventTarget & { hidden: boolean };
let now: number;
let runtimes: CashVisualRuntime[];
let resizeObservers: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>;

beforeEach(() => {
  engineInstances.length = 0;
  canvas = new CanvasDouble();
  media = new MediaDouble();
  windowDouble = Object.assign(new EventTarget(), { devicePixelRatio: 3, matchMedia: () => media,
    setTimeout, clearTimeout, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
  documentDouble = Object.assign(new EventTarget(), { hidden: false });
  now = 0;
  runtimes = [];
  resizeObservers = [];
  vi.stubGlobal("window", windowDouble);
  vi.stubGlobal("document", documentDouble);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(readonly callback: () => void) { resizeObservers.push(this); }
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  for (const engine of engineInstances as TestEngine[]) engine.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function snapshot(received = false, open = true): CashVisualSnapshot {
  return deriveCashVisualState({ payment: { method: "cash", tenderedPence: 500, tenderedCash: [500],
    tenderedCashRecorded: true, received, selectedChange: received ? [50] : [] },
  cashDrawer: createDefaultCashDrawer(), amountPence: 435, checkout: true, open, canInteract: true });
}

function setup() {
  const onPick = vi.fn();
  const onUnavailable = vi.fn();
  const runtime = createCashVisualRuntime(canvas as unknown as HTMLCanvasElement, onPick, onUnavailable);
  runtimes.push(runtime);
  const engine = engineInstances.at(-1) as TestEngine;
  const scene = engine.scenes[0] as Scene;
  runtime.update(snapshot());
  return { runtime, engine, scene, onPick, onUnavailable };
}

function pointer(type: string, patch: { x?: number; y?: number; id?: number; button?: number } = {}): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    clientX: patch.x ?? 125, clientY: patch.y ?? 95, pointerId: patch.id ?? 1, button: patch.button ?? 0,
  });
  canvas.dispatchEvent(event);
  return event;
}

describe("cash close-up real runtime without a GPU", () => {
  it("constructs the real scene and drawer, projects updates and renders at the bounded frame rate", () => {
    const view = setup();
    const render = vi.spyOn(view.scene, "render");
    expect(view.engine.scaling).toBe(2);
    expect(view.scene.activeCamera?.name).toBe("cash-closeup-camera");
    expect(view.scene.getTransformNodeByName("cash-closeup")?.metadata.stage).toBe("awaiting");
    expect(view.scene.meshes.length).toBeGreaterThan(40);
    expect(resizeObservers[0]!.observe).toHaveBeenCalledExactlyOnceWith(canvas);
    expect(view.engine.resizeCalls).toBe(1);
    now = 20; view.engine.frame!();
    expect(render).not.toHaveBeenCalled();
    now = 40; view.engine.frame!();
    expect(render).toHaveBeenCalledTimes(1);
    view.runtime.update(snapshot(true));
    expect(view.scene.getTransformNodeByName("cash-closeup")?.metadata.stage).toBe("received");
    expect(view.scene.getTransformNodeByName("cash-closeup-drawer-50-stack")?.metadata.actualCount).toBe(9);
    now = 50; view.engine.frame!();
    expect(render).toHaveBeenCalledTimes(1);
    now = 80; view.engine.frame!();
    expect(render).toHaveBeenCalledTimes(2);
    expect(view.onUnavailable).not.toHaveBeenCalled();
    expect(view.onPick).not.toHaveBeenCalled();
  });

  it("does not render in the background or after the close-up canvas detaches", () => {
    const view = setup();
    const render = vi.spyOn(view.scene, "render");
    documentDouble.hidden = true;
    now = 100; view.engine.frame!();
    expect(render).not.toHaveBeenCalled();
    documentDouble.hidden = false;
    canvas.isConnected = false;
    now = 200; view.engine.frame!();
    expect(render).not.toHaveBeenCalled();
    canvas.isConnected = true;
    now = 300; view.engine.frame!();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("ignores drags, cancelled pointers, mismatched fingers and secondary buttons", () => {
    const view = setup();
    const pick = vi.spyOn(view.scene, "pick");
    pointer("pointerup");
    pointer("pointerdown"); pointer("pointerup", { x: 140 });
    pointer("pointerdown"); pointer("pointercancel"); pointer("pointerup");
    pointer("pointerdown", { id: 1 }); pointer("pointerup", { id: 2 });
    pointer("pointerdown", { button: 2 }); pointer("pointerup", { button: 2 });
    expect(pick).not.toHaveBeenCalled();
    expect(view.onPick).not.toHaveBeenCalled();
  });

  it("uses CSS-relative coordinates and lets solid shell meshes block cash behind them", () => {
    const view = setup();
    const tender = view.scene.getMeshByName("cash-closeup-tender-floor")!;
    const roof = view.scene.getMeshByName("cash-closeup-asset-roof")!;
    const pick = vi.spyOn(view.scene, "pick").mockReturnValue({ pickedMesh: tender } as PickingInfo);
    pointer("pointerdown"); pointer("pointerup");
    expect(pick).toHaveBeenCalledWith(45, 55, expect.any(Function));
    expect(view.onPick).toHaveBeenCalledExactlyOnceWith({ kind: "receive" });
    const predicate = pick.mock.calls[0]![2] as (mesh: AbstractMesh) => boolean;
    expect(predicate(roof)).toBe(true);
    roof.isPickable = false;
    expect(predicate(roof)).toBe(true); // Occlusion includes non-action housing, not just cash targets.
    roof.isVisible = false; expect(predicate(roof)).toBe(false); roof.isVisible = true;
    roof.visibility = 0; expect(predicate(roof)).toBe(false); roof.visibility = 1;
    roof.setEnabled(false); expect(predicate(roof)).toBe(false); roof.setEnabled(true);
    pick.mockReturnValue({ pickedMesh: roof } as PickingInfo);
    pointer("pointerdown"); pointer("pointerup");
    expect(view.onPick).toHaveBeenCalledTimes(1);
    canvas.bounds.width = 0;
    pointer("pointerdown"); pointer("pointerup");
    expect(pick).toHaveBeenCalledTimes(2);
  });

  it("responds to reduced-motion changes and detaches resize/media listeners on release", () => {
    const view = setup();
    const drawer = view.scene.getTransformNodeByName("cash-closeup-asset-sliding");
    expect(drawer).not.toBeNull();
    expect(drawer!.position.z).toBe(0);
    media.change(true);
    expect(drawer!.position.z).toBeCloseTo(.27);
    view.runtime.update(snapshot(false, false));
    expect(drawer!.position.z).toBe(0);
    media.change(false);
    view.runtime.update(snapshot(false, true));
    expect(drawer!.position.z).toBe(0);
    now = 40; view.engine.frame!();
    expect(drawer!.position.z).toBeGreaterThan(0);
    expect(drawer!.position.z).toBeLessThan(.27);
    windowDouble.dispatchEvent(new Event("resize"));
    resizeObservers[0]!.callback();
    expect(view.engine.resizeCalls).toBe(3);
    view.runtime.dispose();
    windowDouble.dispatchEvent(new Event("resize"));
    resizeObservers[0]!.callback();
    media.change(true);
    expect(view.engine.resizeCalls).toBe(3);
    expect(resizeObservers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(view.onUnavailable).not.toHaveBeenCalled();
  });

  it("honours the in-game motion setting as well as the operating-system preference", () => {
    const view = setup();
    const drawer = view.scene.getTransformNodeByName("cash-closeup-asset-sliding")!;
    view.runtime.update({ ...snapshot(), reducedMotion: true });
    expect(drawer.position.z).toBeCloseTo(.27);
    view.runtime.update({ ...snapshot(false, false), reducedMotion: true });
    expect(drawer.position.z).toBe(0);
    media.change(false);
    view.runtime.update({ ...snapshot(), reducedMotion: true });
    expect(drawer.position.z).toBeCloseTo(.27);
    view.runtime.update({ ...snapshot(false, false), reducedMotion: true });
    view.runtime.update({ ...snapshot(), reducedMotion: false });
    expect(drawer.position.z).toBe(0);
    media.change(true);
    expect(drawer.position.z).toBeCloseTo(.27);
  });

  it.each(["context-lost", "render-throw"] as const)("releases every owned runtime resource exactly once after %s", (failure) => {
    const view = setup();
    const frame = view.engine.frame!;
    const engineDispose = vi.spyOn(view.engine, "dispose");
    const sceneDisposed = vi.fn();
    view.scene.onDisposeObservable.add(sceneDisposed);
    const roof = view.scene.getMeshByName("cash-closeup-asset-roof")!;
    const meshDisposed = vi.fn();
    roof.onDisposeObservable.add(meshDisposed);
    if (failure === "context-lost") {
      const lost = new Event("webglcontextlost", { cancelable: true });
      canvas.dispatchEvent(lost);
      expect(lost.defaultPrevented).toBe(true);
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    } else {
      vi.spyOn(view.scene, "render").mockImplementationOnce(() => { throw new Error("Simulated render failure"); });
      now = 40; frame();
    }
    now = 100; frame();
    view.runtime.dispose();
    view.runtime.dispose();
    view.runtime.update(snapshot(true));
    pointer("pointerdown"); pointer("pointerup");
    windowDouble.dispatchEvent(new Event("resize"));
    media.change(true);
    expect(view.onUnavailable).toHaveBeenCalledOnce();
    expect(view.onPick).not.toHaveBeenCalled();
    expect(resizeObservers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(sceneDisposed).toHaveBeenCalledOnce();
    expect(meshDisposed).toHaveBeenCalledOnce();
    expect(engineDispose).toHaveBeenCalledOnce();
    expect(view.engine.frame).toBeNull();
    expect(view.engine.scenes).toHaveLength(0);
    expect(view.scene.meshes).toHaveLength(0);
  });
});
