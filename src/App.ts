import { buyerTask, customers, previewCards, products, skillLabels } from "./content/dayOne";
import {
  advanceHint,
  applySkillAttempt,
  applyTransaction,
  calculateSettlement,
  canUnlockUpgrade,
  formatMoney,
  gradeSemanticOrder,
  gradeSlots,
} from "./domain/rules";
import type {
  AppPhase,
  CustomerTask,
  GameState,
  ResponseOption,
  SkillId,
  SlotMap,
  SupportMode,
  TransactionRecord,
} from "./domain/types";
import type {
  StoreGameController,
  StoreInteraction,
  StoreProductView,
} from "./game/createStoreGame";
import { SaveRepository } from "./services/saveRepository";
import { createInitialState } from "./state/createInitialState";
import {
  levelLabels,
  phaseLabels,
  queryRequired,
  topbar,
  viewportWarning,
} from "./ui/viewHelpers";

interface StoreSession {
  task: CustomerTask;
  stage: "waiting" | "order" | "pickup" | "counter" | "checkout";
  orderAttempts: number;
  orderHintLevel: number;
  orderFirstCorrect: boolean;
  checkoutAttempts: number;
  checkoutHintLevel: number;
  checkoutFirstCorrect: boolean;
  repairHintLevel: number;
  repairAttempted: boolean;
  repairSuccessful: boolean;
  replayCount: number;
}

interface PracticeQuestion {
  prompt: string;
  options: Array<{ id: string; label: string }>;
  correctId: string;
}

const UPGRADE_COST_PENCE = 500;
const REQUIRED_SKILL_COUNT = 3;
const waterProduct = (() => {
  const product = products.water;
  if (!product) {
    throw new Error("Day 1 content is missing the water product.");
  }
  return product;
})();

export class App {
  private readonly repository = new SaveRepository();
  private state: GameState = createInitialState();
  private resumePhase: AppPhase | null = null;
  private world: StoreGameController | null = null;
  private storeSession: StoreSession | null = null;
  private selectedChipIds: string[] = [];
  private buyerAttempts = 0;
  private buyerHintLevel = 0;
  private buyerReady = false;
  private buyerFeedback = "";
  private toastTimer: number | null = null;
  private practiceSkill: SkillId | null = null;
  private practiceAttempts = 0;
  private practiceRound = 0;
  private practiceFeedback = "";

  constructor(private readonly root: HTMLElement) {}

  async init(): Promise<void> {
    const saved = await this.repository.load();
    if (saved) {
      this.state = saved;
      this.resumePhase = saved.phase === "landing" ? "onboarding" : saved.phase;
      this.state = { ...saved, phase: "landing" };
    }

    this.render();
  }

  private render(): void {
    this.destroyWorld();
    this.root.style.setProperty("--font-scale", String(this.state.settings.fontScale));

    switch (this.state.phase) {
      case "landing":
        this.renderLanding();
        break;
      case "onboarding":
        this.renderOnboarding();
        break;
      case "preview":
        this.renderPreview();
        break;
      case "buyer":
        this.renderBuyerTask();
        break;
      case "restock":
      case "store":
        this.renderStore();
        break;
      case "settlement":
        this.renderSettlement();
        break;
      case "upgrade":
        this.renderUpgrade();
        break;
      case "complete":
        this.renderComplete();
        break;
    }
  }

  private mount(markup: string): void {
    this.root.innerHTML = `
      <div class="app-shell mode-${this.state.settings.supportMode}">
        ${markup}
        <div id="global-live" class="screen-reader-only" aria-live="polite"></div>
      </div>
      ${viewportWarning()}
    `;
  }

  private renderLanding(): void {
    const hasSave = this.resumePhase !== null;
    const saveLabel = this.resumePhase ? phaseLabels[this.resumePhase] : "";
    const progressLine = hasSave
      ? `${saveLabel} · ${formatMoney(this.state.cashPence)} · 顾客 ${Math.min(this.state.customerIndex, 3)}/3`
      : "尚未开始首个营业日";

    this.mount(`
      <main class="screen landing" data-testid="screen-landing">
        <section class="landing__visual" aria-label="温暖的英式街角便利店概念场景">
          <img
            class="landing__image"
            src="/assets/corner-shop-concept.jpg"
            alt="斜上方视角的温暖英式便利店，店主正在服务顾客"
          />
          <div class="landing__caption">首个可玩纵向切片 · Desktop MVP</div>
        </section>
        <section class="landing__content">
          <p class="eyebrow">A life-English shopkeeping game</p>
          <h1 class="display-title">英语商业街<span>English High Street</span></h1>
          <p class="lead">
            从一家英国街角小店开始。先用英语进货，再亲手服务顾客；每一次真正听懂、说清，都会推动店铺成长。
          </p>
          <div class="feature-list" aria-label="MVP 特点">
            <span class="feature-pill">约 8 分钟</span>
            <span class="feature-pill">一家便利店</span>
            <span class="feature-pill">买方 + 卖方英语</span>
            <span class="feature-pill">低压力修复</span>
          </div>
          <div class="button-row">
            ${
              hasSave
                ? `<button id="continue-game" class="primary-button" data-testid="continue-game">继续营业</button>`
                : `<button id="new-game" class="primary-button" data-testid="new-game">开始首个营业日</button>`
            }
            ${
              hasSave
                ? `<button id="new-game" class="secondary-button" data-testid="new-game">重新开始</button>`
                : ""
            }
          </div>
          <div class="save-card" aria-label="本机存档状态">
            <div>
              <strong>${hasSave ? "找到本机存档" : "进度保存在这台设备"}</strong>
              <p>${progressLine}</p>
            </div>
            <span aria-hidden="true">${hasSave ? "已保存" : "自动保存"}</span>
          </div>
        </section>
      </main>
    `);

    queryRequired<HTMLButtonElement>(this.root, "#new-game").addEventListener(
      "click",
      () => void this.startNewGame(hasSave),
    );

    const continueButton = this.root.querySelector<HTMLButtonElement>("#continue-game");
    continueButton?.addEventListener("click", () => {
      this.state = {
        ...this.state,
        phase: this.resumePhase ?? "onboarding",
      };
      this.resumePhase = null;
      this.render();
    });
  }

  private async startNewGame(askForConfirmation: boolean): Promise<void> {
    if (
      askForConfirmation &&
      !window.confirm("重新开始会覆盖当前 MVP 进度。确定继续吗？")
    ) {
      return;
    }

    await this.repository.clear();
    this.state = { ...createInitialState(), phase: "onboarding" };
    this.resumePhase = null;
    this.resetEphemeralState();
    await this.persist();
    this.render();
  }

  private renderOnboarding(): void {
    const selectedMode = this.state.settings.supportMode;
    const checked = (mode: SupportMode): string =>
      selectedMode === mode ? "checked" : "";

    this.mount(`
      <main class="screen" data-testid="screen-onboarding">
        ${topbar("Step 1 · 辅助设置")}
        <section class="setup-page">
          <div class="setup-layout">
            <div class="section-heading">
              <div>
                <p class="eyebrow">先调节帮助，不考你</p>
                <h1>今天想要多少英语支援？</h1>
                <p>支援强度和游戏操作引导分开设置。选错也没关系，之后仍可修改。</p>
              </div>
            </div>
            <fieldset class="mode-grid" aria-label="英语支援强度">
              <legend class="screen-reader-only">英语支援强度</legend>
              <label class="mode-card">
                <input type="radio" name="support-mode" value="guided" ${checked("guided")} />
                <span class="mode-number">1</span>
                <h3>引导模式</h3>
                <p>适合刚起步，或平时很少玩游戏的人。</p>
                <ul><li>中英对照</li><li>慢速重播</li><li>提示更主动</li></ul>
              </label>
              <label class="mode-card">
                <input type="radio" name="support-mode" value="practical" ${checked("practical")} />
                <span class="mode-number">2</span>
                <h3>实用模式</h3>
                <p>英文为主，在需要时保留中文与逐级提示。</p>
                <ul><li>选择 + 词块</li><li>正常语速</li><li>推荐首玩</li></ul>
              </label>
              <label class="mode-card">
                <input type="radio" name="support-mode" value="immersive" ${checked("immersive")} />
                <span class="mode-number">3</span>
                <h3>沉浸模式</h3>
                <p>默认只看英文，遇到困难仍可请求重复。</p>
                <ul><li>隐藏中文</li><li>减少提示</li><li>不强迫开麦</li></ul>
              </label>
            </fieldset>
            <footer class="setup-footer">
              <label class="toggle-row">
                <input id="operation-guide" type="checkbox" ${
                  this.state.settings.operationGuide ? "checked" : ""
                } />
                <span><strong>开启操作引导</strong><br />点击目标后，角色会自动走过去。</span>
              </label>
              <button id="start-preview" class="primary-button" data-testid="start-preview">
                查看今日准备
              </button>
            </footer>
          </div>
        </section>
      </main>
    `);

    queryRequired<HTMLButtonElement>(this.root, "#start-preview").addEventListener(
      "click",
      () => void this.finishOnboarding(),
    );
  }

  private async finishOnboarding(): Promise<void> {
    const selected = queryRequired<HTMLInputElement>(
      this.root,
      'input[name="support-mode"]:checked',
    ).value as SupportMode;
    const operationGuide = queryRequired<HTMLInputElement>(
      this.root,
      "#operation-guide",
    ).checked;

    this.state = {
      ...this.state,
      phase: "preview",
      settings: {
        ...this.state.settings,
        supportMode: selected,
        operationGuide,
      },
    };
    await this.persist();
    this.render();
  }

  private renderPreview(): void {
    const allSeen = this.state.previewSeenIds.length === previewCards.length;
    const cards = previewCards
      .map((card) => {
        const seen = this.state.previewSeenIds.includes(card.id);
        return `
          <article class="preview-card ${seen ? "is-seen" : ""}" data-accent="${card.accent}">
            <button
              class="icon-button audio-button"
              type="button"
              data-speak="${card.id}"
              aria-label="播放英语：${card.phrase}"
            >试听</button>
            <h3>${card.phrase}</h3>
            <p class="translation">${card.translation}</p>
            <p class="note">${card.note}</p>
            <button
              class="ghost-button"
              type="button"
              data-preview-seen="${card.id}"
              data-testid="preview-${card.id}"
            >${seen ? "已看过" : "记住这句"}</button>
          </article>
        `;
      })
      .join("");

    this.mount(`
      <main class="screen" data-testid="screen-preview">
        ${topbar("Step 2 · 今日准备")}
        <section class="lesson-page">
          <div class="lesson-shell">
            <div class="section-heading">
              <div>
                <p class="eyebrow">Day 1 · First stock, first customers</p>
                <h1>今天只准备 4 句话</h1>
                <p>它们会马上出现在进货和营业里。点击试听，也可以只看字幕继续。</p>
              </div>
              <div class="progress-dots" aria-label="已查看 ${this.state.previewSeenIds.length} / 4">
                ${previewCards
                  .map(
                    (card) =>
                      `<span class="progress-dot ${
                        this.state.previewSeenIds.includes(card.id) ? "is-done" : ""
                      }"></span>`,
                  )
                  .join("")}
              </div>
            </div>
            <div class="preview-grid">${cards}</div>
            <div class="lesson-actions">
              <button
                id="continue-to-buyer"
                class="primary-button"
                data-testid="continue-to-buyer"
                ${allSeen ? "" : "disabled"}
              >${allSeen ? "去供货商处进货" : `还需查看 ${previewCards.length - this.state.previewSeenIds.length} 张`}</button>
            </div>
          </div>
        </section>
      </main>
    `);

    this.root.querySelectorAll<HTMLButtonElement>("[data-speak]").forEach((button) => {
      button.addEventListener("click", () => {
        const card = previewCards.find((item) => item.id === button.dataset.speak);
        if (card) this.speak(card.phrase);
      });
    });

    this.root
      .querySelectorAll<HTMLButtonElement>("[data-preview-seen]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const id = button.dataset.previewSeen;
          if (id) void this.markPreviewSeen(id);
        });
      });

    queryRequired<HTMLButtonElement>(this.root, "#continue-to-buyer").addEventListener(
      "click",
      () => void this.goToBuyerTask(),
    );
  }

  private async markPreviewSeen(id: string): Promise<void> {
    if (!this.state.previewSeenIds.includes(id)) {
      this.state = {
        ...this.state,
        previewSeenIds: [...this.state.previewSeenIds, id],
      };
      await this.persist();
    }
    this.render();
  }

  private async goToBuyerTask(): Promise<void> {
    this.state = { ...this.state, phase: "buyer" };
    await this.persist();
    this.render();
  }

  private renderBuyerTask(): void {
    const selectedChips = this.selectedChipIds
      .map((id) => buyerTask.chips.find((chip) => chip.id === id))
      .filter((chip) => chip !== undefined);
    const selectedMarkup = selectedChips.length
      ? selectedChips
          .map(
            (chip) => `
              <button class="phrase-chip is-selected" data-remove-chip="${chip.id}" title="移除词块">
                ${chip.text}
              </button>
            `,
          )
          .join("")
      : "";
    const availableMarkup = buyerTask.chips
      .map(
        (chip) => `
          <button
            class="phrase-chip"
            data-chip-id="${chip.id}"
            ${this.selectedChipIds.includes(chip.id) ? "disabled" : ""}
          >${chip.text}</button>
        `,
      )
      .join("");

    this.mount(`
      <main class="screen" data-testid="screen-buyer">
        ${topbar("Step 3 · 买方进货")}
        <section class="conversation-page">
          <div class="conversation-layout" data-testid="task-day1-buyer-restock-water">
            <article class="supplier-card panel">
              <div>
                <div class="speaker-badge">
                  <span class="speaker-avatar" aria-hidden="true">S</span>
                  <span>Supplier · 供货商</span>
                </div>
                <p class="speech-line">“${buyerTask.supplierLine}”</p>
                <button id="speak-supplier" class="ghost-button">重播英语</button>
              </div>
              <div class="order-note">
                <strong>今日进货单</strong><br />4 × bottles of sparkling water · 成本 ${formatMoney(
                  waterProduct.costPence * buyerTask.quantity,
                )}
              </div>
            </article>
            <article class="phrase-card panel">
              <p class="eyebrow">用词块主动表达</p>
              <h2>告诉供货商你需要什么</h2>
              <p>${buyerTask.instruction}</p>
              <div
                class="selected-phrase ${selectedChips.length ? "" : "is-empty"}"
                data-testid="selected-phrase"
                aria-live="polite"
              >${selectedMarkup}</div>
              <div class="chip-bank" aria-label="可用词块">${availableMarkup}</div>
              <span id="hint-level" class="screen-reader-only" data-testid="hint-level">${this.buyerHintLevel}</span>
              ${
                this.buyerFeedback
                  ? `<div class="feedback ${this.buyerReady ? "" : "is-error"}" role="status">${this.buyerFeedback}</div>`
                  : ""
              }
              ${
                this.buyerReady
                  ? `
                    <div class="confirmation-card">
                      <p class="eyebrow">供应商确认</p>
                      <p class="speech-line">“${buyerTask.confirmationLine}”</p>
                      <div class="button-row">
                        <button id="confirm-procurement" class="primary-button" data-testid="confirm-procurement">
                          Yes, that's right.
                        </button>
                        <button id="edit-procurement" class="secondary-button">Let me correct that.</button>
                      </div>
                    </div>
                  `
                  : `
                    <div class="button-row">
                      <button id="check-phrase" class="primary-button" data-testid="check-phrase">检查表达</button>
                      <button id="buyer-hint" class="secondary-button">给我一点提示</button>
                    </div>
                  `
              }
            </article>
          </div>
        </section>
      </main>
    `);

    this.root.querySelectorAll<HTMLButtonElement>("[data-chip-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.chipId;
        if (id && !this.selectedChipIds.includes(id)) {
          this.selectedChipIds.push(id);
          this.render();
        }
      });
    });
    this.root
      .querySelectorAll<HTMLButtonElement>("[data-remove-chip]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const id = button.dataset.removeChip;
          if (id) {
            this.selectedChipIds = this.selectedChipIds.filter((item) => item !== id);
            this.buyerReady = false;
            this.render();
          }
        });
      });
    queryRequired<HTMLButtonElement>(this.root, "#speak-supplier").addEventListener(
      "click",
      () => this.speak(buyerTask.supplierLine),
    );

    const checkButton = this.root.querySelector<HTMLButtonElement>("#check-phrase");
    checkButton?.addEventListener("click", () => this.checkBuyerPhrase());
    const hintButton = this.root.querySelector<HTMLButtonElement>("#buyer-hint");
    hintButton?.addEventListener("click", () => this.giveBuyerHint());
    const confirmButton = this.root.querySelector<HTMLButtonElement>("#confirm-procurement");
    confirmButton?.addEventListener("click", () => void this.commitProcurement());
    const editButton = this.root.querySelector<HTMLButtonElement>("#edit-procurement");
    editButton?.addEventListener("click", () => {
      this.buyerReady = false;
      this.buyerFeedback = "可以修改词块后再确认。";
      this.render();
    });
  }

  private checkBuyerPhrase(): void {
    const actual = this.selectedChipIds
      .map((id) => buyerTask.chips.find((chip) => chip.id === id)?.semantic)
      .filter((semantic): semantic is string => semantic !== undefined);
    const complete = gradeSemanticOrder(buyerTask.expectedSemanticOrder, actual).correct;
    const politeOptional = gradeSemanticOrder(
      buyerTask.expectedSemanticOrder.slice(0, -1),
      actual,
    ).correct;

    if (complete || politeOptional) {
      this.buyerReady = true;
      this.buyerFeedback = politeOptional
        ? "商品和数量正确。加上 please 会更礼貌，但这次仍算完成。"
        : "表达清楚、礼貌，商品与数量都正确。";
    } else {
      this.buyerAttempts += 1;
      this.buyerHintLevel = advanceHint(this.buyerHintLevel);
      this.buyerFeedback =
        buyerTask.hints[this.buyerHintLevel - 1] ?? buyerTask.hints[2] ?? "请再试一次。";
    }
    this.render();
  }

  private giveBuyerHint(): void {
    this.buyerHintLevel = advanceHint(this.buyerHintLevel);
    this.buyerFeedback =
      buyerTask.hints[this.buyerHintLevel - 1] ?? buyerTask.hints[2] ?? "请再试一次。";
    if (this.buyerHintLevel === 3) {
      this.selectedChipIds = ["chip-start", "chip-four", "chip-water", "chip-please"];
    }
    this.render();
  }

  private async commitProcurement(): Promise<void> {
    if (this.state.procurementCommitted) {
      this.state = { ...this.state, phase: "restock" };
      await this.persist();
      this.render();
      return;
    }

    const firstCorrect = this.buyerAttempts === 0 && this.buyerHintLevel === 0;
    const skillId = buyerTask.skillId;
    let nextState: GameState = {
      ...this.state,
      skills: {
        ...this.state.skills,
        [skillId]: applySkillAttempt(this.state.skills[skillId], {
          successful: true,
          firstCorrect,
          hintLevel: this.buyerHintLevel,
          isVariant: false,
        }),
      },
    };
    const transaction: TransactionRecord = {
      id: buyerTask.id,
      taskId: buyerTask.id,
      role: "buyer",
      productId: buyerTask.productId,
      quantity: buyerTask.quantity,
      firstCorrect,
      hintLevel: this.buyerHintLevel,
      replayCount: 0,
      repairAttempted: false,
      repairSuccessful: false,
      basePence: waterProduct.costPence * buyerTask.quantity,
      bonusPence: 0,
      committedAt: new Date().toISOString(),
    };
    nextState = applyTransaction(nextState, transaction);
    nextState = {
      ...nextState,
      phase: "restock",
      procurementCommitted: true,
      backroomInventory: {
        ...nextState.backroomInventory,
        water: (nextState.backroomInventory.water ?? 0) + buyerTask.quantity,
      },
    };
    this.state = nextState;
    await this.persist();
    this.render();
  }

  private renderStore(): void {
    const isRestock = this.state.phase === "restock";
    const currentCustomer = customers[this.state.customerIndex];
    const objectiveTitle = isRestock
      ? "把新到的水放进冷藏柜"
      : currentCustomer
        ? `${currentCustomer.name} 正在收银台等你`
        : "今天的顾客都已服务完毕";
    const objectiveDescription = isRestock
      ? "点击发光的冷藏柜，角色会自动走过去补货。"
      : "点击顾客听取需求；理解后亲自去货架取商品。";

    this.mount(`
      <main class="screen game-shell mode-${this.state.settings.supportMode}" data-testid="screen-store">
        <header class="game-hud">
          <div class="game-brand"><span class="brand-mark">EHS</span><span>Day 1 · Corner Shop</span></div>
          <div class="hud-stat" aria-label="当天进度">
            <span class="hud-stat__mark">${isRestock ? "P" : Math.min(this.state.customerIndex + 1, 3)}</span>
            <strong id="hud-progress">${isRestock ? "补货" : `${Math.min(this.state.customerIndex + 1, 3)} / 3 顾客`}</strong>
          </div>
          <div class="game-hud__spacer"></div>
          <div class="hud-stat hud-stat--secondary"><span>评价</span><strong id="hud-reputation">${this.state.reputation}</strong></div>
          <div class="hud-stat"><span>现金</span><strong id="cash-balance" data-testid="cash-balance">${formatMoney(this.state.cashPence)}</strong></div>
        </header>
        <section class="game-stage">
          <div id="phaser-store" class="phaser-host" aria-label="可点击移动的英式便利店"></div>
          <aside class="objective-card" aria-live="polite">
            <div class="objective-card__label">当前目标</div>
            <h2 id="objective-title">${objectiveTitle}</h2>
            <p id="objective-description">${objectiveDescription}</p>
          </aside>
          <aside id="interaction-panel" class="interaction-panel" aria-live="polite" hidden></aside>
          <div class="game-footer">
            <span class="control-hint">左键点击地面移动</span>
            <span class="control-hint">发光物体可互动</span>
          </div>
          <div id="game-toast" class="toast" role="status" hidden></div>
        </section>
      </main>
    `);

    void this.mountStoreWorld();
  }

  private async mountStoreWorld(): Promise<void> {
    const host = queryRequired<HTMLElement>(this.root, "#phaser-store");
    try {
      const { createStoreGame } = await import("./game/createStoreGame");
      if (!host.isConnected || !["restock", "store"].includes(this.state.phase)) {
        return;
      }
      this.world = createStoreGame(host, {
        onInteraction: (interaction) => this.handleWorldInteraction(interaction),
      });
    } catch (error) {
      host.innerHTML = `
        <div class="panel" style="margin:24px;padding:24px;max-width:620px">
          <h2>无法启动 2D 店铺</h2>
          <p>请确认浏览器已开启硬件加速，并尝试使用当前版本的 Chrome、Edge 或 Safari。</p>
          <pre>${error instanceof Error ? error.message : "Unknown WebGL error"}</pre>
        </div>
      `;
      return;
    }

    if (this.state.phase === "restock") {
      this.world.setActiveShelf("chiller");
      this.world.setInteractionEnabled(true);
      return;
    }

    this.startCurrentCustomer();
  }

  private handleWorldInteraction(interaction: StoreInteraction): void {
    if (this.state.phase === "restock") {
      if (interaction.kind === "shelf") {
        void this.handleRestock(interaction.shelfId);
      }
      return;
    }

    if (this.state.phase !== "store" || !this.storeSession) return;

    if (interaction.kind === "customer") {
      if (
        interaction.customerId === this.storeSession.task.id &&
        (this.storeSession.stage === "waiting" || this.storeSession.stage === "order")
      ) {
        this.openOrderPanel();
      }
      return;
    }

    if (interaction.kind === "shelf" && this.storeSession.stage === "pickup") {
      this.handleShelfPickup(interaction.shelfId);
      return;
    }

    if (interaction.kind === "counter" && this.storeSession.stage === "counter") {
      if (this.storeSession.task.checkout) {
        this.storeSession.stage = "checkout";
        this.openCheckoutPanel();
      } else {
        void this.completeCurrentTransaction();
      }
    }
  }

  private async handleRestock(shelfId: string): Promise<void> {
    if (shelfId !== "chiller") {
      this.showToast("气泡水需要冷藏。请点击左上方发光的冷藏柜。", true);
      return;
    }

    const quantity = this.state.backroomInventory.water ?? 0;
    this.state = {
      ...this.state,
      phase: "store",
      backroomInventory: { ...this.state.backroomInventory, water: 0 },
      shelfInventory: {
        ...this.state.shelfInventory,
        water: (this.state.shelfInventory.water ?? 0) + quantity,
      },
    };
    await this.persist();
    this.world?.setActiveShelf(null);
    this.showToast(`补货完成 · Sparkling water +${quantity}`);
    this.startCurrentCustomer();
  }

  private startCurrentCustomer(): void {
    const task = customers[this.state.customerIndex];
    if (!task) {
      void this.finishStoreDay();
      return;
    }

    this.storeSession = {
      task,
      stage: "waiting",
      orderAttempts: 0,
      orderHintLevel: 0,
      orderFirstCorrect: false,
      checkoutAttempts: 0,
      checkoutHintLevel: 0,
      checkoutFirstCorrect: task.checkout === undefined,
      repairHintLevel: 0,
      repairAttempted: false,
      repairSuccessful: false,
      replayCount: 0,
    };
    this.world?.spawnCustomer({
      id: task.id,
      name: task.name,
      avatarColour: task.avatarColour,
    });
    this.world?.setInteractionEnabled(true);
    this.world?.setActiveShelf(null);
    this.updateObjective(
      `${task.name} 正在收银台等你`,
      "点击顾客，听听他想买什么。",
    );
    this.updateHud();
  }

  private openOrderPanel(feedback = "", simplified = false): void {
    const session = this.storeSession;
    if (!session) return;
    session.stage = "order";
    const panel = queryRequired<HTMLElement>(this.root, "#interaction-panel");
    const line = simplified ? session.task.simplifiedPrompt : session.task.prompt;
    const options = session.task.orderOptions
      .map((option) => this.responseOptionMarkup(option, "order-option"))
      .join("");
    panel.innerHTML = `
      <div class="interaction-heading">
        <div><h2>${session.task.name}</h2><p>Customer ${this.state.customerIndex + 1} of 3</p></div>
        <button class="icon-button" id="close-interaction" aria-label="暂时关闭对话">关闭</button>
      </div>
      <p class="customer-line">“${line}”</p>
      <p class="translation">${session.task.translation}</p>
      <div class="prompt-actions">
        <button class="ghost-button" id="replay-customer">重播</button>
        <button class="ghost-button" id="request-repeat" data-testid="repair-request-repeat">
          Could you say that again, please?
        </button>
      </div>
      ${feedback ? `<div class="feedback is-error">${feedback}</div>` : ""}
      <div class="response-list">${options}</div>
      <span class="screen-reader-only" data-testid="hint-level">${session.orderHintLevel}</span>
    `;
    panel.hidden = false;
    queryRequired<HTMLButtonElement>(panel, "#close-interaction").addEventListener(
      "click",
      () => {
        panel.hidden = true;
      },
    );
    queryRequired<HTMLButtonElement>(panel, "#replay-customer").addEventListener(
      "click",
      () => {
        session.replayCount += 1;
        this.speak(line);
      },
    );
    queryRequired<HTMLButtonElement>(panel, "#request-repeat").addEventListener(
      "click",
      () => this.handleRepairResponse("request_repeat", true),
    );
    panel.querySelectorAll<HTMLButtonElement>("[data-order-option]").forEach((button) => {
      button.addEventListener("click", () => {
        const option = session.task.orderOptions.find(
          (item) => item.id === button.dataset.orderOption,
        );
        if (option) void this.handleOrderResponse(option);
      });
    });
  }

  private responseOptionMarkup(option: ResponseOption, dataName: string): string {
    return `
      <button class="response-option" data-${dataName}="${option.id}">
        <strong>${option.label}</strong>
        ${option.detail ? `<span>${option.detail}</span>` : ""}
      </button>
    `;
  }

  private async handleOrderResponse(option: ResponseOption): Promise<void> {
    const session = this.storeSession;
    if (!session || !option.slots) return;
    const result = gradeSlots(session.task.expectedOrder, option.slots);

    if (!result.correct) {
      session.orderAttempts += 1;
      session.orderHintLevel = advanceHint(session.orderHintLevel);
      session.orderFirstCorrect = false;
      if (session.task.repairScenario) {
        this.openRepairPanel();
      } else {
        const hint =
          session.task.hints[session.orderHintLevel - 1] ??
          session.task.hints[2] ??
          "请再听一次。";
        this.openOrderPanel(`还没有对上顾客的需求。${hint}`);
      }
      return;
    }

    session.orderFirstCorrect =
      session.orderAttempts === 0 &&
      session.orderHintLevel === 0 &&
      !session.repairAttempted;
    session.stage = "pickup";
    this.world?.setCustomerInteraction(session.task.id, false);

    if (session.task.skillId !== "seller.checkout_details") {
      this.applySkillSuccess(
        session.task.skillId,
        session.orderFirstCorrect,
        session.orderHintLevel,
        session.task.variant,
      );
      await this.persist();
    }

    this.world?.setActiveShelf(session.task.shelfId);
    this.updateObjective(
      `去${this.shelfLabel(session.task.shelfId)}取货`,
      `点击发光货架，取 ${session.task.quantity} × ${products[session.task.productId]?.nameEn ?? session.task.productId}。`,
    );
    const panel = queryRequired<HTMLElement>(this.root, "#interaction-panel");
    panel.innerHTML = `
      <div class="feedback">
        听懂了：${session.task.quantity} × ${products[session.task.productId]?.nameEn ?? session.task.productId}。
      </div>
      <p>现在请亲自去发光货架取商品。</p>
      <button id="close-after-order" class="primary-button">去取货</button>
    `;
    queryRequired<HTMLButtonElement>(panel, "#close-after-order").addEventListener(
      "click",
      () => {
        panel.hidden = true;
      },
    );
  }

  private openRepairPanel(): void {
    const session = this.storeSession;
    if (!session) return;
    const panel = queryRequired<HTMLElement>(this.root, "#interaction-panel");
    const hint =
      session.repairHintLevel > 0
        ? `<div class="feedback is-info">${
            session.task.hints[Math.min(session.repairHintLevel, 2)] ??
            "Ask the customer to repeat."
          }</div>`
        : "";
    panel.innerHTML = `
      <div class="interaction-heading"><div><h2>出现了误会</h2><p>沟通修复</p></div></div>
      <p class="customer-line">“Sorry, that's not what I asked for.”</p>
      <p class="translation">抱歉，那不是我想要的。</p>
      ${hint}
      <div class="response-list">
        <button class="response-option" data-repair-intent="request_repeat">
          <strong>Could you say that again, please?</strong><span>请对方重复</span>
        </button>
        <button class="response-option" data-repair-intent="receipt">
          <strong>Would you like a receipt?</strong><span>询问收据</span>
        </button>
        <button class="response-option" data-repair-intent="payment">
          <strong>I'll pay by card.</strong><span>说明自己刷卡</span>
        </button>
      </div>
    `;
    panel.hidden = false;
    panel.querySelectorAll<HTMLButtonElement>("[data-repair-intent]").forEach((button) => {
      button.addEventListener("click", () => {
        const intent = button.dataset.repairIntent;
        if (intent) this.handleRepairResponse(intent, false);
      });
    });
  }

  private handleRepairResponse(intent: string, proactive: boolean): void {
    const session = this.storeSession;
    if (!session) return;

    if (intent !== "request_repeat") {
      session.repairHintLevel = advanceHint(session.repairHintLevel);
      session.repairAttempted = true;
      this.openRepairPanel();
      return;
    }

    session.repairAttempted = true;
    session.repairSuccessful = true;
    session.orderHintLevel = Math.max(1, session.orderHintLevel);
    this.applySkillSuccess(
      "repair.request_repetition",
      session.repairHintLevel === 0,
      session.repairHintLevel,
      false,
    );
    void this.persist();
    this.speak(session.task.simplifiedPrompt, 0.75);
    const message = proactive
      ? "主动请求重复很合适。顾客现在会说慢一点。"
      : "修复成功：你没有继续猜，而是请顾客重新说明。";
    this.openOrderPanel(message, true);
  }

  private handleShelfPickup(shelfId: string): void {
    const session = this.storeSession;
    if (!session) return;
    if (shelfId !== session.task.shelfId) {
      this.showToast(`不是这里。${products[session.task.productId]?.nameEn ?? "商品"} 在${this.shelfLabel(session.task.shelfId)}。`, true);
      return;
    }

    const available = this.state.shelfInventory[session.task.productId] ?? 0;
    if (available < session.task.quantity) {
      this.showToast("货架库存不足，无法完成这笔订单。", true);
      return;
    }

    const product = products[session.task.productId];
    const productView: StoreProductView = {
      id: session.task.productId,
      nameEn: product?.nameEn,
      colour: product?.colour,
    };
    this.world?.setCarriedProduct(productView);
    this.world?.setActiveShelf(null);
    session.stage = "counter";
    queryRequired<HTMLElement>(this.root, "#interaction-panel").hidden = true;
    this.updateObjective(
      "把商品带回收银台",
      "点击右侧木质收银台，完成结账。",
    );
    this.showToast(`已取 ${session.task.quantity} × ${product?.nameEn ?? session.task.productId}`);
  }

  private openCheckoutPanel(feedback = ""): void {
    const session = this.storeSession;
    const checkout = session?.task.checkout;
    if (!session || !checkout) return;
    const panel = queryRequired<HTMLElement>(this.root, "#interaction-panel");
    panel.innerHTML = `
      <div class="interaction-heading"><div><h2>确认结账信息</h2><p>Bag · Receipt · Payment</p></div></div>
      <p class="customer-line">“${checkout.customerLine}”</p>
      <p class="translation">听清袋子、收据和付款方式。</p>
      <div class="prompt-actions"><button id="replay-checkout" class="ghost-button">重播</button></div>
      ${feedback ? `<div class="feedback is-error">${feedback}</div>` : ""}
      <div class="response-list">
        ${checkout.options
          .map((option) => this.responseOptionMarkup(option, "checkout-option"))
          .join("")}
      </div>
    `;
    panel.hidden = false;
    queryRequired<HTMLButtonElement>(panel, "#replay-checkout").addEventListener(
      "click",
      () => {
        session.replayCount += 1;
        this.speak(checkout.customerLine);
      },
    );
    panel
      .querySelectorAll<HTMLButtonElement>("[data-checkout-option]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const option = checkout.options.find(
            (item) => item.id === button.dataset.checkoutOption,
          );
          if (option) void this.handleCheckoutResponse(option, checkout.expectedSlots);
        });
      });
  }

  private async handleCheckoutResponse(
    option: ResponseOption,
    expected: SlotMap,
  ): Promise<void> {
    const session = this.storeSession;
    if (!session || !option.slots) return;
    const result = gradeSlots(expected, option.slots);
    if (!result.correct) {
      session.checkoutAttempts += 1;
      session.checkoutHintLevel = advanceHint(session.checkoutHintLevel);
      const missing = result.mismatches
        .map((slot) => ({ bag: "袋子", receipt: "收据", payment: "付款方式" })[slot] ?? slot)
        .join("、");
      this.openCheckoutPanel(`再听一次 ${missing}。提示等级 ${session.checkoutHintLevel}/3。`);
      return;
    }

    session.checkoutFirstCorrect =
      session.checkoutAttempts === 0 && session.checkoutHintLevel === 0;
    this.applySkillSuccess(
      "seller.checkout_details",
      session.checkoutFirstCorrect,
      session.checkoutHintLevel,
      session.task.variant,
    );
    await this.persist();
    await this.completeCurrentTransaction();
  }

  private async completeCurrentTransaction(): Promise<void> {
    const session = this.storeSession;
    if (!session) return;
    const firstCorrect = session.orderFirstCorrect && session.checkoutFirstCorrect;
    const bonusPence = firstCorrect
      ? session.task.accuracyBonusPence
      : session.repairSuccessful
        ? 10
        : 0;
    const transaction: TransactionRecord = {
      id: session.task.id,
      taskId: session.task.id,
      role: "seller",
      productId: session.task.productId,
      quantity: session.task.quantity,
      firstCorrect,
      hintLevel: Math.max(session.orderHintLevel, session.checkoutHintLevel),
      replayCount: session.replayCount,
      repairAttempted: session.repairAttempted,
      repairSuccessful: session.repairSuccessful,
      basePence: session.task.baseRevenuePence,
      bonusPence,
      committedAt: new Date().toISOString(),
    };

    try {
      this.state = applyTransaction(this.state, transaction);
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : "交易无法完成。", true);
      return;
    }

    const totalErrors = session.orderAttempts + session.checkoutAttempts;
    this.state = {
      ...this.state,
      reputation: Math.max(70, this.state.reputation - totalErrors * 3),
      customerIndex: this.state.customerIndex + 1,
    };
    await this.persist();
    this.world?.setCarriedProduct(null);
    this.world?.completeCustomer(session.task.id, true);
    this.world?.setInteractionEnabled(false);
    queryRequired<HTMLElement>(this.root, "#interaction-panel").hidden = true;
    this.showToast(
      `成交 +${formatMoney(transaction.basePence + transaction.bonusPence)}${
        bonusPence ? " · 包含英语表现奖励" : ""
      }`,
    );
    this.updateHud();

    if (this.state.customerIndex >= customers.length) {
      window.setTimeout(() => void this.finishStoreDay(), 650);
    } else {
      window.setTimeout(() => this.startCurrentCustomer(), 650);
    }
  }

  private async finishStoreDay(): Promise<void> {
    this.state = { ...this.state, phase: "settlement" };
    await this.persist();
    this.render();
  }

  private renderSettlement(): void {
    const summary = calculateSettlement(this.state);
    const skillRows = this.renderSkillRows();
    this.mount(`
      <main class="screen" data-testid="screen-settlement">
        ${topbar("Step 5 · 当日结算")}
        <section class="summary-page">
          <div class="summary-shell">
            <div class="section-heading">
              <div>
                <p class="eyebrow">Day 1 complete</p>
                <h1>第一天，顺利打烊</h1>
                <p>错误只减少奖励，不会让店铺破产。现在看看经营和英语分别发生了什么。</p>
              </div>
            </div>
            <div class="summary-grid">
              <article class="receipt-card panel">
                <p class="eyebrow">经营账本</p>
                <h2>Today's takings</h2>
                <div class="receipt-lines">
                  <div class="receipt-line"><span>期初现金</span><strong>${formatMoney(summary.startingCashPence)}</strong></div>
                  <div class="receipt-line"><span>进货成本</span><strong>− ${formatMoney(summary.procurementCostPence)}</strong></div>
                  <div class="receipt-line"><span>三笔销售</span><strong>+ ${formatMoney(summary.salesPence)}</strong></div>
                  <div class="receipt-line"><span>英语表现奖励</span><strong>+ ${formatMoney(summary.bonusPence)}</strong></div>
                </div>
                <div class="receipt-total"><span>收店余额</span><strong data-testid="settlement-cash">${formatMoney(summary.endingCashPence)}</strong></div>
              </article>
              <article class="skills-card panel">
                <p class="eyebrow">不是笼统经验值</p>
                <h2>今天留下的技能证据</h2>
                <div class="skill-list">${skillRows}</div>
                <div class="feedback is-info">
                  顾客满意度 ${summary.satisfaction}% · 首次独立听懂 ${summary.firstCorrectCount} 笔 · 沟通修复 ${summary.repairCount} 次
                </div>
              </article>
            </div>
            <div class="summary-actions">
              <button id="view-upgrade" class="primary-button" data-testid="view-upgrade">查看可解锁升级</button>
            </div>
          </div>
        </section>
      </main>
    `);
    queryRequired<HTMLButtonElement>(this.root, "#view-upgrade").addEventListener(
      "click",
      () => void this.goToUpgrade(),
    );
  }

  private async goToUpgrade(): Promise<void> {
    this.state = { ...this.state, phase: "upgrade" };
    await this.persist();
    this.render();
  }

  private renderUpgrade(): void {
    const gate = canUnlockUpgrade(
      this.state.cashPence,
      this.state.skills,
      UPGRADE_COST_PENCE,
      REQUIRED_SKILL_COUNT,
    );
    const cashRequirement = this.requirementMarkup(
      gate.cashReady,
      `资金 ${formatMoney(this.state.cashPence)} / ${formatMoney(UPGRADE_COST_PENCE)}`,
    );
    const skillRequirement = this.requirementMarkup(
      gate.skillReady,
      `独立英语技能 ${gate.skillCount} / ${REQUIRED_SKILL_COUNT}`,
    );
    const practice = this.practiceSkill ? this.renderPracticePanel(this.practiceSkill) : "";

    this.mount(`
      <main class="screen" data-testid="screen-upgrade">
        ${topbar("Step 6 · 双门槛升级")}
        <section class="summary-page">
          <div class="summary-shell">
            <div class="section-heading">
              <div>
                <p class="eyebrow">Money × English skill</p>
                <h1>${this.state.upgradePurchased ? "新服务台已安装" : "店铺成长不能只靠金币"}</h1>
                <p>功能升级同时要求经营资金与真实完成过的英语任务；重复乱点不能刷出独立完成。</p>
              </div>
            </div>
            <div class="upgrade-layout">
              <article class="upgrade-card panel">
                <p class="eyebrow">首个里程碑</p>
                <h2>新增服务货架</h2>
                <p>扩展收银台旁的服务区，为下一阶段的自动收银试运行腾出空间。</p>
                <div class="requirement-list">
                  ${cashRequirement}
                  ${skillRequirement}
                </div>
                ${
                  this.state.upgradePurchased
                    ? `
                      <div class="celebration-banner" role="status">
                        已购买 · 现金剩余 <strong data-testid="cash-after-upgrade">${formatMoney(this.state.cashPence)}</strong><br />
                        小店出现了可见扩建，下一阶段将处理自动收银异常。
                      </div>
                      <div class="button-row" style="margin-top:18px">
                        <button id="finish-mvp" class="primary-button" data-testid="finish-mvp">完成这个 MVP</button>
                      </div>
                    `
                    : `
                      <div class="button-row">
                        <button id="buy-upgrade" class="primary-button" data-testid="buy-upgrade" ${gate.unlocked ? "" : "disabled"}>
                          购买升级 · ${formatMoney(UPGRADE_COST_PENCE)}
                        </button>
                        ${
                          !gate.skillReady
                            ? `<button id="start-practice" class="secondary-button">免费补练</button>`
                            : ""
                        }
                      </div>
                      ${
                        !gate.unlocked
                          ? `<p id="upgrade-lock-reason" data-testid="upgrade-lock-reason" style="margin-top:14px">
                              ${!gate.cashReady ? "还需要更多经营资金。" : "资金已满足；还需独立完成英语任务。"}
                            </p>`
                          : ""
                      }
                    `
                }
                ${practice}
              </article>
              <figure class="upgrade-preview panel">
                <img src="/assets/corner-shop-concept.jpg" alt="升级后的温暖英式便利店预览" />
                <figcaption class="upgrade-preview__caption">
                  <strong>${this.state.upgradePurchased ? "服务区已扩建" : "今天的可见成长"}</strong>
                  <span>${this.state.upgradePurchased ? "从亲手服务，走向自动化筹备。" : "先证明经营与英语之间的双门槛成立。"}</span>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>
      </main>
    `);

    const buyButton = this.root.querySelector<HTMLButtonElement>("#buy-upgrade");
    buyButton?.addEventListener("click", () => void this.buyUpgrade());
    const practiceButton = this.root.querySelector<HTMLButtonElement>("#start-practice");
    practiceButton?.addEventListener("click", () => this.startPractice());
    const finishButton = this.root.querySelector<HTMLButtonElement>("#finish-mvp");
    finishButton?.addEventListener("click", () => void this.finishMvp());
    this.bindPracticeActions();
  }

  private requirementMarkup(ready: boolean, label: string): string {
    return `
      <div class="requirement ${ready ? "is-ready" : ""}">
        <span class="requirement__mark">${ready ? "✓" : "·"}</span>
        <span>${label}</span>
      </div>
    `;
  }

  private startPractice(): void {
    const deficient = (Object.keys(this.state.skills) as SkillId[]).find(
      (skillId) =>
        !["independent", "variant"].includes(this.state.skills[skillId].level),
    );
    this.practiceSkill = deficient ?? null;
    this.practiceAttempts = 0;
    this.practiceFeedback = "";
    this.render();
  }

  private renderPracticePanel(skillId: SkillId): string {
    const question = this.practiceQuestion(skillId, this.practiceRound);
    return `
      <div class="confirmation-card" style="color:var(--navy-950);margin-top:20px">
        <p class="eyebrow">免费变式补练 · 不奖励金币</p>
        <strong>${question.prompt}</strong>
        ${
          this.practiceFeedback
            ? `<div class="feedback is-error">${this.practiceFeedback}</div>`
            : ""
        }
        <div class="response-list">
          ${question.options
            .map(
              (option) => `
                <button class="response-option" data-practice-option="${option.id}">
                  <strong>${option.label}</strong>
                </button>
              `,
            )
            .join("")}
        </div>
        ${
          this.practiceAttempts > 0
            ? `<button id="new-practice-variant" class="ghost-button" style="margin-top:12px">换一个新变式</button>`
            : ""
        }
      </div>
    `;
  }

  private bindPracticeActions(): void {
    if (!this.practiceSkill) return;
    const question = this.practiceQuestion(this.practiceSkill, this.practiceRound);
    this.root
      .querySelectorAll<HTMLButtonElement>("[data-practice-option]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const id = button.dataset.practiceOption;
          if (id) void this.handlePracticeAnswer(id, question.correctId);
        });
      });
    const nextButton = this.root.querySelector<HTMLButtonElement>(
      "#new-practice-variant",
    );
    nextButton?.addEventListener("click", () => {
      this.practiceRound += 1;
      this.practiceAttempts = 0;
      this.practiceFeedback = "";
      this.render();
    });
  }

  private async handlePracticeAnswer(
    selectedId: string,
    correctId: string,
  ): Promise<void> {
    if (!this.practiceSkill) return;
    if (selectedId !== correctId) {
      this.practiceAttempts += 1;
      this.practiceFeedback = "这次还没有完成意图。换一个新变式后，首次正确才会记为独立完成。";
      this.render();
      return;
    }

    const firstCorrect = this.practiceAttempts === 0;
    this.applySkillSuccess(this.practiceSkill, firstCorrect, firstCorrect ? 0 : 1, true);
    await this.persist();
    this.practiceSkill = null;
    this.practiceAttempts = 0;
    this.practiceFeedback = "";
    this.practiceRound += 1;
    this.render();
  }

  private practiceQuestion(skillId: SkillId, round: number): PracticeQuestion {
    const alternate = round % 2 === 1;
    const questions: Record<SkillId, PracticeQuestion> = {
      "buyer.request_item_quantity": {
        prompt: alternate
          ? "You need one carton of milk. What do you say?"
          : "You need two bottles of water. What do you say?",
        options: [
          { id: "request", label: alternate ? "I'd like one carton of milk, please." : "I'd like two bottles of water, please." },
          { id: "checkout", label: "Would you like a receipt?" },
        ],
        correctId: "request",
      },
      "seller.understand_item_quantity": {
        prompt: alternate ? "The customer says: Two packets of crisps." : "The customer says: One bottle of water.",
        options: [
          { id: "correct", label: alternate ? "2 × crisps" : "1 × water" },
          { id: "wrong", label: alternate ? "1 × crisps" : "2 × water" },
        ],
        correctId: "correct",
      },
      "seller.checkout_details": {
        prompt: alternate ? "No bag. Receipt, please. Cash." : "A bag, no receipt. Card, please.",
        options: [
          { id: "correct", label: alternate ? "No bag · Receipt · Cash" : "Bag · No receipt · Card" },
          { id: "wrong", label: alternate ? "Bag · Receipt · Cash" : "Bag · Receipt · Card" },
        ],
        correctId: "correct",
      },
      "repair.request_repetition": {
        prompt: "You did not hear the quantity. Which response keeps the sale moving?",
        options: [
          { id: "repeat", label: "Could you say that again, please?" },
          { id: "guess", label: "Three bottles, then." },
        ],
        correctId: "repeat",
      },
    };
    return questions[skillId];
  }

  private async buyUpgrade(): Promise<void> {
    if (this.state.upgradePurchased) return;
    const gate = canUnlockUpgrade(
      this.state.cashPence,
      this.state.skills,
      UPGRADE_COST_PENCE,
      REQUIRED_SKILL_COUNT,
    );
    if (!gate.unlocked) return;

    this.state = {
      ...this.state,
      cashPence: this.state.cashPence - UPGRADE_COST_PENCE,
      upgradePurchased: true,
    };
    await this.persist();
    this.render();
  }

  private async finishMvp(): Promise<void> {
    this.state = { ...this.state, phase: "complete" };
    await this.persist();
    this.render();
  }

  private renderComplete(): void {
    this.mount(`
      <main class="screen complete-page" data-testid="screen-complete">
        <section class="complete-shell">
          <div class="complete-copy">
            <p class="eyebrow">Vertical slice complete</p>
            <h1>从一句英语，到一家更好的店</h1>
            <p>
              你完成了“预习 → 买方进货 → 卖方服务 → 沟通修复 → 日结 → 双门槛升级”的完整闭环。
              下一阶段会把新增服务台变成自动收银试运行，并加入支付失败等新语言责任。
            </p>
            <div class="button-row">
              <button id="replay-mvp" class="primary-button">再玩一遍</button>
              <button id="export-save" class="secondary-button">导出存档 JSON</button>
            </div>
          </div>
          <div class="complete-image">
            <img src="/assets/supermarket-concept.jpg" alt="未来大型商超阶段的概念预告" />
          </div>
        </section>
      </main>
    `);
    queryRequired<HTMLButtonElement>(this.root, "#replay-mvp").addEventListener(
      "click",
      () => void this.startNewGame(true),
    );
    queryRequired<HTMLButtonElement>(this.root, "#export-save").addEventListener(
      "click",
      () => void this.repository.export(this.state),
    );
  }

  private applySkillSuccess(
    skillId: SkillId,
    firstCorrect: boolean,
    hintLevel: number,
    isVariant: boolean,
  ): void {
    this.state = {
      ...this.state,
      skills: {
        ...this.state.skills,
        [skillId]: applySkillAttempt(this.state.skills[skillId], {
          successful: true,
          firstCorrect,
          hintLevel,
          isVariant,
        }),
      },
    };
  }

  private renderSkillRows(): string {
    return (Object.keys(this.state.skills) as SkillId[])
      .map((skillId) => {
        const skill = this.state.skills[skillId];
        const label = skillLabels[skillId];
        return `
          <div class="skill-row" data-testid="skill-state-${skillId}">
            <div><strong>${label.en}</strong><span>${label.zh}</span></div>
            <span class="level-pill" data-level="${skill.level}">${levelLabels[skill.level]}</span>
          </div>
        `;
      })
      .join("");
  }

  private updateObjective(title: string, description: string): void {
    const titleElement = this.root.querySelector<HTMLElement>("#objective-title");
    const descriptionElement = this.root.querySelector<HTMLElement>(
      "#objective-description",
    );
    if (titleElement) titleElement.textContent = title;
    if (descriptionElement) descriptionElement.textContent = description;
  }

  private updateHud(): void {
    const cash = this.root.querySelector<HTMLElement>("#cash-balance");
    const reputation = this.root.querySelector<HTMLElement>("#hud-reputation");
    const progress = this.root.querySelector<HTMLElement>("#hud-progress");
    if (cash) cash.textContent = formatMoney(this.state.cashPence);
    if (reputation) reputation.textContent = String(this.state.reputation);
    if (progress) {
      progress.textContent = `${Math.min(this.state.customerIndex + 1, 3)} / 3 顾客`;
    }
  }

  private shelfLabel(shelfId: string): string {
    return (
      { chiller: "冷藏柜", pantry: "食品货架", snacks: "零食货架" }[shelfId] ??
      "货架"
    );
  }

  private showToast(message: string, isError = false): void {
    const toast = this.root.querySelector<HTMLElement>("#game-toast");
    if (!toast) {
      this.announce(message);
      return;
    }
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    toast.textContent = message;
    toast.style.background = isError ? "var(--danger-700)" : "var(--navy-950)";
    toast.hidden = false;
    this.toastTimer = window.setTimeout(() => {
      toast.hidden = true;
      this.toastTimer = null;
    }, 2300);
  }

  private speak(text: string, rate?: 0.75 | 1): void {
    if (!("speechSynthesis" in window)) {
      this.announce("当前浏览器没有可用的语音朗读，字幕仍可继续使用。")
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-GB";
    utterance.rate = rate ?? this.state.settings.speechRate;
    window.speechSynthesis.speak(utterance);
  }

  private announce(message: string): void {
    const live = this.root.querySelector<HTMLElement>("#global-live");
    if (live) live.textContent = message;
  }

  private async persist(): Promise<void> {
    await this.repository.save(this.state);
  }

  private destroyWorld(): void {
    this.world?.destroy();
    this.world = null;
    this.storeSession = null;
  }

  private resetEphemeralState(): void {
    this.selectedChipIds = [];
    this.buyerAttempts = 0;
    this.buyerHintLevel = 0;
    this.buyerReady = false;
    this.buyerFeedback = "";
    this.practiceSkill = null;
    this.practiceAttempts = 0;
    this.practiceRound = 0;
    this.practiceFeedback = "";
  }
}
