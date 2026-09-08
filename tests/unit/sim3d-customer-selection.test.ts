import { asV14BusinessSnapshot } from "../helpers/sim3dDelivery";
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_CONTENT_VERSION, CUSTOMER_CORPUS, CUSTOMER_PROFILES, CUSTOMER_STOP_SECONDS, CUSTOMER_WALK_SPEED,
  LEGACY_CUSTOMER_CORPUS_LENGTHS, LEGACY_CUSTOMER_PROFILES,
  cashTenderSpeechFor, createCustomerSeed, customerProfileFor, customerSpeechFor,
  pickCustomerEntry, type CustomerScene,
} from "../../src/sim3d/customerSelection";
import { createFirstDayState, reduceSim, validateSimState, validateV4SimState, validateV5SimState } from "../../src/sim3d/domain";
import { parseImportedSimState } from "../../src/sim3d/persistence";

const SCENES: CustomerScene[] = ["greeting", "checkout", "thanks"];

describe("saved customer variety and scene-specific shuffle bags", () => {
  it("ships six shopping profiles while preserving the original four-profile v1 pool", () => {
    expect(CUSTOMER_CONTENT_VERSION).toBe(2);
    expect(CUSTOMER_PROFILES).toHaveLength(6);
    expect(new Set(CUSTOMER_PROFILES.map((entry) => entry.id)).size).toBe(6);
    expect(new Set(CUSTOMER_PROFILES.map((entry) => entry.model)).size).toBe(6);
    expect(CUSTOMER_PROFILES.filter((entry) => entry.voice === "female")).toHaveLength(3);
    expect(CUSTOMER_PROFILES.filter((entry) => entry.voice === "male")).toHaveLength(3);
    expect(CUSTOMER_PROFILES.every((entry) => entry.height >= 1.6 && entry.height <= 1.9)).toBe(true);
    expect(LEGACY_CUSTOMER_PROFILES).toEqual(CUSTOMER_PROFILES.slice(0, 4));
    expect(LEGACY_CUSTOMER_PROFILES.map((entry) => entry.id)).toEqual(["female-01", "male-01", "female-02", "male-02"]);
  });

  it.each([0, 1, 31, 77, 0xffffffff])("shows every v2 model within six visits, without boundary repeats (seed %i)", (customerSeed) => {
    const initial = createFirstDayState();
    const state = { ...initial, customerSeed, customer: { ...initial.customer, contentVersion: 2 as const } };
    const visitors = Array.from({ length: 200 }, (_, index) => customerProfileFor({ ...state, customer: { ...state.customer, number: index + 1 } }));
    for (let index = 1; index < visitors.length; index += 1) expect(visitors[index]!.id).not.toBe(visitors[index - 1]!.id);
    for (let start = 0; start < visitors.length; start += 6) {
      const bag = visitors.slice(start, start + 6);
      expect(new Set(bag.map((entry) => entry.id)).size).toBe(bag.length);
    }
    // With three of each in the bag, any first four visits include both voices.
    expect(new Set(visitors.slice(0, 4).map((entry) => entry.voice)).size).toBe(2);
  });

  it("keeps v1 and missing-version visitors on the exact original appearance pool", () => {
    for (const contentVersion of [undefined, 1] as const) {
      const ids = Array.from({ length: 120 }, (_, index) => customerProfileFor({
        customerSeed: 31,
        customer: { number: index + 1, ...(contentVersion === undefined ? {} : { contentVersion }) },
      }).id);
      expect(new Set(ids)).toEqual(new Set(LEGACY_CUSTOMER_PROFILES.map((entry) => entry.id)));
      for (let start = 0; start < ids.length; start += 4) expect(new Set(ids.slice(start, start + 4)).size).toBe(4);
    }
  });

  it.each(SCENES)("uses every %s line before repeating and does not repeat across bags", (scene) => {
    const pool = CUSTOMER_CORPUS[scene];
    for (const customerSeed of [0, 31, 9001, 0xffffffff]) {
      const initial = createFirstDayState();
      const state = { ...initial, customerSeed, customer: { ...initial.customer, contentVersion: 2 as const } };
      const ids = Array.from({ length: pool.length * 10 }, (_, index) => customerSpeechFor({ ...state, customer: { ...state.customer, number: index + 1 } }, scene).id);
      for (let index = 1; index < ids.length; index += 1) expect(ids[index]).not.toBe(ids[index - 1]);
      for (let start = 0; start < ids.length; start += pool.length) expect(new Set(ids.slice(start, start + pool.length)).size).toBe(pool.length);
    }
  });

  it("keeps v1 dialogue on every original pool length while v2 exposes all ten additions", () => {
    expect(CUSTOMER_CORPUS.greeting).toHaveLength(11);
    expect(CUSTOMER_CORPUS.checkout).toHaveLength(14);
    expect(CUSTOMER_CORPUS.checkoutCash).toHaveLength(6);
    expect(CUSTOMER_CORPUS.thanks).toHaveLength(11);
    expect(CUSTOMER_CORPUS.tenderCash).toHaveLength(3);
    const pools = [
      ["greeting", "greeting", undefined],
      ["checkout", "checkout", { method: "card" as const }],
      ["checkoutCash", "checkout", { method: "cash" as const, tenderedPence: 500 }],
      ["thanks", "thanks", undefined],
    ] as const;
    for (const [poolName, scene, payment] of pools) {
      const legacyPool = CUSTOMER_CORPUS[poolName].slice(0, LEGACY_CUSTOMER_CORPUS_LENGTHS[poolName]);
      const ids = Array.from({ length: legacyPool.length * 5 }, (_, index) => customerSpeechFor({
        customerSeed: 31,
        customer: { number: index + 1, contentVersion: 1 },
        ...(payment ? { payment } : {}),
      }, scene).id);
      expect(new Set(ids)).toEqual(new Set(legacyPool.map((entry) => entry.id)));
      for (let start = 0; start < ids.length; start += legacyPool.length) {
        expect(new Set(ids.slice(start, start + legacyPool.length)).size).toBe(legacyPool.length);
      }
      const v2Ids = Array.from({ length: CUSTOMER_CORPUS[poolName].length }, (_, index) => customerSpeechFor({
        customerSeed: 31,
        customer: { number: index + 1, contentVersion: 2 },
        ...(payment ? { payment } : {}),
      }, scene).id);
      expect(new Set(v2Ids)).toEqual(new Set(CUSTOMER_CORPUS[poolName].map((entry) => entry.id)));
    }
  });

  it("selects captions and audio from the same entry and the current customer's voice", () => {
    for (let number = 1; number <= 30; number += 1) {
      const state = { ...createFirstDayState(), customerSeed: 22, customer: { phase: "checkout" as const, number, contentVersion: 2 as const } };
      const profile = customerProfileFor(state);
      for (const scene of SCENES) {
        const clip = customerSpeechFor(state, scene);
        const entry = CUSTOMER_CORPUS[scene].find((candidate) => candidate.id === clip.id);
        expect(entry).toBeDefined();
        expect(clip.text).toBe(entry!.text);
        expect(clip.zh).toBe(entry!.zh);
        expect(clip.src).toBe(`/assets/sim3d/audio/customers/${profile.voice}/${clip.id}.wav`);
      }
    }
  });

  it("filters checkout dialogue by the saved payment choice, defaulting old visitors to card", () => {
    for (let number = 1; number <= 40; number += 1) {
      const state = { customerSeed: 22, customer: { number, contentVersion: 2 as const } };
      const oldClip = customerSpeechFor(state, "checkout");
      expect(oldClip.text).toMatch(/\bcard\b/i);
      expect(customerSpeechFor({ ...state, payment: null }, "checkout")).toEqual(oldClip);
      expect(customerSpeechFor({ ...state, payment: { method: "card" } }, "checkout")).toEqual(oldClip);
      const cash = { ...state, payment: { method: "cash" as const, tenderedPence: 500 } };
      const clip = customerSpeechFor(cash, "checkout");
      expect(CUSTOMER_CORPUS.checkoutCash).toContainEqual({ id: clip.id, text: clip.text, zh: clip.zh });
      expect(clip.text).toMatch(/\bcash\b/i);
      expect(clip.text).not.toMatch(/\bcard\b/i);
      expect(clip.src).toBe(`/assets/sim3d/audio/customers/${customerProfileFor(cash).voice}/${clip.id}.wav`);
      for (const scene of ["greeting", "thanks"] as const) {
        expect(customerSpeechFor(cash, scene)).toEqual(customerSpeechFor(state, scene));
      }
    }
  });

  it("keeps cash request selection stable and uses the entire cash-only shuffle bag", () => {
    const pool = CUSTOMER_CORPUS.checkoutCash;
    for (const customerSeed of [0, 31, 9001, 0xffffffff]) {
      const ids = Array.from({ length: pool.length * 10 }, (_, index) => {
        const state = { customerSeed, customer: { number: index + 1, contentVersion: 2 as const }, payment: { method: "cash" as const, tenderedPence: 500 } };
        const before = customerSpeechFor(state, "checkout");
        expect(customerSpeechFor(JSON.parse(JSON.stringify(state)), "checkout")).toEqual(before);
        const receiving = { ...state, payment: { ...state.payment, received: true, selectedChange: [50, 10, 5] } };
        expect(customerSpeechFor(receiving, "checkout")).toEqual(before);
        return before.id;
      });
      for (let index = 1; index < ids.length; index += 1) expect(ids[index]).not.toBe(ids[index - 1]);
      for (let start = 0; start < ids.length; start += pool.length) expect(new Set(ids.slice(start, start + pool.length)).size).toBe(pool.length);
    }
  });

  it.each([
    [500, "tender-cash-five-pounds", "Here's five pounds."],
    [1000, "tender-cash-ten-pounds", "Here's ten pounds."],
    [435, "tender-cash-exact-amount", "I have the exact amount."],
    [1200, "tender-cash-exact-amount", "I have the exact amount."],
  ] as const)("uses the saved %ip tender's exact subtitle and matching local voice", (tenderedPence, id, text) => {
    const seenVoices = new Set<string>();
    for (let number = 1; number <= 8; number += 1) {
      const state = { customerSeed: 32, customer: { number, contentVersion: 2 as const }, payment: { method: "cash" as const, tenderedPence } };
      const voice = customerProfileFor(state).voice;
      seenVoices.add(voice);
      const clip = cashTenderSpeechFor(state);
      expect(clip).toEqual({ ...CUSTOMER_CORPUS.tenderCash.find((entry) => entry.id === id)!, src: `/assets/sim3d/audio/customers/${voice}/${id}.wav` });
      expect(clip?.text).toBe(text);
      expect(cashTenderSpeechFor(JSON.parse(JSON.stringify(state)))).toEqual(clip);
      const receiving = { ...state, payment: { ...state.payment, received: true, selectedChange: [5, 10] } };
      expect(cashTenderSpeechFor(receiving)).toEqual(clip);
    }
    expect([...seenVoices].sort()).toEqual(["female", "male"]);
  });

  it("does not invent a cash tender line for legacy/card visitors or invalid cash amounts", () => {
    const state = { customer: { number: 1 } };
    expect(cashTenderSpeechFor(state)).toBeNull();
    expect(cashTenderSpeechFor({ ...state, payment: null })).toBeNull();
    expect(cashTenderSpeechFor({ ...state, payment: { method: "card" } })).toBeNull();
    expect(cashTenderSpeechFor({ ...state, payment: { method: "cash" } })).toBeNull();
    for (const tenderedPence of [0, -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(cashTenderSpeechFor({ ...state, payment: { method: "cash", tenderedPence } })).toBeNull();
    }
  });

  it("keeps the same visitor and words across redraw, saving, import and re-listening", () => {
    const state = { ...createFirstDayState(), customerSeed: 239 };
    const before = SCENES.map((scene) => customerSpeechFor(state, scene));
    const updated = reduceSim(state, { type: "SAVE_POSE", pose: { x: 0, z: -3, yaw: .2, pitch: .1 } }).state;
    const restored = parseImportedSimState(JSON.stringify(updated));
    expect(restored.customerSeed).toBe(239);
    expect(customerProfileFor(restored)).toEqual(customerProfileFor(state));
    expect(SCENES.map((scene) => customerSpeechFor(restored, scene))).toEqual(before);
  });

  it.each([4, 5])("accepts original v%i saves without inventing cash, stock, or a new random choice on load", (schemaVersion) => {
    const current = createFirstDayState();
    const { payment: _payment, recyclingBatches: _batches, recyclingRecords: _records,
      cashJournal: _cashJournal, cashReservePence: _cashReservePence, day, ...previous } = asV14BusinessSnapshot(current);
    const old = {
      ...previous, schemaVersion,
      customer: { phase: current.customer.phase, number: current.customer.number },
      day: {
        number: day.number, phase: "preparing", targetCustomers: 3,
        transactionStart: day.transactionStart, purchaseStart: day.purchaseStart,
        openingCashPence: day.openingCashPence, openingStockUnits: day.openingStockUnits,
        openingInventoryValuePence: day.openingInventoryValuePence,
      },
    };
    expect(old.customerSeed).toBeUndefined();
    expect(old.day).not.toHaveProperty("elapsedOpenMs");
    expect(schemaVersion === 4 ? validateV4SimState(old) : validateV5SimState(old)).toBe(true);
    const restored = parseImportedSimState(JSON.stringify(old));
    const expected = { ...current, customer: { ...current.customer, contentVersion: 1 as const } };
    expect(restored).toEqual(expected);
    expect(customerProfileFor(restored)).toEqual(customerProfileFor(expected));
    expect(customerSpeechFor(restored, "checkout")).toEqual(customerSpeechFor(expected, "checkout"));
  });

  it.each([-1, 0x1_0000_0000, 1.5, null, "31", {}, Infinity, NaN])("rejects invalid presentation seed %s without relaxing the ledger validator", (customerSeed) => {
    expect(validateSimState({ ...createFirstDayState(), customerSeed })).toBe(false);
  });

  it("gives different saved seeds different schedules while large visit numbers remain bounded", () => {
    const schedules = new Set(Array.from({ length: 20 }, (_, customerSeed) => Array.from({ length: 12 }, (_, index) => {
      const state = { ...createFirstDayState(), customerSeed, customer: { phase: "outside" as const, number: index + 1, contentVersion: 2 as const } };
      return `${customerProfileFor(state).id}:${customerSpeechFor(state, "checkout").id}`;
    }).join("|")));
    expect(schedules.size).toBe(20);
    const huge = { ...createFirstDayState(), customer: { phase: "outside" as const, number: Number.MAX_SAFE_INTEGER, contentVersion: 2 as const } };
    expect(CUSTOMER_PROFILES).toContain(customerProfileFor(huge));
    expect(CUSTOMER_CORPUS.checkout.some((entry) => entry.id === customerSpeechFor(huge, "checkout").id)).toBe(true);
  });

  it("supports small future pools and fails clearly on an empty pool or invalid visit", () => {
    expect(pickCustomerEntry(["a"], 31, 999, "test")).toBe("a");
    const pair = Array.from({ length: 20 }, (_, index) => pickCustomerEntry(["a", "b"], 31, index + 1, "test"));
    pair.slice(1).forEach((entry, index) => expect(entry).not.toBe(pair[index]));
    expect(() => pickCustomerEntry([], 31, 1, "test")).toThrow("不能为空");
    expect(() => pickCustomerEntry(["a"], 31, 0, "test")).toThrow("序号无效");
  });

  it("creates a uint32 seed once from browser randomness and does not need a network service", () => {
    const getRandomValues = vi.fn((values: Uint32Array) => { values[0] = 0xffffffff; return values });
    vi.stubGlobal("crypto", { getRandomValues });
    try {
      expect(createCustomerSeed()).toBe(0xffffffff);
      expect(getRandomValues).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals() }
  });

  it("retains faster walking and short route stops independently of business-day arrival intervals", () => {
    expect(CUSTOMER_WALK_SPEED).toBeCloseTo(1.7);
    expect(CUSTOMER_STOP_SECONDS).toBeLessThan(.5);
  });
});
