import { createDefaultShopLayout, validateShopLayout, type ShopLayout } from "./shopLayout";
import type { ProductAssetId } from "./product-library/catalog";

/** First release opens one real 3 m extension. Later stages are previews, never purchasable. */
export const SHOP_EXPANSION_COST_PENCE = 1500;
export const SMALL_SHOP_EXPANSION_STAGES = 3;
export const AVAILABLE_EXPANSION_STAGES = 1;

export interface ShopRenovation {
  layout: ShopLayout;
  expansionDay: number | null;
  /** Accepted changes only; cancelling or repeatedly applying the same plan earns nothing. */
  layoutRevision: number;
}

export function createInitialRenovation(): ShopRenovation {
  return { layout: createDefaultShopLayout(), expansionDay: null, layoutRevision: 0 };
}

export function validateRenovation(value: unknown, dayNumber: number): value is ShopRenovation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.layoutRevision) || (record.layoutRevision as number) < 0
    || !validateShopLayout(record.layout).valid) return false;
  const layout = record.layout as ShopLayout;
  return layout.expansion === 0 ? record.expansionDay === null
    : Number.isSafeInteger(record.expansionDay) && (record.expansionDay as number) >= 1
      && (record.expansionDay as number) <= dayNumber;
}

interface RenovationContext {
  day: { phase: string; number: number };
  held: { kind: string };
  customer: { phase: string };
}

/** Renovation moves fixtures, not the people holding or purchasing their stock. */
export function shopRenovationReason(state: RenovationContext): string | undefined {
  if (state.day.phase !== "preparing" && state.day.phase !== "settled") {
    return "营业中不能移动设备。请先完成店内订单并打烊，或在次日开门前装修。";
  }
  if (state.held.kind !== "none") return "请先放下手里的货箱或商品，再开始装修。";
  if (state.customer.phase !== "outside" && state.customer.phase !== "complete") {
    return "请等店内顾客离开后再装修，当前订单不会被中断。";
  }
  return undefined;
}

export interface ExpansionOffer { allowed: boolean; costPence: number; reason?: string }
export function getShopExpansionOffer(state: RenovationContext & { cashPence: number; renovation: ShopRenovation }): ExpansionOffer {
  const costPence = SHOP_EXPANSION_COST_PENCE;
  if (state.renovation.layout.expansion >= AVAILABLE_EXPANSION_STAGES) {
    return { allowed: false, costPence, reason: "第一次店面扩建已完成。后续扩建与升级超市尚未开放，不会再次扣款。" };
  }
  const reason = shopRenovationReason(state);
  if (reason) return { allowed: false, costPence, reason };
  if (state.cashPence < costPence) return {
    allowed: false, costPence,
    reason: `扩建需要 £${(costPence / 100).toFixed(2)}，还差 £${((costPence - state.cashPence) / 100).toFixed(2)}。没有等级或英语门槛。`,
  };
  return { allowed: true, costPence };
}

interface AchievementContext {
  transactions: readonly unknown[];
  settlements: readonly { paidCustomers: number }[];
  items: readonly { productId: ProductAssetId; location: { kind: string } }[];
  upgraded: boolean;
  recyclingRecords: readonly unknown[];
  renovation: ShopRenovation;
}
export interface ShopAchievement {
  id: string;
  name: string;
  description: string;
  category: "经营" | "建设";
  current: number;
  target: number;
  completed: boolean;
}

/** Badges are derived from saved actions. They neither mint cash nor assert English mastery. */
export function getShopAchievements(state: AchievementContext): ShopAchievement[] {
  const soldKinds = new Set(state.items.filter((item) => item.location.kind === "sold").map((item) => item.productId)).size;
  const entries: Array<Omit<ShopAchievement, "completed">> = [
    { id: "first-sale", name: "开张大吉", description: "完成第一笔真实收款", category: "经营", current: state.transactions.length, target: 1 },
    { id: "ten-sales", name: "渐入佳境", description: "累计完成 10 笔收款", category: "经营", current: state.transactions.length, target: 10 },
    { id: "thirty-sales", name: "街坊小店", description: "累计完成 30 笔收款", category: "经营", current: state.transactions.length, target: 30 },
    { id: "first-day", name: "完整的一天", description: "完成至少有一笔收款的营业日结", category: "经营", current: state.settlements.filter((day) => day.paidCustomers > 0).length, target: 1 },
    { id: "five-products", name: "丰富货架", description: "实际售出 5 种不同商品", category: "经营", current: soldKinds, target: 5 },
    { id: "shelf-capacity", name: "多一层空间", description: "购买原有的货架容量升级", category: "建设", current: Number(state.upgraded), target: 1 },
    { id: "first-extension", name: "小店长大了", description: "完成第一次实体店面扩建", category: "建设", current: state.renovation.layout.expansion, target: 1 },
    { id: "first-layout", name: "我的店我来摆", description: "保存一次实际改变设备位置或朝向的布局", category: "建设", current: state.renovation.layoutRevision, target: 1 },
    { id: "ten-recycled", name: "整洁小店", description: "回收 10 个用过的空纸箱", category: "建设", current: state.recyclingRecords.length, target: 10 },
  ];
  return entries.map((entry) => ({ ...entry, current: Math.min(entry.current, entry.target), completed: entry.current >= entry.target }));
}
