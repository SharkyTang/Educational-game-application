import type { SimState } from "./domain";

export type VenueId = "cafe" | "restaurant" | "supermarket";
export interface StreetVenue {
  id: VenueId;
  nameEn: string;
  nameZh: string;
  requiredLevel: number;
}
export const STREET_VENUES: readonly StreetVenue[] = [
  { id: "cafe", nameEn: "Willow & Bean", nameZh: "街角咖啡店", requiredLevel: 2 },
  { id: "restaurant", nameEn: "The Copper Table", nameZh: "邻里餐厅", requiredLevel: 3 },
  { id: "supermarket", nameEn: "Evergreen Market", nameZh: "大商超", requiredLevel: 5 },
];
export interface StreetProgress {
  level: number;
  experience: number;
  nextLevelExperience: number;
  levelExperience: number;
  experiencePerLevel: 30;
  paidOrders: number;
  settledDays: number;
  upgraded: boolean;
}
export interface VenueRequirement {
  id: "level" | "settlement" | "paid-orders" | "upgrade";
  label: string;
  current: number;
  target: number;
  completed: boolean;
}
export interface VenueProgress {
  venue: StreetVenue;
  requirements: VenueRequirement[];
  eligible: boolean;
  statusText: "暂未开放" | "条件已达成·筹备中";
}

/** Business progress is derived from audited receipts, never from exposure or English mastery. */
export function getStreetProgress(state: SimState): StreetProgress {
  const paidOrders = state.transactions.length - state.cashJournal.filter((event) => event.kind === "refund").length;
  const experience = paidOrders * 10;
  const level = 1 + Math.floor(experience / 30);
  return {
    level, experience, nextLevelExperience: level * 30, levelExperience: experience % 30,
    experiencePerLevel: 30, paidOrders, settledDays: state.settlements.length,
    upgraded: state.upgraded,
  };
}

/** Meeting milestones announces future content; no unimplemented interior is advertised as open. */
export function getVenueProgress(state: SimState, id: VenueId): VenueProgress {
  const venue = STREET_VENUES.find((candidate) => candidate.id === id);
  if (!venue) throw new Error("找不到这家商业街商铺。");
  const progress = getStreetProgress(state);
  const requirement = (requirementId: VenueRequirement["id"], label: string, current: number, target: number): VenueRequirement => ({
    id: requirementId, label, current, target, completed: current >= target,
  });
  const requirements = [requirement("level", `经营等级达到 Lv ${venue.requiredLevel}`, progress.level, venue.requiredLevel)];
  if (id === "cafe") requirements.push(requirement("settlement", "完成首次有收款的营业日结", state.settlements.filter((day) => day.paidCustomers > day.refundCount).length, 1));
  if (id === "restaurant") requirements.push(requirement("paid-orders", "累计完成 12 单收款", progress.paidOrders, 12));
  if (id === "supermarket") {
    requirements.push(requirement("upgrade", "完成小店货架扩容", progress.upgraded ? 1 : 0, 1));
    requirements.push(requirement("paid-orders", "累计完成 30 单收款", progress.paidOrders, 30));
  }
  const eligible = requirements.every((entry) => entry.completed);
  return { venue, requirements, eligible, statusText: eligible ? "条件已达成·筹备中" : "暂未开放" };
}
