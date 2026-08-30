import { CONTENT_VERSION } from "../content/dayOne";
import { createEmptySkill } from "../domain/rules";
import type { GameState, SkillId } from "../domain/types";

const skillIds: SkillId[] = [
  "buyer.request_item_quantity",
  "seller.understand_item_quantity",
  "seller.checkout_details",
  "repair.request_repetition",
];

export function createInitialState(): GameState {
  const now = new Date().toISOString();
  const skills = Object.fromEntries(
    skillIds.map((skillId) => [skillId, createEmptySkill(skillId)]),
  ) as GameState["skills"];

  return {
    schemaVersion: 1,
    contentVersion: CONTENT_VERSION,
    phase: "landing",
    settings: {
      supportMode: "practical",
      operationGuide: true,
      subtitles: true,
      speechRate: 1,
      fontScale: 1,
      reducedMotion: false,
    },
    cashPence: 300,
    reputation: 100,
    backroomInventory: { water: 0, milk: 0, crisps: 0 },
    shelfInventory: { water: 0, milk: 1, crisps: 1 },
    previewSeenIds: [],
    procurementCommitted: false,
    customerIndex: 0,
    transactions: [],
    completedTransactionIds: [],
    skills,
    upgradePurchased: false,
    createdAt: now,
    updatedAt: now,
  };
}
