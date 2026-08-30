import {
  PRODUCTS, PRODUCT_IDS, UPGRADE_COST_PENCE, capacityFor, countAt,
  createInitialSimState, getCheckoutTotal, getObjective, reduceSim,
  type PlayerPose, type ProductId, type SimCommand, type SimState,
} from "./domain";
import { loadSimState, parseImportedSimState, SimSaveConflictError, SimSaveSession, SIM_STORAGE_KEY } from "./persistence";
import { ShopWorld, type InteractionTarget, type Quality } from "./world";
import "./styles.css";

type ScreenMode = "loading" | "start" | "playing" | "paused" | "inspecting" | "readonly" | "error";
interface Settings {
  schemaVersion: 1;
  sensitivity: number;
  quality: Quality;
  reducedMotion: boolean;
  volume: number;
}
const SETTINGS_KEY = "english-high-street:sim3d:settings:v1";
const MAX_INTERACTION_DISTANCE = 2.6;
const DEFAULT_SETTINGS: Settings = { schemaVersion: 1, sensitivity: 1, quality: "standard", reducedMotion: true, volume: 0.7 };
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
const unitPhrase = (id: ProductId): string => id === "milk" ? "a carton of milk" : "a loaf of bread";
const clamp = (number: number, min: number, max: number): number => Math.max(min, Math.min(max, number));
const activeInstances = new Set<App3D>();

export function interactionInReach(target: InteractionTarget | null): target is InteractionTarget {
  return target !== null && Number.isFinite(target.distance) && target.distance >= 0 && target.distance <= MAX_INTERACTION_DISTANCE;
}

/** A DOM button follows the same ray-picked target and distance rules as its keyboard shortcut. */
export function commandForInteraction(state: SimState, target: InteractionTarget | null): { command?: SimCommand; message?: string } {
  if (!target) return {};
  if (!interactionInReach(target)) return { message: "再走近一点，才能操作这件物品。" };
  switch (target.kind) {
    case "crate": return target.crateId ? { command: { type: "PICK_CRATE", crateId: target.crateId } } : {};
    case "shelf": {
      if (!target.productId) return {};
      const occupied = state.items.flatMap((item) => item.location.kind === "shelf" && item.location.productId === target.productId ? [item.location.slot] : []);
      const slot = Array.from({ length: capacityFor(state) }, (_, index) => index).find((candidate) => !occupied.includes(candidate));
      return slot === undefined ? { message: "这一侧货架已经放满了。" } : { command: { type: "STOCK", productId: target.productId, slot } };
    }
    case "item": {
      if (!target.itemId) return {};
      const item = state.items.find((candidate) => candidate.id === target.itemId);
      if (!item) return { message: "这里的商品已经移走，请重新看向物品。" };
      return { command: { type: item.location.kind === "checkout" ? "SCAN" : "TAKE_ITEM", itemId: item.id } };
    }
    case "counter": {
      if (state.customer.phase !== "checkout") return { message: "等顾客带着商品来到收银台后，就可以收款。" };
      const next = state.items.find((item) => item.location.kind === "checkout" && !state.scannedIds.includes(item.id));
      return { command: next ? { type: "SCAN", itemId: next.id } : { type: "PAY", success: true } };
    }
    case "open-sign":
      return { command: { type: state.customer.phase === "outside" ? "OPEN_STORE" : "NEXT_CUSTOMER" } };
    case "drop-zone":
      return state.held.kind === "item" ? { command: { type: "RETURN_ITEM" } }
        : target.position ? { command: { type: "DROP_HELD", position: target.position } } : {};
  }
}

export function inspectableProduct(state: SimState, target: InteractionTarget | null): ProductId | null {
  const held = state.held;
  if (held.kind === "item") return state.items.find((item) => item.id === held.itemId)?.productId ?? null;
  if (held.kind === "crate") return state.items.find((item) => item.location.kind === "crate" && item.location.crateId === held.crateId)?.productId ?? null;
  return interactionInReach(target) && target.inspectable ? target.productId ?? null : null;
}

/** Accessible DOM controls over the real 3D world; no mock inventory or hidden test bridge. */
export class App3D {
  private readonly root: HTMLElement;
  private state: SimState = createInitialSimState();
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private world: ShopWorld | null = null;
  private saveSession: SimSaveSession | null = null;
  private mode: ScreenMode = "loading";
  private target: InteractionTarget | null = null;
  private inspecting: ProductId | null = null;
  private loadedSession = false;
  private ready = false;
  private disposed = false;
  private initGeneration = 0;
  private precedingMountRelease: Promise<void> = Promise.resolve();
  private releaseCompletion: Promise<void> = Promise.resolve();
  private loadWarning = "";
  private saveError = "";
  private writerWarning = "";
  private settingsWarning = "";
  private lastSaveText = "存档保存在这台电脑的浏览器中";
  private lastPoseSave = 0;
  private lastFpsUpdate = 0;
  private receiptCustomer = 0;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private speechTimer: ReturnType<typeof setTimeout> | undefined;
  private speechGeneration = 0;
  private dragLookFallback = false;
  private pendingImport: SimState | null = null;
  private importGeneration = 0;
  private readonly events = new AbortController();

  constructor(root: HTMLElement) {
    this.root = root;
    // A hot remount must release the previous owner before its DOM is replaced.
    for (const app of activeInstances) if (app.root === root) this.precedingMountRelease = app.dispose();
    try {
      const saved = loadSimState();
      this.state = saved.state;
      this.loadedSession = saved.source !== "new";
      this.loadWarning = saved.warning ?? "";
      if (this.loadedSession) this.lastSaveText = "已读取本机存档";
    } catch {
      this.saveError = "浏览器暂不允许读取本地存档。为避免覆盖已有进度，本页保持只读；请检查浏览器存储权限。";
    }
    this.readSettings();
    this.renderShell();
    this.bindEvents();
    this.renderState();
    activeInstances.add(this);
  }

  async init(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.initGeneration;
    const isCurrent = (): boolean => !this.disposed && generation === this.initGeneration;
    this.ready = false;
    this.mode = "loading";
    this.dragLookFallback = false;
    this.el<HTMLButtonElement>("s3-start-button").disabled = true;
    this.text("s3-loading", "正在载入小店、商品和顾客模型…");
    this.el("s3-retry").hidden = true;
    this.el("s3-start").hidden = false;
    this.world?.dispose();
    this.world = null;
    try {
      await this.precedingMountRelease;
      if (!isCurrent()) return;
      this.saveSession ??= new SimSaveSession();
      const admitted = await this.saveSession.acquire();
      if (!isCurrent()) return;
      const snapshot = this.saveSession.load();
      this.state = snapshot.state;
      this.loadedSession = snapshot.source !== "new";
      this.loadWarning = snapshot.warning ?? "";
      this.writerWarning = admitted ? "" : "另一页面正在营业。此页面只读，不能修改进度或设置；关闭另一页面后，可以读取最新进度并接管。";
      if (admitted) this.saveError = "";
      this.lastSaveText = admitted ? "已读取本机完整快照" : "只读 · 不会覆盖另一页面的进度";
    } catch {
      if (!isCurrent()) return;
      this.saveSession?.release();
      this.writerWarning = "无法取得安全的存档写入权限。此页面保持只读，请检查浏览器存储权限后重试。";
    }
    this.renderState();
    try {
      const world = new ShopWorld(this.el<HTMLCanvasElement>("s3-canvas"), this.state, {
        onTarget: (target) => { if (isCurrent()) { this.target = target; this.renderTarget() } },
        onInteract: () => { if (isCurrent()) this.interact() },
        onInspect: () => { if (isCurrent()) this.openInspection() },
        onDrop: () => { if (isCurrent()) this.dropHeld() },
        onPause: () => { if (isCurrent()) this.pause() },
        onCustomerArrive: () => {
          if (isCurrent() && this.mode === "playing") this.dispatch({ type: "CUSTOMER_ADVANCE" });
        },
        onStatus: (text) => {
          if (!isCurrent()) return;
          if (text.includes("浏览器未锁定鼠标")) { this.dragLookFallback = true; this.renderCaptureHint() }
          if (this.mode === "loading") this.text("s3-loading", text);
          else this.notify(text);
        },
        onGuide: (text) => { if (isCurrent()) this.text("s3-guide", text) },
        onFrame: (fps, pose) => { if (isCurrent()) this.onFrame(fps, pose) },
      });
      this.world = world;
      await world.init();
      if (!isCurrent()) return;
      this.applySettings();
      world.setActive(false);
      this.ready = true;
      this.mode = this.saveSession?.canWrite ? "start" : "readonly";
      this.text("s3-loading", this.saveSession?.canWrite ? "小店准备好了 · 键盘与鼠标操作" : "小店预览已载入，本页不会写入存档。");
      this.renderState();
    } catch (error) {
      if (!isCurrent()) return;
      this.world?.setActive(false);
      this.ready = false;
      this.mode = "error";
      this.text("s3-loading", "小店暂时没有加载成功。请检查网络与浏览器的图形加速设置，再重试；存档不会因此被清除。");
      this.text("s3-load-detail", error instanceof Error ? error.message : "模型或 3D 图形初始化失败。");
      this.el("s3-load-detail").hidden = false;
      this.el("s3-retry").hidden = false;
    }
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing 3D UI element: ${id}`);
    return element;
  }

  private text(id: string, text: string): void {
    const element = this.el(id);
    if (element.textContent !== text) element.textContent = text;
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <main class="sim3d-app" aria-label="英语商业街 3D 小店">
        <canvas id="s3-canvas" class="s3-canvas" tabindex="0" aria-label="第一人称小店场景：WASD 移动，鼠标观察，E 互动，F 近看商品，G 放下货箱，Esc 暂停"></canvas>
        <audio id="s3-word-audio" preload="none" hidden></audio>
        <div id="s3-hud" class="s3-hud" hidden>
          <div class="s3-top-left">
            <p class="s3-wordmark">CORNER SHOP <span>英语商业街</span></p>
            <details id="s3-task" class="s3-task" open>
              <summary><span id="s3-phase">准备开店</span><span class="s3-fold-hint">目标</span></summary>
              <p id="s3-objective"></p>
              <div class="s3-stock-line"><span id="s3-milk-stock"></span><span id="s3-bread-stock"></span></div>
            </details>
          </div>
          <div class="s3-top-right">
            <div class="s3-wallet"><span class="s3-small-label">小店资金</span><strong id="s3-cash">£0.00</strong><span id="s3-sold">售出 0 / 8 件</span></div>
            <button id="s3-pause-button" class="s3-glass-button" type="button">暂停 <kbd>Esc</kbd></button>
          </div>
          <p id="s3-guide" class="s3-guide"></p>
          <div id="s3-reticle" class="s3-reticle" aria-hidden="true"></div>
          <button id="s3-capture" class="s3-capture" type="button" hidden>点击继续控制视角 <span>Esc 可释放鼠标</span></button>
          <details id="s3-receipt" class="s3-receipt" hidden>
            <summary><span id="s3-receipt-title">本单小票</span><span id="s3-receipt-summary">£4.00</span></summary>
            <div class="s3-receipt-body">
              <p id="s3-customer-line" class="s3-customer-line">“Card, please.”</p>
              <button id="s3-read-customer" class="s3-text-button" type="button">听顾客说话</button>
              <div class="s3-receipt-row"><span>milk <small>牛奶 × 1</small></span><span id="s3-scan-milk">未扫描</span><strong>£1.60</strong></div>
              <div class="s3-receipt-row"><span>bread <small>面包 × 1</small></span><span id="s3-scan-bread">未扫描</span><strong>£2.40</strong></div>
              <div class="s3-receipt-total"><span id="s3-receipt-state">应收</span><strong id="s3-receipt-total">£4.00</strong></div>
              <p id="s3-receipt-help" class="s3-muted">靠近收银台，逐件扫描后启用刷卡机。</p>
            </div>
          </details>
          <div class="s3-action-area">
            <div><p id="s3-drag-hint" class="s3-held" hidden>按住画面拖动视角 · IJKL 亦可转头</p></div>
            <p id="s3-held" class="s3-held" hidden></p>
            <div class="s3-action-card">
              <p id="s3-target-label" class="s3-target-label">看向身边的物品</p>
              <div class="s3-action-buttons">
                <button id="s3-interact" class="s3-interact" type="button" disabled><kbd>E</kbd><span id="s3-target-action">走近物品后互动</span></button>
                <button id="s3-inspect-button" class="s3-action-secondary" type="button" disabled><kbd>F</kbd>近看</button>
                <button id="s3-drop-button" class="s3-action-secondary" type="button" hidden><kbd>G</kbd><span id="s3-drop-label">放下</span></button>
              </div>
            </div>
          </div>
          <p class="s3-bottom-meta"><span id="s3-save-status"></span><span id="s3-fps"></span></p>
        </div>

        <section id="s3-start" class="s3-start" aria-labelledby="s3-start-title">
          <div class="s3-start-card">
            <p class="s3-eyebrow">ENGLISH HIGH STREET · 3D S0</p>
            <h1 id="s3-start-title">Corner<br>Shop<span>从第一箱货，开始营业。</span></h1>
            <p class="s3-start-description">搬进货物，摆上货架，迎接第一位邻居。<br>在一间真正可以走进去的小店里，认识英语。</p>
            <div class="s3-start-stock"><span>milk <small>牛奶 × 4</small></span><span>bread <small>面包 × 4</small></span></div>
            <p id="s3-start-note" class="s3-muted">首批试营业货物免费。本次小样先验证搬运、上架、购物和收款。</p>
            <button id="s3-start-button" class="s3-primary-button" type="button" disabled>开始试营业</button>
            <p id="s3-readonly-note" class="s3-pause-alert" role="status" hidden></p>
            <button id="s3-takeover" class="s3-secondary-button" type="button" hidden>读取最新进度并尝试接管</button>
            <button id="s3-export-readonly" class="s3-text-button" type="button" hidden>下载本页快照</button>
            <p id="s3-loading" class="s3-loading" role="status">正在载入小店…</p>
            <p id="s3-load-detail" class="s3-error-detail" hidden></p>
            <button id="s3-retry" class="s3-secondary-button" type="button" hidden>重新加载小店</button>
            <p class="s3-start-controls"><kbd>W A S D</kbd> 走动 <span>·</span> 鼠标观察 <span>·</span> <kbd>E</kbd> 互动</p>
          </div>
          <p class="s3-start-footer">第一人称经营小样 · 本机存档 · 无需登录或开麦</p>
        </section>

        <section id="s3-inspection" class="s3-inspection" role="dialog" aria-modal="true" aria-labelledby="s3-inspect-word" hidden>
          <div class="s3-inspection-caption">
            <p class="s3-eyebrow">认识手里的实物</p>
            <h2 id="s3-inspect-word">milk</h2><p id="s3-inspect-chinese" class="s3-inspect-chinese">牛奶</p>
            <p id="s3-inspect-phrase" class="s3-inspect-phrase">a carton of milk</p>
            <div class="s3-inspect-buttons"><button id="s3-speak-word" class="s3-light-button" type="button">听单词</button><button id="s3-speak-phrase" class="s3-light-button" type="button">听搭配</button></div>
            <p id="s3-speech-status" class="s3-inspect-note" aria-live="polite">观察外形和材质，试着把英文与实物对应。</p>
            <p class="s3-inspect-note">这次只记录接触，不计为独立掌握。</p>
          </div>
          <div class="s3-inspection-bottom"><div class="s3-inspection-meta"><span>拖动商品，换个角度看</span><p class="s3-audio-credit">发音 Judith Franck / Shtooka · <a href="https://creativecommons.org/licenses/by/3.0/us/" target="_blank" rel="noopener noreferrer">CC BY 3.0 US</a> · <a href="/assets/sim3d/audio/audio-SOURCES.md" target="_blank" rel="noopener noreferrer" aria-label="查看单词发音来源与许可说明">来源</a></p></div><button id="s3-close-inspect" class="s3-glass-button" type="button">返回小店 <kbd>F / Esc</kbd></button></div>
        </section>

        <dialog id="s3-pause" class="s3-pause" aria-labelledby="s3-pause-title">
          <div class="s3-pause-heading"><div><p class="s3-eyebrow">TAKE YOUR TIME</p><h2 id="s3-pause-title">小店暂停中</h2></div><button id="s3-resume" class="s3-primary-button" type="button">继续营业</button></div>
          <p class="s3-muted">没有倒计时。顾客会等你回来，商品和资金保存在同一个快照中。</p>
          <p id="s3-pause-alert" class="s3-pause-alert" role="alert" hidden></p>
          <p id="s3-pause-notice" class="s3-pause-notice" role="status" hidden></p>
          <details class="s3-pause-section"><summary>看看怎么操作</summary><dl class="s3-controls-list"><div><dt>走动 / 观察</dt><dd><kbd>W A S D</kbd> / 鼠标</dd></div><div><dt>拿箱、上架、扫描、收款</dt><dd><kbd>E</kbd></dd></div><div><dt>近看商品 / 返回</dt><dd><kbd>F</kbd></dd></div><div><dt>安全放下货箱 / 放回单品</dt><dd><kbd>G</kbd></dd></div><div><dt>暂停 / 释放鼠标</dt><dd><kbd>Esc</kbd></dd></div><div><dt>视角备用按键</dt><dd><kbd>I J K L</kbd></dd></div></dl><p class="s3-muted">先看向物品并走近，再按键操作。也可以释放鼠标后点击底部操作按钮；按钮不会隔空拿货或上架。浏览器不允许锁定鼠标时，可按住画面左键拖动视角。</p></details>
          <details class="s3-pause-section" open><summary>画面与操作</summary><div class="s3-settings-grid">
            <label for="s3-sensitivity">鼠标灵敏度 <output id="s3-sensitivity-value">1.0</output></label><input id="s3-sensitivity" type="range" min="0.3" max="2" step="0.1" value="1">
            <label for="s3-quality">画质</label><select id="s3-quality"><option value="standard">标准 · 优先细节</option><option value="low">流畅 · 降低渲染负担</option></select>
            <label for="s3-reduced-motion">减少镜头动态</label><input id="s3-reduced-motion" type="checkbox" checked>
            <label for="s3-volume">发音音量 <output id="s3-volume-value">70%</output></label><input id="s3-volume" type="range" min="0" max="1" step="0.1" value="0.7">
          </div><p class="s3-muted">单词使用内置英式录音；搭配和顾客句子使用浏览器可用语音。商品名称始终可看文字，不录音，也不要求开麦。</p></details>
          <details class="s3-pause-section"><summary>普通容量升级 <span id="s3-upgrade-badge">£8</span></summary><p class="s3-muted">只需要小店资金，不设英语等级门槛。S0 验证每种商品 4 → 8 个货位；尚未加入采购新货或店面扩建。</p><button id="s3-upgrade" class="s3-secondary-button" type="button">£8 · 扩充货架容量</button><p id="s3-upgrade-status" class="s3-muted"></p></details>
          <details class="s3-pause-section"><summary>存档与试玩管理</summary><p id="s3-pause-save" class="s3-muted"></p><div class="s3-management-buttons"><button id="s3-export" class="s3-secondary-button" type="button">下载存档备份</button><button id="s3-import" class="s3-secondary-button" type="button">导入存档备份</button><input id="s3-import-file" type="file" accept="application/json,.json" aria-label="选择本游戏导出的 3D JSON 存档" hidden><button id="s3-cancel-customer" class="s3-secondary-button" type="button">取消本单并归还商品</button><button id="s3-restart" class="s3-text-button" type="button">重新试玩</button></div><p class="s3-muted">导入文件只在本机校验，确认后才替换进度。取消订单只退回尚未付款的商品。</p></details>
          <section id="s3-restart-confirm" class="s3-confirm" aria-labelledby="s3-confirm-title" hidden><h3 id="s3-confirm-title">重新开始这轮试营业？</h3><p>当前 3D 进度会被新一轮替换，上一有效快照会保留为备份。建议先下载存档；旧版 2D 存档不受影响。</p><div><button id="s3-restart-confirm-button" class="s3-danger-button" type="button">确认重新试玩</button><button id="s3-restart-cancel" class="s3-secondary-button" type="button">保留当前进度</button></div></section>
          <section id="s3-import-confirm" class="s3-confirm" aria-labelledby="s3-import-title" hidden><h3 id="s3-import-title">确认导入这份存档？</h3><p id="s3-import-summary"></p><p>会替换当前 3D 进度，覆盖前保留当前有效快照。旧版 2D 存档不变；文件不会上传。</p><div><button id="s3-import-confirm-button" class="s3-primary-button" type="button">确认导入并替换进度</button><button id="s3-import-cancel" class="s3-secondary-button" type="button">保留当前进度</button></div></section>
        </dialog>

        <div id="s3-save-banner" class="s3-save-banner" role="alert" hidden><p id="s3-save-warning"></p><button id="s3-dismiss-warning" class="s3-light-button" type="button">知道了</button></div>
        <p id="s3-toast" class="s3-toast" role="status" aria-live="polite" hidden></p>
      </main>`;
  }

  private bindEvents(): void {
    const signal = this.events.signal;
    const click = (id: string, action: () => void): void => { this.el(id).addEventListener("click", action, { signal }) };
    click("s3-start-button", () => this.start());
    click("s3-retry", () => { this.el("s3-load-detail").hidden = true; void this.init() });
    click("s3-takeover", () => { if (this.ready) void this.init() });
    click("s3-export-readonly", () => this.exportSave());
    click("s3-interact", () => this.interact());
    click("s3-inspect-button", () => this.openInspection());
    click("s3-drop-button", () => this.dropHeld());
    click("s3-pause-button", () => this.pause());
    click("s3-resume", () => this.resume(true));
    click("s3-capture", () => { if (this.mode === "playing") this.world?.requestPointerLock() });
    click("s3-close-inspect", () => this.closeInspection());
    click("s3-speak-word", () => { if (this.inspecting) this.speak(PRODUCTS[this.inspecting].nameEn) });
    click("s3-speak-phrase", () => { if (this.inspecting) this.speak(unitPhrase(this.inspecting)) });
    click("s3-read-customer", () => this.speak("Card, please."));
    click("s3-export", () => this.exportSave());
    click("s3-import", () => {
      if (!this.saveSession?.canWrite) return;
      this.el<HTMLInputElement>("s3-import-file").click();
    });
    this.el<HTMLInputElement>("s3-import-file").addEventListener("change", () => { void this.prepareImport() }, { signal });
    click("s3-import-confirm-button", () => { void this.confirmImport() });
    click("s3-import-cancel", () => this.cancelImport());
    click("s3-upgrade", () => this.dispatch({ type: "BUY_UPGRADE" }));
    click("s3-cancel-customer", () => this.dispatch({ type: "CANCEL_CUSTOMER" }));
    click("s3-restart", () => { this.cancelImport(); this.el("s3-restart-confirm").hidden = false; this.el("s3-restart-cancel").focus() });
    click("s3-restart-cancel", () => { this.el("s3-restart-confirm").hidden = true; this.el("s3-restart").focus() });
    click("s3-restart-confirm-button", () => this.restart());
    click("s3-dismiss-warning", () => { this.loadWarning = ""; this.settingsWarning = ""; this.renderSaveStatus() });
    this.el<HTMLDialogElement>("s3-pause").addEventListener("cancel", (event) => { event.preventDefault(); this.resume(false) }, { signal });
    for (const id of ["s3-sensitivity", "s3-quality", "s3-reduced-motion", "s3-volume"]) {
      this.el(id).addEventListener("input", () => this.updateSettings(), { signal });
    }
    window.addEventListener("keydown", (event) => this.onKeyDown(event), { capture: true, signal });
    window.addEventListener("blur", () => { this.stopSpeech(); if (this.mode === "playing") this.pause() }, { signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.stopSpeech(); if (this.mode === "playing") this.pause() }
    }, { signal });
    document.addEventListener("pointerlockchange", () => this.renderCaptureHint(), { signal });
    window.addEventListener("storage", (event) => {
      if (event.key === SIM_STORAGE_KEY && this.saveSession?.observeExternalSnapshot(event.newValue)) this.enterReadOnly(new SimSaveConflictError().message);
    }, { signal });
    window.addEventListener("pagehide", () => {
      this.savePoseAndPersist();
      this.stopSpeech();
      this.initGeneration += 1;
      this.mode = "readonly";
      this.ready = false;
      this.world?.setActive(false);
      this.saveSession?.release();
      this.writerWarning = "页面已暂停写入，返回后将重新读取最新存档。";
      this.text("s3-loading", "页面已离开，营业暂时停止。");
      this.renderState();
    }, { signal });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && !this.disposed) {
        this.el<HTMLDialogElement>("s3-pause").close();
        this.el("s3-inspection").hidden = true;
        this.el("s3-hud").hidden = true;
        this.inspecting = null;
        void this.init();
      }
    }, { signal });
  }

  private start(): void {
    if (!this.ready || !this.world || !this.saveSession?.canWrite || (this.mode !== "start" && this.mode !== "loading")) return;
    try { this.saveSession.assertCurrent() }
    catch (error) { this.enterReadOnly(error instanceof Error ? error.message : "存档写入权限不可用。"); return }
    this.mode = "playing";
    this.el("s3-start").hidden = true;
    this.el("s3-hud").hidden = false;
    this.world.setActive(true);
    this.world.requestPointerLock();
    this.lastPoseSave = performance.now();
    this.capturePose();
    this.persist();
    if (!this.saveSession.canWrite) return;
    this.renderCaptureHint();
    this.notify(this.loadedSession ? "欢迎回来，货物和资金已恢复。" : "第一箱货在门边。看向它，走近后按 E 抱起。WASD 可以移动。");
  }

  private interact(): void {
    if (this.mode !== "playing") return;
    const decision = commandForInteraction(this.state, this.target);
    if (decision.command) this.dispatch(decision.command);
    else if (decision.message) this.notify(decision.message);
  }

  private dropHeld(): void {
    if (this.mode !== "playing") return;
    if (this.state.held.kind === "item") { this.dispatch({ type: "RETURN_ITEM" }); return }
    if (this.state.held.kind !== "crate") { this.notify("手里没有需要放下的货箱。"); return }
    const position = this.world?.getNearestDrop();
    if (position) this.dispatch({ type: "DROP_HELD", position });
    else this.notify("走近货箱卸货点再按 G；通道中不能随意放箱，以免挡住顾客。");
  }

  private inspectableProduct(): ProductId | null {
    return inspectableProduct(this.state, this.target);
  }

  private openInspection(): void {
    if (this.mode !== "playing") return;
    const productId = this.inspectableProduct();
    if (!productId) { this.notify("先看向并走近商品，或拿起货箱，再按 F 近看。"); return }
    this.dispatch({ type: "INSPECT", productId }, false);
    this.savePoseAndPersist();
    if (this.mode !== "playing" || !this.saveSession?.canWrite) return;
    this.mode = "inspecting";
    this.inspecting = productId;
    this.world?.setActive(false);
    this.releasePointer();
    this.world?.inspect(productId);
    this.el("s3-hud").hidden = true;
    this.el("s3-inspection").hidden = false;
    this.text("s3-inspect-word", PRODUCTS[productId].nameEn);
    this.text("s3-inspect-chinese", PRODUCTS[productId].nameZh);
    this.text("s3-inspect-phrase", unitPhrase(productId));
    this.text("s3-speech-status", "观察外形和材质，试着把英文与实物对应。");
    this.el("s3-speak-word").focus();
  }

  private closeInspection(): void {
    if (this.mode !== "inspecting") return;
    try { this.saveSession?.assertCurrent() }
    catch (error) { this.enterReadOnly(error instanceof Error ? error.message : "存档写入权限不可用。"); return }
    this.stopSpeech();
    this.inspecting = null;
    this.world?.inspect(null);
    this.el("s3-inspection").hidden = true;
    this.el("s3-hud").hidden = false;
    this.mode = "playing";
    this.world?.setActive(true);
    this.renderCaptureHint();
    this.el(this.dragLookFallback ? "s3-canvas" : "s3-capture").focus();
    this.notify(this.dragLookFallback ? "回到小店。按住画面拖动视角，或使用 IJKL 转头、E 操作。" : "回到小店。点击继续控制视角，或使用底部操作按钮。");
  }

  private pause(): void {
    this.stopSpeech();
    if (this.mode !== "playing" || !this.ready) return;
    this.savePoseAndPersist();
    if (!this.saveSession?.canWrite) return;
    this.mode = "paused";
    this.world?.setActive(false);
    this.releasePointer();
    this.el("s3-restart-confirm").hidden = true;
    this.cancelImport();
    this.el("s3-pause-notice").hidden = true;
    this.renderState();
    const dialog = this.el<HTMLDialogElement>("s3-pause");
    if (!dialog.open) dialog.showModal();
  }

  private resume(lockPointer: boolean): void {
    if (this.mode !== "paused") return;
    if (!this.el("s3-import-confirm").hidden) { this.cancelImport(); this.el("s3-resume").focus(); return }
    if (!this.el("s3-restart-confirm").hidden) {
      this.el("s3-restart-confirm").hidden = true;
      this.el("s3-resume").focus();
      return;
    }
    try { this.saveSession?.assertCurrent() }
    catch (error) { this.enterReadOnly(error instanceof Error ? error.message : "存档写入权限不可用。"); return }
    this.el<HTMLDialogElement>("s3-pause").close();
    this.mode = "playing";
    this.world?.setActive(true);
    if (lockPointer) this.world?.requestPointerLock();
    this.renderCaptureHint();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (this.mode === "inspecting" && (event.code === "KeyF" || event.code === "Escape")) {
      event.preventDefault(); event.stopImmediatePropagation(); this.closeInspection(); return;
    }
    if (this.mode === "paused" && event.code === "Escape") {
      event.preventDefault(); event.stopImmediatePropagation(); this.resume(false); return;
    }
    if (this.mode === "inspecting" && event.code === "Tab") {
      const buttons = Array.from(this.el("s3-inspection").querySelectorAll<HTMLElement>("button, a[href]"));
      const current = buttons.findIndex((button) => button === document.activeElement);
      const index = (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[index]?.focus();
    }
  }

  private dispatch(command: SimCommand, showMessage = true): void {
    if (!this.saveSession?.canWrite) { this.enterReadOnly("此页面只读，不能修改小店进度。"); return }
    try {
      this.saveSession.assertCurrent();
      this.capturePose();
      const result = reduceSim(this.state, command);
      this.state = result.state;
      if (result.changed) {
        this.persist();
        if (!this.saveSession.canWrite) return;
        this.world?.setState(this.state);
        this.renderState();
      }
      if (showMessage && result.message) this.notify(result.message);
      if (result.changed && command.type === "PAY" && command.success) {
        this.notify(this.state.transactions.length === 1
          ? "第一笔收入 +£4！Card payment · 刷卡付款。再接待一位顾客，就能支付 £8 的普通容量升级。"
          : !this.state.upgraded && this.state.cashPence >= UPGRADE_COST_PENCE
            ? `收款成功 +£4 · 资金已足够！按 Esc，在暂停菜单中购买 £8 的普通容量升级。`
            : `收款成功 +£4 · 当前资金 ${money(this.state.cashPence)}`);
      }
      if (result.changed && this.state.customer.phase === "complete" && this.state.items.every((item) => item.location.kind === "sold")) {
        this.notify("这轮 8 件商品全部售完，试营业流程完成！可以继续逛店，或按 Esc 下载存档、重新试玩。");
      }
    } catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return }
      this.saveError = "本次操作或画面同步遇到问题。请先暂停并下载当前存档备份，再重试；不要继续重复收款。";
      this.renderSaveStatus();
    }
  }

  private capturePose(pose?: PlayerPose): void {
    if (!this.ready || !this.world || this.mode === "inspecting") return;
    const result = reduceSim(this.state, { type: "SAVE_POSE", pose: pose ?? this.world.getPose() });
    if (result.changed) this.state = result.state;
  }

  private savePoseAndPersist(): void {
    if (!this.ready || this.disposed || !this.saveSession?.canWrite) return;
    this.capturePose();
    this.persist();
  }

  private persist(): void {
    if (!this.saveSession?.canWrite) return;
    try {
      this.saveSession.save(this.state);
      this.saveError = "";
      this.lastSaveText = `已保存 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    } catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return }
      this.saveError = "本次进度尚未保存：浏览器空间或权限不足。请暂停并下载存档备份，勿直接关闭页面。";
      this.lastSaveText = "尚未保存";
    }
    this.renderSaveStatus();
  }

  private onFrame(fps: number, pose: PlayerPose): void {
    const now = performance.now();
    if (this.mode === "playing" && now - this.lastPoseSave >= 5000) {
      this.lastPoseSave = now;
      this.capturePose(pose);
      this.persist();
    }
    if (now - this.lastFpsUpdate >= 1000) {
      this.lastFpsUpdate = now;
      this.text("s3-fps", Number.isFinite(fps) ? `${Math.round(fps)} fps · ${this.settings.quality === "low" ? "流畅" : "标准"}` : "");
    }
  }

  private renderState(): void {
    this.text("s3-start-button", this.mode === "readonly" ? "此页面只读" : this.loadedSession ? "继续营业" : "开始试营业");
    this.el<HTMLButtonElement>("s3-start-button").disabled = !this.ready || !this.saveSession?.canWrite;
    this.text("s3-readonly-note", this.writerWarning);
    this.el("s3-readonly-note").hidden = !this.writerWarning;
    this.el("s3-takeover").hidden = !this.writerWarning;
    this.el<HTMLButtonElement>("s3-takeover").disabled = !this.ready;
    this.el("s3-export-readonly").hidden = !this.writerWarning;
    this.text("s3-start-note", this.loadedSession
      ? `已恢复本机进度：${money(this.state.cashPence)} 资金，${this.state.items.filter((item) => item.location.kind === "sold").length} 件已售出。继续后货物仍在上次的位置。`
      : "首批试营业货物免费。本次小样先验证搬运、上架、购物和收款。");
    this.text("s3-objective", getObjective(this.state));
    this.text("s3-phase", this.state.customer.phase === "outside" ? "准备开店" : this.state.customer.phase === "complete" ? "整理小店" : `接待第 ${this.state.customer.number} 位顾客`);
    this.text("s3-cash", money(this.state.cashPence));
    this.text("s3-sold", `售出 ${this.state.items.filter((item) => item.location.kind === "sold").length} / 8 件`);
    this.text("s3-milk-stock", `牛奶 ${countAt(this.state, "milk", "shelf")} / ${capacityFor(this.state)}`);
    this.text("s3-bread-stock", `面包 ${countAt(this.state, "bread", "shelf")} / ${capacityFor(this.state)}`);
    this.renderReceipt();
    this.renderTarget();
    this.renderSaveStatus();
    const availableUpgrade = !this.state.upgraded && this.state.cashPence >= UPGRADE_COST_PENCE;
    this.el<HTMLButtonElement>("s3-upgrade").disabled = !availableUpgrade;
    this.text("s3-upgrade", this.state.upgraded ? "容量已升级至 8 个货位" : "£8 · 扩充货架容量");
    this.text("s3-upgrade-badge", this.state.upgraded ? "已升级" : "£8");
    this.text("s3-upgrade-status", this.state.upgraded ? "只扩充容量，不会凭空增加商品。" : availableUpgrade ? "资金已足够，可以购买。" : `还需要 ${money(UPGRADE_COST_PENCE - this.state.cashPence)}。`);
    this.el<HTMLButtonElement>("s3-cancel-customer").disabled = ["outside", "leaving", "complete"].includes(this.state.customer.phase);
    this.el<HTMLInputElement>("s3-sensitivity").value = String(this.settings.sensitivity);
    this.el<HTMLSelectElement>("s3-quality").value = this.settings.quality;
    this.el<HTMLInputElement>("s3-reduced-motion").checked = this.settings.reducedMotion;
    this.el<HTMLInputElement>("s3-volume").value = String(this.settings.volume);
    this.text("s3-sensitivity-value", this.settings.sensitivity.toFixed(1));
    this.text("s3-volume-value", `${Math.round(this.settings.volume * 100)}%`);
  }

  private renderTarget(): void {
    const target = this.target;
    const inReach = interactionInReach(target);
    this.text("s3-target-label", inReach ? `${target.label} · ${target.distance.toFixed(1)} m` : "看向身边的物品");
    this.text("s3-target-action", inReach ? target.action : "走近物品后互动");
    this.el<HTMLButtonElement>("s3-interact").disabled = !inReach;
    this.el<HTMLButtonElement>("s3-inspect-button").disabled = this.inspectableProduct() === null;
    this.el("s3-reticle").classList.toggle("s3-reticle-active", inReach);
    const held = this.state.held;
    this.el("s3-held").hidden = held.kind === "none";
    this.el("s3-drop-button").hidden = held.kind === "none";
    this.text("s3-drop-label", held.kind === "item" ? "放回" : "安全放箱");
    if (held.kind === "crate") {
      const crate = this.state.crates.find((candidate) => candidate.id === held.crateId);
      const count = this.state.items.filter((item) => item.location.kind === "crate" && item.location.crateId === held.crateId).length;
      this.text("s3-held", `手中 · ${crate ? PRODUCTS[crate.productId].nameZh : "商品"}箱 · 剩余 ${count} 件`);
    } else if (held.kind === "item") {
      const item = this.state.items.find((candidate) => candidate.id === held.itemId);
      this.text("s3-held", item ? `手中 · ${PRODUCTS[item.productId].nameEn} / ${PRODUCTS[item.productId].nameZh}` : "手中 · 商品");
    }
  }

  private renderReceipt(): void {
    const phase = this.state.customer.phase;
    const transaction = this.state.transactions.find((sale) => sale.customerNumber === this.state.customer.number);
    const atCheckout = phase === "checkout";
    const showPaid = !!transaction && (phase === "leaving" || phase === "complete");
    const receipt = this.el<HTMLDetailsElement>("s3-receipt");
    receipt.hidden = !atCheckout && !showPaid;
    if (atCheckout && this.receiptCustomer !== this.state.customer.number) { receipt.open = true; this.receiptCustomer = this.state.customer.number }
    this.text("s3-receipt-title", showPaid ? "本单已收款" : "本单小票");
    this.text("s3-receipt-state", showPaid ? "实收" : "应收");
    const total = transaction?.amountPence ?? getCheckoutTotal(this.state);
    this.text("s3-receipt-summary", money(total));
    this.text("s3-receipt-total", money(total));
    for (const productId of PRODUCT_IDS) {
      const scanned = showPaid || this.state.items.some((item) => item.productId === productId && this.state.scannedIds.includes(item.id));
      this.text(`s3-scan-${productId}`, scanned ? "已扫描" : "未扫描");
      this.el(`s3-scan-${productId}`).classList.toggle("s3-scanned", scanned);
    }
    this.text("s3-customer-line", showPaid ? "Card payment · 刷卡付款" : "“Card, please.”");
    this.el("s3-read-customer").hidden = showPaid;
    this.text("s3-receipt-help", showPaid ? "金额已入账，不会重复收费。" : this.state.scannedIds.length === 2 ? "全部已扫描。靠近收银台按 E 启用刷卡机。" : "靠近收银台，逐件扫描后启用刷卡机。");
  }

  private renderSaveStatus(): void {
    const warning = this.saveError || this.writerWarning || this.loadWarning || this.settingsWarning;
    this.el("s3-save-banner").hidden = !warning;
    this.el("s3-save-banner").classList.toggle("s3-save-error", !!this.saveError);
    this.text("s3-save-warning", warning);
    this.el("s3-dismiss-warning").hidden = !!this.saveError || !!this.writerWarning;
    this.text("s3-save-status", this.lastSaveText);
    this.text("s3-pause-save", warning || `${this.lastSaveText}。本地保存与浏览器绑定，下载 JSON 可额外留一份备份。`);
    this.text("s3-pause-alert", warning);
    this.el("s3-pause-alert").hidden = !warning;
  }

  private renderCaptureHint(): void {
    const canvas = this.el<HTMLCanvasElement>("s3-canvas");
    const released = this.mode === "playing" && document.pointerLockElement !== canvas;
    this.el("s3-capture").hidden = !released || this.dragLookFallback;
    this.el("s3-drag-hint").hidden = !released || !this.dragLookFallback;
  }

  private enterReadOnly(message: string): void {
    this.saveSession?.release();
    this.stopSpeech();
    this.writerWarning = message;
    this.lastSaveText = "只读 · 本页已停止写入";
    this.mode = "readonly";
    this.world?.setActive(false);
    this.world?.inspect(null);
    this.releasePointer();
    this.inspecting = null;
    this.cancelImport();
    this.el<HTMLDialogElement>("s3-pause").close();
    this.el("s3-inspection").hidden = true;
    this.el("s3-hud").hidden = true;
    this.el("s3-start").hidden = false;
    this.text("s3-loading", "请关闭另一营业页面，再读取最新进度继续。也可以先下载本页快照。");
    this.renderState();
  }

  private notify(text: string): void {
    if (this.disposed || !text) return;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.text("s3-toast", text);
    this.el("s3-toast").hidden = false;
    if (this.mode === "paused") {
      this.text("s3-pause-notice", text);
      this.el("s3-pause-notice").hidden = false;
    }
    this.statusTimer = setTimeout(() => { if (!this.disposed) this.el("s3-toast").hidden = true }, 6000);
  }

  private readSettings(): void {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1) return;
      const input = value as Partial<Settings>;
      this.settings = {
        schemaVersion: 1,
        sensitivity: typeof input.sensitivity === "number" && Number.isFinite(input.sensitivity) ? clamp(input.sensitivity, 0.3, 2) : DEFAULT_SETTINGS.sensitivity,
        quality: input.quality === "low" ? "low" : "standard",
        reducedMotion: input.reducedMotion !== false,
        volume: typeof input.volume === "number" && Number.isFinite(input.volume) ? clamp(input.volume, 0, 1) : DEFAULT_SETTINGS.volume,
      };
    } catch { this.settingsWarning = "个性化设置暂未读取成功，当前使用默认设置。" }
  }

  private updateSettings(): void {
    try { this.saveSession?.assertCurrent() }
    catch (error) { this.enterReadOnly(error instanceof Error ? error.message : "此页面只读，不能修改设置。"); return }
    if (!this.saveSession?.canWrite) return;
    this.settings = {
      schemaVersion: 1,
      sensitivity: clamp(Number(this.el<HTMLInputElement>("s3-sensitivity").value), 0.3, 2),
      quality: this.el<HTMLSelectElement>("s3-quality").value === "low" ? "low" : "standard",
      reducedMotion: this.el<HTMLInputElement>("s3-reduced-motion").checked,
      volume: clamp(Number(this.el<HTMLInputElement>("s3-volume").value), 0, 1),
    };
    this.applySettings();
    this.text("s3-sensitivity-value", this.settings.sensitivity.toFixed(1));
    this.text("s3-volume-value", `${Math.round(this.settings.volume * 100)}%`);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); this.settingsWarning = "" }
    catch { this.settingsWarning = "设置已在本局生效，但暂时无法保存到浏览器。" }
    this.renderSaveStatus();
  }

  private applySettings(): void {
    this.world?.setSensitivity(this.settings.sensitivity);
    this.world?.setQuality(this.settings.quality);
    this.world?.setReducedMotion(this.settings.reducedMotion);
  }

  private speak(text: string): void {
    const report = (message: string): void => {
      if (this.mode === "inspecting") this.text("s3-speech-status", message);
      else this.notify(message);
    };
    this.stopSpeech();
    if (this.settings.volume === 0) { report("发音音量当前为 0，可以在暂停设置中调高。"); return }
    const generation = this.speechGeneration;
    const liveReport = (message: string): void => {
      if (!this.disposed && generation === this.speechGeneration) report(message);
    };
    if (text === "milk" || text === "bread") {
      const audio = this.el<HTMLAudioElement>("s3-word-audio");
      let started = false;
      let failed = false;
      const fail = (): void => {
        if (this.disposed || generation !== this.speechGeneration) return;
        failed = true;
        if (this.speechTimer) clearTimeout(this.speechTimer);
        liveReport("这段单词发音未能播放，请重试；商品文字和操作不受影响。");
      };
      audio.onplaying = () => {
        if (generation !== this.speechGeneration) return;
        started = true;
        if (this.speechTimer) clearTimeout(this.speechTimer);
        liveReport(`正在播放英式发音：${text}`);
      };
      audio.onended = () => {
        if (started && !failed) liveReport(`已播放英式发音：${text}。可以再听一次。`);
      };
      audio.onerror = fail;
      audio.volume = this.settings.volume;
      audio.src = `/assets/sim3d/audio/${text}.ogg`;
      liveReport(`正在准备单词录音：${text}`);
      this.speechTimer = setTimeout(() => { if (!started && !failed) liveReport("单词录音还未开始，请重试并检查设备声音。") }, 4000);
      // Called directly by the user's button click so normal browser media policies apply.
      try { void audio.play().catch(fail) }
      catch { fail() }
      return;
    }
    const unavailable = text === "Card, please."
      ? "这句顾客话暂无可用朗读，单词可正常听。"
      : "这段搭配暂无可用朗读，单词可正常听。";
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") { report(unavailable); return }
    const voices = speechSynthesis.getVoices();
    const voice = voices.find((candidate) => candidate.lang.toLowerCase() === "en-gb") ?? voices.find((candidate) => candidate.lang.toLowerCase().startsWith("en"));
    if (!voice) { report(unavailable); return }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice.lang;
    utterance.voice = voice;
    utterance.rate = 0.85;
    utterance.volume = this.settings.volume;
    let started = false;
    utterance.onstart = () => { started = true; liveReport(`正在朗读：${text}`) };
    utterance.onend = () => {
      if (this.speechTimer) clearTimeout(this.speechTimer);
      liveReport(this.mode === "inspecting" ? "可以再听一次，也可以换个角度看看商品。" : `顾客说：${text}`);
    };
    utterance.onerror = () => { if (this.speechTimer) clearTimeout(this.speechTimer); liveReport("本次发音未能播放，请重试；不影响商品操作和存档。") };
    speechSynthesis.speak(utterance);
    this.speechTimer = setTimeout(() => { if (!started) liveReport("发音还未开始。请检查设备声音，或换用可提供英语语音的浏览器。") }, 4000);
  }

  private stopSpeech(): void {
    this.speechGeneration += 1;
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = undefined;
    const audio = this.root.querySelector<HTMLAudioElement>("#s3-word-audio");
    if (audio) {
      const wasPlaying = !audio.paused;
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      try { audio.currentTime = 0 }
      catch { /* Some browsers do not allow seeking until metadata has loaded. */ }
      if (wasPlaying && this.mode === "inspecting") this.text("s3-speech-status", "发音已停止，可以再次点击听单词。");
    }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  private exportSave(): void {
    this.savePoseAndPersist();
    const blob = new Blob([JSON.stringify(this.state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `corner-shop-s0-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
    link.hidden = true;
    this.root.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.notify("已请求下载当前完整存档，请检查浏览器下载列表。可在暂停菜单的“导入存档备份”中恢复。");
  }

  private async prepareImport(): Promise<void> {
    const input = this.el<HTMLInputElement>("s3-import-file");
    const file = input.files?.[0];
    input.value = "";
    if (!file || this.mode !== "paused" || !this.saveSession?.canWrite) return;
    this.cancelImport();
    const generation = this.importGeneration;
    this.el("s3-restart-confirm").hidden = true;
    try {
      if (file.size > 2_000_000) throw new Error("存档文件超过 2 MB，请选择本游戏导出的 3D JSON 快照。");
      const imported = parseImportedSimState(await file.text());
      if (this.disposed || this.mode !== "paused" || !this.saveSession.canWrite || generation !== this.importGeneration) return;
      this.saveSession.assertCurrent();
      this.pendingImport = imported;
      this.text("s3-import-summary", `${file.name} · 资金 ${money(imported.cashPence)} · 已售 ${imported.items.filter((item) => item.location.kind === "sold").length} / 8 件 · 第 ${imported.customer.number} 位顾客。`);
      this.el("s3-import-confirm").hidden = false;
      this.el("s3-import-cancel").focus();
    } catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return }
      this.notify(error instanceof Error ? error.message : "无法读取这份存档，当前进度未改变。");
    }
  }

  private cancelImport(): void {
    this.importGeneration += 1;
    this.pendingImport = null;
    this.el("s3-import-confirm").hidden = true;
  }

  private async confirmImport(): Promise<void> {
    if (!this.pendingImport || this.mode !== "paused" || !this.saveSession?.canWrite) return;
    const imported = this.pendingImport;
    try {
      // Preserve even unsaved in-memory progress before replacing the primary snapshot.
      this.capturePose();
      this.saveSession.save(this.state);
      this.saveSession.save(imported);
    } catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return }
      this.saveError = "导入未能安全写入，当前进度已保留。请检查存储权限与空间后重试。";
      this.renderSaveStatus();
      return;
    }
    this.state = imported;
    this.loadedSession = true;
    this.saveError = "";
    this.loadWarning = "";
    this.target = null;
    this.receiptCustomer = 0;
    this.lastSaveText = "导入存档已安全保存";
    this.cancelImport();
    this.stopSpeech();
    this.el<HTMLDialogElement>("s3-pause").close();
    this.el("s3-hud").hidden = true;
    // Rebuild from the imported snapshot so an equal phase with a different customer
    // cannot accidentally reuse the previous customer's mid-route transform.
    await this.init();
    if (!this.disposed && this.ready && this.saveSession?.canWrite) this.notify("存档导入成功。点击“继续营业”恢复货物、顾客阶段和玩家位置。");
  }

  private restart(): void {
    if (!this.saveSession?.canWrite) return;
    const fresh = createInitialSimState();
    try { this.saveSession.save(this.state); this.saveSession.save(fresh) }
    catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return }
      this.saveError = "新一轮暂时无法安全保存，已保留当前进度。请先下载备份并检查浏览器存储权限。";
      this.renderSaveStatus();
      return;
    }
    this.state = fresh;
    this.loadedSession = false;
    this.target = null;
    this.receiptCustomer = 0;
    this.saveError = "";
    this.loadWarning = "";
    this.lastSaveText = "新一轮试玩已保存";
    this.world?.setState(fresh);
    this.world?.restorePose(fresh.playerPose);
    this.world?.setActive(false);
    this.el<HTMLDialogElement>("s3-pause").close();
    this.el("s3-restart-confirm").hidden = true;
    this.el("s3-hud").hidden = true;
    this.el("s3-start").hidden = false;
    this.mode = "start";
    this.renderState();
    this.el("s3-start-button").focus();
  }

  private releasePointer(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.releaseCompletion;
    this.savePoseAndPersist();
    this.releaseCompletion = this.saveSession?.release() ?? Promise.resolve();
    this.disposed = true;
    this.initGeneration += 1;
    this.events.abort();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.stopSpeech();
    this.releasePointer();
    this.world?.dispose();
    this.world = null;
    activeInstances.delete(this);
    return this.releaseCompletion;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const app of [...activeInstances]) app.dispose();
  });
}
