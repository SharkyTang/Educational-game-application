import { describe, expect, it, vi } from "vitest";
import {
  EQUIPMENT_COMMERCE_CATALOG,
  OPERATIONAL_EQUIPMENT_ASSET_IDS,
  createEquipmentAssetState,
  purchaseEquipment,
  type EquipmentAssetState,
  type EquipmentFloorPlacement,
  type OperationalEquipmentAssetId,
} from "../../src/sim3d/equipmentCommerce";
import { EquipmentStore, equipmentStoreMarkup, type EquipmentStoreCallbacks } from "../../src/sim3d/equipmentStore";
import { PRODUCTS, type ProductId } from "../../src/sim3d/products";

type Dataset = Record<string, string | undefined>;

/** The same small DOM surface used by the repository's cash-register UI tests. */
class ElementDouble extends EventTarget {
  textContent = "";
  hidden = false;
  disabled = false;
  id = "";
  value = "";
  parentElement: ElementDouble | null = null;
  readonly dataset: Dataset = {};
  readonly elements = new Map<string, ElementDouble>();
  readonly attributes = new Map<string, string>();
  readonly focus = vi.fn();
  private markup = "";

  constructor(readonly tagName = "DIV") { super() }

  get innerHTML(): string { return this.markup }
  set innerHTML(markup: string) {
    this.markup = markup;
    this.elements.clear();
    for (const match of markup.matchAll(/<([a-z][a-z\d-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const element = new ElementDouble(match[1]!.toUpperCase());
      const attributes = match[2]!;
      element.parentElement = this;
      for (const attribute of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
        element.setAttribute(attribute[1]!, attribute[2]!);
      }
      element.hidden = /\bhidden(?:\s|$)/.test(attributes);
      element.disabled = /\bdisabled(?:\s|$)/.test(attributes);
      this.elements.set(match[3]!, element);
    }
  }

  querySelector(selector: string): ElementDouble | null {
    if (!selector.startsWith("#")) return null;
    return this.elements.get(selector.slice(1)) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "value") this.value = value;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  closest(selector: string): ElementDouble | null {
    if (selector === "button" && this.tagName === "BUTTON") return this;
    if (selector === "[data-equipment-product]" && this.dataset.equipmentProduct !== undefined) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchAtHost("click");
  }

  change(): void {
    if (this.disabled) return;
    this.dispatchAtHost("change");
  }

  replaceChildren(): void {
    this.innerHTML = "";
  }

  private dispatchAtHost(type: string): void {
    let host: ElementDouble = this;
    while (host.parentElement) host = host.parentElement;
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "target", { value: this });
    host.dispatchEvent(event);
  }
}

interface MountedStore {
  store: EquipmentStore;
  root: ElementDouble;
  onBuy: ReturnType<typeof vi.fn<EquipmentStoreCallbacks["onBuy"]>>;
  onLayout: ReturnType<typeof vi.fn<EquipmentStoreCallbacks["onLayout"]>>;
  element(id: string): ElementDouble;
  setState(state?: EquipmentAssetState, placements?: readonly EquipmentFloorPlacement[], cashPence?: number,
    options?: { writable: boolean; reason?: string }): void;
}

function mount(onBuyResult = true): MountedStore {
  const root = new ElementDouble();
  const onBuy = vi.fn<EquipmentStoreCallbacks["onBuy"]>(() => onBuyResult);
  const onLayout = vi.fn<EquipmentStoreCallbacks["onLayout"]>();
  const store = new EquipmentStore(root as unknown as HTMLElement, { onBuy, onLayout });
  const element = (id: string): ElementDouble => {
    const found = root.querySelector(`#${id}`);
    if (!found) throw new Error(`Missing equipment-store fixture: ${id}`);
    return found;
  };
  return {
    store,
    root,
    onBuy,
    onLayout,
    element,
    setState: (state = createEquipmentAssetState(), placements = [], cashPence = 5_000,
      options = { writable: true }) => store.setState(state, placements, cashPence, options),
  };
}

function buy(
  state: EquipmentAssetState,
  cashPence: number,
  purchaseId: string,
  assetId: OperationalEquipmentAssetId,
  productId: ProductId,
) {
  const result = purchaseEquipment(state, cashPence, { purchaseId, assetId, productId, purchasedDay: 1 });
  expect(result.changed, result.reason).toBe(true);
  return result;
}

describe("equipment store catalogue and product assignment", () => {
  it("renders exactly the six operational cards with price, capacity and compatible products", () => {
    const markup = equipmentStoreMarkup();
    expect([...markup.matchAll(/class="s3-equipment-card"/g)]).toHaveLength(6);
    expect([...markup.matchAll(/data-equipment-buy="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(OPERATIONAL_EQUIPMENT_ASSET_IDS);

    for (const assetId of OPERATIONAL_EQUIPMENT_ASSET_IDS) {
      const definition = EQUIPMENT_COMMERCE_CATALOG[assetId];
      expect(markup).toContain(`id="s3-equipment-card-${assetId}"`);
      expect(markup).toContain(`${definition.capacity} 个真实陈列位`);
      expect(markup).toContain(`£${(definition.pricePence / 100).toFixed(2)}`);
      for (const productId of definition.compatibleProducts) {
        expect(markup).toContain(`<option value="${productId}">${PRODUCTS[productId].nameZh}`);
      }
    }
  });

  it("uses the selected compatible product in confirmation and purchase callback", () => {
    const view = mount();
    view.setState();
    const assetId = OPERATIONAL_EQUIPMENT_ASSET_IDS.find((id) => EQUIPMENT_COMMERCE_CATALOG[id].compatibleProducts.length > 1)!;
    const productId = EQUIPMENT_COMMERCE_CATALOG[assetId].compatibleProducts[1]!;
    const select = view.element(`s3-equipment-product-${assetId}`);
    select.value = productId;
    select.change();

    view.element(`s3-equipment-buy-${assetId}`).click();
    expect(view.element(`s3-equipment-confirmation-${assetId}`).hidden).toBe(false);
    expect(view.element(`s3-equipment-confirm-copy-${assetId}`).textContent).toContain(PRODUCTS[productId].nameZh);
    view.element(`s3-equipment-confirm-${assetId}`).click();
    expect(view.onBuy).toHaveBeenCalledExactlyOnceWith("equipment-purchase-1", assetId, productId);
  });
});

describe("equipment store purchase gates", () => {
  it("blocks purchases when funds are insufficient without changing the cash display", () => {
    const view = mount();
    view.setState(createEquipmentAssetState(), [], 599);
    const buyButton = view.element("s3-equipment-buy-wall-shelf-narrow");
    expect(view.element("s3-equipment-cash").textContent).toBe("£5.99");
    expect(view.element("s3-equipment-balance-wall-shelf-narrow").textContent).toBe("店铺资金不足。");
    expect(buyButton.disabled).toBe(true);
    buyButton.click();
    expect(view.onBuy).not.toHaveBeenCalled();
  });

  it.each([
    { label: "只读", options: { writable: false }, reason: "此页面只读，不能购买设备。" },
    { label: "营业锁定", options: { writable: true, reason: "营业中不能购买设备。" }, reason: "营业中不能购买设备。" },
  ])("blocks every buy action while $label", ({ options, reason }) => {
    const view = mount();
    view.setState(createEquipmentAssetState(), [], 10_000, options);
    expect(view.element("s3-equipment-store-reason").textContent).toBe(reason);
    for (const assetId of OPERATIONAL_EQUIPMENT_ASSET_IDS) {
      const button = view.element(`s3-equipment-buy-${assetId}`);
      expect(button.disabled).toBe(true);
      button.click();
      expect(view.element(`s3-equipment-confirmation-${assetId}`).hidden).toBe(true);
    }
    expect(view.onBuy).not.toHaveBeenCalled();
  });
});

describe("equipment confirmation, warehouse and navigation", () => {
  it("keeps the purchase id stable, manages focus, and does not accept a stale second confirmation", () => {
    const view = mount();
    view.setState({ ...createEquipmentAssetState(), nextSequence: 7 });
    const assetId = "wall-shelf-narrow";
    const buyButton = view.element(`s3-equipment-buy-${assetId}`);
    const confirmButton = view.element(`s3-equipment-confirm-${assetId}`);

    buyButton.click();
    expect(buyButton.getAttribute("aria-expanded")).toBe("true");
    expect(confirmButton.focus).toHaveBeenCalledOnce();
    confirmButton.click();
    expect(view.onBuy).toHaveBeenCalledExactlyOnceWith(
      "equipment-purchase-7",
      assetId,
      EQUIPMENT_COMMERCE_CATALOG[assetId].compatibleProducts[0],
    );
    expect(view.element(`s3-equipment-confirmation-${assetId}`).hidden).toBe(true);
    expect(view.element("s3-equipment-warehouse-heading").focus).toHaveBeenCalledOnce();

    confirmButton.click();
    expect(view.onBuy).toHaveBeenCalledOnce();
  });

  it("returns focus to the same buy button after cancelling", () => {
    const view = mount();
    view.setState();
    const assetId = "chest-chiller-wide";
    const buyButton = view.element(`s3-equipment-buy-${assetId}`);
    buyButton.click();
    const cancel = new ElementDouble("BUTTON");
    cancel.parentElement = view.root;
    cancel.setAttribute("data-equipment-cancel", "true");
    cancel.click();
    expect(view.element(`s3-equipment-confirmation-${assetId}`).hidden).toBe(true);
    expect(buyButton.focus).toHaveBeenCalledOnce();
  });

  it("renders owned, in-store and warehouse counts from placements", () => {
    const first = buy(createEquipmentAssetState(), 10_000, "equipment-ui-1", "wall-shelf-narrow", "cereal");
    const second = buy(first.state, first.cashPence, "equipment-ui-2", "chest-chiller-wide", "milk");
    const placements: EquipmentFloorPlacement[] = [{ instanceId: first.instance!.id, x: 1, z: 1, rotation: 0 }];
    const view = mount();
    view.setState(second.state, placements, second.cashPence);

    expect(view.element("s3-equipment-owned").textContent).toBe("2");
    expect(view.element("s3-equipment-active").textContent).toBe("1");
    expect(view.element("s3-equipment-warehouse-count").textContent).toBe("1");
    const warehouse = view.element("s3-equipment-warehouse-list").innerHTML;
    expect(warehouse).toContain("店内使用");
    expect(warehouse).toContain("仓库待摆");
    expect(warehouse).toContain("早餐麦片");
    expect(warehouse).toContain("牛奶");
  });

  it("opens free layout once per navigation click", () => {
    const view = mount();
    view.setState();
    view.element("s3-equipment-to-layout").click();
    expect(view.onLayout).toHaveBeenCalledOnce();
    expect(view.onBuy).not.toHaveBeenCalled();
  });
});
