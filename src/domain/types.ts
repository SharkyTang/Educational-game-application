export type AppPhase =
  | "landing"
  | "onboarding"
  | "preview"
  | "buyer"
  | "restock"
  | "store"
  | "settlement"
  | "upgrade"
  | "complete";

export type SupportMode = "guided" | "practical" | "immersive";

export type SkillId =
  | "buyer.request_item_quantity"
  | "seller.understand_item_quantity"
  | "seller.checkout_details"
  | "repair.request_repetition";

export type SkillLevel =
  | "unseen"
  | "exposed"
  | "guided"
  | "independent"
  | "variant";

export interface SkillEvidence {
  skillId: SkillId;
  level: SkillLevel;
  exposedCount: number;
  guidedSuccessCount: number;
  independentSuccessCount: number;
  variantSuccessCount: number;
}

export type SlotValue = string | number | boolean;
export type SlotMap = Record<string, SlotValue>;

export interface Product {
  id: string;
  nameEn: string;
  nameZh: string;
  unitEn: string;
  pricePence: number;
  costPence: number;
  shelfId: ShelfId;
  colour: number;
}

export type ShelfId = "chiller" | "pantry" | "snacks";

export interface PreviewCard {
  id: string;
  phrase: string;
  translation: string;
  note: string;
  accent: "sage" | "mustard" | "terracotta" | "navy";
}

export interface ResponseOption {
  id: string;
  label: string;
  detail?: string;
  slots?: SlotMap;
  intent?: string;
}

export interface PhraseChip {
  id: string;
  text: string;
  semantic?: string;
}

export interface BuyerTask {
  id: string;
  supplierLine: string;
  instruction: string;
  chips: PhraseChip[];
  expectedSemanticOrder: string[];
  confirmationLine: string;
  productId: string;
  quantity: number;
  hints: string[];
  skillId: SkillId;
}

export interface CheckoutDefinition {
  customerLine: string;
  expectedSlots: SlotMap;
  options: ResponseOption[];
}

export interface CustomerTask {
  id: string;
  name: string;
  avatarColour: number;
  prompt: string;
  translation: string;
  simplifiedPrompt: string;
  expectedOrder: SlotMap;
  orderOptions: ResponseOption[];
  productId: string;
  quantity: number;
  shelfId: ShelfId;
  baseRevenuePence: number;
  accuracyBonusPence: number;
  skillId: SkillId;
  variant: boolean;
  checkout?: CheckoutDefinition;
  repairScenario?: boolean;
  hints: string[];
}

export interface TransactionRecord {
  id: string;
  taskId: string;
  role: "buyer" | "seller";
  productId: string;
  quantity: number;
  firstCorrect: boolean;
  hintLevel: number;
  replayCount: number;
  repairAttempted: boolean;
  repairSuccessful: boolean;
  basePence: number;
  bonusPence: number;
  committedAt: string;
}

export interface GameSettings {
  supportMode: SupportMode;
  operationGuide: boolean;
  subtitles: boolean;
  speechRate: 0.75 | 1;
  fontScale: 1 | 1.25 | 1.5;
  reducedMotion: boolean;
}

export interface GameState {
  schemaVersion: 1;
  contentVersion: string;
  phase: AppPhase;
  settings: GameSettings;
  cashPence: number;
  reputation: number;
  backroomInventory: Record<string, number>;
  shelfInventory: Record<string, number>;
  previewSeenIds: string[];
  procurementCommitted: boolean;
  customerIndex: number;
  transactions: TransactionRecord[];
  completedTransactionIds: string[];
  skills: Record<SkillId, SkillEvidence>;
  upgradePurchased: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GradeResult {
  correct: boolean;
  mismatches: string[];
}

export interface SettlementSummary {
  startingCashPence: number;
  procurementCostPence: number;
  salesPence: number;
  bonusPence: number;
  endingCashPence: number;
  satisfaction: number;
  firstCorrectCount: number;
  repairCount: number;
}
