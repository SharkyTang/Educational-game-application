import { describe, expect, it } from "vitest";

import {
  advanceHint,
  applySkillAttempt,
  applyTransaction,
  calculateSettlement,
  canUnlockUpgrade,
  createEmptySkill,
  formatMoney,
  gradeSemanticOrder,
  gradeSlots,
  qualifyingSkillCount,
} from "../../src/domain/rules";
import type {
  GameState,
  SkillEvidence,
  SkillId,
  SkillLevel,
  TransactionRecord,
} from "../../src/domain/types";
import { createInitialState } from "../../src/state/createInitialState";

const SKILL_IDS: SkillId[] = [
  "buyer.request_item_quantity",
  "seller.understand_item_quantity",
  "seller.checkout_details",
  "repair.request_repetition",
];

function transaction(
  overrides: Partial<TransactionRecord> = {},
): TransactionRecord {
  return {
    id: "transaction-1",
    taskId: "task-1",
    role: "seller",
    productId: "water",
    quantity: 1,
    firstCorrect: true,
    hintLevel: 0,
    replayCount: 0,
    repairAttempted: false,
    repairSuccessful: false,
    basePence: 100,
    bonusPence: 20,
    committedAt: "2026-08-29T08:00:00.000Z",
    ...overrides,
  };
}

function skillEvidence(
  skillId: SkillId,
  level: SkillLevel,
): SkillEvidence {
  return {
    skillId,
    level,
    exposedCount: level === "unseen" ? 0 : 1,
    guidedSuccessCount: level === "guided" ? 1 : 0,
    independentSuccessCount:
      level === "independent" || level === "variant" ? 1 : 0,
    variantSuccessCount: level === "variant" ? 1 : 0,
  };
}

function skillsAt(levels: SkillLevel[]): GameState["skills"] {
  return Object.fromEntries(
    SKILL_IDS.map((skillId, index) => [
      skillId,
      skillEvidence(skillId, levels[index] ?? "unseen"),
    ]),
  ) as GameState["skills"];
}

describe("slot and sequence grading", () => {
  it("treats false as a real expected boolean value, not as a missing slot", () => {
    expect(
      gradeSlots(
        { bag: false, receipt: true, payment: "card" },
        { bag: false, receipt: true, payment: "card" },
      ),
    ).toEqual({ correct: true, mismatches: [] });

    expect(
      gradeSlots(
        { bag: false, receipt: true },
        { bag: true, receipt: true },
      ),
    ).toEqual({ correct: false, mismatches: ["bag"] });

    expect(gradeSlots({ bag: false }, {})).toEqual({
      correct: false,
      mismatches: ["bag"],
    });
  });

  it("requires semantic chips in the exact order and detects missing or extra positions", () => {
    const expected = [
      "intent:request",
      "quantity:4",
      "product:water",
      "polite:please",
    ];

    expect(gradeSemanticOrder(expected, [...expected])).toEqual({
      correct: true,
      mismatches: [],
    });
    expect(
      gradeSemanticOrder(expected, [
        "intent:request",
        "product:water",
        "quantity:4",
        "polite:please",
      ]),
    ).toEqual({
      correct: false,
      mismatches: ["position:1", "position:2"],
    });
    expect(gradeSemanticOrder(expected, expected.slice(0, 3))).toEqual({
      correct: false,
      mismatches: ["position:3"],
    });
    expect(
      gradeSemanticOrder(expected, [...expected, "product:milk"]),
    ).toEqual({ correct: false, mismatches: ["position:4"] });
  });
});

describe("hint progression", () => {
  it("advances one level at a time and never exceeds the third hint", () => {
    expect(advanceHint(0)).toBe(1);
    expect(advanceHint(1)).toBe(2);
    expect(advanceHint(2)).toBe(3);
    expect(advanceHint(3)).toBe(3);
    expect(advanceHint(99)).toBe(3);
  });
});

describe("skill evidence", () => {
  it("records a first-try unprompted success as independent", () => {
    const empty = createEmptySkill("buyer.request_item_quantity");
    const result = applySkillAttempt(empty, {
      successful: true,
      firstCorrect: true,
      hintLevel: 0,
      isVariant: false,
    });

    expect(result).toEqual({
      skillId: "buyer.request_item_quantity",
      level: "independent",
      exposedCount: 1,
      guidedSuccessCount: 0,
      independentSuccessCount: 1,
      variantSuccessCount: 0,
    });
    expect(empty).toEqual(createEmptySkill("buyer.request_item_quantity"));
  });

  it.each([
    {
      label: "used a hint",
      firstCorrect: true,
      hintLevel: 1,
    },
    {
      label: "needed another attempt",
      firstCorrect: false,
      hintLevel: 0,
    },
  ])("records a successful attempt as guided when it $label", (input) => {
    const result = applySkillAttempt(
      createEmptySkill("seller.checkout_details"),
      {
        successful: true,
        firstCorrect: input.firstCorrect,
        hintLevel: input.hintLevel,
        isVariant: false,
      },
    );

    expect(result.level).toBe("guided");
    expect(result.guidedSuccessCount).toBe(1);
    expect(result.independentSuccessCount).toBe(0);
  });

  it("only awards variant after prior independent evidence", () => {
    const empty = createEmptySkill("seller.understand_item_quantity");
    const firstVariant = applySkillAttempt(empty, {
      successful: true,
      firstCorrect: true,
      hintLevel: 0,
      isVariant: true,
    });
    const laterVariant = applySkillAttempt(firstVariant, {
      successful: true,
      firstCorrect: true,
      hintLevel: 0,
      isVariant: true,
    });

    expect(firstVariant.level).toBe("independent");
    expect(firstVariant.independentSuccessCount).toBe(1);
    expect(firstVariant.variantSuccessCount).toBe(0);
    expect(laterVariant.level).toBe("variant");
    expect(laterVariant.independentSuccessCount).toBe(1);
    expect(laterVariant.variantSuccessCount).toBe(1);
  });

  it("never downgrades stronger evidence after a guided or failed attempt", () => {
    const current = skillEvidence(
      "seller.understand_item_quantity",
      "variant",
    );
    const afterGuided = applySkillAttempt(current, {
      successful: true,
      firstCorrect: false,
      hintLevel: 2,
      isVariant: false,
    });
    const afterFailure = applySkillAttempt(afterGuided, {
      successful: false,
      firstCorrect: false,
      hintLevel: 3,
      isVariant: false,
    });

    expect(afterGuided.level).toBe("variant");
    expect(afterGuided.guidedSuccessCount).toBe(1);
    expect(afterFailure.level).toBe("variant");
    expect(afterFailure.exposedCount).toBe(current.exposedCount + 2);
  });
});

describe("transactions", () => {
  it("commits a seller transaction exactly once for the same id", () => {
    const state = createInitialState();
    state.shelfInventory.water = 2;
    const sale = transaction({ id: "sale-water-1", quantity: 1 });

    const once = applyTransaction(state, sale);
    const twice = applyTransaction(once, sale);

    expect(once.cashPence).toBe(state.cashPence + 120);
    expect(once.shelfInventory.water).toBe(1);
    expect(once.transactions).toEqual([sale]);
    expect(once.completedTransactionIds).toEqual([sale.id]);
    expect(twice).toBe(once);
    expect(state.cashPence).toBe(300);
    expect(state.shelfInventory.water).toBe(2);
  });

  it("rejects a sale with insufficient shelf stock without mutating state", () => {
    const state = createInitialState();
    state.shelfInventory.water = 1;
    const before = structuredClone(state);
    const oversizedSale = transaction({
      id: "sale-water-too-many",
      quantity: 2,
    });

    expect(() => applyTransaction(state, oversizedSale)).toThrowError(
      "Insufficient shelf stock for water",
    );
    expect(state).toEqual(before);
  });
});

describe("settlement", () => {
  it("totals exact integer pence and reports first-correct and repair evidence", () => {
    const state = createInitialState();
    state.cashPence = 485;
    state.transactions = [
      transaction({
        id: "procurement",
        role: "buyer",
        quantity: 4,
        basePence: 205,
        bonusPence: 0,
      }),
      transaction({
        id: "sale-1",
        productId: "milk",
        basePence: 150,
        bonusPence: 20,
        firstCorrect: true,
      }),
      transaction({
        id: "sale-2",
        productId: "crisps",
        basePence: 120,
        bonusPence: 20,
        firstCorrect: false,
        repairAttempted: true,
        repairSuccessful: true,
      }),
    ];

    const summary = calculateSettlement(state);

    expect(summary).toEqual({
      startingCashPence: 300,
      procurementCostPence: 205,
      salesPence: 270,
      bonusPence: 40,
      endingCashPence: 485,
      satisfaction: 94,
      firstCorrectCount: 1,
      repairCount: 1,
    });
    expect(
      Object.values(summary).every((value) => Number.isInteger(value)),
    ).toBe(true);
    expect(formatMoney(305)).toBe("£3.05");
  });
});

describe("upgrade gate", () => {
  it("counts only independent and variant skills as qualifying", () => {
    const skills = skillsAt([
      "independent",
      "variant",
      "guided",
      "exposed",
    ]);

    expect(qualifyingSkillCount(skills)).toBe(2);
  });

  it("requires cash and skill thresholds together, inclusively", () => {
    const twoSkills = skillsAt([
      "independent",
      "variant",
      "guided",
      "unseen",
    ]);
    const threeSkills = skillsAt([
      "independent",
      "variant",
      "independent",
      "guided",
    ]);

    expect(canUnlockUpgrade(500, twoSkills)).toEqual({
      unlocked: false,
      cashReady: true,
      skillReady: false,
      skillCount: 2,
    });
    expect(canUnlockUpgrade(499, threeSkills)).toEqual({
      unlocked: false,
      cashReady: false,
      skillReady: true,
      skillCount: 3,
    });
    expect(canUnlockUpgrade(500, threeSkills)).toEqual({
      unlocked: true,
      cashReady: true,
      skillReady: true,
      skillCount: 3,
    });
  });
});
