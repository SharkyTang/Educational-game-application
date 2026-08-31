import {
  PRODUCTS, PRODUCT_IDS, UPGRADE_COST_PENCE, capacityFor, countAt,
  createFirstDayState, getCheckoutTotal, getObjective, reduceSim,
  getDaySummary, getPurchaseOffer, getDeliverySummary, canSettleDay, DAY_CUSTOMER_TARGET,
  type PlayerPose, type ProductId, type SimCommand, type SimState,
} from "./domain";
import { loadSimState, parseImportedSimState, SimSaveConflictError, SimSaveSession, SIM_STORAGE_KEY } from "./persistence";
import { ShopWorld, type InteractionTarget, type Quality } from "./world";
import { SPEECH_CLIPS, type SpeechClipId } from "./speechClips";
import { STREET_VENUES, getStreetProgress, getVenueProgress } from "./progression";
import type { PointerMode } from "./pointerAccess";
import "./styles.css";

type ScreenMode = "loading" | "start" | "playing" | "paused" | "inspecting" | "readonly" | "error";
type ManagementSection = "supply" | "day" | "upgrade" | "street";
type StreetVenueId = (typeof STREET_VENUES)[number]["id"];
const MANAGEMENT_SECTIONS: readonly ManagementSection[] = ["supply", "day", "upgrade", "street"];
interface InteractionDecision {
  command?: SimCommand;
  message?: string;
  management?: ManagementSection;
  venueId?: StreetVenueId;
}
interface Settings {
  schemaVersion: 1;
  sensitivity: number;
  quality: Quality;
  reducedMotion: boolean;
  volume: number;
  autoSpeech: boolean;
}
const SETTINGS_KEY = "english-high-street:sim3d:settings:v1";
const MAX_INTERACTION_DISTANCE = 2.6;
const DEFAULT_SETTINGS: Settings = { schemaVersion: 1, sensitivity: 1, quality: "standard", reducedMotion: true, volume: 0.7, autoSpeech: true };
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
const unitPhrase = (id: ProductId): string => id === "milk" ? "a carton of milk" : "a loaf of bread";
const clamp = (number: number, min: number, max: number): number => Math.max(min, Math.min(max, number));
const activeInstances = new Set<App3D>();

export function interactionInReach(target: InteractionTarget | null): target is InteractionTarget {
  return target !== null && Number.isFinite(target.distance) && target.distance >= 0 && target.distance <= MAX_INTERACTION_DISTANCE;
}

/** A DOM button follows the same ray-picked target and distance rules as its keyboard shortcut. */
export function commandForInteraction(state: SimState, target: InteractionTarget | null): InteractionDecision {
  if (!target) return {};
  if (!interactionInReach(target)) return { message: "再走近一点，才能操作这件物品。" };
  switch (target.kind) {
    case "delivery": {
      const delivery = getDeliverySummary(state);
      if (!delivery.pendingOrders) return { management: "supply" };
      return delivery.canReceive ? { command: { type: "RECEIVE_DELIVERY" } }
        : { message: delivery.reason ?? "暂时不能卸货，请先腾出双手与门口卸货位。" };
    }
    case "venue": return { management: "street", venueId: target.venueId };
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
      if (state.day.phase === "settled" || getDaySummary(state).paidCustomers >= DAY_CUSTOMER_TARGET) return { management: "day" };
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
  private state: SimState = createFirstDayState();
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
  private pointerMode: PointerMode = "free";
  private customerClip: SpeechClipId = "greeting";
  private lastCustomerCue = "";
  private lastFrameAt = 0;
  private nextCustomerElapsed = 0;
  private dayReadyNotified = 0;
  private purchasePairs: 1 | 3 | 6 = 3;
  private purchaseOrderId = "";
  private purchaseBusy = false;
  private managementSection: ManagementSection = "supply";
  private selectedVenue: StreetVenueId = "cafe";
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
        onPointerMode: (mode) => {
          if (!isCurrent()) return;
          this.pointerMode = mode;
          this.dragLookFallback = mode === "drag";
          this.renderCaptureHint();
        },
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
        <canvas id="s3-canvas" class="s3-canvas" tabindex="0" aria-label="第一人称小店与商业街：WASD 移动，鼠标观察，E 互动与签收，F 近看商品，G 放下货箱，M 商业街，Esc 暂停"></canvas>
        <audio id="s3-word-audio" preload="none" hidden></audio>
        <div id="s3-hud" class="s3-hud" hidden>
          <div class="s3-top-left">
            <p class="s3-wordmark">CORNER SHOP <span>英语商业街</span></p>
            <details id="s3-task" class="s3-task" open>
              <summary><span id="s3-phase">准备开店</span><span class="s3-fold-hint">目标</span></summary>
              <p id="s3-objective"></p>
              <div class="s3-stock-line"><span id="s3-milk-stock"></span><span id="s3-bread-stock"></span></div>
            </details>
            <p id="s3-delivery-hud" class="s3-delivery-hud" role="status" aria-live="polite" hidden></p>
            <nav class="s3-business-nav" aria-label="小店经营">
              <button id="s3-open-supply" type="button">进货 <kbd>B</kbd></button>
              <button id="s3-open-day" type="button">营业 / 日结</button>
              <button id="s3-open-upgrade" type="button">扩容 <kbd>U</kbd></button>
              <button id="s3-open-street" type="button">商业街 <kbd>M</kbd></button>
            </nav>
          </div>
          <div class="s3-top-right">
            <div class="s3-wallet"><span class="s3-small-label">小店资金</span><strong id="s3-cash">£0.00</strong><span id="s3-sold">售出 0 / 8 件</span></div>
            <button id="s3-pause-button" class="s3-glass-button" type="button">暂停 <kbd>Esc</kbd></button>
          </div>
          <p id="s3-guide" class="s3-guide"></p>
          <div id="s3-reticle" class="s3-reticle" aria-hidden="true"></div>
          <details id="s3-receipt" class="s3-receipt" hidden>
            <summary><span id="s3-receipt-title">本单小票</span><span id="s3-receipt-summary">£4.00</span></summary>
            <div class="s3-receipt-body">
              <p id="s3-customer-line" class="s3-customer-line">“Hello!”</p>
              <p id="s3-customer-zh" class="s3-muted"></p>
              <div class="s3-customer-actions"><button id="s3-read-customer" class="s3-secondary-button" type="button">重听 <kbd>R</kbd></button><button id="s3-repeat-customer" class="s3-secondary-button" type="button">请再说一遍</button></div>
              <p id="s3-customer-audio-status" class="s3-muted" role="status" aria-live="polite"></p>
              <div id="s3-receipt-items">
              <div class="s3-receipt-row"><span>milk <small>牛奶 × 1</small></span><span id="s3-scan-milk">未扫描</span><strong>£1.60</strong></div>
              <div class="s3-receipt-row"><span>bread <small>面包 × 1</small></span><span id="s3-scan-bread">未扫描</span><strong>£2.40</strong></div>
              <div class="s3-receipt-total"><span id="s3-receipt-state">应收</span><strong id="s3-receipt-total">£4.00</strong></div>
              </div>
              <p id="s3-receipt-help" class="s3-muted">靠近收银台，逐件扫描后启用刷卡机。</p>
            </div>
          </details>
          <div class="s3-action-area">
            <button id="s3-capture" class="s3-capture" type="button" hidden>切回鼠标转头 <kbd>Tab</kbd></button>
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
            <p class="s3-eyebrow">ENGLISH HIGH STREET · YOUR FIRST SHOP</p>
            <h1 id="s3-start-title">Corner<br>Shop<span>一条商业街，从你的小店开始。</span></h1>
            <p class="s3-start-description">每天的送货车停在门口，签收后亲手搬货上架。<br>迎接邻居、听见英语，也看看街上的咖啡店、餐厅与未来大商超。</p>
            <div class="s3-start-stock"><span><span id="s3-start-capital">£12</span><small id="s3-start-capital-label">首日本金 · 进货会扣钱</small></span><span>3 guests <small>下单 → 签收 → 营业 → 成长</small></span></div>
            <p id="s3-start-note" class="s3-muted">首次建议购买 3 份组合货，共 £6.90。到门口按 E 签收；商业街店铺的开放条件可按 M 查看。</p>
            <button id="s3-start-button" class="s3-primary-button" type="button" disabled>开始第一天</button>
            <p id="s3-readonly-note" class="s3-pause-alert" role="status" hidden></p>
            <button id="s3-takeover" class="s3-secondary-button" type="button" hidden>读取最新进度并尝试接管</button>
            <button id="s3-export-readonly" class="s3-text-button" type="button" hidden>下载本页快照</button>
            <p id="s3-loading" class="s3-loading" role="status">正在载入小店…</p>
            <p id="s3-load-detail" class="s3-error-detail" hidden></p>
            <button id="s3-retry" class="s3-secondary-button" type="button" hidden>重新加载小店</button>
            <p class="s3-start-controls"><kbd>W A S D</kbd> 走动 · <kbd>E</kbd> 互动 / 签收<br><kbd>Tab</kbd> 释放鼠标 · <kbd>B</kbd> 进货 · <kbd>M</kbd> 商业街</p>
          </div>
          <p class="s3-start-footer">第一人称街角经营 · 本地语音与存档 · 无需登录或开麦</p>
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
          <div class="s3-inspection-bottom"><div class="s3-inspection-meta"><span>拖动商品，换个角度看</span><p class="s3-audio-credit">单词真人：Judith Franck / Shtooka · <a href="https://creativecommons.org/licenses/by/3.0/us/" target="_blank" rel="noopener noreferrer">CC BY 3.0 US</a> · <a href="/assets/sim3d/audio/audio-SOURCES.md" target="_blank" rel="noopener noreferrer" aria-label="查看单词发音来源与许可说明">来源</a><br>搭配与顾客：本地英式合成语音 · <a href="/assets/sim3d/audio/phrase-SOURCES.md" target="_blank" rel="noopener noreferrer" aria-label="查看合成短句来源与许可说明">Cori 来源</a></p></div><button id="s3-close-inspect" class="s3-glass-button" type="button">返回小店 <kbd>F / Esc</kbd></button></div>
        </section>

        <dialog id="s3-pause" class="s3-pause" aria-labelledby="s3-pause-title">
          <div class="s3-pause-heading"><div><p class="s3-eyebrow">YOUR LITTLE BUSINESS</p><h2 id="s3-pause-title">小店管理</h2></div><button id="s3-resume" class="s3-primary-button" type="button">返回小店</button></div>
          <p class="s3-muted">这里会暂停营业，顾客会等你。返回后鼠标保持可点击；按 Tab 再切回自由转头。</p>
          <p id="s3-pause-alert" class="s3-pause-alert" role="alert" hidden></p>
          <p id="s3-pause-notice" class="s3-pause-notice" role="status" hidden></p>
          <nav class="s3-management-tabs" aria-label="经营管理分类">
            <button id="s3-tab-supply" type="button" aria-pressed="true">进货</button>
            <button id="s3-tab-day" type="button" aria-pressed="false">营业与日结</button>
            <button id="s3-tab-upgrade" type="button" aria-pressed="false">普通扩容</button>
            <button id="s3-tab-street" type="button" aria-pressed="false">商业街</button>
          </nav>
          <section id="s3-panel-supply" class="s3-management-panel" aria-labelledby="s3-supply-title">
            <p class="s3-eyebrow">DAILY DOORSTEP DELIVERY</p><h3 id="s3-supply-title">今天的货，送到小店门口</h3>
            <p class="s3-muted">每份组合包含 milk 牛奶 1 盒（£0.90）和 bread 面包 1 袋（£1.40）。送货车每天来店门口，下单后需亲自签收，不会自动上架。</p>
            <ol class="s3-delivery-steps" aria-label="进货流程"><li><span>01</span>下单扣款</li><li><span>02</span>门口按 E 签收</li><li><span>03</span>抱箱搬货上架</li></ol>
            <p id="s3-delivery-summary" class="s3-delivery-summary" role="status" aria-live="polite"></p>
            <div class="s3-purchase-options" role="group" aria-label="选择进货份数">
              <button id="s3-buy-one" type="button" aria-pressed="false">1 份<small>少量补货 · £2.30</small></button>
              <button id="s3-buy-three" type="button" aria-pressed="true">3 份<small>首日推荐 · £6.90</small></button>
              <button id="s3-buy-six" type="button" aria-pressed="false">6 份<small>提前备货 · £13.80</small></button>
            </div>
            <dl class="s3-account-lines"><div><dt>现有资金</dt><dd id="s3-supply-cash"></dd></div><div><dt>本次进货</dt><dd id="s3-supply-total"></dd></div><div><dt>购买后剩余</dt><dd id="s3-supply-after"></dd></div></dl>
            <p id="s3-supply-summary" class="s3-muted"></p><p id="s3-supply-error" class="s3-inline-reason" role="status"></p>
            <button id="s3-purchase" class="s3-primary-button" type="button">确认下单</button>
          </section>
          <section id="s3-panel-day" class="s3-management-panel" aria-labelledby="s3-day-title" hidden>
            <p id="s3-day-eyebrow" class="s3-eyebrow">TODAY AT THE CORNER SHOP</p><h3 id="s3-day-title">今天的小店</h3>
            <p id="s3-day-progress" class="s3-muted"></p>
            <dl class="s3-account-lines"><div><dt>今日营业收入</dt><dd id="s3-day-revenue"></dd></div><div><dt>已售商品成本</dt><dd id="s3-day-cogs"></dd></div><div class="s3-account-result"><dt>商品毛利</dt><dd id="s3-day-profit"></dd></div><div><dt>今日进货支出</dt><dd id="s3-day-procurement"></dd></div><div><dt>今日扩容支出</dt><dd id="s3-day-investment"></dd></div><div><dt>当前剩余资金</dt><dd id="s3-day-cash"></dd></div><div><dt>未售商品 / 成本价值</dt><dd id="s3-day-inventory"></dd></div></dl>
            <p class="s3-muted">毛利 = 收入 − 已售商品成本。进货中尚未卖出的部分仍是存货；扩容是投资，不把钱包余额当利润。</p>
            <p id="s3-day-reason" class="s3-inline-reason" role="status"></p>
            <div class="s3-management-buttons"><button id="s3-settle-day" class="s3-primary-button" type="button">结束营业并结算</button><button id="s3-next-day" class="s3-primary-button" type="button" hidden>开始下一天</button><button id="s3-day-to-upgrade" class="s3-secondary-button" type="button">看看 £8 普通扩容</button></div>
          </section>
          <section id="s3-panel-upgrade" class="s3-management-panel" aria-labelledby="s3-upgrade-title" hidden>
            <p class="s3-eyebrow">MORE ROOM TO GROW</p><h3 id="s3-upgrade-title">让货架多一层空间</h3>
            <div id="s3-capacity-comparison" class="s3-capacity-comparison"><span><span id="s3-capacity-label">现在</span> <strong id="s3-capacity-now">4</strong> 个 / 每种</span><span id="s3-capacity-arrow" aria-hidden="true">→</span><span id="s3-capacity-next">扩容后 <strong>8</strong> 个 / 每种</span></div>
            <p class="s3-muted">£8 一次性启用冰柜和面包架的预留层位。只检查资金，不设英语等级门槛；不会凭空补货，也不是店面扩建。</p>
            <p id="s3-upgrade-status" class="s3-inline-reason" role="status"></p><button id="s3-upgrade" class="s3-primary-button" type="button">£8 · 扩充货架容量</button><span id="s3-upgrade-badge" class="s3-upgrade-badge">£8</span>
          </section>
          <section id="s3-panel-street" class="s3-management-panel s3-street-panel" aria-labelledby="s3-street-title" hidden>
            <p class="s3-eyebrow">A LITTLE SHOP, A BIGGER STREET</p><h3 id="s3-street-title">从街角小店，走向整条街</h3>
            <p class="s3-muted">走出小店，看看街上的未来邻居。尚未满足等级与成就条件的店铺会显示“暂未开放”。</p>
            <div class="s3-street-growth"><div class="s3-street-growth-heading"><div><span class="s3-small-label">小店经营等级</span><strong id="s3-street-level">Lv. 1</strong></div><p id="s3-street-experience"></p></div><div id="s3-street-progress" class="s3-street-progress" role="progressbar" aria-label="距离下一级的经营成长值" aria-valuemin="0" aria-valuemax="30" aria-valuenow="0"><span id="s3-street-progress-fill"></span></div><p id="s3-street-record" class="s3-muted"></p></div>
            <p class="s3-street-growth-note">每完成一笔收款 +10 成长值。经营等级不代表英语掌握程度。</p>
            <div class="s3-venue-cards" role="group" aria-label="选择未来店铺查看条件">${STREET_VENUES.map((venue) => `
              <button id="s3-venue-${venue.id}" class="s3-venue-card s3-venue-${venue.id}" type="button" aria-pressed="${venue.id === this.selectedVenue}" aria-controls="s3-venue-detail-${venue.id}"><span class="s3-venue-english">${venue.nameEn}</span><strong>${venue.nameZh}</strong><span id="s3-venue-status-${venue.id}" class="s3-venue-status">暂未开放</span><span class="s3-venue-level">需要 Lv. ${venue.requiredLevel}</span></button>`).join("")}</div>
            ${STREET_VENUES.map((venue) => `
              <section id="s3-venue-detail-${venue.id}" class="s3-venue-detail" aria-labelledby="s3-venue-title-${venue.id}"${venue.id === this.selectedVenue ? "" : " hidden"}>
                <div class="s3-venue-detail-heading"><h4 id="s3-venue-title-${venue.id}">${venue.nameZh} · 开放条件</h4><span id="s3-venue-detail-status-${venue.id}" class="s3-venue-status">暂未开放</span></div>
                <ul class="s3-venue-requirements">${getVenueProgress(this.state, venue.id).requirements.map((requirement) => `<li id="s3-requirement-${venue.id}-${requirement.id}"><span>${requirement.label}</span><strong id="s3-requirement-progress-${venue.id}-${requirement.id}"></strong></li>`).join("")}</ul>
                <p id="s3-venue-note-${venue.id}" class="s3-muted"></p>
              </section>`).join("")}
            <p class="s3-street-walk-note">返回场景，沿店门前的人行道走近店铺门牌，按 E 也能查看这家店的条件。当前版本尚未开放这些店铺的内部经营。</p>
          </section>
          <details class="s3-pause-section"><summary>看看怎么操作</summary><dl class="s3-controls-list"><div><dt>走动 / 观察</dt><dd><kbd>W A S D</kbd> / 鼠标</dd></div><div><dt>签收、拿箱、上架、扫描、收款</dt><dd><kbd>E</kbd></dd></div><div><dt>近看商品 / 返回</dt><dd><kbd>F</kbd></dd></div><div><dt>安全放下货箱 / 放回单品</dt><dd><kbd>G</kbd></dd></div><div><dt>切换可点击鼠标 / 转头</dt><dd><kbd>Tab</kbd></dd></div><div><dt>重听顾客</dt><dd><kbd>R</kbd></dd></div><div><dt>进货 / 普通扩容 / 商业街</dt><dd><kbd>B</kbd> / <kbd>U</kbd> / <kbd>M</kbd></dd></div><div><dt>暂停与管理</dt><dd><kbd>Esc</kbd></dd></div><div><dt>视角备用按键</dt><dd><kbd>I J K L</kbd></dd></div></dl><p class="s3-muted">先看向物品并走近，再按键操作。也可以释放鼠标后点击底部操作按钮；按钮不会隔空签收、拿货或上架。浏览器不允许锁定鼠标时，可按住画面左键拖动视角。</p></details>
          <details class="s3-pause-section"><summary>画面与操作</summary><div class="s3-settings-grid">
            <label for="s3-sensitivity">鼠标灵敏度 <output id="s3-sensitivity-value">1.0</output></label><input id="s3-sensitivity" type="range" min="0.3" max="2" step="0.1" value="1">
            <label for="s3-quality">画质</label><select id="s3-quality"><option value="standard">标准 · 优先细节</option><option value="low">流畅 · 降低渲染负担</option></select>
            <label for="s3-reduced-motion">减少镜头动态</label><input id="s3-reduced-motion" type="checkbox" checked>
            <label for="s3-volume">发音音量 <output id="s3-volume-value">70%</output></label><input id="s3-volume" type="range" min="0" max="1" step="0.1" value="0.7">
            <label for="s3-auto-speech">顾客自动说话</label><input id="s3-auto-speech" type="checkbox" checked>
          </div><p class="s3-muted">单词为英式真人录音，短句为本地英式合成音频，不依赖系统语音。字幕始终保留，R 可重听，不录音、不要求开麦。</p></details>
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
    click("s3-resume", () => this.resume(false));
    click("s3-capture", () => { if (this.mode === "playing") this.world?.requestPointerLock() });
    click("s3-close-inspect", () => this.closeInspection());
    click("s3-speak-word", () => { if (this.inspecting) this.speak(PRODUCTS[this.inspecting].nameEn) });
    click("s3-speak-phrase", () => { if (this.inspecting) this.speak(unitPhrase(this.inspecting)) });
    click("s3-read-customer", () => this.replayCustomer());
    click("s3-repeat-customer", () => this.repeatCustomer());
    click("s3-open-supply", () => this.openManagement("supply"));
    click("s3-open-day", () => this.openManagement("day"));
    click("s3-open-upgrade", () => this.openManagement("upgrade"));
    click("s3-open-street", () => this.openManagement("street"));
    for (const section of MANAGEMENT_SECTIONS) {
      click(`s3-tab-${section}`, () => this.showManagementSection(section));
    }
    for (const venue of STREET_VENUES) {
      click(`s3-venue-${venue.id}`, () => {
        this.selectedVenue = venue.id;
        this.renderStreet();
      });
    }
    for (const [id, pairs] of [["one", 1], ["three", 3], ["six", 6]] as const) {
      click(`s3-buy-${id}`, () => {
        this.purchasePairs = pairs;
        this.purchaseOrderId = crypto.randomUUID();
        this.renderManagement();
      });
    }
    click("s3-purchase", () => this.purchaseStock());
    click("s3-settle-day", () => this.dispatch({ type: "SETTLE_DAY" }));
    click("s3-next-day", () => {
      if (this.dispatch({ type: "START_NEXT_DAY" })) {
        this.lastCustomerCue = "";
        this.nextCustomerElapsed = 0;
        this.showManagementSection("supply");
      }
    });
    click("s3-day-to-upgrade", () => this.showManagementSection("upgrade"));
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
    for (const id of ["s3-sensitivity", "s3-quality", "s3-reduced-motion", "s3-volume", "s3-auto-speech"]) {
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
    this.unlockSpeech();
    this.world.requestPointerLock();
    this.lastFrameAt = performance.now();
    this.lastPoseSave = performance.now();
    this.capturePose();
    this.persist();
    if (!this.saveSession.canWrite) return;
    this.renderCaptureHint();
    this.notify(this.loadedSession ? "欢迎回来，货物和资金已恢复。待收货订单请到门口签收；B 进货，M 查看商业街。" : "先按 B 下单，推荐 3 份 £6.90。返回小店走到门口货车旁按 E 签收，再搬运上架。");
    this.syncCustomerCue();
  }

  private interact(): void {
    if (this.mode !== "playing") return;
    if (interactionInReach(this.target) && this.target.kind === "open-sign" && (this.state.day.phase === "settled" || canSettleDay(this.state))) {
      this.openManagement("day"); return;
    }
    // Delivery clearance depends on the live pose, not the periodic save snapshot.
    if (interactionInReach(this.target) && this.target.kind === "delivery") this.capturePose();
    const decision = commandForInteraction(this.state, this.target);
    if (decision.management) {
      if (decision.venueId) this.selectedVenue = decision.venueId;
      this.openManagement(decision.management);
    } else if (decision.command) this.dispatch(decision.command);
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

  private openManagement(section: ManagementSection): void {
    if (this.mode !== "playing" && this.mode !== "paused") return;
    this.pause();
    if (this.mode !== "paused") return;
    this.purchaseOrderId = crypto.randomUUID();
    this.showManagementSection(section);
  }

  private showManagementSection(section: ManagementSection): void {
    this.managementSection = section;
    for (const candidate of MANAGEMENT_SECTIONS) {
      this.el(`s3-panel-${candidate}`).hidden = candidate !== section;
      this.el(`s3-tab-${candidate}`).setAttribute("aria-pressed", String(candidate === section));
    }
    this.renderManagement();
  }

  private purchaseStock(): void {
    if (this.mode !== "paused" || this.purchaseBusy) return;
    const offer = getPurchaseOffer(this.state, this.purchasePairs);
    if (!offer.allowed) { this.notify(offer.reason ?? "本次暂时不能进货。"); return }
    this.purchaseOrderId ||= crypto.randomUUID();
    this.purchaseBusy = true;
    this.renderManagement();
    const bought = this.dispatch({ type: "PURCHASE_STOCK", orderId: this.purchaseOrderId, pairs: this.purchasePairs });
    this.purchaseBusy = false;
    this.renderManagement();
    if (bought) {
      this.resume(false);
      this.notify(`下单成功：牛奶、面包各 ${this.purchasePairs} 件，已扣 ${money(offer.costPence)}。走到门口货车旁按 E 签收，再抱箱上架；签收不再扣款。`);
    }
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
    this.lastFrameAt = performance.now();
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
    if (this.mode === "playing") {
      if (event.code === "Tab") {
        event.preventDefault(); event.stopImmediatePropagation();
        this.world?.setCursorFree(this.pointerMode === "locked");
        return;
      }
      if (event.code === "KeyB" || event.code === "KeyU" || event.code === "KeyM") {
        event.preventDefault(); event.stopImmediatePropagation();
        this.openManagement(event.code === "KeyB" ? "supply" : event.code === "KeyU" ? "upgrade" : "street");
        return;
      }
      if (event.code === "KeyR") {
        event.preventDefault(); event.stopImmediatePropagation(); this.replayCustomer(); return;
      }
    }
    if (this.mode === "inspecting" && event.code === "Tab") {
      const buttons = Array.from(this.el("s3-inspection").querySelectorAll<HTMLElement>("button, a[href]"));
      const current = buttons.findIndex((button) => button === document.activeElement);
      const index = (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[index]?.focus();
    }
  }

  private dispatch(command: SimCommand, showMessage = true): boolean {
    if (!this.saveSession?.canWrite) { this.enterReadOnly("此页面只读，不能修改小店进度。"); return false }
    try {
      this.saveSession.assertCurrent();
      this.capturePose();
      const result = reduceSim(this.state, command);
      this.state = result.state;
      if (result.changed) {
        this.persist();
        if (!this.saveSession.canWrite) return false;
        this.world?.setState(this.state);
        this.renderState();
        this.syncCustomerCue();
      }
      if (showMessage && result.message) this.notify(result.message);
      if (result.changed && command.type === "PAY" && command.success) {
        const summary = getDaySummary(this.state);
        this.notify(`收款成功 +£4 · 今日 ${summary.paidCustomers} / ${summary.targetCustomers} 单。${!this.state.upgraded && this.state.cashPence >= UPGRADE_COST_PENCE ? "按 U 可查看 £8 扩容；注意留足下次进货资金。" : `当前资金 ${money(this.state.cashPence)}。`}`);
      }
      return result.changed;
    } catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return false }
      this.saveError = "本次操作或画面同步遇到问题。请先暂停并下载当前存档备份，再重试；不要继续重复收款。";
      this.renderSaveStatus();
      return false;
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
    const elapsed = this.lastFrameAt ? Math.min(1.5, (now - this.lastFrameAt) / 1000) : 0;
    this.lastFrameAt = now;
    if (this.mode === "playing" && this.state.day.phase === "open" && this.state.customer.phase === "complete") {
      this.nextCustomerElapsed += elapsed;
      if (this.nextCustomerElapsed >= 2) {
        if (canSettleDay(this.state) && this.dayReadyNotified !== this.state.day.number) {
          this.dayReadyNotified = this.state.day.number;
          this.openManagement("day");
          this.notify("三位顾客都已结账离店。看看今天的账目，再点击日结；收入不会再重复计入。");
        } else if (getDaySummary(this.state).paidCustomers < DAY_CUSTOMER_TARGET && PRODUCT_IDS.every((id) => countAt(this.state, id, "shelf") > 0)) {
          this.nextCustomerElapsed = 0;
          this.dispatch({ type: "NEXT_CUSTOMER" });
        }
      }
    } else this.nextCustomerElapsed = 0;
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
    const day = getDaySummary(this.state);
    const delivery = getDeliverySummary(this.state);
    this.text("s3-start-button", this.mode === "readonly" ? "此页面只读" : this.loadedSession ? "继续营业" : "开始第一天");
    this.el<HTMLButtonElement>("s3-start-button").disabled = !this.ready || !this.saveSession?.canWrite;
    this.text("s3-readonly-note", this.writerWarning);
    this.el("s3-readonly-note").hidden = !this.writerWarning;
    this.el("s3-takeover").hidden = !this.writerWarning;
    this.el<HTMLButtonElement>("s3-takeover").disabled = !this.ready;
    this.el("s3-export-readonly").hidden = !this.writerWarning;
    this.text("s3-start-note", this.loadedSession
      ? `已恢复${this.state.openingKind === "legacy-s0" ? "旧试玩" : "本机"}进度：第 ${this.state.day.number} 天，${money(this.state.cashPence)} 资金。${delivery.pendingOrders ? `还有 ${delivery.pendingUnits} 件待到门口签收。` : "货物、收款记录和扩容保持不变。"}不另加本金。按 M 可查看商业街条件。`
      : "首日建议先买 3 份牛奶与面包，£6.90。到门口签收、上架后迎客；按 M 查看咖啡店、餐厅与大商超的条件。");
    this.text("s3-start-capital", money(this.state.cashPence));
    this.text("s3-start-capital-label", this.loadedSession ? "已保存资金 · 原进度保留" : "首日本金 · 进货会扣钱");
    this.text("s3-objective", getObjective(this.state));
    this.text("s3-phase", `第 ${this.state.day.number} 天 · ${this.state.day.phase === "settled" ? "已日结" : this.state.day.phase === "preparing" ? "进货与开店" : `营业 ${day.paidCustomers} / ${day.targetCustomers} 单`}`);
    this.text("s3-cash", money(this.state.cashPence));
    this.text("s3-sold", `今日 ${day.paidCustomers} / ${day.targetCustomers} 单 · 库存 ${day.remainingStockUnits} 件`);
    this.text("s3-milk-stock", `牛奶 ${countAt(this.state, "milk", "shelf")} / ${capacityFor(this.state)}`);
    this.text("s3-bread-stock", `面包 ${countAt(this.state, "bread", "shelf")} / ${capacityFor(this.state)}`);
    this.el("s3-delivery-hud").hidden = delivery.pendingOrders === 0;
    this.text("s3-delivery-hud", delivery.pendingOrders ? `${delivery.pendingUnits} 件待签收 · 门口货车旁按 E` : "");
    this.renderReceipt();
    this.renderTarget();
    this.renderSaveStatus();
    this.renderManagement();
    this.el<HTMLButtonElement>("s3-cancel-customer").disabled = ["outside", "leaving", "complete"].includes(this.state.customer.phase);
    this.el<HTMLInputElement>("s3-sensitivity").value = String(this.settings.sensitivity);
    this.el<HTMLSelectElement>("s3-quality").value = this.settings.quality;
    this.el<HTMLInputElement>("s3-reduced-motion").checked = this.settings.reducedMotion;
    this.el<HTMLInputElement>("s3-volume").value = String(this.settings.volume);
    this.el<HTMLInputElement>("s3-auto-speech").checked = this.settings.autoSpeech;
    this.text("s3-sensitivity-value", this.settings.sensitivity.toFixed(1));
    this.text("s3-volume-value", `${Math.round(this.settings.volume * 100)}%`);
  }

  private renderManagement(): void {
    const writable = !!this.saveSession?.canWrite;
    const day = getDaySummary(this.state);
    const offer = getPurchaseOffer(this.state, this.purchasePairs);
    const delivery = getDeliverySummary(this.state);
    this.el("s3-pause").classList.toggle("s3-pause-street", this.managementSection === "street");
    for (const [id, pairs] of [["one", 1], ["three", 3], ["six", 6]] as const) {
      this.el(`s3-buy-${id}`).setAttribute("aria-pressed", String(this.purchasePairs === pairs));
    }
    for (const candidate of MANAGEMENT_SECTIONS) {
      this.el(`s3-panel-${candidate}`).hidden = candidate !== this.managementSection;
    }
    this.text("s3-supply-cash", money(this.state.cashPence));
    this.text("s3-supply-total", `−${money(offer.costPence)}`);
    this.text("s3-supply-after", this.state.cashPence < offer.costPence ? `还差 ${money(offer.costPence - this.state.cashPence)}` : money(this.state.cashPence - offer.costPence));
    this.text("s3-delivery-summary", delivery.pendingOrders
      ? `${delivery.pendingOrders} 笔已付款订单 · ${delivery.pendingUnits} 件待签收。${delivery.canReceive ? "返回场景，空手走到门口货车旁按 E 卸货。" : delivery.reason ?? "返回场景后到门口签收。"}`
      : delivery.receivedToday ? `今日已签收 ${delivery.receivedToday} 笔订单。需要补货时可再次下单，继续到车旁签收；不会免费补满。`
        : `第 ${this.state.day.number} 天的送货服务已备好。选好数量下单，再到门口签收；未下单不会扣款。`);
    this.text("s3-supply-summary", `本次共 ${this.purchasePairs * 2} 件。箱内：牛奶 ${countAt(this.state, "milk", "crate")} 件、面包 ${countAt(this.state, "bread", "crate")} 件；待签收 ${delivery.pendingUnits} 件。每箱最多 8 件，待收货也占预留容量。`);
    this.text("s3-supply-error", offer.reason ?? "确认下单时扣款一次，门口签收不再收费。签收后货箱放在室外卸货区，需要自己搬运上架。");
    this.el<HTMLButtonElement>("s3-purchase").disabled = !writable || !offer.allowed || this.purchaseBusy;
    this.text("s3-purchase", this.purchaseBusy ? "正在下单…" : `确认下单 · ${money(offer.costPence)}`);
    this.text("s3-day-title", `第 ${day.dayNumber} 天${this.state.day.phase === "settled" ? " · 日结完成" : " · 营业账本"}`);
    this.text("s3-day-progress", `已收款 ${day.paidCustomers} / ${day.targetCustomers} 单 · 开始时资金 ${money(day.openingCashPence)}`);
    for (const [suffix, value] of [["revenue", day.revenuePence], ["cogs", day.costOfGoodsPence], ["profit", day.grossProfitPence], ["procurement", day.procurementPence], ["investment", day.upgradeSpendPence], ["cash", day.closingCashPence]] as const) {
      this.text(`s3-day-${suffix}`, money(value));
    }
    this.text("s3-day-inventory", `${day.remainingStockUnits} 件 / ${money(day.remainingInventoryValuePence)}`);
    const settled = this.state.day.phase === "settled";
    const canSettle = canSettleDay(this.state);
    this.text("s3-day-reason", settled ? "今天的账已记好。可以先扩容，也可以留钱备货；下一天会保留全部资金、库存与扩容。送货车每天都会来，补货仍需下单。" : delivery.pendingUnits > 0 ? `还有 ${delivery.pendingUnits} 件已付款商品待签收。先返回门口货车旁签收，才能结束今天的营业。` : canSettle ? "今天的 3 单都已完成，顾客已经离店。可以日结了。" : this.state.day.phase === "preparing" ? "先按 B 下单，到门口签收并摆好两种商品，再去门口翻转营业牌。" : day.paidCustomers >= day.targetCustomers ? "最后一位顾客正在离店，返回小店稍等片刻即可日结。" : `还需完成 ${day.targetCustomers - day.paidCustomers} 单收款。顾客会依次进店；缺货时先补货。`);
    this.el("s3-settle-day").hidden = settled;
    this.el<HTMLButtonElement>("s3-settle-day").disabled = !writable || !canSettle;
    this.el("s3-next-day").hidden = !settled;
    this.el<HTMLButtonElement>("s3-next-day").disabled = !writable;
    const availableUpgrade = !this.state.upgraded && this.state.cashPence >= UPGRADE_COST_PENCE;
    this.el<HTMLButtonElement>("s3-upgrade").disabled = !writable || !availableUpgrade;
    this.text("s3-upgrade", this.state.upgraded ? "已扩容 · 每种 8 个货位" : "£8 · 确认扩充货架容量");
    this.text("s3-upgrade-badge", this.state.upgraded ? "已升级" : "一次性 £8");
    this.text("s3-capacity-now", String(capacityFor(this.state)));
    this.text("s3-capacity-label", this.state.upgraded ? "已启用" : "现在");
    this.el("s3-capacity-arrow").hidden = this.state.upgraded;
    this.el("s3-capacity-next").hidden = this.state.upgraded;
    this.el("s3-capacity-comparison").classList.toggle("s3-capacity-complete", this.state.upgraded);
    this.text("s3-upgrade-status", this.state.upgraded ? "冰柜和面包架的新层位已经启用，不会再次扣钱。去店里看看，也可以继续备货。" : availableUpgrade ? `资金足够。购买后剩 ${money(this.state.cashPence - UPGRADE_COST_PENCE)}；请为进货留一些资金（每份 £2.30）。不需要答题解锁。` : `当前 ${money(this.state.cashPence)}，还差 ${money(UPGRADE_COST_PENCE - this.state.cashPence)}。只检查资金，不要求英语等级。`);
    this.el("s3-open-upgrade").classList.toggle("s3-upgrade-ready", availableUpgrade);
    this.el("s3-open-upgrade").setAttribute("aria-label", this.state.upgraded ? "货架已扩容，查看详情 U" : availableUpgrade ? "资金足够，查看扩容 U" : "查看扩容条件 U");
    this.el("s3-open-day").classList.toggle("s3-upgrade-ready", canSettle);
    this.renderStreet();
  }

  private renderStreet(): void {
    const progress = getStreetProgress(this.state);
    const withinLevel = progress.levelExperience;
    const toNextLevel = progress.nextLevelExperience - progress.experience;
    this.text("s3-street-level", `Lv. ${progress.level}`);
    this.text("s3-street-experience", `${withinLevel} / ${progress.experiencePerLevel} 成长值 · 再 ${toNextLevel} 升级`);
    const bar = this.el("s3-street-progress");
    bar.setAttribute("aria-valuemax", String(progress.experiencePerLevel));
    bar.setAttribute("aria-valuenow", String(withinLevel));
    bar.setAttribute("aria-valuetext", `经营等级 ${progress.level}，本级 ${withinLevel} / ${progress.experiencePerLevel} 成长值`);
    this.el("s3-street-progress-fill").setAttribute("style", `width: ${clamp(withinLevel / progress.experiencePerLevel * 100, 0, 100)}%`);
    this.text("s3-street-record", `累计收款 ${progress.paidOrders} 单 · 完成日结 ${progress.settledDays} 天 · ${progress.upgraded ? "货架已扩容" : "货架未扩容"}`);
    for (const venue of STREET_VENUES) {
      const current = getVenueProgress(this.state, venue.id);
      const selected = this.selectedVenue === venue.id;
      this.el(`s3-venue-${venue.id}`).setAttribute("aria-pressed", String(selected));
      this.el(`s3-venue-${venue.id}`).setAttribute("aria-label", `${venue.nameZh}，${current.statusText}，查看 Lv. ${venue.requiredLevel} 与成就条件`);
      this.el(`s3-venue-${venue.id}`).classList.toggle("s3-venue-eligible", current.eligible);
      this.el(`s3-venue-detail-${venue.id}`).hidden = !selected;
      this.text(`s3-venue-status-${venue.id}`, current.statusText);
      this.text(`s3-venue-detail-status-${venue.id}`, current.statusText);
      for (const requirement of current.requirements) {
        this.el(`s3-requirement-${venue.id}-${requirement.id}`).classList.toggle("s3-requirement-complete", requirement.completed);
        this.text(`s3-requirement-progress-${venue.id}-${requirement.id}`, `${Math.min(requirement.current, requirement.target)} / ${requirement.target}${requirement.completed ? " · 已达成" : ""}`);
      }
      this.text(`s3-venue-note-${venue.id}`, current.eligible
        ? "等级与成就条件已达成，店铺仍在筹备中。当前版本可以参观门前街景，内部经营尚未开放。"
        : "满足以上全部等级与成就条件后，店铺将标记为“条件已达成·筹备中”。当前版本暂未开放内部经营。");
    }
  }

  private renderTarget(): void {
    const target = this.target;
    const inReach = interactionInReach(target);
    this.text("s3-target-label", inReach ? `${target.label} · ${target.distance.toFixed(1)} m` : "看向身边的物品");
    const delivery = inReach && target.kind === "delivery" ? getDeliverySummary(this.state) : null;
    this.text("s3-target-action", delivery ? delivery.pendingOrders ? `签收 ${delivery.pendingUnits} 件送货` : "查看今日进货单" : inReach ? target.action : "走近物品后互动");
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
    const shopping = ["to-milk", "to-bread", "to-checkout"].includes(phase);
    const receipt = this.el<HTMLDetailsElement>("s3-receipt");
    receipt.hidden = !atCheckout && !showPaid && !shopping;
    if (atCheckout && this.receiptCustomer !== this.state.customer.number) { receipt.open = true; this.receiptCustomer = this.state.customer.number }
    this.text("s3-receipt-title", showPaid ? "本单已收款" : atCheckout ? "顾客想结账" : "顾客进店了");
    this.text("s3-receipt-state", showPaid ? "实收" : "应收");
    const total = transaction?.amountPence ?? getCheckoutTotal(this.state);
    this.text("s3-receipt-summary", shopping ? "听听问候" : money(total));
    this.text("s3-receipt-total", money(total));
    this.el("s3-receipt-items").hidden = !atCheckout && !showPaid;
    for (const productId of PRODUCT_IDS) {
      const scanned = showPaid || this.state.items.some((item) => item.productId === productId && this.state.scannedIds.includes(item.id));
      this.text(`s3-scan-${productId}`, scanned ? "已扫描" : "未扫描");
      this.el(`s3-scan-${productId}`).classList.toggle("s3-scanned", scanned);
    }
    this.customerClip = showPaid ? "thanks" : atCheckout ? (getDaySummary(this.state).paidCustomers >= 2 ? "cardRepeat" : "card") : "greeting";
    const clip = SPEECH_CLIPS[this.customerClip];
    this.text("s3-customer-line", `“${clip.text}”`);
    this.text("s3-customer-zh", clip.zh);
    this.el("s3-repeat-customer").hidden = !atCheckout;
    this.text("s3-receipt-help", showPaid ? "金额已入账，不会重复收费。可在营业账本中查看今天的收支。" : shopping ? "顾客会自己拿取牛奶与面包，再到收银台。R 可重听；Tab 释放鼠标。" : this.state.scannedIds.length === 2 ? "全部已扫描。靠近收银台按 E 启用刷卡机。" : "鼠标已释放，可点击重听。走到收银台内侧，按 E 逐件扫描。");
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
    const playing = this.mode === "playing";
    this.el("s3-capture").hidden = !playing || this.pointerMode === "locked" || this.dragLookFallback;
    this.el("s3-drag-hint").hidden = !playing;
    this.text("s3-drag-hint", this.pointerMode === "locked" ? "Tab 释放鼠标 · R 重听 · B 进货 · M 商业街" : "鼠标可点击 · 按住画面拖动观察 · M 商业街");
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
        autoSpeech: input.autoSpeech !== false,
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
      autoSpeech: this.el<HTMLInputElement>("s3-auto-speech").checked,
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

  /** Prime this very same audio element in the Start click's user activation. */
  private unlockSpeech(): void {
    const audio = this.el<HTMLAudioElement>("s3-word-audio");
    const generation = this.speechGeneration;
    audio.muted = true;
    audio.src = SPEECH_CLIPS.greeting.src;
    const finish = (): void => {
      if (this.disposed || generation !== this.speechGeneration) return;
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    };
    try { void audio.play().then(finish, finish) }
    catch { finish() }
  }

  private syncCustomerCue(): void {
    if (this.mode !== "playing" || this.state.customer.phase === "outside") return;
    const phase = this.state.customer.phase;
    if ((phase === "leaving" || phase === "complete") && !this.state.transactions.some((sale) => sale.customerNumber === this.state.customer.number)) return;
    const cue = `${this.state.customer.number}:${this.customerClip}`;
    if (cue === this.lastCustomerCue) return;
    this.lastCustomerCue = cue;
    this.el<HTMLDetailsElement>("s3-receipt").open = true;
    if (phase === "checkout") this.world?.setCursorFree(true);
    if (this.settings.autoSpeech && phase !== "complete") this.speak(SPEECH_CLIPS[this.customerClip].text);
    else this.text("s3-customer-audio-status", "点击重听或按 R 播放，字幕始终保留。");
  }

  private replayCustomer(): void {
    if (this.mode !== "playing") return;
    if (this.el("s3-receipt").hidden) { this.notify("顾客进店后，按 R 就能重听刚刚的话。"); return }
    this.el<HTMLDetailsElement>("s3-receipt").open = true;
    const clip = SPEECH_CLIPS[this.customerClip];
    this.text("s3-customer-line", `“${clip.text}”`);
    this.text("s3-customer-zh", clip.zh);
    this.speak(clip.text);
  }

  private repeatCustomer(): void {
    if (this.mode !== "playing" || this.state.customer.phase !== "checkout") return;
    const number = this.state.customer.number;
    const reply = SPEECH_CLIPS[this.customerClip];
    const request = SPEECH_CLIPS.repeatRequest;
    this.text("s3-customer-line", `你：“${request.text}”`);
    this.text("s3-customer-zh", request.zh);
    this.speak(request.text, 1, () => {
      if (this.mode !== "playing" || this.state.customer.phase !== "checkout" || this.state.customer.number !== number) return;
      this.text("s3-customer-line", `顾客：“${reply.text}”`);
      this.text("s3-customer-zh", `${reply.zh} · 这次慢一点说`);
      this.speak(reply.text, 0.84);
    });
  }

  private speak(text: string, rate = 1, onDone?: () => void): void {
    const report = (message: string): void => {
      if (this.mode === "inspecting") this.text("s3-speech-status", message);
      else this.text("s3-customer-audio-status", message);
    };
    this.stopSpeech();
    if (this.settings.volume === 0) { report("发音音量当前为 0，可以在暂停设置中调高。"); return }
    const generation = this.speechGeneration;
    const liveReport = (message: string): void => {
      if (!this.disposed && generation === this.speechGeneration) report(message);
    };
    const word = text === "milk" || text === "bread";
    const normalize = (value: string): string => value.toLowerCase().replace(/[.!?]/g, "").trim();
    const clip = Object.values(SPEECH_CLIPS).find((candidate) => normalize(candidate.text) === normalize(text));
    if (!word && !clip) { report("这句话暂未配音，字幕和操作不受影响。"); return }
    const audio = this.el<HTMLAudioElement>("s3-word-audio");
    let started = false;
    let failed = false;
    const fail = (): void => {
      if (this.disposed || generation !== this.speechGeneration || failed) return;
      failed = true;
      if (this.speechTimer) clearTimeout(this.speechTimer);
      liveReport(word ? "这段单词发音未能播放，请重试；商品文字和操作不受影响。" : "语音未能播放。点击“重听”或按 R 再试，并检查浏览器与设备声音；字幕和收款仍可用。");
    };
    audio.onplaying = () => {
      if (failed || this.disposed || generation !== this.speechGeneration) return;
      started = true;
      if (this.speechTimer) clearTimeout(this.speechTimer);
      liveReport(word ? `正在播放英式发音：${text}` : `正在播放${rate < 1 ? "慢速" : "英式"}语音：${text}`);
    };
    audio.onended = () => {
      if (this.disposed || generation !== this.speechGeneration || !started || failed) return;
      liveReport(word ? `已播放英式发音：${text}。可以再听一次。` : "语音播放结束，可以点击重听或按 R 再听一次。");
      onDone?.();
    };
    audio.onerror = fail;
    audio.onloadedmetadata = () => {
      if (!this.disposed && generation === this.speechGeneration) audio.playbackRate = rate;
    };
    audio.muted = false;
    audio.volume = this.settings.volume;
    // The media load algorithm restores playbackRate from defaultPlaybackRate.
    // Set both so changing src cannot silently undo a requested slow replay.
    audio.defaultPlaybackRate = rate;
    audio.src = word ? `/assets/sim3d/audio/${text}.ogg` : clip!.src;
    audio.playbackRate = rate;
    liveReport(word ? `正在准备单词录音：${text}` : "正在准备本地英式合成语音…");
    this.speechTimer = setTimeout(() => { if (!started && !failed) liveReport("语音还未开始，请点击重听并检查设备声音。") }, 4000);
    try { void audio.play().catch(fail) }
    catch { fail() }
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
      audio.onloadedmetadata = null;
      audio.pause();
      try { audio.currentTime = 0 }
      catch { /* Some browsers do not allow seeking until metadata has loaded. */ }
      if (wasPlaying && this.mode === "inspecting") this.text("s3-speech-status", "发音已停止，可以再次点击听单词。");
    }
  }

  private exportSave(): void {
    this.savePoseAndPersist();
    const blob = new Blob([JSON.stringify(this.state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `corner-shop-day-${this.state.day.number}-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`;
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
      this.text("s3-import-summary", `${file.name} · 第 ${imported.day.number} 天 · 资金 ${money(imported.cashPence)} · 未售库存 ${getDaySummary(imported).remainingStockUnits} 件 · ${imported.openingKind === "legacy-s0" ? "兼容旧试玩进度" : "完整首日存档"}。`);
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
    this.lastCustomerCue = "";
    this.dayReadyNotified = 0;
    this.nextCustomerElapsed = 0;
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
    const fresh = createFirstDayState();
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
    this.lastCustomerCue = "";
    this.dayReadyNotified = 0;
    this.nextCustomerElapsed = 0;
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
    this.world?.setCursorFree(true);
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
