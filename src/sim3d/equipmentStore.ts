import {
  EQUIPMENT_COMMERCE_CATALOG,
  OPERATIONAL_EQUIPMENT_ASSET_IDS,
  equipmentInventoryStats,
  getEquipmentPurchaseOffer,
  type EquipmentAssetState,
  type EquipmentFloorPlacement,
  type OperationalEquipmentAssetId,
} from "./equipmentCommerce";
import { EQUIPMENT_ASSETS } from "./equipment-library/catalog";
import { PRODUCTS, type ProductId } from "./products";
import "./equipmentStore.css";

const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

export interface EquipmentStoreCallbacks {
  onBuy(purchaseId: string, assetId: OperationalEquipmentAssetId, productId: ProductId): boolean;
  onLayout(): void;
}

export interface EquipmentStoreOptions {
  writable: boolean;
  reason?: string;
}

/** Management UI only. Ownership, cash and idempotency remain domain responsibilities. */
export class EquipmentStore {
  private readonly lifetime = new AbortController();
  private readonly selections = new Map<OperationalEquipmentAssetId, ProductId>();
  private state: EquipmentAssetState = { instances: [], purchases: [], nextSequence: 1 };
  private placements: readonly EquipmentFloorPlacement[] = [];
  private options: EquipmentStoreOptions = { writable: false };
  private cashPence = 0;
  private confirming: OperationalEquipmentAssetId | null = null;

  constructor(private readonly host: HTMLElement, private readonly callbacks: EquipmentStoreCallbacks) {
    for (const assetId of OPERATIONAL_EQUIPMENT_ASSET_IDS) {
      this.selections.set(assetId, EQUIPMENT_COMMERCE_CATALOG[assetId].compatibleProducts[0]!);
    }
    host.innerHTML = equipmentStoreMarkup();
    const signal = this.lifetime.signal;
    host.addEventListener("change", (event) => {
      const select = (event.target as Element | null)?.closest<HTMLSelectElement>("[data-equipment-product]");
      if (!select) return;
      const assetId = select.dataset.equipmentProduct as OperationalEquipmentAssetId;
      const definition = EQUIPMENT_COMMERCE_CATALOG[assetId];
      const productId = select.value as ProductId;
      if (!definition?.compatibleProducts.includes(productId)) return;
      this.selections.set(assetId, productId);
      this.confirming = null;
      this.render();
    }, { signal });
    host.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
      if (!button) return;
      if (button.id === "s3-equipment-to-layout") {
        this.confirming = null;
        this.callbacks.onLayout();
        return;
      }
      const buy = button.dataset.equipmentBuy as OperationalEquipmentAssetId | undefined;
      const confirm = button.dataset.equipmentConfirm as OperationalEquipmentAssetId | undefined;
      if (buy) {
        if (!this.canBuy(buy)) return;
        this.confirming = buy;
        this.render();
        this.element<HTMLButtonElement>(`s3-equipment-confirm-${buy}`).focus();
      } else if (confirm) {
        if (this.confirming !== confirm) return;
        const productId = this.selections.get(confirm)!;
        if (this.canBuy(confirm) && this.callbacks.onBuy(`equipment-purchase-${this.state.nextSequence}`, confirm, productId)) {
          this.confirming = null;
          this.element("s3-equipment-warehouse-heading").focus();
        }
        this.render();
      } else if (button.dataset.equipmentCancel) {
        const cancelled = this.confirming;
        this.confirming = null;
        this.render();
        if (cancelled) this.element<HTMLButtonElement>(`s3-equipment-buy-${cancelled}`).focus();
      }
    }, { signal });
  }

  setState(
    state: EquipmentAssetState,
    placements: readonly EquipmentFloorPlacement[],
    cashPence: number,
    options: EquipmentStoreOptions,
  ): void {
    this.state = state;
    this.placements = placements;
    this.cashPence = cashPence;
    this.options = options;
    if (!options.writable || options.reason) this.confirming = null;
    this.render();
  }

  cancelConfirmation(): void {
    if (this.confirming === null) return;
    this.confirming = null;
    this.render();
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.host.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing equipment store element: ${id}`);
    return element;
  }

  private canBuy(assetId: OperationalEquipmentAssetId): boolean {
    const productId = this.selections.get(assetId)!;
    return this.options.writable && !this.options.reason && getEquipmentPurchaseOffer(this.state, this.cashPence, {
      purchaseId: `quote:${assetId}`,
      assetId,
      productId,
      purchasedDay: 1,
    }).allowed;
  }

  private render(): void {
    const stats = equipmentInventoryStats(this.state, this.placements);
    this.element("s3-equipment-cash").textContent = money(this.cashPence);
    this.element("s3-equipment-owned").textContent = String(stats.total);
    this.element("s3-equipment-active").textContent = String(stats.inUse);
    this.element("s3-equipment-warehouse-count").textContent = String(stats.inWarehouse);
    this.element("s3-equipment-store-reason").textContent = !this.options.writable
      ? "此页面只读，不能购买设备。"
      : this.options.reason ?? "购买后先进入设备仓库；在自由装修中摆入店内才会增加可上架货位。普通设备不设英语等级门槛。";

    for (const assetId of OPERATIONAL_EQUIPMENT_ASSET_IDS) {
      const definition = EQUIPMENT_COMMERCE_CATALOG[assetId];
      const productId = this.selections.get(assetId)!;
      const offer = getEquipmentPurchaseOffer(this.state, this.cashPence, {
        purchaseId: `quote:${assetId}`,
        assetId,
        productId,
        purchasedDay: 1,
      });
      const select = this.element<HTMLSelectElement>(`s3-equipment-product-${assetId}`);
      if (select.value !== productId) select.value = productId;
      select.disabled = !this.options.writable;
      const buy = this.element<HTMLButtonElement>(`s3-equipment-buy-${assetId}`);
      buy.disabled = !this.canBuy(assetId);
      buy.textContent = `${money(definition.pricePence)} · 购买`;
      buy.setAttribute("aria-expanded", String(this.confirming === assetId));
      this.element(`s3-equipment-balance-${assetId}`).textContent = this.options.reason ?? (offer.allowed
        ? `购买后 ${money(offer.cashAfterPence)}`
        : offer.reason ?? "当前不能购买");
      const confirm = this.element(`s3-equipment-confirmation-${assetId}`);
      confirm.hidden = this.confirming !== assetId;
      this.element<HTMLButtonElement>(`s3-equipment-confirm-${assetId}`).disabled = !this.canBuy(assetId);
      this.element(`s3-equipment-confirm-copy-${assetId}`).textContent =
        `支付 ${money(definition.pricePence)}，购买 1 台用于${PRODUCTS[productId].nameZh}的${definition.nameZh}。设备先存入仓库，不赠送商品。`;
    }

    const inUse = new Set(this.placements.map((placement) => placement.instanceId));
    this.element("s3-equipment-warehouse-list").innerHTML = this.state.instances.length
      ? this.state.instances.map((instance) => {
        const equipment = EQUIPMENT_COMMERCE_CATALOG[instance.assetId];
        const placed = inUse.has(instance.id);
        return `<li><img src="${EQUIPMENT_ASSETS[instance.assetId].thumbnailUrl}" alt="" width="44" height="44"><div><strong>${equipment.nameZh}</strong><span>${PRODUCTS[instance.productId].nameZh} · ${equipment.capacity} 个货位</span></div><small class="${placed ? "is-active" : ""}">${placed ? "店内使用" : "仓库待摆"}</small></li>`;
      }).join("")
      : `<li class="s3-equipment-empty">还没有购买设备。选择设备及对应商品后购买，设备会安全存入仓库。</li>`;
  }

  dispose(): void {
    this.lifetime.abort();
    this.host.innerHTML = "";
  }
}

export function equipmentStoreMarkup(): string {
  return `<section class="s3-equipment-store" aria-labelledby="s3-equipment-title">
    <div class="s3-equipment-heading"><div><p class="s3-eyebrow">EQUIPMENT SHOP & WAREHOUSE</p><h3 id="s3-equipment-title">设备商店与仓库</h3></div><strong id="s3-equipment-cash">£0.00</strong></div>
    <p id="s3-equipment-store-reason" class="s3-muted" role="status"></p>
    <div class="s3-equipment-stats"><div><span>已拥有</span><strong id="s3-equipment-owned">0</strong></div><div><span>店内使用</span><strong id="s3-equipment-active">0</strong></div><div><span>仓库待摆</span><strong id="s3-equipment-warehouse-count">0</strong></div></div>
    <div class="s3-equipment-catalog">${OPERATIONAL_EQUIPMENT_ASSET_IDS.map((assetId) => {
      const definition = EQUIPMENT_COMMERCE_CATALOG[assetId];
      const asset = EQUIPMENT_ASSETS[assetId];
      return `<article class="s3-equipment-card" id="s3-equipment-card-${assetId}">
        <img src="${asset.thumbnailUrl}" alt="${definition.nameZh}" width="120" height="90" loading="lazy">
        <div class="s3-equipment-card-copy"><span>${definition.nameEn}</span><h4>${definition.nameZh}</h4><p>${asset.description}</p><small>${definition.capacity} 个真实陈列位 · ${money(definition.pricePence)}</small></div>
        <label for="s3-equipment-product-${assetId}">指定陈列商品<select id="s3-equipment-product-${assetId}" data-equipment-product="${assetId}">${definition.compatibleProducts.map((productId) => `<option value="${productId}">${PRODUCTS[productId].nameZh} · ${PRODUCTS[productId].nameEn}</option>`).join("")}</select></label>
        <div class="s3-equipment-buy-row"><span id="s3-equipment-balance-${assetId}"></span><button id="s3-equipment-buy-${assetId}" data-equipment-buy="${assetId}" class="s3-primary-button" type="button" aria-controls="s3-equipment-confirmation-${assetId}" aria-expanded="false">${money(definition.pricePence)} · 购买</button></div>
        <section id="s3-equipment-confirmation-${assetId}" class="s3-confirm" aria-labelledby="s3-equipment-confirm-copy-${assetId}" hidden><p id="s3-equipment-confirm-copy-${assetId}"></p><div><button id="s3-equipment-confirm-${assetId}" data-equipment-confirm="${assetId}" class="s3-primary-button" type="button">确认购买</button><button data-equipment-cancel="true" class="s3-secondary-button" type="button">先不购买</button></div></section>
      </article>`;
    }).join("")}</div>
    <div id="s3-equipment-warehouse-heading" class="s3-equipment-warehouse-heading" tabindex="-1"><div><p class="s3-eyebrow">OWNED EQUIPMENT</p><h4>我的设备仓库</h4></div><button id="s3-equipment-to-layout" class="s3-secondary-button" type="button">进入自由装修</button></div>
    <ul id="s3-equipment-warehouse-list" class="s3-equipment-warehouse-list"></ul>
  </section>`;
}
