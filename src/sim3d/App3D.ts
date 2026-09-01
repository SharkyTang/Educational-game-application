import {
  PRODUCTS, PRODUCT_IDS, UPGRADE_COST_PENCE, capacityFor, countAt,
  createFirstDayState, getCheckoutTotal, getObjective, reduceSim,
  getDaySummary, getPurchaseOffer, getDeliverySummary, getCustomerOrder, getShoppingProduct,
  getRecyclingOffer, getRecyclingSummary, RECYCLING_REWARD_PENCE,
  canSettleDay, canStartCustomer, getShopLayoutObstacles, CRATE_CAPACITY,
  type PlayerPose, type ProductId, type PurchaseLine, type SimCommand, type SimState,
} from "./domain";
import { loadSimState, parseImportedSimState, SimSaveConflictError, SimSaveSession, SIM_STORAGE_KEY } from "./persistence";
import { ShopWorld, type InteractionTarget, type Quality } from "./world";
import { SPEECH_CLIPS } from "./speechClips";
import { ShopAudio, type ShopEffect } from "./shopAudio";
import { createCustomerSeed, customerProfileFor, customerSpeechFor, cashTenderSpeechFor, type CustomerSpeechClip } from "./customerSelection";
import { getBusinessClock } from "./businessTime";
import { BusinessClockDriver, isBusinessTimeRunning } from "./businessClockDriver";
import { cashRegisterMarkup } from "./cashRegister";
import { CashRegisterController } from "./cashRegisterController";
import { LayoutEditor } from "./layoutEditor";
import { DevelopmentPanel } from "./developmentPanel";
import { shopRenovationReason } from "./shopDevelopment";
import { STREET_VENUES, getStreetProgress, getVenueProgress } from "./progression";
import { PRODUCT_ASSETS, PRODUCT_CATEGORIES, type ProductCategoryId } from "./product-library/catalog";
import type { PointerMode } from "./pointerAccess";
import "./styles.css";
import "./cashRegister.css";
import "./businessTime.css";
import "./developmentPanel.css";

type ScreenMode = "loading" | "start" | "playing" | "paused" | "inspecting" | "cashier" | "readonly" | "error";
type ManagementSection = "supply" | "day" | "upgrade" | "development" | "layout" | "street";
type StreetVenueId = (typeof STREET_VENUES)[number]["id"];
const MANAGEMENT_SECTIONS: readonly ManagementSection[] = ["supply", "day", "upgrade", "development", "layout", "street"];
interface InteractionDecision {
  command?: SimCommand;
  message?: string;
  management?: ManagementSection;
  venueId?: StreetVenueId;
  cashRegister?: true;
}
interface Settings {
  schemaVersion: 1;
  sensitivity: number;
  quality: Quality;
  reducedMotion: boolean;
  volume: number;
  autoSpeech: boolean;
  musicEnabled: boolean;
  musicVolume: number;
  effectsVolume: number;
}
const SETTINGS_KEY = "english-high-street:sim3d:settings:v1";
const MAX_INTERACTION_DISTANCE = 2.6;
const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1, sensitivity: 1, quality: "standard", reducedMotion: true, volume: 0.7, autoSpeech: true,
  musicEnabled: true, musicVolume: 0.22, effectsVolume: 0.5,
};
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
const unitPhrase = (id: ProductId): string => PRODUCTS[id].phraseEn;
const clamp = (number: number, min: number, max: number): number => Math.max(min, Math.min(max, number));
const activeInstances = new Set<App3D>();

/** Preserve invalid edits as errors so a hidden or half-edited quantity cannot become an order. */
export function parsePurchaseQuantities(values: ReadonlyMap<ProductId, string>): { lines: PurchaseLine[]; invalidProductIds: ProductId[]; error?: string } {
  const lines: PurchaseLine[] = [];
  const invalidProductIds: ProductId[] = [];
  for (const productId of PRODUCT_IDS) {
    const raw = values.get(productId) ?? "0";
    const quantity = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > CRATE_CAPACITY) {
      invalidProductIds.push(productId);
    } else if (quantity > 0) lines.push({ productId, quantity });
  }
  return {
    lines, invalidProductIds,
    ...(invalidProductIds.length ? { error: `${PRODUCTS[invalidProductIds[0]!].nameZh}的数量无效，请填写 0–${CRATE_CAPACITY} 的整数；0 表示不进货。${invalidProductIds.length > 1 ? `另有 ${invalidProductIds.length - 1} 项需要修正。` : ""}` } : {}),
  };
}

export function interactionInReach(target: InteractionTarget | null): target is InteractionTarget {
  return target !== null && Number.isFinite(target.distance) && target.distance >= 0 && target.distance <= MAX_INTERACTION_DISTANCE;
}

/** A DOM button follows the same ray-picked target and distance rules as its keyboard shortcut. */
export function commandForInteraction(state: SimState, target: InteractionTarget | null): InteractionDecision {
  if (!target) return {};
  if (!interactionInReach(target)) return { message: "再走近一点，才能操作这件物品。" };
  switch (target.kind) {
    case "recycling": {
      const offer = getRecyclingOffer(state);
      return offer.allowed ? { command: { type: "RECYCLE_CRATE" } }
        : { message: offer.reason ?? "抱起空纸箱，到这里按 E 回收。" };
    }
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
      if (next) return { command: { type: "SCAN", itemId: next.id } };
      return state.payment?.method === "cash" ? { cashRegister: true } : { command: { type: "PAY", success: true } };
    }
    case "open-sign":
      return state.day.phase === "preparing" ? { command: { type: "OPEN_STORE" } } : { management: "day" };
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
  private synthesisUtterance: SpeechSynthesisUtterance | null = null;
  private dragLookFallback = false;
  private pointerMode: PointerMode = "free";
  private customerClip: CustomerSpeechClip = customerSpeechFor(this.state, "greeting");
  private lastCustomerCue = "";
  private readonly businessClock = new BusinessClockDriver();
  private learningPlayback = false;
  private closingWarningDay = 0;
  private closeConfirmation = false;
  private dayReadyNotified = 0;
  private readonly purchaseQuantities = new Map<ProductId, string>();
  private purchaseSearch = "";
  private purchaseCategory: ProductCategoryId | "all" = "all";
  private purchaseSelectedOnly = false;
  private purchaseOrderId = "";
  private purchaseBusy = false;
  private managementSection: ManagementSection = "supply";
  private selectedVenue: StreetVenueId = "cafe";
  private pendingImport: SimState | null = null;
  private importGeneration = 0;
  private readonly events = new AbortController();
  private readonly shopAudio: ShopAudio;
  private readonly cashRegister: CashRegisterController;
  private readonly layoutEditor: LayoutEditor;
  private readonly developmentPanel: DevelopmentPanel;
  private pendingLayoutExit: ManagementSection | "resume" | null = null;
  private audioForeground = true;

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
    this.shopAudio = new ShopAudio({
      onStatus: (status) => { if (!this.disposed) this.text("s3-music-status", status) },
    });
    this.shopAudio.setSettings(this.settings);
    this.cashRegister = new CashRegisterController(this.root, {
      read: () => ({
        payment: this.state.payment,
        amountPence: getCheckoutTotal(this.state),
        atCheckout: this.state.customer.phase === "checkout",
        canWrite: !!this.saveSession?.canWrite,
        customerName: `${customerProfileFor(this.state).name} · 第 ${this.state.customer.number} 位顾客`,
        clip: cashTenderSpeechFor(this.state),
        warning: this.saveError || this.writerWarning,
      }),
      canOpen: () => this.canOpenCashRegister(),
      dispatch: (command) => this.dispatch(command),
      onOpen: () => {
        this.stopSpeech();
        this.mode = "cashier";
        this.world?.setActive(false);
        this.releasePointer();
        this.renderCaptureHint();
        this.syncShopAudio();
      },
      onClose: () => {
        // Lifecycle transitions close the dialog after changing mode. Never
        // resume a stale, read-only, reinitializing or disposed world from here.
        if (this.mode !== "cashier" || this.disposed) return;
        this.stopSpeech();
        this.mode = "playing";
        this.businessClock.resume(performance.now());
        this.world?.setActive(true);
        this.releasePointer();
        this.renderCaptureHint();
        this.syncShopAudio();
        this.el("s3-canvas").focus();
        this.syncCustomerCue();
      },
      speak: (clip, rate) => this.speak(clip, rate, undefined, true),
    }, this.events.signal);
    this.layoutEditor = new LayoutEditor(this.el("s3-layout-editor"), {
      onApply: (layout) => this.mode === "paused" && this.dispatch({ type: "APPLY_SHOP_LAYOUT", layout }),
      onDirtyChange: (dirty) => { if (!dirty) this.cancelLayoutExit(false) },
    });
    this.developmentPanel = new DevelopmentPanel(this.el("s3-development-host"), {
      onExpand: () => this.mode === "paused" && this.dispatch({ type: "BUY_SPACE_EXPANSION" }),
      onLayout: () => this.showManagementSection("layout"),
    });
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
    this.businessClock.reset();
    this.cashRegister.close();
    this.shopAudio.setActive(false);
    this.stopSpeech();
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
      this.state = snapshot.source === "new" && admitted
        ? { ...snapshot.state, customerSeed: createCustomerSeed() }
        : snapshot.state;
      this.layoutEditor.setState(this.state.renovation.layout, { editable: false, resetDraft: true });
      this.cancelLayoutExit(false);
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
        onCustomerEnter: () => {
          if (!isCurrent() || this.mode !== "playing") return;
          this.shopAudio.playEffect("doorbell");
          this.renderObjective();
          this.renderReceipt();
          this.syncCustomerCue();
        },
        onCustomerArrive: () => {
          if (isCurrent() && this.mode === "playing" && !this.learningPlayback && this.audioForeground && !document.hidden) this.dispatch({ type: "CUSTOMER_ADVANCE" });
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
        <canvas id="s3-canvas" class="s3-canvas" tabindex="0" aria-label="第一人称小店与商业街：WASD 移动，按住 Shift 加速，鼠标观察，E 互动、签收与空箱回收，F 近看商品，G 放下货箱，P 装修，M 商业街，Esc 暂停"></canvas>
        <audio id="s3-word-audio" preload="none" hidden></audio>
        <div id="s3-hud" class="s3-hud" hidden>
          <div class="s3-top-left">
            <p class="s3-wordmark">CORNER SHOP <span>英语商业街</span></p>
            <div id="s3-business-clock" class="s3-business-clock" aria-label="小店营业时间">
              <time id="s3-business-time" role="timer" aria-live="off">08:30</time>
              <strong id="s3-clock-state">准备中</strong><span id="s3-clock-note">09:00—19:00 营业</span>
            </div>
            <details id="s3-task" class="s3-task" open>
              <summary><span id="s3-phase">准备开店</span><span class="s3-fold-hint">目标</span></summary>
              <p id="s3-objective"></p>
              <div class="s3-stock-line"><span id="s3-shelf-stock"></span><span id="s3-crate-stock"></span></div>
            </details>
            <p id="s3-delivery-hud" class="s3-delivery-hud" role="status" aria-live="polite" hidden></p>
            <nav class="s3-business-nav" aria-label="小店经营">
              <button id="s3-open-supply" type="button">进货 <kbd>B</kbd></button>
              <button id="s3-open-day" type="button">营业 / 日结</button>
              <button id="s3-open-upgrade" type="button">扩容 <kbd>U</kbd></button>
              <button id="s3-open-layout" type="button">装修 <kbd>P</kbd></button>
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
            <summary><span id="s3-receipt-title">本单小票</span><span id="s3-receipt-summary">£0.00</span></summary>
            <div class="s3-receipt-body">
              <p id="s3-customer-name" class="s3-muted"></p>
              <p id="s3-payment-method" class="s3-payment-method" hidden></p>
              <p id="s3-customer-line" class="s3-customer-line">“Hello!”</p>
              <p id="s3-customer-zh" class="s3-muted"></p>
              <p id="s3-customer-order" class="s3-customer-order"></p>
              <div class="s3-customer-actions"><button id="s3-read-customer" class="s3-secondary-button" type="button">重听 <kbd>R</kbd></button><button id="s3-repeat-customer" class="s3-secondary-button" type="button">请再说一遍</button></div>
              <p id="s3-customer-audio-status" class="s3-muted" role="status" aria-live="polite"></p>
              <div id="s3-receipt-items">
              ${PRODUCT_IDS.map((productId) => `<div id="s3-receipt-line-${productId}" class="s3-receipt-row" hidden><span>${PRODUCTS[productId].nameEn}<small id="s3-receipt-count-${productId}">${PRODUCTS[productId].nameZh}</small></span><span id="s3-scan-${productId}">未扫描</span><strong id="s3-receipt-price-${productId}"></strong></div>`).join("")}
              <div class="s3-receipt-total"><span id="s3-receipt-state">应收</span><strong id="s3-receipt-total">£0.00</strong></div>
              </div>
              <p id="s3-receipt-cash-breakdown" class="s3-receipt-cash-breakdown" hidden></p>
              <p id="s3-receipt-help" class="s3-muted">靠近收银台，逐件扫描后启用刷卡机。</p>
              <button id="s3-open-cash" class="s3-primary-button s3-cash-receipt-action" type="button" hidden disabled>打开现金收银台 <kbd>E</kbd></button>
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
            <p class="s3-start-description">从 30 种商品里挑选你的小店要卖什么。<br>选好数量、门口签收，再亲手摆上货架，迎接街坊的第一笔生意。</p>
            <div class="s3-start-stock"><span><span id="s3-start-capital">£12</span><small id="s3-start-capital-label">首日本金 · 进货会扣钱</small></span><span>09:00–19:00 <small>持续来客 · 打烊后安心收尾</small></span></div>
            <p id="s3-start-note" class="s3-muted">按 B 打开进货清单，商品与数量都由你选择。至少上架一种商品就能迎客；按 M 看看商业街。</p>
            <button id="s3-start-button" class="s3-primary-button" type="button" disabled>开始第一天</button>
            <a id="s3-asset-library-link" class="s3-asset-library-link" href="?assets=1">商品素材库 <span>30 种模型 · 预览与导出 ↗</span></a>
            <p id="s3-readonly-note" class="s3-pause-alert" role="status" hidden></p>
            <button id="s3-takeover" class="s3-secondary-button" type="button" hidden>读取最新进度并尝试接管</button>
            <button id="s3-export-readonly" class="s3-text-button" type="button" hidden>下载本页快照</button>
            <p id="s3-loading" class="s3-loading" role="status">正在载入小店…</p>
            <p id="s3-load-detail" class="s3-error-detail" hidden></p>
            <button id="s3-retry" class="s3-secondary-button" type="button" hidden>重新加载小店</button>
            <p class="s3-start-controls"><kbd>W A S D</kbd> 走动 · <kbd>Shift</kbd> 按住加速 · <kbd>E</kbd> 互动 / 签收<br><kbd>Tab</kbd> 释放鼠标 · <kbd>B</kbd> 进货 · <kbd>M</kbd> 商业街</p>
          </div>
          <p class="s3-start-footer">第一人称街角经营 · 本地语音与存档 · 无需登录或开麦</p>
        </section>

        <section id="s3-inspection" class="s3-inspection" role="dialog" aria-modal="true" aria-labelledby="s3-inspect-word" hidden>
          <div class="s3-inspection-caption">
            <p class="s3-eyebrow">认识手里的实物</p>
            <h2 id="s3-inspect-word">milk</h2><p id="s3-inspect-chinese" class="s3-inspect-chinese">牛奶</p>
            <p id="s3-inspect-phrase" class="s3-inspect-phrase">a carton of milk</p>
            <p id="s3-inspect-phrase-zh" class="s3-inspect-note">一盒牛奶</p>
            <div class="s3-inspect-buttons"><button id="s3-speak-word" class="s3-light-button" type="button">听单词</button><button id="s3-speak-phrase" class="s3-light-button" type="button">听搭配</button></div>
            <p id="s3-speech-status" class="s3-inspect-note" aria-live="polite">观察外形和材质，试着把英文与实物对应。</p>
            <p id="s3-inspect-audio-note" class="s3-inspect-note"></p>
            <p class="s3-inspect-note">这次只记录接触，不计为独立掌握。</p>
          </div>
          <div class="s3-inspection-bottom"><div class="s3-inspection-meta"><span>拖动商品，换个角度看</span><p class="s3-audio-credit">milk / bread 单词录音：Judith Franck / Shtooka · <a href="https://creativecommons.org/licenses/by/3.0/us/" target="_blank" rel="noopener noreferrer">CC BY 3.0 US</a> · <a href="/assets/sim3d/audio/audio-SOURCES.md" target="_blank" rel="noopener noreferrer" aria-label="查看单词发音来源与许可说明">来源</a><br>milk / bread 搭配：<a href="/assets/sim3d/audio/phrase-SOURCES.md" target="_blank" rel="noopener noreferrer" aria-label="查看合成短句来源与许可说明">本地 Cori 合成音频</a>；其他商品：浏览器合成发音<br>顾客：本地男女声 · <a href="/assets/sim3d/audio/customer-phrase-SOURCES.md" target="_blank" rel="noopener noreferrer" aria-label="查看顾客配音来源与许可说明">配音来源</a></p></div><button id="s3-close-inspect" class="s3-glass-button" type="button">返回小店 <kbd>F / Esc</kbd></button></div>
        </section>

        <dialog id="s3-pause" class="s3-pause" aria-labelledby="s3-pause-title">
          <div class="s3-pause-heading"><div><p class="s3-eyebrow">YOUR LITTLE BUSINESS</p><h2 id="s3-pause-title">小店管理</h2></div><button id="s3-resume" class="s3-primary-button" type="button">返回小店</button></div>
          <p class="s3-muted">这里会暂停营业，顾客会等你。返回后鼠标保持可点击；按 Tab 再切回自由转头。</p>
          <p id="s3-pause-alert" class="s3-pause-alert" role="alert" hidden></p>
          <p id="s3-pause-notice" class="s3-pause-notice" role="status" hidden></p>
          <section id="s3-layout-exit-confirm" class="s3-confirm" aria-labelledby="s3-layout-exit-title" hidden><h3 id="s3-layout-exit-title">还有未应用的装修修改</h3><p>当前只是平面图草稿，尚未改变店内设备。可以继续装修并应用，或放弃草稿后离开。</p><div><button id="s3-layout-exit-keep" class="s3-primary-button" type="button">继续装修</button><button id="s3-layout-exit-discard" class="s3-secondary-button" type="button">放弃修改并离开</button></div></section>
          <nav class="s3-management-tabs" aria-label="经营管理分类">
            <button id="s3-tab-supply" type="button" aria-pressed="true">进货</button>
            <button id="s3-tab-day" type="button" aria-pressed="false">营业与日结</button>
            <button id="s3-tab-upgrade" type="button" aria-pressed="false">普通扩容</button>
            <button id="s3-tab-development" type="button" aria-pressed="false">店铺成长</button>
            <button id="s3-tab-layout" type="button" aria-pressed="false">自由装修</button>
            <button id="s3-tab-street" type="button" aria-pressed="false">商业街</button>
          </nav>
          <section id="s3-panel-supply" class="s3-management-panel" aria-labelledby="s3-supply-title">
            <p class="s3-eyebrow">DAILY DOORSTEP DELIVERY</p><h3 id="s3-supply-title">今天的货，送到小店门口</h3>
            <p class="s3-muted">30 种商品自由选购。数量默认为 0，选好后才下单；送货车每天来店门口，签收后还需亲手上架。</p>
            <ol class="s3-delivery-steps" aria-label="进货流程"><li><span>01</span>下单扣款</li><li><span>02</span>门口按 E 签收</li><li><span>03</span>抱箱搬货上架</li></ol>
            <p id="s3-delivery-summary" class="s3-delivery-summary" role="status" aria-live="polite"></p>
            <div class="s3-supply-filters">
              <label class="s3-supply-search-label" for="s3-supply-search"><span>找商品</span><input id="s3-supply-search" type="search" placeholder="搜索中文或英文商品名" autocomplete="off"></label>
              <label for="s3-supply-category"><span>商品分类</span><select id="s3-supply-category"><option value="all">全部分类</option>${PRODUCT_CATEGORIES.map((category) => `<option value="${category.id}">${category.nameZh}</option>`).join("")}</select></label>
            </div>
            <div class="s3-supply-list-tools"><p id="s3-supply-visible" class="s3-muted" role="status"></p><label><input id="s3-supply-selected-only" type="checkbox">仅看已选</label><button id="s3-clear-cart" class="s3-text-button" type="button">清空选择</button></div>
            <div id="s3-supply-catalog" class="s3-supply-catalog" role="group" aria-label="选择进货商品和数量" tabindex="0">
              <p id="s3-supply-empty" class="s3-supply-empty" hidden>没有找到商品。试试其他关键词或分类；已有选择会保留。</p>
              ${PRODUCT_IDS.map((productId) => { const product = PRODUCTS[productId]; return `<article id="s3-supply-product-${productId}" class="s3-supply-product" aria-label="${product.nameZh}">
                <img src="${PRODUCT_ASSETS[productId].thumbnailUrl}" alt="" width="64" height="64" loading="lazy">
                <div class="s3-supply-product-info"><strong>${product.nameZh}</strong><span class="s3-product-en">${product.nameEn}</span><p><span id="s3-supply-inventory-${productId}"></span><span id="s3-supply-pending-${productId}"></span></p></div>
                <div class="s3-supply-product-prices"><span>进价 <strong>${money(product.costPence)}</strong></span><small>售价 ${money(product.pricePence)}</small></div>
                <div class="s3-supply-quantity"><div class="s3-quantity-stepper"><button id="s3-quantity-remove-${productId}" type="button" aria-label="减少${product.nameZh}进货数量">−</button><input id="s3-quantity-${productId}" type="number" min="0" max="${CRATE_CAPACITY}" step="1" inputmode="numeric" value="0" aria-label="${product.nameZh}进货数量" aria-describedby="s3-supply-line-error-${productId}"><button id="s3-quantity-add-${productId}" type="button" aria-label="增加${product.nameZh}进货数量">+</button></div><span id="s3-supply-line-total-${productId}" class="s3-supply-line-total"></span></div>
                <p id="s3-supply-line-error-${productId}" class="s3-supply-line-error" hidden></p>
              </article>` }).join("")}
            </div>
            <div class="s3-supply-checkout">
              <p id="s3-supply-summary" class="s3-supply-summary" aria-live="polite"></p>
              <dl class="s3-account-lines s3-supply-account"><div><dt>现有资金</dt><dd id="s3-supply-cash"></dd></div><div><dt>本次进货</dt><dd id="s3-supply-total"></dd></div><div><dt>下单后余额</dt><dd id="s3-supply-after"></dd></div></dl>
              <p id="s3-supply-error" class="s3-inline-reason" role="status"></p>
              <button id="s3-purchase" class="s3-primary-button" type="button" disabled>先选择商品与数量</button>
              <p class="s3-supply-capacity-note">每种商品箱内和待收货合计最多 ${CRATE_CAPACITY} 件。确认扣款一次，门口签收不再收费。</p>
              <p class="s3-supply-capacity-note">上架后把空箱送到店门旁绿色回收点，按 E 投入。每个新进货空箱回收 ${money(RECYCLING_REWARD_PENCE)}，即投即清，不设容量上限。</p>
            </div>
          </section>
          <section id="s3-panel-day" class="s3-management-panel" aria-labelledby="s3-day-title" hidden>
            <p id="s3-day-eyebrow" class="s3-eyebrow">TODAY AT THE CORNER SHOP</p><h3 id="s3-day-title">今天的小店</h3>
            <p id="s3-day-progress" class="s3-muted"></p>
            <p id="s3-day-clock" class="s3-day-clock"></p>
            <dl class="s3-account-lines"><div><dt>今日营业收入</dt><dd id="s3-day-revenue"></dd></div><div><dt>已售商品成本</dt><dd id="s3-day-cogs"></dd></div><div class="s3-account-result"><dt>商品毛利</dt><dd id="s3-day-profit"></dd></div><div><dt>空箱回收收入</dt><dd id="s3-day-recycling"></dd></div><div><dt>今日进货支出</dt><dd id="s3-day-procurement"></dd></div><div><dt>货架扩容支出</dt><dd id="s3-day-investment"></dd></div><div><dt>店面扩建支出</dt><dd id="s3-day-expansion"></dd></div><div><dt>当前剩余资金</dt><dd id="s3-day-cash"></dd></div><div><dt>未售商品 / 成本价值</dt><dd id="s3-day-inventory"></dd></div></dl>
            <p id="s3-day-recycling-count" class="s3-muted"></p>
            <p class="s3-muted">商品毛利 = 营业收入 − 已售商品成本。回收收入单独记账，投入时即入账，日结不再发一次。进货中尚未卖出的部分仍是存货；扩容是投资，不把钱包余额当利润。</p>
            <p id="s3-day-reason" class="s3-inline-reason" role="status"></p>
            <div class="s3-management-buttons"><button id="s3-close-shop" class="s3-secondary-button" type="button">提前打烊</button><button id="s3-settle-day" class="s3-primary-button" type="button" hidden>完成日结</button><button id="s3-next-day" class="s3-primary-button" type="button" hidden>开始下一天</button><button id="s3-day-to-upgrade" class="s3-secondary-button" type="button">看看 £8 普通扩容</button></div>
            <div id="s3-close-confirm" class="s3-close-confirm" role="group" aria-label="确认提前打烊" hidden>
              <p>今天不再接新顾客或新采购。店里的顾客仍可完成购物，已付款配送仍可签收；收尾后才能日结。确认提前打烊吗？</p>
              <div class="s3-management-buttons"><button id="s3-close-confirm-button" class="s3-primary-button" type="button">确认打烊，开始收尾</button><button id="s3-close-cancel" class="s3-secondary-button" type="button">继续营业</button></div>
            </div>
          </section>
          <section id="s3-panel-upgrade" class="s3-management-panel" aria-labelledby="s3-upgrade-title" hidden>
            <p class="s3-eyebrow">MORE ROOM TO GROW</p><h3 id="s3-upgrade-title">让货架多一层空间</h3>
            <div id="s3-capacity-comparison" class="s3-capacity-comparison"><span><span id="s3-capacity-label">现在</span> <strong id="s3-capacity-now">4</strong> 个 / 每种</span><span id="s3-capacity-arrow" aria-hidden="true">→</span><span id="s3-capacity-next">扩容后 <strong>8</strong> 个 / 每种</span></div>
            <p class="s3-muted">£8 一次性启用各商品陈列区的预留层位。只检查资金，不设英语等级门槛；不会凭空补货，也不是店面扩建。</p>
            <p id="s3-upgrade-status" class="s3-inline-reason" role="status"></p><button id="s3-upgrade" class="s3-primary-button" type="button">£8 · 扩充货架容量</button><span id="s3-upgrade-badge" class="s3-upgrade-badge">£8</span>
          </section>
          <section id="s3-panel-development" class="s3-management-panel" aria-label="店铺成长与成就" hidden><div id="s3-development-host"></div></section>
          <section id="s3-panel-layout" class="s3-management-panel" aria-label="自由装修" hidden><div id="s3-layout-editor"></div></section>
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
          <details class="s3-pause-section"><summary>看看怎么操作</summary><dl class="s3-controls-list"><div><dt>走动 / 观察</dt><dd><kbd>W A S D</kbd> / 鼠标</dd></div><div><dt>按住加速 / 松开恢复</dt><dd><kbd>Shift</kbd>（左右均可）</dd></div><div><dt>签收、拿箱、上架、扫描、收款</dt><dd><kbd>E</kbd> / 鼠标左键</dd></div><div><dt>近看商品 / 返回</dt><dd><kbd>F</kbd></dd></div><div><dt>安全放下货箱 / 放回单品</dt><dd><kbd>G</kbd></dd></div><div><dt>切换可点击鼠标 / 转头</dt><dd><kbd>Tab</kbd></dd></div><div><dt>重听顾客</dt><dd><kbd>R</kbd></dd></div><div><dt>进货 / 普通扩容 / 商业街</dt><dd><kbd>B</kbd> / <kbd>U</kbd> / <kbd>M</kbd></dd></div><div><dt>自由装修 / 布局中旋转</dt><dd><kbd>P</kbd> / <kbd>R</kbd></dd></div><div><dt>暂停与管理</dt><dd><kbd>Esc</kbd></dd></div><div><dt>视角备用按键</dt><dd><kbd>I J K L</kbd></dd></div></dl><p class="s3-muted">先看向物品并走近，再按键操作。鼠标锁定且抱着货箱上架时，单击左键摆放 1 件，按住左键会逐件连续摆放，松开立即停止。也可以释放鼠标后点击底部操作按钮；按钮不会隔空操作。浏览器不允许锁定鼠标时，可按住画面左键拖动视角。</p></details>
          <details class="s3-pause-section"><summary>画面与操作</summary><div class="s3-settings-grid">
            <label for="s3-sensitivity">鼠标灵敏度 <output id="s3-sensitivity-value">1.0</output></label><input id="s3-sensitivity" type="range" min="0.3" max="2" step="0.1" value="1">
            <label for="s3-quality">画质</label><select id="s3-quality"><option value="standard">标准 · 优先细节</option><option value="low">流畅 · 降低渲染负担</option></select>
            <label for="s3-reduced-motion">减少镜头动态</label><input id="s3-reduced-motion" type="checkbox" checked>
          </div></details>
          <details id="s3-sound-settings" class="s3-pause-section"><summary>声音与音乐</summary>
            <p id="s3-music-status" class="s3-muted" role="status" aria-live="polite">背景音乐：Local Forecast · 等待开始</p>
            <div class="s3-settings-grid">
            <label for="s3-music-enabled">循环背景音乐</label><input id="s3-music-enabled" type="checkbox" checked>
            <label for="s3-music-volume">音乐音量 <output id="s3-music-volume-value">22%</output></label><input id="s3-music-volume" type="range" min="0" max="1" step="0.01" value="0.22">
            <label for="s3-effects-volume">操作音效 <output id="s3-effects-volume-value">50%</output></label><input id="s3-effects-volume" type="range" min="0" max="1" step="0.05" value="0.5">
            <label for="s3-volume">发音音量 <output id="s3-volume-value">70%</output></label><input id="s3-volume" type="range" min="0" max="1" step="0.1" value="0.7">
            <label for="s3-auto-speech">顾客自动说话</label><input id="s3-auto-speech" type="checkbox" checked>
          </div><p class="s3-muted">顾客进店、成功上架、扫码和收款各有轻声反馈。播放英语时音乐自动变轻；暂停或切出页面时停声，返回小店后继续循环。操作音效调到 0 即可关闭，不影响英语发音。</p>
          <p class="s3-muted">milk / bread 使用现有单词录音与本地短句音频；其他商品尚未录制，按设备能力使用浏览器合成发音。顾客继续使用本地配音。字幕始终保留，不录音、不要求开麦。</p>
          <p class="s3-muted s3-music-credit">音乐：<a href="https://www.incompetech.com/music/royalty-free/index.html?isrc=USUAN1300010" target="_blank" rel="noopener noreferrer">Local Forecast</a> — Kevin MacLeod（incompetech.com），<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>。原音频未改动，仅在游戏内循环播放并调节音量。</p></details>
          <details class="s3-pause-section"><summary>存档与试玩管理</summary><p id="s3-pause-save" class="s3-muted"></p><div class="s3-management-buttons"><button id="s3-export" class="s3-secondary-button" type="button">下载存档备份</button><button id="s3-import" class="s3-secondary-button" type="button">导入存档备份</button><input id="s3-import-file" type="file" accept="application/json,.json" aria-label="选择本游戏导出的 3D JSON 存档" hidden><button id="s3-cancel-customer" class="s3-secondary-button" type="button">取消本单并归还商品</button><button id="s3-restart" class="s3-text-button" type="button">重新试玩</button></div><p class="s3-muted">导入文件只在本机校验，确认后才替换进度。取消订单只退回尚未付款的商品。</p></details>
          <section id="s3-restart-confirm" class="s3-confirm" aria-labelledby="s3-confirm-title" hidden><h3 id="s3-confirm-title">重新开始这轮试营业？</h3><p>当前 3D 进度会被新一轮替换，上一有效快照会保留为备份。建议先下载存档；旧版 2D 存档不受影响。</p><div><button id="s3-restart-confirm-button" class="s3-danger-button" type="button">确认重新试玩</button><button id="s3-restart-cancel" class="s3-secondary-button" type="button">保留当前进度</button></div></section>
          <section id="s3-import-confirm" class="s3-confirm" aria-labelledby="s3-import-title" hidden><h3 id="s3-import-title">确认导入这份存档？</h3><p id="s3-import-summary"></p><p>会替换当前 3D 进度，覆盖前保留当前有效快照。旧版 2D 存档不变；文件不会上传。</p><div><button id="s3-import-confirm-button" class="s3-primary-button" type="button">确认导入并替换进度</button><button id="s3-import-cancel" class="s3-secondary-button" type="button">保留当前进度</button></div></section>
        </dialog>

        ${cashRegisterMarkup()}

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
    click("s3-open-cash", () => this.openCashRegister());
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
    click("s3-open-layout", () => this.openManagement("layout"));
    click("s3-open-street", () => this.openManagement("street"));
    click("s3-layout-exit-keep", () => this.cancelLayoutExit(true));
    click("s3-layout-exit-discard", () => {
      const destination = this.pendingLayoutExit;
      this.layoutEditor.discard();
      this.cancelLayoutExit(false);
      if (destination === "resume") this.resume(false);
      else if (destination) this.showManagementSection(destination);
    });
    for (const section of MANAGEMENT_SECTIONS) {
      click(`s3-tab-${section}`, () => this.showManagementSection(section));
    }
    for (const venue of STREET_VENUES) {
      click(`s3-venue-${venue.id}`, () => {
        this.selectedVenue = venue.id;
        this.renderStreet();
      });
    }
    for (const productId of PRODUCT_IDS) {
      this.el<HTMLInputElement>(`s3-quantity-${productId}`).addEventListener("input", () => {
        this.setPurchaseQuantity(productId, this.el<HTMLInputElement>(`s3-quantity-${productId}`).value);
      }, { signal });
      for (const [operation, delta] of [["remove", -1], ["add", 1]] as const) {
        click(`s3-quantity-${operation}-${productId}`, () => {
          const raw = this.purchaseQuantities.get(productId) ?? "0";
          if (!/^\d+$/.test(raw)) return;
          const quantity = Number(raw);
          if (Number.isSafeInteger(quantity) && quantity + delta >= 0 && quantity + delta <= CRATE_CAPACITY) {
            this.setPurchaseQuantity(productId, String(quantity + delta));
          }
        });
      }
    }
    this.el<HTMLInputElement>("s3-supply-search").addEventListener("input", () => {
      this.purchaseSearch = this.el<HTMLInputElement>("s3-supply-search").value;
      this.renderSupply();
    }, { signal });
    this.el<HTMLSelectElement>("s3-supply-category").addEventListener("change", () => {
      const category = this.el<HTMLSelectElement>("s3-supply-category").value;
      this.purchaseCategory = PRODUCT_CATEGORIES.find((entry) => entry.id === category)?.id ?? "all";
      this.renderSupply();
    }, { signal });
    this.el<HTMLInputElement>("s3-supply-selected-only").addEventListener("change", () => {
      this.purchaseSelectedOnly = this.el<HTMLInputElement>("s3-supply-selected-only").checked;
      this.renderSupply();
    }, { signal });
    click("s3-clear-cart", () => {
      if (this.mode !== "paused" || !this.saveSession?.canWrite || this.purchaseBusy) return;
      this.purchaseQuantities.clear();
      this.purchaseOrderId = crypto.randomUUID();
      this.renderSupply();
    });
    click("s3-purchase", () => this.purchaseStock());
    click("s3-close-shop", () => {
      if (this.mode !== "paused" || !this.saveSession?.canWrite || !["preparing", "open"].includes(this.state.day.phase)) return;
      this.closeConfirmation = true;
      this.renderManagement();
      this.el("s3-close-cancel").focus();
    });
    click("s3-close-cancel", () => this.cancelCloseConfirmation());
    click("s3-close-confirm-button", () => {
      if (!this.closeConfirmation || this.mode !== "paused") return;
      if (this.dispatch({ type: "CLOSE_STORE" })) {
        this.closeConfirmation = false;
        this.renderManagement();
        this.el(canSettleDay(this.state) ? "s3-settle-day" : "s3-resume").focus();
      }
    });
    click("s3-settle-day", () => this.dispatch({ type: "SETTLE_DAY" }));
    click("s3-next-day", () => {
      if (this.dispatch({ type: "START_NEXT_DAY" })) {
        this.lastCustomerCue = "";
        this.businessClock.reset();
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
    for (const id of ["s3-sensitivity", "s3-quality", "s3-reduced-motion", "s3-volume", "s3-auto-speech", "s3-music-enabled", "s3-music-volume", "s3-effects-volume"]) {
      this.el(id).addEventListener("input", () => this.updateSettings(), { signal });
    }
    window.addEventListener("keydown", (event) => this.onKeyDown(event), { capture: true, signal });
    window.addEventListener("blur", () => {
      this.advanceBusinessTime();
      this.businessClock.reset();
      this.audioForeground = false;
      this.syncShopAudio();
      this.stopSpeech();
      if (this.mode === "cashier") this.cashRegister.close();
      if (this.mode === "playing") this.pause();
    }, { signal });
    window.addEventListener("focus", () => { this.audioForeground = true; this.syncShopAudio() }, { signal });
    document.addEventListener("visibilitychange", () => {
      this.syncShopAudio();
      if (document.hidden) {
        this.businessClock.reset();
        this.stopSpeech();
        if (this.mode === "cashier") this.cashRegister.close();
        if (this.mode === "playing") this.pause();
      }
    }, { signal });
    document.addEventListener("pointerlockchange", () => this.renderCaptureHint(), { signal });
    window.addEventListener("storage", (event) => {
      if (event.key === SIM_STORAGE_KEY && this.saveSession?.observeExternalSnapshot(event.newValue)) this.enterReadOnly(new SimSaveConflictError().message);
    }, { signal });
    window.addEventListener("pagehide", () => {
      this.shopAudio.setActive(false);
      this.savePoseAndPersist();
      this.businessClock.reset();
      this.stopSpeech();
      this.initGeneration += 1;
      this.mode = "readonly";
      this.cashRegister.close();
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
    this.shopAudio.unlock();
    this.syncShopAudio();
    this.world.requestPointerLock();
    this.businessClock.resume(performance.now());
    this.lastPoseSave = performance.now();
    this.capturePose();
    this.persist();
    if (!this.saveSession.canWrite) return;
    this.renderCaptureHint();
    this.notify(this.loadedSession ? "欢迎回来，货物和资金已恢复。待收货订单请到门口签收；B 进货，M 查看商业街。" : "按 B 从 30 种商品中选择数量，确认总价后下单。到门口货车旁按 E 签收，再把想卖的商品上架。");
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
    } else if (decision.cashRegister) this.openCashRegister();
    else if (decision.command) this.dispatch(decision.command);
    else if (decision.message) this.notify(decision.message);
  }

  private canOpenCashRegister(): boolean {
    if (this.mode !== "playing" || !this.ready || !this.saveSession?.canWrite
      || !interactionInReach(this.target) || this.target.kind !== "counter"
      || this.state.customer.phase !== "checkout" || this.state.payment?.method !== "cash") return false;
    const items = this.state.items.filter((item) => item.location.kind === "checkout");
    return items.length > 0 && items.every((item) => this.state.scannedIds.includes(item.id));
  }

  private openCashRegister(): void {
    if (!this.canOpenCashRegister()) return;
    // Preserve the actual counter pose too, so refresh returns to this checkout.
    this.savePoseAndPersist();
    if (!this.saveSession?.canWrite) return;
    if (this.cashRegister.open()) {
      this.text("s3-cash-audio-status", "按 R 重听交款金额，Shift + R 慢速重听；字幕始终保留。");
      const clip = cashTenderSpeechFor(this.state);
      if (this.settings.autoSpeech && clip) this.speak(clip);
    }
  }

  private dropHeld(): void {
    if (this.mode !== "playing") return;
    if (this.state.held.kind === "item") { this.dispatch({ type: "RETURN_ITEM" }); return }
    if (this.state.held.kind !== "crate") { this.notify("手里没有需要放下的货箱。"); return }
    const position = this.world?.getNearestDrop();
    if (position) this.dispatch({ type: "DROP_HELD", position });
    else this.notify(getRecyclingOffer(this.state).allowed
      ? "空箱可送到店门旁的绿色回收点，看向它按 E；想暂放则靠近卸货点按 G。"
      : "走近货箱卸货点再按 G；通道中不能随意放箱，以免挡住顾客。");
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
    this.businessClock.reset();
    this.stopSpeech();
    this.syncShopAudio();
    this.inspecting = productId;
    this.world?.setActive(false);
    this.releasePointer();
    this.world?.inspect(productId);
    this.el("s3-hud").hidden = true;
    this.el("s3-inspection").hidden = false;
    this.text("s3-inspect-word", PRODUCTS[productId].nameEn);
    this.text("s3-inspect-chinese", PRODUCTS[productId].nameZh);
    this.text("s3-inspect-phrase", unitPhrase(productId));
    this.text("s3-inspect-phrase-zh", PRODUCTS[productId].phraseZh);
    this.text("s3-inspect-audio-note", PRODUCT_ASSETS[productId].audio
      ? "本商品可播放现有单词录音与本地搭配音频。"
      : "本商品尚无本地录音。点击发音将尝试浏览器合成语音，效果取决于设备；字幕始终可读。");
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
    this.businessClock.resume(performance.now());
    this.world?.setActive(true);
    this.shopAudio.unlock();
    this.syncShopAudio();
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
    this.businessClock.reset();
    this.syncShopAudio();
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
    if (section !== this.managementSection && this.layoutEditor.hasUnsavedChanges()) {
      this.requestLayoutExit(section);
      return;
    }
    this.cancelLayoutExit(false);
    this.developmentPanel.cancelConfirmation();
    this.managementSection = section;
    this.closeConfirmation = false;
    for (const candidate of MANAGEMENT_SECTIONS) {
      this.el(`s3-panel-${candidate}`).hidden = candidate !== section;
      this.el(`s3-tab-${candidate}`).setAttribute("aria-pressed", String(candidate === section));
    }
    this.renderManagement();
  }

  private requestLayoutExit(destination: ManagementSection | "resume"): void {
    this.pendingLayoutExit = destination;
    this.el("s3-layout-exit-confirm").hidden = false;
    this.el("s3-layout-exit-keep").focus();
  }

  private cancelLayoutExit(focusEditor: boolean): void {
    this.pendingLayoutExit = null;
    this.el("s3-layout-exit-confirm").hidden = true;
    if (focusEditor) this.el("s3-layout-select").focus();
  }

  private cancelCloseConfirmation(): void {
    this.closeConfirmation = false;
    this.renderManagement();
    this.el("s3-close-shop").focus();
  }

  private purchaseStock(): void {
    if (this.mode !== "paused" || this.purchaseBusy) return;
    const selection = parsePurchaseQuantities(this.purchaseQuantities);
    if (selection.error) { this.notify(selection.error); return }
    const offer = getPurchaseOffer(this.state, selection.lines);
    if (!offer.allowed) { this.notify(offer.reason ?? "本次暂时不能进货。"); return }
    this.purchaseOrderId ||= crypto.randomUUID();
    this.purchaseBusy = true;
    this.renderManagement();
    const bought = this.dispatch({ type: "PURCHASE_STOCK", orderId: this.purchaseOrderId, lines: offer.lines });
    this.purchaseBusy = false;
    if (bought) {
      this.purchaseQuantities.clear();
      this.purchaseOrderId = crypto.randomUUID();
    }
    this.renderManagement();
    if (bought) {
      this.resume(false);
      this.notify(`下单成功：${offer.lines.length} 种商品，共 ${offer.unitCount} 件，已扣 ${money(offer.costPence)}。走到门口货车旁按 E 签收，再抱箱上架；签收不再扣款。`);
    }
  }

  private setPurchaseQuantity(productId: ProductId, raw: string): void {
    if (this.mode !== "paused" || !this.saveSession?.canWrite || this.purchaseBusy) return;
    this.purchaseQuantities.set(productId, raw);
    this.purchaseOrderId = crypto.randomUUID();
    this.renderSupply();
  }

  private resume(lockPointer: boolean): void {
    if (this.mode !== "paused") return;
    if (this.pendingLayoutExit) { this.cancelLayoutExit(true); return }
    if (!this.el("s3-extension-confirm").hidden) {
      this.developmentPanel.cancelConfirmation();
      this.el("s3-buy-space").focus();
      return;
    }
    if (this.closeConfirmation) { this.cancelCloseConfirmation(); return }
    if (!this.el("s3-import-confirm").hidden) { this.cancelImport(); this.el("s3-resume").focus(); return }
    if (!this.el("s3-restart-confirm").hidden) {
      this.el("s3-restart-confirm").hidden = true;
      this.el("s3-resume").focus();
      return;
    }
    if (this.layoutEditor.hasUnsavedChanges()) { this.requestLayoutExit("resume"); return }
    try { this.saveSession?.assertCurrent() }
    catch (error) { this.enterReadOnly(error instanceof Error ? error.message : "存档写入权限不可用。"); return }
    this.el<HTMLDialogElement>("s3-pause").close();
    this.mode = "playing";
    this.businessClock.resume(performance.now());
    this.world?.setActive(true);
    this.shopAudio.unlock();
    this.syncShopAudio();
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
      if (event.code === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); this.pause(); return;
      }
      if (event.code === "Tab") {
        event.preventDefault(); event.stopImmediatePropagation();
        this.world?.setCursorFree(this.pointerMode === "locked");
        return;
      }
      if (event.code === "KeyB" || event.code === "KeyU" || event.code === "KeyM" || event.code === "KeyP") {
        event.preventDefault(); event.stopImmediatePropagation();
        this.openManagement(event.code === "KeyB" ? "supply" : event.code === "KeyU" ? "upgrade" : event.code === "KeyP" ? "layout" : "street");
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
      this.advanceBusinessTime();
      if (!this.saveSession.canWrite) return false;
      this.capturePose();
      const result = reduceSim(this.state, command);
      const renovation = command.type === "APPLY_SHOP_LAYOUT" || command.type === "BUY_SPACE_EXPANSION";
      // Keep the draft and the existing room until the entire proposed snapshot
      // is safely stored. A quota failure must not clear the editor or spend cash.
      if (result.changed && renovation && !this.persist(result.state)) return false;
      this.state = result.state;
      if (result.changed) {
        if (command.type === "OPEN_STORE") this.businessClock.resume(performance.now());
        if (command.type === "CLOSE_STORE" || command.type === "START_NEXT_DAY") this.businessClock.reset();
        if (!renovation) this.persist();
        if (!this.saveSession.canWrite) return false;
        this.world?.setState(this.state);
        this.renderState();
        this.syncCustomerCue();
        this.playInteractionSound(command);
      }
      if (showMessage && result.message) this.notify(result.message);
      if (result.changed && ((command.type === "PAY" && command.success) || command.type === "CONFIRM_CASH")) {
        const summary = getDaySummary(this.state);
        const payment = this.state.transactions.find((transaction) => transaction.customerNumber === this.state.customer.number);
        this.notify(`${command.type === "CONFIRM_CASH" ? "现金" : "刷卡"}收款成功 +${money(payment?.amountPence ?? 0)} · 今日 ${summary.paidCustomers} 单。${!this.state.upgraded && this.state.cashPence >= UPGRADE_COST_PENCE ? "按 U 可查看 £8 扩容；注意留足下次进货资金。" : `当前资金 ${money(this.state.cashPence)}。`}`);
      }
      return result.changed;
    } catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return false }
      this.saveError = "本次操作或画面同步遇到问题。请先暂停并下载当前存档备份，再重试；不要继续重复收款。";
      this.renderSaveStatus();
      return false;
    }
  }

  /** Only committed, accepted actions reach here; retries and rejected actions stay silent. */
  private playInteractionSound(command: SimCommand): void {
    let effect: ShopEffect | undefined;
    switch (command.type) {
      case "STOCK": effect = "stock"; break;
      case "SCAN": effect = "scan"; break;
      case "PAY": if (command.success) effect = "payment"; break;
      case "CONFIRM_CASH": effect = "payment"; break;
    }
    if (effect) this.shopAudio.playEffect(effect);
  }

  private capturePose(pose?: PlayerPose): void {
    if (!this.ready || !this.world || this.mode === "inspecting") return;
    const result = reduceSim(this.state, { type: "SAVE_POSE", pose: pose ?? this.world.getPose() });
    if (result.changed) this.state = result.state;
  }

  private savePoseAndPersist(): void {
    if (!this.ready || this.disposed || !this.saveSession?.canWrite) return;
    this.advanceBusinessTime();
    this.capturePose();
    this.persist();
  }

  private persist(snapshot = this.state): boolean {
    if (!this.saveSession?.canWrite) return false;
    let saved = false;
    try {
      this.saveSession.save(snapshot);
      this.saveError = "";
      this.lastSaveText = `已保存 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
      saved = true;
    } catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return false }
      this.saveError = "本次进度尚未保存：浏览器空间或权限不足。请暂停并下载存档备份，勿直接关闭页面。";
      this.lastSaveText = "尚未保存";
    }
    this.renderSaveStatus();
    return saved;
  }

  /** Only time is updated on routine frames; full world/ledger work stays at save and action boundaries. */
  private advanceBusinessTime(now = performance.now()): void {
    const elapsedMs = this.businessClock.sample(now, isBusinessTimeRunning({
      phase: this.state.day.phase, mode: this.mode, writable: !!this.saveSession?.canWrite,
      foreground: this.audioForeground, hidden: document.hidden, learningPlayback: this.learningPlayback,
    }));
    if (elapsedMs > 0) {
      const oldPhase = this.state.day.phase;
      this.state = reduceSim(this.state, { type: "ADVANCE_BUSINESS_TIME", elapsedMs }).state;
      if (oldPhase !== this.state.day.phase) {
        this.businessClock.reset();
        this.persist();
        if (!this.saveSession?.canWrite) return;
        this.world?.setState(this.state);
        this.renderState();
        this.notify("19:00，停止接待新顾客。请安心完成店内订单、签收已付款配送，再日结；当前交易不会被打断。");
      }
    }
    const clock = getBusinessClock(this.state.day);
    if (clock.closingSoon && this.closingWarningDay !== this.state.day.number && !this.learningPlayback
      && (this.mode === "playing" || this.mode === "cashier") && this.audioForeground && !document.hidden) {
      this.closingWarningDay = this.state.day.number;
      this.notify("18:30，距离停止接客还有半个游戏小时。店里的顾客可以在打烊后继续结账。");
    }
    this.renderBusinessClock();
  }

  private onFrame(fps: number, pose: PlayerPose): void {
    const now = performance.now();
    this.advanceBusinessTime(now);
    const active = this.mode === "playing" && !this.learningPlayback && this.audioForeground && !document.hidden && !!this.saveSession?.canWrite;
    if (active && canSettleDay(this.state) && this.dayReadyNotified !== this.state.day.number) {
      this.dayReadyNotified = this.state.day.number;
      this.openManagement("day");
      this.notify("收尾已完成。看看今天的账目，再点击日结；收入不会重复计入。");
    } else if (active && this.state.day.phase === "open" && this.state.customer.phase === "complete"
      && this.state.day.nextCustomerAtMs !== null && this.state.day.elapsedOpenMs >= this.state.day.nextCustomerAtMs
      && canStartCustomer(this.state)) {
      this.dispatch({ type: "NEXT_CUSTOMER" });
    }
    if ((this.mode === "playing" || this.mode === "cashier") && this.audioForeground && !document.hidden && now - this.lastPoseSave >= 5000) {
      this.lastPoseSave = now;
      this.capturePose(pose);
      this.persist();
    }
    if (now - this.lastFpsUpdate >= 1000) {
      this.lastFpsUpdate = now;
      this.text("s3-fps", Number.isFinite(fps) ? `${Math.round(fps)} fps · ${this.settings.quality === "low" ? "流畅" : "标准"}` : "");
    }
  }

  private renderBusinessClock(): void {
    const day = this.state.day;
    const clock = getBusinessClock(day);
    const legacy = day.closeReason === "legacy";
    const paused = day.phase === "open" && !isBusinessTimeRunning({
      phase: day.phase, mode: this.mode, writable: !!this.saveSession?.canWrite,
      foreground: this.audioForeground, hidden: document.hidden, learningPlayback: this.learningPlayback,
    });
    const stateLabel = day.phase === "preparing" ? "准备中" : day.phase === "closing" ? "收尾中" : day.phase === "settled" ? "已日结"
      : paused ? this.learningPlayback ? "学习暂停" : this.mode === "paused" ? "管理暂停" : "计时暂停" : "营业中";
    const note = day.phase === "preparing" ? "开门后开始计时" : day.phase === "closing" ? "不接新客 · 安心完成本单"
      : legacy ? "旧版日结未记录时间" : day.phase === "settled" ? "现金与库存带入次日"
        : this.learningPlayback ? "重听结束后继续" : clock.closingSoon ? "19:00 停止接客" : "09:00—19:00 营业";
    this.text("s3-business-time", legacy ? "—:—" : clock.timeLabel);
    this.text("s3-clock-state", stateLabel);
    this.text("s3-clock-note", note);
    this.el("s3-business-clock").classList.toggle("s3-closing-soon", clock.closingSoon || day.phase === "closing");
    this.el("s3-business-clock").classList.toggle("s3-clock-paused", paused);
    this.text("s3-day-clock", legacy ? "旧版三单营业日 · 未记录营业时间" : `${clock.timeLabel} · ${stateLabel}。${day.phase === "preparing" ? "准备不限时，开门从09:00开始。" : day.phase === "closing" ? `${day.closeReason === "time" ? "已到19:00" : "已提前打烊"}，完成店内订单和签收后日结。` : day.phase === "settled" ? "今天的营业已经结束。" : "19:00停止接客，管理与学习时暂停。"}`);
    this.text("s3-cash-business-clock", `${clock.timeLabel} · ${stateLabel}${day.phase === "closing" ? " · 已停止接新客，本单可以继续完成" : paused ? " · 重听或离开页面时暂停" : " · 正常找零期间营业钟继续"}`);
  }

  private renderObjective(): void {
    this.text("s3-objective", this.state.day.phase === "open" && this.world?.isCustomerApproaching()
      ? "顾客正沿人行道走来，请留出店门和通道。" : getObjective(this.state));
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
      : "按 B 打开进货清单，自己选择商品与数量，再确认总价下单。至少上架一种商品即可迎客；按 M 查看商业街的成长目标。");
    this.text("s3-start-capital", money(this.state.cashPence));
    this.text("s3-start-capital-label", this.loadedSession ? "已保存资金 · 原进度保留" : "首日本金 · 进货会扣钱");
    this.renderObjective();
    this.text("s3-phase", `第 ${this.state.day.number} 天 · ${this.state.day.phase === "settled" ? "已日结" : this.state.day.phase === "preparing" ? "进货与开店" : this.state.day.phase === "closing" ? "打烊收尾" : "营业中"}`);
    this.text("s3-cash", money(this.state.cashPence));
    this.text("s3-sold", `今日 ${day.paidCustomers} 单 · 库存 ${day.remainingStockUnits} 件`);
    this.renderBusinessClock();
    const stockedProducts = PRODUCT_IDS.filter((productId) => countAt(this.state, productId, "shelf") > 0);
    const shelvedUnits = this.state.items.filter((item) => item.location.kind === "shelf").length;
    this.text("s3-shelf-stock", `货架 ${stockedProducts.length} 种 · ${shelvedUnits} 件`);
    this.text("s3-crate-stock", `箱内 ${this.state.items.filter((item) => item.location.kind === "crate").length} 件`);
    this.el("s3-delivery-hud").hidden = delivery.pendingOrders === 0;
    this.text("s3-delivery-hud", delivery.pendingOrders ? `${delivery.pendingUnits} 件待签收 · 门口货车旁按 E` : "");
    this.renderReceipt();
    this.renderTarget();
    this.cashRegister.render();
    this.renderSaveStatus();
    this.renderManagement();
    this.el<HTMLButtonElement>("s3-cancel-customer").disabled = ["outside", "leaving", "complete"].includes(this.state.customer.phase);
    this.el<HTMLInputElement>("s3-sensitivity").value = String(this.settings.sensitivity);
    this.el<HTMLSelectElement>("s3-quality").value = this.settings.quality;
    this.el<HTMLInputElement>("s3-reduced-motion").checked = this.settings.reducedMotion;
    this.el<HTMLInputElement>("s3-volume").value = String(this.settings.volume);
    this.el<HTMLInputElement>("s3-auto-speech").checked = this.settings.autoSpeech;
    this.el<HTMLInputElement>("s3-music-enabled").checked = this.settings.musicEnabled;
    this.el<HTMLInputElement>("s3-music-volume").value = String(this.settings.musicVolume);
    this.el<HTMLInputElement>("s3-effects-volume").value = String(this.settings.effectsVolume);
    this.text("s3-sensitivity-value", this.settings.sensitivity.toFixed(1));
    this.text("s3-volume-value", `${Math.round(this.settings.volume * 100)}%`);
    this.renderSoundSettings();
    this.syncShopAudio();
  }

  private renderManagement(): void {
    const writable = !!this.saveSession?.canWrite;
    const day = getDaySummary(this.state);
    const delivery = getDeliverySummary(this.state);
    this.el("s3-pause").classList.toggle("s3-pause-street", this.managementSection === "street");
    this.el("s3-pause").classList.toggle("s3-pause-supply", this.managementSection === "supply");
    this.el("s3-pause").classList.toggle("s3-pause-development", this.managementSection === "development");
    this.el("s3-pause").classList.toggle("s3-pause-layout", this.managementSection === "layout");
    for (const candidate of MANAGEMENT_SECTIONS) {
      this.el(`s3-panel-${candidate}`).hidden = candidate !== this.managementSection;
    }
    this.renderSupply();
    this.text("s3-day-title", `第 ${day.dayNumber} 天${this.state.day.phase === "settled" ? " · 日结完成" : " · 营业账本"}`);
    this.text("s3-day-progress", `已收款 ${day.paidCustomers} 单 · 开始时资金 ${money(day.openingCashPence)}`);
    this.renderBusinessClock();
    for (const [suffix, value] of [["revenue", day.revenuePence], ["cogs", day.costOfGoodsPence], ["profit", day.grossProfitPence], ["recycling", day.recyclingIncomePence], ["procurement", day.procurementPence], ["investment", day.upgradeSpendPence], ["expansion", day.expansionSpendPence], ["cash", day.closingCashPence]] as const) {
      this.text(`s3-day-${suffix}`, money(value));
    }
    const recycling = getRecyclingSummary(this.state);
    this.text("s3-day-recycling-count", `今日回收 ${recycling.recycledToday} 箱 · 店门旁回收点按 E 投入，无容量上限。新进货空箱每箱 ${money(RECYCLING_REWARD_PENCE)}，同批来源不重复奖励。`);
    this.text("s3-day-inventory", `${day.remainingStockUnits} 件 / ${money(day.remainingInventoryValuePence)}`);
    const settled = this.state.day.phase === "settled";
    const closing = this.state.day.phase === "closing";
    const canSettle = canSettleDay(this.state);
    this.text("s3-day-reason", settled ? "今天的账已记好。下一天会保留资金、库存与扩容，不补发本金。零单日可以结束，但不计入有效经营日成就。" : delivery.pendingUnits > 0 ? `还有 ${delivery.pendingUnits} 件已付款商品待签收。请返回门口货车旁签收；打烊后仍可签收，完成收尾后才能日结。` : canSettle ? `收尾已完成，今天共收款 ${day.paidCustomers} 单。可以日结了，资金不会重复入账。` : closing ? this.state.customer.phase === "leaving" ? "最后一位顾客正在离店。请返回小店让顾客走完，再完成日结。" : "已停止接新客。请返回小店完成当前订单，或在存档与试玩管理中安全取消，再日结。" : this.state.day.phase === "preparing" ? "按 B 自选商品并签收，上架后到营业牌开门。准备时间不限；今天不营业也可以确认结束准备。" : "19:00 停止接客，营业期间没有三单上限。可以继续补货经营，也可以确认提前打烊。打开管理面板时营业钟暂停。");
    if (closing || settled) this.closeConfirmation = false;
    this.el("s3-close-shop").hidden = closing || settled;
    this.el<HTMLButtonElement>("s3-close-shop").disabled = !writable;
    this.text("s3-close-shop", this.state.day.phase === "preparing" ? "今天不营业，结束准备" : "提前打烊");
    this.el("s3-close-confirm").hidden = !this.closeConfirmation;
    this.el<HTMLButtonElement>("s3-close-confirm-button").disabled = !writable || !this.closeConfirmation;
    this.el("s3-settle-day").hidden = !closing;
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
    this.text("s3-upgrade-status", this.state.upgraded ? "各商品陈列区的新层位已经启用，不会再次扣钱。去店里看看，也可以继续备货。" : availableUpgrade ? `资金足够。购买后剩 ${money(this.state.cashPence - UPGRADE_COST_PENCE)}；请为自选商品进货留一些资金。不需要答题解锁。` : `当前 ${money(this.state.cashPence)}，还差 ${money(UPGRADE_COST_PENCE - this.state.cashPence)}。只检查资金，不要求英语等级。`);
    this.el("s3-open-upgrade").classList.toggle("s3-upgrade-ready", availableUpgrade);
    this.el("s3-open-upgrade").setAttribute("aria-label", this.state.upgraded ? "货架已扩容，查看详情 U" : availableUpgrade ? "资金足够，查看扩容 U" : "查看扩容条件 U");
    this.el("s3-open-day").classList.toggle("s3-upgrade-ready", canSettle);
    this.renderStreet();
    this.developmentPanel.render(this.state, writable && this.mode === "paused");
    const reason = !writable ? "此页面只读，不能修改设备布局。" : shopRenovationReason(this.state);
    this.layoutEditor.setState(this.state.renovation.layout, {
      editable: writable && this.mode === "paused" && !reason,
      reason,
      obstacles: getShopLayoutObstacles(this.state),
    });
  }

  private renderSupply(): void {
    const writable = !!this.saveSession?.canWrite;
    const editable = writable && this.mode === "paused" && !this.purchaseBusy;
    const selection = parsePurchaseQuantities(this.purchaseQuantities);
    const invalidIds = new Set(selection.invalidProductIds);
    const selectedIds = new Set(selection.lines.map((line) => line.productId));
    const offer = getPurchaseOffer(this.state, selection.lines);
    const delivery = getDeliverySummary(this.state);
    const needle = this.purchaseSearch.trim().toLocaleLowerCase();
    let visibleCount = 0;
    for (const productId of PRODUCT_IDS) {
      const product = PRODUCTS[productId];
      const raw = this.purchaseQuantities.get(productId) ?? "0";
      const quantity = Number(raw);
      const invalid = invalidIds.has(productId);
      const selected = selectedIds.has(productId);
      const visible = (this.purchaseCategory === "all" || product.category === this.purchaseCategory)
        && (!needle || `${productId} ${product.nameZh} ${product.nameEn} ${product.phraseEn}`.toLocaleLowerCase().includes(needle))
        && (!this.purchaseSelectedOnly || selected || invalid);
      const row = this.el(`s3-supply-product-${productId}`);
      row.hidden = !visible;
      row.classList.toggle("s3-supply-product-selected", selected);
      if (visible) visibleCount += 1;
      const available = this.state.items.filter((item) => item.productId === productId && item.location.kind !== "sold" && item.location.kind !== "delivery").length;
      const pending = countAt(this.state, productId, "delivery");
      this.text(`s3-supply-inventory-${productId}`, `现货 ${available} · 架上 ${countAt(this.state, productId, "shelf")}`);
      this.text(`s3-supply-pending-${productId}`, `待收 ${pending}`);
      const input = this.el<HTMLInputElement>(`s3-quantity-${productId}`);
      if (input.value !== raw) input.value = raw;
      input.disabled = !editable;
      input.setAttribute("aria-invalid", String(invalid));
      this.el<HTMLButtonElement>(`s3-quantity-remove-${productId}`).disabled = !editable || invalid || quantity <= 0;
      this.el<HTMLButtonElement>(`s3-quantity-add-${productId}`).disabled = !editable || invalid || quantity >= CRATE_CAPACITY;
      this.text(`s3-supply-line-total-${productId}`, invalid ? "数量待修正" : selected ? `小计 ${money(quantity * product.costPence)}` : "未选择");
      const itemOffer = selected ? getPurchaseOffer(this.state, [{ productId, quantity }]) : null;
      const error = invalid ? `请填写 0–${CRATE_CAPACITY} 的整数，0 表示不进货。` : itemOffer && !itemOffer.allowed ? itemOffer.reason ?? "当前数量无法进货。" : "";
      this.text(`s3-supply-line-error-${productId}`, error);
      this.el(`s3-supply-line-error-${productId}`).hidden = !error;
    }
    this.el("s3-supply-empty").hidden = visibleCount > 0;
    this.text("s3-supply-empty", this.purchaseSelectedOnly && !selection.lines.length && !selection.invalidProductIds.length
      ? "还没有选中的商品。取消“仅看已选”，就能继续挑选。"
      : "没有找到商品。试试其他关键词或分类；已有选择会保留。");
    this.text("s3-supply-visible", `显示 ${visibleCount} / ${PRODUCT_IDS.length} 种商品 · 筛选不清空选择`);
    this.text("s3-supply-cash", money(this.state.cashPence));
    this.text("s3-supply-total", selection.error ? "请先修正数量" : `−${money(offer.costPence)}`);
    this.text("s3-supply-after", selection.error ? "—" : this.state.cashPence < offer.costPence ? `还差 ${money(offer.costPence - this.state.cashPence)}` : money(this.state.cashPence - offer.costPence));
    this.text("s3-supply-summary", `${selection.lines.length ? `已选 ${selection.lines.length} 种商品 · 共 ${offer.unitCount} 件` : "尚未选择商品 · 共 0 件"}${selection.error ? ` · ${selection.invalidProductIds.length} 项数量待修正` : ""}`);
    this.text("s3-supply-error", selection.error ?? offer.reason ?? "请核对商品、数量与总价。提交后到门口签收，再把商品搬上货架。");
    this.el<HTMLButtonElement>("s3-purchase").disabled = !editable || !!selection.error || !offer.allowed;
    this.text("s3-purchase", this.purchaseBusy ? "正在下单…" : selection.error ? "请先修正商品数量" : selection.lines.length ? `确认下单 · ${money(offer.costPence)}` : "先选择商品与数量");
    this.el<HTMLButtonElement>("s3-clear-cart").disabled = !editable || (!selection.lines.length && !selection.invalidProductIds.length);
    this.text("s3-delivery-summary", delivery.pendingOrders
      ? `${delivery.pendingOrders} 笔已付款订单 · ${delivery.pendingUnits} 件待签收。${delivery.canReceive ? "返回场景，空手走到门口货车旁按 E 卸货。" : delivery.reason ?? "返回场景后到门口签收。"}`
      : delivery.receivedToday ? `今日已签收 ${delivery.receivedToday} 笔订单。需要补货时可再次自选商品下单，继续到车旁签收。`
        : `第 ${this.state.day.number} 天配送已就绪。选择数量前不会产生订单，浏览与筛选都不扣款。`);
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
    const recycling = inReach && target.kind === "recycling" ? getRecyclingOffer(this.state) : null;
    this.text("s3-target-action", recycling
      ? recycling.allowed ? `回收空箱${recycling.rewardPence ? ` +${money(recycling.rewardPence)}` : " · 不重复奖励"}` : recycling.reason ?? "抱起空箱后回收"
      : delivery ? delivery.pendingOrders ? `签收 ${delivery.pendingUnits} 件送货` : "查看今日进货单" : inReach ? target.action : "走近物品后互动");
    this.el<HTMLButtonElement>("s3-interact").disabled = !inReach;
    this.el<HTMLButtonElement>("s3-open-cash").disabled = !this.canOpenCashRegister();
    this.el<HTMLButtonElement>("s3-inspect-button").disabled = this.inspectableProduct() === null;
    this.el("s3-reticle").classList.toggle("s3-reticle-active", inReach);
    const held = this.state.held;
    this.el("s3-held").hidden = held.kind === "none";
    this.el("s3-drop-button").hidden = held.kind === "none";
    this.text("s3-drop-label", held.kind === "item" ? "放回" : "安全放箱");
    if (held.kind === "crate") {
      const crate = this.state.crates.find((candidate) => candidate.id === held.crateId);
      const count = this.state.items.filter((item) => item.location.kind === "crate" && item.location.crateId === held.crateId).length;
      this.text("s3-held", count > 0 ? `手中 · ${crate ? PRODUCTS[crate.productId].nameZh : "商品"}箱 · 剩余 ${count} 件`
        : "手中 · 空纸箱 · 送到店门旁绿色回收点，按 E 回收");
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
    const approaching = this.world?.isCustomerApproaching() ?? false;
    const receipt = this.el<HTMLDetailsElement>("s3-receipt");
    receipt.hidden = !atCheckout && !showPaid && !shopping;
    if (atCheckout && this.receiptCustomer !== this.state.customer.number) { receipt.open = true; this.receiptCustomer = this.state.customer.number }
    this.text("s3-receipt-title", showPaid ? "本单已收款" : atCheckout ? "顾客想结账" : approaching ? "顾客正从街上走来" : "顾客进店了");
    this.text("s3-receipt-state", showPaid ? "实收" : "应收");
    const total = transaction?.amountPence ?? getCheckoutTotal(this.state);
    this.text("s3-receipt-summary", shopping ? approaching ? "即将进店" : "听听问候" : money(total));
    this.text("s3-receipt-total", money(total));
    const method = showPaid ? transaction?.paymentMethod : this.state.payment?.method;
    this.el("s3-payment-method").hidden = !method;
    this.el("s3-payment-method").setAttribute("data-method", method ?? "");
    this.text("s3-payment-method", method === "cash" ? "现金付款 · CASH" : "刷卡付款 · CARD");
    this.el("s3-receipt-cash-breakdown").hidden = !showPaid || method !== "cash";
    this.text("s3-receipt-cash-breakdown", showPaid && transaction?.paymentMethod === "cash"
      ? `交付 ${money(transaction.tenderedPence)} · 找零 ${money(transaction.changePence)} · 本单入账 ${money(transaction.amountPence)}` : "");
    this.el("s3-receipt-items").hidden = !atCheckout && !showPaid;
    const receiptItems = transaction && showPaid
      ? this.state.items.filter((item) => transaction.itemIds.includes(item.id))
      : this.state.items.filter((item) => item.location.kind === "checkout");
    for (const productId of PRODUCT_IDS) {
      const items = receiptItems.filter((item) => item.productId === productId);
      const scanned = items.length > 0 && (showPaid || items.every((item) => this.state.scannedIds.includes(item.id)));
      this.el(`s3-receipt-line-${productId}`).hidden = items.length === 0;
      this.text(`s3-receipt-count-${productId}`, `${PRODUCTS[productId].nameZh} × ${items.length}`);
      this.text(`s3-receipt-price-${productId}`, money(items.length * PRODUCTS[productId].pricePence));
      this.text(`s3-scan-${productId}`, scanned ? "已扫描" : "未扫描");
      this.el(`s3-scan-${productId}`).classList.toggle("s3-scanned", scanned);
    }
    const order = showPaid ? [...new Set(receiptItems.map((item) => item.productId))] : getCustomerOrder(this.state);
    const shoppingProduct = getShoppingProduct(this.state);
    this.text("s3-customer-order", order.length ? `${showPaid ? "本单商品" : "购物清单"}：${order.map((productId) => PRODUCTS[productId].nameZh).join("、")}` : "");
    const profile = customerProfileFor(this.state);
    this.text("s3-customer-name", `${profile.name} · 第 ${this.state.customer.number} 位顾客`);
    this.customerClip = customerSpeechFor(this.state, showPaid ? "thanks" : atCheckout ? "checkout" : "greeting");
    const clip = this.customerClip;
    this.text("s3-customer-line", `“${clip.text}”`);
    this.text("s3-customer-zh", clip.zh);
    this.el("s3-repeat-customer").hidden = !atCheckout;
    const allScanned = receiptItems.length > 0 && receiptItems.every((item) => this.state.scannedIds.includes(item.id));
    const cash = this.state.payment?.method === "cash" ? this.state.payment : null;
    this.el("s3-open-cash").hidden = !atCheckout || !allScanned || !cash;
    this.text("s3-open-cash", cash?.received ? "继续找零 · E" : "打开现金收银台 · E");
    this.text("s3-receipt-help", showPaid ? "金额已入账，不会重复收费。可在营业账本中查看今天的收支。" : shopping ? `${shoppingProduct ? `顾客正在找 ${PRODUCTS[shoppingProduct].nameEn} / ${PRODUCTS[shoppingProduct].nameZh}。` : "顾客选好商品，正在走向收银台。"}R 可重听；Tab 释放鼠标。` : allScanned
      ? cash ? `${cash.received ? `已暂收 ${money(cash.tenderedPence)}，本单尚未入账。` : `本单 ${receiptItems.length} 件商品全部已扫描。`}看向身边的收银台按 E ${cash.received ? "继续找零" : "收下现金并找零"}。`
        : `本单 ${receiptItems.length} 件商品全部已扫描。靠近收银台按 E 启用刷卡机。`
      : `本单 ${receiptItems.length} 件商品，请在收银台内侧按 E 逐件扫描。鼠标已释放，可点击重听。`);
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
    this.text("s3-drag-hint", this.pointerMode === "locked" ? "Tab 释放鼠标 · Shift 按住加速 · R 重听 · B 进货 · M 商业街" : "鼠标可点击 · 按住画面拖动观察 · Shift 按住加速 · M 商业街");
    this.renderBusinessClock();
  }

  private enterReadOnly(message: string): void {
    this.saveSession?.release();
    this.businessClock.reset();
    this.shopAudio.setActive(false);
    this.stopSpeech();
    this.writerWarning = message;
    this.lastSaveText = "只读 · 本页已停止写入";
    this.mode = "readonly";
    this.cashRegister.close();
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
        musicEnabled: input.musicEnabled !== false,
        musicVolume: typeof input.musicVolume === "number" && Number.isFinite(input.musicVolume) ? clamp(input.musicVolume, 0, 1) : DEFAULT_SETTINGS.musicVolume,
        effectsVolume: typeof input.effectsVolume === "number" && Number.isFinite(input.effectsVolume) ? clamp(input.effectsVolume, 0, 1) : DEFAULT_SETTINGS.effectsVolume,
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
      musicEnabled: this.el<HTMLInputElement>("s3-music-enabled").checked,
      musicVolume: clamp(Number(this.el<HTMLInputElement>("s3-music-volume").value), 0, 1),
      effectsVolume: clamp(Number(this.el<HTMLInputElement>("s3-effects-volume").value), 0, 1),
    };
    this.applySettings();
    this.text("s3-sensitivity-value", this.settings.sensitivity.toFixed(1));
    this.text("s3-volume-value", `${Math.round(this.settings.volume * 100)}%`);
    this.renderSoundSettings();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); this.settingsWarning = "" }
    catch { this.settingsWarning = "设置已在本局生效，但暂时无法保存到浏览器。" }
    this.renderSaveStatus();
  }

  private applySettings(): void {
    this.world?.setSensitivity(this.settings.sensitivity);
    this.world?.setQuality(this.settings.quality);
    this.world?.setReducedMotion(this.settings.reducedMotion);
    this.shopAudio.setSettings(this.settings);
    this.syncShopAudio();
  }

  private renderSoundSettings(): void {
    this.text("s3-music-volume-value", `${Math.round(this.settings.musicVolume * 100)}%`);
    this.text("s3-effects-volume-value", `${Math.round(this.settings.effectsVolume * 100)}%`);
  }

  private syncShopAudio(): void {
    this.shopAudio.setActive(!this.disposed && this.ready && !!this.saveSession?.canWrite
      && this.audioForeground && !document.hidden && (this.mode === "playing" || this.mode === "inspecting" || this.mode === "cashier"));
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
    if (this.world?.isCustomerApproaching()) {
      this.text("s3-customer-audio-status", "顾客正在走近，进店后会打招呼。");
      return;
    }
    const phase = this.state.customer.phase;
    if ((phase === "leaving" || phase === "complete") && !this.state.transactions.some((sale) => sale.customerNumber === this.state.customer.number)) return;
    const cue = `${this.state.customer.number}:${this.customerClip.id}`;
    if (cue === this.lastCustomerCue) return;
    this.lastCustomerCue = cue;
    this.el<HTMLDetailsElement>("s3-receipt").open = true;
    if (phase === "checkout") this.world?.setCursorFree(true);
    if (this.settings.autoSpeech && phase !== "complete") this.speak(this.customerClip);
    else this.text("s3-customer-audio-status", "点击重听或按 R 播放，字幕始终保留。");
  }

  private replayCustomer(): void {
    if (this.mode !== "playing") return;
    if (this.el("s3-receipt").hidden) { this.notify("顾客进店后，按 R 就能重听刚刚的话。"); return }
    this.el<HTMLDetailsElement>("s3-receipt").open = true;
    const clip = this.customerClip;
    this.text("s3-customer-line", `“${clip.text}”`);
    this.text("s3-customer-zh", clip.zh);
    this.speak(clip, 1, undefined, true);
  }

  private repeatCustomer(): void {
    if (this.mode !== "playing" || this.state.customer.phase !== "checkout") return;
    const number = this.state.customer.number;
    const reply = this.customerClip;
    const request = SPEECH_CLIPS.repeatRequest;
    this.text("s3-customer-line", `你：“${request.text}”`);
    this.text("s3-customer-zh", request.zh);
    this.speak(request.text, 1, () => {
      if (this.mode !== "playing" || this.state.customer.phase !== "checkout" || this.state.customer.number !== number) return;
      this.text("s3-customer-line", `顾客：“${reply.text}”`);
      this.text("s3-customer-zh", `${reply.zh} · 这次慢一点说`);
      this.speak(reply, 0.84, undefined, true);
    }, true);
  }

  private setLearningPlayback(active: boolean): void {
    if (active === this.learningPlayback) return;
    if (active) this.advanceBusinessTime();
    this.learningPlayback = active;
    if (active) this.businessClock.reset();
    else this.businessClock.resume(performance.now());
    if (this.mode === "playing" && !this.disposed) {
      this.world?.setActive(!active && !!this.saveSession?.canWrite && this.audioForeground && !document.hidden);
    }
    this.renderBusinessClock();
  }

  private speak(input: string | CustomerSpeechClip, rate = 1, onDone?: () => void, learning = false): void {
    const text = typeof input === "string" ? input : input.text;
    const report = (message: string): void => {
      if (this.mode === "inspecting") this.text("s3-speech-status", message);
      else if (this.mode === "cashier") this.text("s3-cash-audio-status", message);
      else this.text("s3-customer-audio-status", message);
    };
    this.stopSpeech();
    if (this.settings.volume === 0) { report("发音音量当前为 0，可以在暂停设置中调高。"); return }
    this.setLearningPlayback(learning);
    const generation = this.speechGeneration;
    const liveReport = (message: string): void => {
      if (!this.disposed && generation === this.speechGeneration) report(message);
    };
    const word = typeof input === "string" && (text === "milk" || text === "bread");
    const normalize = (value: string): string => value.toLowerCase().replace(/[.!?]/g, "").trim();
    // NPC captions and audio are one selection. Never look up a new customer's
    // text in the legacy female-only clips, even when the sentence is identical.
    const clip = typeof input === "string"
      ? Object.values(SPEECH_CLIPS).find((candidate) => normalize(candidate.text) === normalize(text))
      : input;
    if (!word && !clip) {
      this.speakWithBrowser(text, rate, generation, liveReport, onDone, learning);
      return;
    }
    const audio = this.el<HTMLAudioElement>("s3-word-audio");
    let started = false;
    let failed = false;
    const fail = (): void => {
      if (this.disposed || generation !== this.speechGeneration || failed) return;
      failed = true;
      this.shopAudio.setSpeechActive(false);
      this.setLearningPlayback(false);
      if (this.speechTimer) clearTimeout(this.speechTimer);
      liveReport(word ? "这段单词发音未能播放，请重试；商品文字和操作不受影响。" : "语音未能播放。点击“重听”或按 R 再试，并检查浏览器与设备声音；字幕和收款仍可用。");
    };
    audio.onplaying = () => {
      if (failed || this.disposed || generation !== this.speechGeneration) return;
      started = true;
      this.shopAudio.setSpeechActive(true);
      this.setLearningPlayback(learning);
      if (this.speechTimer) clearTimeout(this.speechTimer);
      liveReport(word ? `正在播放英式发音：${text}` : `正在播放${rate < 1 ? "慢速" : "英式"}语音：${text}`);
    };
    audio.onended = () => {
      if (this.disposed || generation !== this.speechGeneration || !started || failed) return;
      this.shopAudio.setSpeechActive(false);
      this.setLearningPlayback(false);
      liveReport(word ? `已播放英式发音：${text}。可以再听一次。` : "语音播放结束，可以点击重听或按 R 再听一次。");
      onDone?.();
    };
    audio.onpause = () => {
      // A queued pause from the previous source can arrive after a replay starts.
      if (this.disposed || generation !== this.speechGeneration || !started || failed || !audio.paused) return;
      this.shopAudio.setSpeechActive(false);
      this.setLearningPlayback(false);
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
    this.speechTimer = setTimeout(() => {
      if (!this.disposed && generation === this.speechGeneration && !started && !failed) {
        this.setLearningPlayback(false);
        liveReport("语音还未开始，营业计时已恢复。请点击重听并检查设备声音。");
      }
    }, 4000);
    try { void audio.play().catch(fail) }
    catch { fail() }
  }

  private speakWithBrowser(text: string, rate: number, generation: number, report: (message: string) => void, onDone?: () => void, learning = false): void {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      this.setLearningPlayback(false);
      report("本商品尚无本地录音，当前浏览器也不支持合成发音。可继续查看英文、中文与搭配，操作不受影响。");
      return;
    }
    const synthesis = window.speechSynthesis;
    let started = false;
    let failed = false;
    const current = (): boolean => !this.disposed && generation === this.speechGeneration;
    const fail = (): void => {
      if (!current() || failed) return;
      failed = true;
      this.shopAudio.setSpeechActive(false);
      this.setLearningPlayback(false);
      if (this.speechTimer) clearTimeout(this.speechTimer);
      report("浏览器合成发音未能播放；本商品尚无本地录音。请重试或继续阅读字幕。");
    };
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      this.synthesisUtterance = utterance;
      const voices = synthesis.getVoices();
      const voice = voices.find((entry) => entry.lang.toLowerCase() === "en-gb") ?? voices.find((entry) => entry.lang.toLowerCase().startsWith("en"));
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? "en-GB";
      utterance.rate = clamp(rate, 0.5, 1.5);
      utterance.volume = this.settings.volume;
      utterance.onstart = () => {
        if (!current() || failed) return;
        started = true;
        this.shopAudio.setSpeechActive(true);
        this.setLearningPlayback(learning);
        if (this.speechTimer) clearTimeout(this.speechTimer);
        report(`正在播放浏览器合成发音：${text}（非本地录音）`);
      };
      utterance.onend = () => {
        if (!current() || !started || failed) return;
        this.synthesisUtterance = null;
        this.shopAudio.setSpeechActive(false);
        this.setLearningPlayback(false);
        report("浏览器合成发音结束，可以再听一次。声音由当前设备提供。");
        onDone?.();
      };
      utterance.onerror = fail;
      report("本商品尚无本地录音，正在尝试浏览器合成发音…");
      this.speechTimer = setTimeout(() => {
        if (current() && !started && !failed) {
          this.setLearningPlayback(false);
          report("浏览器合成发音尚未开始，营业计时已恢复。请重试；设备可能没有可用的英语声音，字幕仍可阅读。");
        }
      }, 4000);
      synthesis.speak(utterance);
    } catch { fail() }
  }

  private stopSpeech(): void {
    this.speechGeneration += 1;
    this.setLearningPlayback(false);
    this.shopAudio.setSpeechActive(false);
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = undefined;
    if (this.synthesisUtterance) {
      this.synthesisUtterance.onstart = null;
      this.synthesisUtterance.onend = null;
      this.synthesisUtterance.onerror = null;
      this.synthesisUtterance = null;
      try { window.speechSynthesis?.cancel() }
      catch { /* A missing or unavailable device voice must not block returning to the shop. */ }
    }
    const audio = this.root.querySelector<HTMLAudioElement>("#s3-word-audio");
    if (audio) {
      const wasPlaying = !audio.paused;
      audio.onplaying = null;
      audio.onended = null;
      audio.onpause = null;
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
    this.purchaseQuantities.clear();
    this.purchaseOrderId = "";
    this.loadedSession = true;
    this.saveError = "";
    this.loadWarning = "";
    this.target = null;
    this.receiptCustomer = 0;
    this.lastCustomerCue = "";
    this.dayReadyNotified = 0;
    this.businessClock.reset();
    this.closingWarningDay = 0;
    this.closeConfirmation = false;
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
    const fresh = { ...createFirstDayState(), customerSeed: createCustomerSeed() };
    try { this.saveSession.save(this.state); this.saveSession.save(fresh) }
    catch (error) {
      if (error instanceof SimSaveConflictError) { this.enterReadOnly(error.message); return }
      this.saveError = "新一轮暂时无法安全保存，已保留当前进度。请先下载备份并检查浏览器存储权限。";
      this.renderSaveStatus();
      return;
    }
    this.state = fresh;
    this.layoutEditor.setState(fresh.renovation.layout, { editable: false, resetDraft: true });
    this.cancelLayoutExit(false);
    this.purchaseQuantities.clear();
    this.purchaseOrderId = "";
    this.loadedSession = false;
    this.target = null;
    this.receiptCustomer = 0;
    this.lastCustomerCue = "";
    this.dayReadyNotified = 0;
    this.businessClock.reset();
    this.closingWarningDay = 0;
    this.closeConfirmation = false;
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
    this.cashRegister.close();
    this.stopSpeech();
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
    this.cashRegister.close();
    this.initGeneration += 1;
    this.events.abort();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.stopSpeech();
    this.shopAudio.dispose();
    this.layoutEditor.dispose();
    this.developmentPanel.dispose();
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
