import type { SimState } from "./domain";
import { getStreetProgress } from "./progression";
import { getShopAchievements, getShopExpansionOffer, shopRenovationReason, SMALL_SHOP_EXPANSION_STAGES, type ShopRenovation } from "./shopDevelopment";

type DevelopmentState = SimState & { renovation: ShopRenovation };
const money = (value: number): string => `£${(value / 100).toFixed(2)}`;

export interface DevelopmentPanelCallbacks {
  onExpand(): boolean;
  onLayout(): void;
}

/** A small, state-driven management view; purchases still go through the game's ledger. */
export class DevelopmentPanel {
  private readonly lifetime = new AbortController();
  private achievementSignature = "";
  private confirming = false;
  private eligible = false;

  constructor(private readonly host: HTMLElement, private readonly callbacks: DevelopmentPanelCallbacks) {
    host.innerHTML = `
      <div class="s3-development-heading"><div><p class="s3-eyebrow">MAKE ROOM FOR YOUR LITTLE SHOP</p><h3>让小店慢慢长大</h3></div><span class="s3-shop-type">街角小卖铺</span></div>
      <p class="s3-muted">经营等级记录成交经验。实体扩建增加可用面积，货架容量仍单独升级；普通成长不设英语门槛。</p>
      <div class="s3-development-stats">
        <div><span>经营等级</span><strong id="s3-growth-level">Lv. 1</strong><small id="s3-growth-experience"></small></div>
        <div><span>当前店面</span><strong id="s3-growth-area"></strong><small id="s3-growth-stage"></small></div>
        <div><span>建设与经营成就</span><strong id="s3-growth-achievements"></strong><small>永久记录 · 本版无现金奖励</small></div>
      </div>
      <div id="s3-growth-progress" class="s3-development-progress" role="progressbar" aria-label="本级经营经验" aria-valuemin="0" aria-valuemax="30"><span></span></div>
      <article class="s3-extension-card">
        <div><p class="s3-eyebrow">FIRST EXTENSION</p><h4 id="s3-extension-title">打开后方的新空间</h4><p>后墙向后延伸 3 米，增加 20.4 平方米。原有商品、设备和库存全部保留；新增区域可自由摆放设备。</p></div>
        <dl><div><dt>本次改造</dt><dd id="s3-extension-price"></dd></div><div><dt>扩建后余额</dt><dd id="s3-extension-balance"></dd></div></dl>
        <p id="s3-extension-reason" class="s3-inline-reason" role="status"></p>
        <div class="s3-management-buttons"><button id="s3-buy-space" class="s3-primary-button" type="button">查看扩建费用</button><button id="s3-growth-to-layout" class="s3-secondary-button" type="button">自由移动设备</button></div>
        <section id="s3-extension-confirm" class="s3-confirm" aria-labelledby="s3-extension-confirm-title" hidden><h4 id="s3-extension-confirm-title">确认扩建这间小卖铺？</h4><p id="s3-extension-confirm-cost"></p><p>请预留后续进货资金。只扣这一次改造费，不赠送库存，不改变 £8 货架容量升级的状态。</p><div><button id="s3-confirm-space" class="s3-primary-button" type="button">确认支付并扩建</button><button id="s3-cancel-space" class="s3-secondary-button" type="button">先不扩建</button></div></section>
      </article>
      <p id="s3-layout-availability" class="s3-muted"></p>
      <ol class="s3-shop-roadmap" aria-label="店铺成长路线"><li class="is-available"><span>01</span><strong>自由装修与首次扩建</strong><small>本版可玩</small></li><li><span>02</span><strong>继续扩张小卖铺</strong><small>第二、三次扩建 · 后续版本</small></li><li><span>03</span><strong>升级社区超市</strong><small>小卖铺达到空间上限后 · 尚未开放</small></li></ol>
      <div class="s3-achievement-heading"><h4>小店成就</h4><span>从实际经营记录计算，不等于英语掌握</span></div>
      <div id="s3-achievement-list" class="s3-achievement-list"></div>
      <p class="s3-muted s3-development-footnote">新设备购买、员工招聘和超市经营会在后续版本接入。本版先使用现有 11 组设备；收银台上的扫码器、刷卡机和打印机整组移动。</p>`;
    const listen = (id: string, action: () => void): void => this.element(id).addEventListener("click", action, { signal: this.lifetime.signal });
    listen("s3-buy-space", () => {
      if (!this.eligible) return;
      this.confirming = true;
      this.element("s3-extension-confirm").hidden = false;
      this.element("s3-confirm-space").focus();
    });
    listen("s3-cancel-space", () => this.cancelConfirmation());
    listen("s3-confirm-space", () => {
      if (this.eligible && this.callbacks.onExpand()) this.cancelConfirmation();
    });
    listen("s3-growth-to-layout", () => { this.cancelConfirmation(); this.callbacks.onLayout(); });
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.host.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing shop development element: ${id}`);
    return element;
  }
  private text(id: string, value: string): void { this.element(id).textContent = value; }

  render(state: DevelopmentState, writable: boolean): void {
    const progress = getStreetProgress(state);
    const expansion = state.renovation.layout.expansion;
    const offer = getShopExpansionOffer(state);
    const achievements = getShopAchievements(state);
    this.eligible = writable && offer.allowed;
    this.text("s3-growth-level", `Lv. ${progress.level}`);
    this.text("s3-growth-experience", `${progress.levelExperience} / ${progress.experiencePerLevel} 经验 · 每笔收款 +10`);
    this.text("s3-growth-area", `${(6.8 * (9.2 + expansion * 3)).toFixed(1)} m²`);
    this.text("s3-growth-stage", `小卖铺扩建 ${expansion} / ${SMALL_SHOP_EXPANSION_STAGES} · 本版开放第 1 次`);
    this.text("s3-growth-achievements", `${achievements.filter((achievement) => achievement.completed).length} / ${achievements.length}`);
    const bar = this.element("s3-growth-progress");
    bar.setAttribute("aria-valuenow", String(progress.levelExperience));
    bar.setAttribute("aria-valuetext", `经营等级 ${progress.level}，本级 ${progress.levelExperience} / ${progress.experiencePerLevel} 经验`);
    bar.querySelector<HTMLElement>("span")!.style.width = `${progress.levelExperience / progress.experiencePerLevel * 100}%`;
    this.text("s3-extension-title", expansion ? "后方的新空间已经打开" : "打开后方的新空间");
    this.text("s3-extension-price", expansion ? "已完成 · 不再扣款" : `${money(offer.costPence)} · 一次性`);
    this.text("s3-extension-balance", expansion ? money(state.cashPence) : state.cashPence >= offer.costPence ? money(state.cashPence - offer.costPence) : "资金不足");
    this.text("s3-extension-reason", !writable ? "此页面只读，不能购买或修改布局。" : offer.reason ?? "资金足够。扩建增加真实空间，不要求经营等级或英语任务。请留一些钱继续进货。" );
    const buy = this.element<HTMLButtonElement>("s3-buy-space");
    buy.disabled = !this.eligible;
    buy.textContent = expansion ? "第一次扩建已完成" : `${money(offer.costPence)} · 查看扩建`;
    this.element<HTMLButtonElement>("s3-confirm-space").disabled = !this.eligible;
    this.text("s3-extension-confirm-cost", `支付 ${money(offer.costPence)}，扩建后剩余 ${money(Math.max(0, state.cashPence - offer.costPence))}。店面将由 62.6 m² 增至 83.0 m²。`);
    if (!this.eligible) this.cancelConfirmation();
    this.element("s3-extension-confirm").hidden = !this.confirming;
    this.text("s3-layout-availability", shopRenovationReason(state) ?? "现在可以免费调整设备布局；商品随货架一起移动，确认保存后生效。" );
    const signature = JSON.stringify(achievements);
    if (signature !== this.achievementSignature) {
      this.achievementSignature = signature;
      this.element("s3-achievement-list").innerHTML = achievements.map((achievement) => `<article id="s3-achievement-${achievement.id}" class="s3-achievement${achievement.completed ? " is-complete" : ""}" aria-label="${achievement.name}：${achievement.completed ? "已达成" : `${achievement.current} / ${achievement.target}`}"><div class="s3-achievement-mark" aria-hidden="true">${achievement.completed ? "✓" : "○"}</div><div><div class="s3-achievement-title"><strong>${achievement.name}</strong><span>${achievement.category}</span></div><p>${achievement.description}</p><small>${achievement.completed ? "已达成" : `${achievement.current} / ${achievement.target}`}</small></div></article>`).join("");
    }
  }

  cancelConfirmation(): void {
    this.confirming = false;
    this.element("s3-extension-confirm").hidden = true;
  }
  dispose(): void { this.lifetime.abort(); this.host.replaceChildren(); }
}
