import {
  Camera, Color3, Color4, DirectionalLight, Engine, HemisphericLight,
  Scene, TransformNode, UniversalCamera, Vector3,
} from "@babylonjs/core";
import { CashDrawerVisual } from "./cashDrawerVisual";
import { cashVisualPickCommand, type CashVisualPick, type CashVisualSnapshot } from "./cashVisualState";

const PREFIX = "s3-cash-visual-";

export interface CashVisualRuntime {
  update(snapshot: CashVisualSnapshot): void;
  dispose(): void;
}
export type CashVisualRuntimeFactory = (
  canvas: HTMLCanvasElement,
  onPick: (pick: CashVisualPick) => void,
  onUnavailable: () => void,
) => CashVisualRuntime;

export function cashVisualInstructions(snapshot: CashVisualSnapshot): string {
  if (!snapshot.open) return "钱箱已合上。打开钱箱后可继续；暂收款和找零托盘会保留。";
  if (snapshot.stage === "awaiting") return "点顾客交款区收下现金，再从钱箱分格点选零钱。";
  if (snapshot.stage === "received") return "点钱箱分格加入一枚／张；点找零托盘里的钱撤回。暂收款完成交易后才入钱箱。";
  return "钱箱按当前存档显示；没有正在进行的现金订单。";
}

export function cashVisualBalance(snapshot: CashVisualSnapshot): string {
  const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
  if (snapshot.stage === "idle") return "没有待处理的现金订单";
  const difference = snapshot.changeDuePence - snapshot.selectedChangePence;
  const status = snapshot.stage !== "received" ? "等待收下现金"
    : difference > 0 ? `还差 ${money(difference)}`
    : difference < 0 ? `多了 ${money(-difference)}` : "金额正好";
  return `应找 ${money(snapshot.changeDuePence)} · 已选 ${money(snapshot.selectedChangePence)} · ${status}`;
}

/** A lightweight close-up of the same assets used on the real counter, not a second ledger. */
export const createCashVisualRuntime: CashVisualRuntimeFactory = (canvas, onPick, onUnavailable) => {
  let engine: Engine | undefined;
  let scene: Scene | undefined;
  let visual: CashDrawerVisual | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let disposed = false;
  const events = new AbortController();
  const release = (): void => {
    if (disposed) return;
    disposed = true;
    events.abort();
    resizeObserver?.disconnect();
    engine?.stopRenderLoop();
    visual?.dispose();
    scene?.dispose();
    engine?.dispose();
  };
  try {
    engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false }, false);
    engine.setHardwareScalingLevel(Math.max(1, (window.devicePixelRatio || 1) / 1.5));
    scene = new Scene(engine);
    scene.clearColor = new Color4(.91, .93, .86, 1);
    scene.ambientColor = new Color3(.26, .27, .23);
    const light = new HemisphericLight("cash-closeup-daylight", new Vector3(0, 1, 0), scene);
    light.intensity = 1.05;
    const key = new DirectionalLight("cash-closeup-key", new Vector3(.35, -1, .5), scene);
    key.intensity = .65;
    const camera = new UniversalCamera("cash-closeup-camera", new Vector3(.18, 1.9, 1.61), scene);
    camera.setTarget(new Vector3(.18, 0, .19));
    camera.inputs.clear();
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.minZ = .01;
    camera.maxZ = 6;
    scene.activeCamera = camera;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let gameReducedMotion = false;
    visual = new CashDrawerVisual(scene, new TransformNode("cash-closeup-root", scene), {
      name: "cash-closeup", reducedMotion: media?.matches ?? false,
      changePosition: { x: .46, y: -.02, z: .42 },
    });
    media?.addEventListener("change", (event) => visual?.setReducedMotion(gameReducedMotion || event.matches), { signal: events.signal });
    const resize = (): void => {
      if (disposed || !engine) return;
      engine.resize();
      const aspect = Math.max(.5, engine.getRenderWidth() / Math.max(1, engine.getRenderHeight()));
      const halfHeight = Math.max(.37, .52 / aspect);
      camera.orthoLeft = -halfHeight * aspect;
      camera.orthoRight = halfHeight * aspect;
      camera.orthoTop = halfHeight;
      camera.orthoBottom = -halfHeight;
    };
    window.addEventListener("resize", resize, { signal: events.signal });
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas);
    }
    resize();
    let down: { x: number; y: number; id: number } | null = null;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button === 0) down = { x: event.clientX, y: event.clientY, id: event.pointerId };
    }, { signal: events.signal });
    canvas.addEventListener("pointercancel", () => { down = null }, { signal: events.signal });
    canvas.addEventListener("pointerup", (event) => {
      const start = down;
      down = null;
      if (!start || start.id !== event.pointerId || event.button !== 0 || disposed
        || Math.hypot(start.x - event.clientX, start.y - event.clientY) > 8) return;
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      // Babylon's pick coordinates are CSS pixels; engine scaling is applied internally.
      // Housing and dividers must occlude the cash even when they have no action.
      const hit = scene!.pick(event.clientX - bounds.left, event.clientY - bounds.top,
        (mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0);
      if (!hit?.pickedMesh) return;
      const pick = visual!.pick(hit.pickedMesh);
      if (pick) onPick(pick);
    }, { signal: events.signal });
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      release();
      onUnavailable();
    }, { signal: events.signal });
    let previous = performance.now();
    engine.runRenderLoop(() => {
      if (disposed || document.hidden || !canvas.isConnected) return;
      const now = performance.now();
      if (now - previous < 1000 / 30) return;
      const elapsed = Math.min(100, Math.max(0, now - previous));
      previous = now;
      try { visual!.tick(elapsed); scene!.render(); }
      catch { release(); onUnavailable(); }
    });
    return {
      update(snapshot) {
        if (disposed) return;
        gameReducedMotion = snapshot.reducedMotion;
        visual!.setReducedMotion(gameReducedMotion || media?.matches === true);
        visual!.update(snapshot);
      },
      dispose: release,
    };
  } catch (error) {
    release();
    throw error;
  }
};

export interface CashVisualViewportCallbacks {
  /** The controller must resolve this pick again against the current saved payment. */
  onPick(pick: CashVisualPick): boolean;
  onDrawerChange(open: boolean): void;
  /** Restore the accessible controls immediately, including after closing the drawer. */
  onUnavailable?(): void;
}

/** Lifecycle and accessible explanation only; closing or losing WebGL never changes money. */
export class CashVisualViewport {
  private readonly events = new AbortController();
  private runtime: CashVisualRuntime | null = null;
  private snapshot: CashVisualSnapshot | null = null;
  private visible = false;
  private failed = false;
  private disposed = false;
  private generation = 0;

  constructor(private readonly host: HTMLElement, private readonly callbacks: CashVisualViewportCallbacks,
    private readonly factory: CashVisualRuntimeFactory = createCashVisualRuntime) {
    host.innerHTML = `<section class="s3-cash-visual" aria-labelledby="${PREFIX}title">
      <div class="s3-cash-visual-heading"><div><h3 id="${PREFIX}title">实体钱箱 <span lang="en">Cash drawer</span></h3><p>游戏英镑 · 分格找零</p></div><button id="${PREFIX}toggle" type="button" class="s3-secondary-button" aria-expanded="false">打开钱箱</button></div>
      <p id="${PREFIX}balance" class="s3-cash-visual-balance" role="status" aria-live="polite"></p>
      <canvas id="${PREFIX}canvas" aria-label="三维钱箱、顾客交款区和找零托盘。也可使用下方的面额按钮操作。"></canvas>
      <p id="${PREFIX}status" class="s3-cash-visual-status" role="status" aria-live="polite"></p>
      <p id="${PREFIX}source" class="s3-cash-visual-source"></p>
      <p class="s3-cash-visual-caption">每格最多显示 6 枚／张示意，数量标签为实际库存；大额堆叠仍可逐次点取。不是可流通货币。</p>
    </section>`;
    this.el<HTMLButtonElement>("toggle").addEventListener("click", () => {
      if (this.visible && !this.failed && !this.disposed && this.snapshot) this.callbacks.onDrawerChange(!this.snapshot.open);
    }, { signal: this.events.signal });
  }

  get available(): boolean { return this.visible && this.runtime !== null && !this.failed && !this.disposed }

  show(snapshot: CashVisualSnapshot): void {
    if (this.disposed) return;
    this.visible = true;
    this.failed = false;
    this.snapshot = snapshot;
    if (!this.runtime) {
      const generation = ++this.generation;
      try {
        this.runtime = this.factory(this.el<HTMLCanvasElement>("canvas"), (pick) => {
          if (generation === this.generation && this.available && this.snapshot
            && cashVisualPickCommand(this.snapshot, pick)) this.callbacks.onPick(pick);
        }, () => { if (generation === this.generation && this.visible) this.fail(); });
        if (this.failed) { this.runtime.dispose(); this.runtime = null; }
      } catch { this.fail(); }
    }
    this.update(snapshot);
  }

  update(snapshot: CashVisualSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    if (!this.visible) return;
    try { this.runtime?.update(snapshot); } catch { this.fail(); }
    const toggle = this.el<HTMLButtonElement>("toggle");
    toggle.textContent = snapshot.open ? "合上钱箱" : "打开钱箱";
    toggle.setAttribute("aria-expanded", String(snapshot.open));
    toggle.disabled = this.failed;
    this.host.setAttribute("data-renderer", this.failed ? "fallback" : "ready");
    this.el("canvas").hidden = this.failed;
    this.el("balance").textContent = cashVisualBalance(snapshot);
    this.el("status").textContent = this.failed
      ? "3D 近景暂不可用，现金和找零已保留；请使用下方的面额按钮继续。"
      : cashVisualInstructions(snapshot);
    this.el("source").textContent = snapshot.tenderSourceLabel;
    this.el("source").hidden = snapshot.tenderSource === "none";
  }

  hide(): void {
    this.visible = false;
    this.generation += 1;
    this.runtime?.dispose();
    this.runtime = null;
    this.snapshot = null;
    this.failed = false;
    this.host.setAttribute("data-renderer", "inactive");
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.runtime?.dispose();
    this.runtime = null;
    if (this.visible && this.snapshot) this.update(this.snapshot);
    this.callbacks.onUnavailable?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
    this.events.abort();
    this.host.replaceChildren();
  }

  private el<T extends HTMLElement = HTMLElement>(suffix: string): T {
    return this.host.querySelector<T>(`#${PREFIX}${suffix}`)!;
  }
}
