import type {
  GameState,
  GradeResult,
  SettlementSummary,
  SkillEvidence,
  SkillId,
  SkillLevel,
  SlotMap,
  TransactionRecord,
} from "./types";

const LEVEL_RANK: Record<SkillLevel, number> = {
  unseen: 0,
  exposed: 1,
  guided: 2,
  independent: 3,
  variant: 4,
};

export function formatMoney(pence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}

export function gradeSlots(expected: SlotMap, actual: SlotMap): GradeResult {
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => !(key in actual) || !Object.is(actual[key], value))
    .map(([key]) => key);

  return { correct: mismatches.length === 0, mismatches };
}

export function gradeSemanticOrder(
  expected: string[],
  actual: string[],
): GradeResult {
  const mismatches: string[] = [];
  const maxLength = Math.max(expected.length, actual.length);

  for (let index = 0; index < maxLength; index += 1) {
    if (expected[index] !== actual[index]) {
      mismatches.push(`position:${index}`);
    }
  }

  return { correct: mismatches.length === 0, mismatches };
}

export function advanceHint(current: number): number {
  return Math.min(3, current + 1);
}

export function classifyLearningOutcome(input: {
  firstCorrect: boolean;
  hintLevel: number;
  isVariant: boolean;
  alreadyIndependent: boolean;
}): SkillLevel {
  if (!input.firstCorrect || input.hintLevel > 0) {
    return "guided";
  }

  if (input.isVariant && input.alreadyIndependent) {
    return "variant";
  }

  return "independent";
}

export function createEmptySkill(skillId: SkillId): SkillEvidence {
  return {
    skillId,
    level: "unseen",
    exposedCount: 0,
    guidedSuccessCount: 0,
    independentSuccessCount: 0,
    variantSuccessCount: 0,
  };
}

export function applySkillAttempt(
  current: SkillEvidence,
  input: {
    successful: boolean;
    firstCorrect: boolean;
    hintLevel: number;
    isVariant: boolean;
  },
): SkillEvidence {
  const next: SkillEvidence = {
    ...current,
    exposedCount: current.exposedCount + 1,
    level: current.level === "unseen" ? "exposed" : current.level,
  };

  if (!input.successful) {
    return next;
  }

  const outcome = classifyLearningOutcome({
    firstCorrect: input.firstCorrect,
    hintLevel: input.hintLevel,
    isVariant: input.isVariant,
    alreadyIndependent:
      current.independentSuccessCount > 0 || current.variantSuccessCount > 0,
  });

  if (outcome === "guided") {
    next.guidedSuccessCount += 1;
  } else if (outcome === "independent") {
    next.independentSuccessCount += 1;
  } else if (outcome === "variant") {
    next.variantSuccessCount += 1;
  }

  if (LEVEL_RANK[outcome] > LEVEL_RANK[next.level]) {
    next.level = outcome;
  }

  return next;
}

export function applyTransaction(
  state: GameState,
  transaction: TransactionRecord,
): GameState {
  if (state.completedTransactionIds.includes(transaction.id)) {
    return state;
  }

  const available = state.shelfInventory[transaction.productId] ?? 0;
  if (transaction.role === "seller" && available < transaction.quantity) {
    throw new Error(`Insufficient shelf stock for ${transaction.productId}`);
  }

  return {
    ...state,
    cashPence:
      state.cashPence +
      (transaction.role === "buyer"
        ? -(transaction.basePence + transaction.bonusPence)
        : transaction.basePence + transaction.bonusPence),
    shelfInventory:
      transaction.role === "seller"
        ? {
            ...state.shelfInventory,
            [transaction.productId]: available - transaction.quantity,
          }
        : state.shelfInventory,
    transactions: [...state.transactions, transaction],
    completedTransactionIds: [
      ...state.completedTransactionIds,
      transaction.id,
    ],
    updatedAt: new Date().toISOString(),
  };
}

export function calculateSettlement(state: GameState): SettlementSummary {
  const buyerTransactions = state.transactions.filter(
    (transaction) => transaction.role === "buyer",
  );
  const sellerTransactions = state.transactions.filter(
    (transaction) => transaction.role === "seller",
  );
  const procurementCostPence = buyerTransactions.reduce(
    (total, transaction) => total + transaction.basePence,
    0,
  );
  const salesPence = sellerTransactions.reduce(
    (total, transaction) => total + transaction.basePence,
    0,
  );
  const bonusPence = sellerTransactions.reduce(
    (total, transaction) => total + transaction.bonusPence,
    0,
  );
  const incorrectAttempts = sellerTransactions.filter(
    (transaction) => !transaction.firstCorrect,
  ).length;

  return {
    startingCashPence: 300,
    procurementCostPence,
    salesPence,
    bonusPence,
    endingCashPence: state.cashPence,
    satisfaction: Math.max(70, 100 - incorrectAttempts * 6),
    firstCorrectCount: sellerTransactions.filter(
      (transaction) => transaction.firstCorrect,
    ).length,
    repairCount: sellerTransactions.filter(
      (transaction) => transaction.repairSuccessful,
    ).length,
  };
}

export function qualifyingSkillCount(
  skills: Record<SkillId, SkillEvidence>,
): number {
  return Object.values(skills).filter(
    (skill) => LEVEL_RANK[skill.level] >= LEVEL_RANK.independent,
  ).length;
}

export function canUnlockUpgrade(
  cashPence: number,
  skills: Record<SkillId, SkillEvidence>,
  requiredCashPence = 500,
  requiredSkillCount = 3,
): { unlocked: boolean; cashReady: boolean; skillReady: boolean; skillCount: number } {
  const skillCount = qualifyingSkillCount(skills);
  const cashReady = cashPence >= requiredCashPence;
  const skillReady = skillCount >= requiredSkillCount;

  return {
    unlocked: cashReady && skillReady,
    cashReady,
    skillReady,
    skillCount,
  };
}
