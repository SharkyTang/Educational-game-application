import { PRODUCTS, type SimState } from "./domain";
import { deliveryRemainingMs } from "./delivery";

export type ComputerApp = "supply" | "day" | "upgrade" | "equipment" | "layout" | "street";

/** Each icon is drawn in the same view box so the desktop remains consistent across devices. */
export const COMPUTER_APPS: readonly { id: ComputerApp; name: string; detail: string; key?: string; drawing: string }[] = [
  { id: "supply", name: "进货", detail: "选商品 · 查配送", key: "B", drawing: '<path d="m8 15 16-8 16 8v20l-16 8-16-8Z M8 15l16 8 16-8 M24 23v20 M16 11l16 8v9"/>' },
  { id: "day", name: "营业 / 日结", detail: "开关店 · 账本 · 现金", drawing: '<rect x="9" y="9" width="30" height="33" rx="3"/><path d="M16 6v8 M32 6v8 M9 20h30 M16 27h6 M16 34h6"/><circle cx="32" cy="32" r="6"/><path d="M32 28v4l3 2"/>' },
  { id: "upgrade", name: "扩容", detail: "货架容量 · 店铺成长", key: "U", drawing: '<path d="M8 41V17h32v24 M8 29h32 M5 41h38 M17 22v7 M31 22v7 M24 4v9 M19 9l5-5 5 5"/>' },
  { id: "equipment", name: "设备商店", detail: "购买设备 · 查看仓库", drawing: '<path d="M8 20v21h32V20 M5 20l4-12h30l4 12 M15 8v12 M24 8v12 M33 8v12 M8 20q4 6 8 0 4 6 8 0 4 6 8 0 4 6 8 0 M17 41V29h14v12"/>' },
  { id: "layout", name: "装修", detail: "移动家具 · 布置电脑", key: "P", drawing: '<rect x="6" y="8" width="27" height="12" rx="3"/><path d="M33 14h8v12H22v15 M18 33h8v9h-8Z"/>' },
  { id: "street", name: "商业街", detail: "未来商铺 · 开放条件", key: "M", drawing: '<path d="m5 10 12-4 14 4 12-4v32l-12 4-14-4-12 4Z M17 6v32 M31 10v32"/><path d="M29 19c0 6-5 10-5 10s-5-4-5-10a5 5 0 0 1 10 0Z"/><circle cx="24" cy="19" r="1"/>' },
];

export function computerDesktopMarkup(): string {
  return `<section id="s3-computer-desktop" class="s3-computer-desktop" aria-labelledby="s3-desktop-title" hidden>
    <div class="s3-desktop-welcome"><span class="s3-desktop-mark" aria-hidden="true">CS</span><div><p class="s3-eyebrow">CORNER SHOP · SHOP DESKTOP</p><h3 id="s3-desktop-title">今天的小店，由你安排</h3><p>打开一个应用开始经营，退出电脑后时间继续。</p></div></div>
    <nav class="s3-desktop-icons" aria-label="电脑桌面应用">${COMPUTER_APPS.map((app) => `<button id="s3-computer-${app.id}" class="s3-desktop-icon" type="button" aria-label="${app.name}"><span class="s3-desktop-icon-picture"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${app.drawing}</svg></span><strong>${app.name}${app.key ? ` <kbd>${app.key}</kbd>` : ""}</strong><small>${app.detail}</small></button>`).join("")}</nav>
    <p class="s3-desktop-note">营业与配送已暂停 · <kbd>Esc</kbd> 退出电脑</p>
  </section>`;
}

export function computerShortcut(code: string): ComputerApp | null {
  return ({ KeyB: "supply", KeyU: "upgrade", KeyP: "layout", KeyM: "street" } as const)[code as "KeyB" | "KeyU" | "KeyP" | "KeyM"] ?? null;
}

export function isComputerTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable === true);
}

export interface ComputerPurchaseOrder {
  id: string;
  title: string;
  products: string;
  amount: string;
  status: string;
  awaitingReceipt: boolean;
}

/** Keep the FIFO ledger order, including the received vehicle that still occupies the queue. */
export function computerPurchaseOrders(state: Pick<SimState, "day" | "purchases" | "delivery">): ComputerPurchaseOrder[] {
  const { purchases, delivery } = state;
  const lastReceivedIndex = purchases.reduce((last, order, index) => order.receivedDay !== null ? index : last, -1);
  const departingIndex = delivery.phase === "departing" ? purchases.findIndex((order) => order.id === delivery.orderId) : -1;
  let unreceivedBefore = 0;
  return purchases.flatMap((order, index) => {
    const awaitingReceipt = order.receivedDay === null;
    const ordersAhead = unreceivedBefore + (departingIndex >= 0 && departingIndex < index ? 1 : 0);
    if (awaitingReceipt) unreceivedBefore += 1;
    if (!awaitingReceipt && order.dayNumber !== state.day.number && order.receivedDay !== state.day.number
      && index !== lastReceivedIndex) return [];
    let status = awaitingReceipt ? `排队中 · 前方 ${ordersAhead} 单` : `已签收 · 第 ${order.receivedDay} 天`;
    if (order.id === delivery.orderId) {
      const seconds = Math.ceil(deliveryRemainingMs(delivery) / 1000);
      if (delivery.phase === "preparing") status = `备货中 · 约 ${seconds} 秒后停稳`;
      else if (delivery.phase === "arriving") status = delivery.blocked ? "驶入暂停 · 让行中，请离开车道" : `驶入中 · 约 ${seconds} 秒后停稳`;
      else if (delivery.phase === "ready") status = "待签收 · 已到门口，空手按 E";
      else if (delivery.phase === "departing") status = delivery.blocked ? "已签收 · 驶离暂停，让行中" : `已签收 · 货车驶离中，约 ${seconds} 秒`;
    }
    return [{
      id: order.id, title: `第 ${index + 1} 单 · 第 ${order.dayNumber} 天采购`,
      products: order.lines.map((line) => `${PRODUCTS[line.productId].nameZh} × ${line.quantity}`).join("、"),
      amount: `£${(order.amountPence / 100).toFixed(2)}`, status, awaitingReceipt,
    }];
  });
}

const escapeOrderText = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

/** Every dynamic field is escaped, including identifiers used in attributes. */
export function computerPurchaseOrdersMarkup(rows: readonly ComputerPurchaseOrder[]): string {
  if (!rows.length) return '<p class="s3-muted">还没有进货订单。先选择商品与数量，确认后在这里查看配送进度。</p>';
  return `<ol class="s3-purchase-orders-list" tabindex="0" aria-label="按采购顺序排列的进货订单">${rows.map((order) => `<li data-order-id="${escapeOrderText(order.id)}"><div class="s3-purchase-order-heading"><strong>${escapeOrderText(order.title)}</strong><span>${escapeOrderText(order.amount)}</span></div><p>${escapeOrderText(order.products)}</p><p class="s3-purchase-order-status${order.awaitingReceipt ? " s3-purchase-order-pending" : ""}">${escapeOrderText(order.status)}</p></li>`).join("")}</ol>`;
}
