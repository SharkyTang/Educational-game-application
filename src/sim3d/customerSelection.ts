import corpus from "./customerCorpus.json" with { type: "json" };

export type CustomerVoice = "female" | "male";
export type CustomerScene = "greeting" | "checkout" | "thanks";
export interface CustomerProfile {
  id: string;
  name: string;
  voice: CustomerVoice;
  model: string;
  height: number;
}
export interface CustomerSpeechClip {
  id: string;
  text: string;
  zh: string;
  src: string;
}

/** Four separate adult meshes, not colour variants of the original woman. */
export const CUSTOMER_PROFILES: readonly CustomerProfile[] = [
  { id: "female-01", name: "Clara", voice: "female", model: "customer.glb", height: 1.68 },
  { id: "male-01", name: "Oliver", voice: "male", model: "customer-male-01.glb", height: 1.79 },
  { id: "female-02", name: "Amara", voice: "female", model: "customer-female-02.glb", height: 1.65 },
  { id: "male-02", name: "George", voice: "male", model: "customer-male-02.glb", height: 1.75 },
];

export const CUSTOMER_CORPUS = corpus.scenes;
export const CUSTOMER_WALK_SPEED = 1.41; // Was .94 m/s; +50%, independent of frame rate.
export const CUSTOMER_WALK_ANIMATION_RATE = 1.575; // Keep stride cadence with translation.
export const CUSTOMER_STOP_SECONDS = .35; // Was 1.1 s at every stage.
export const CUSTOMER_EXIT_STOP_SECONDS = .1;

const LEGACY_CUSTOMER_SEED = 31;
// Appearance and dialogue depend on visit identity, never on the shopping basket.
type VisitState = {
  customer: { number: number };
  customerSeed?: number;
  /** Older saves without a payment choice keep their original card dialogue. */
  payment?: { method: "card" | "cash"; tenderedPence?: number } | null;
};

/** Stored once per new game. Old snapshots have a stable fallback, not a new draw on load. */
export function createCustomerSeed(): number {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint32Array(1))[0]!;
  }
  return Math.floor(Math.random() * 0x1_0000_0000);
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return result >>> 0;
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let current = seed;
  const random = (): number => {
    current = (current + 0x6d2b79f5) >>> 0;
    let value = Math.imul(current ^ (current >>> 15), 1 | current);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

/**
 * A reproducible shuffle bag: exhaust the pool before reusing a line/model.
 * A boundary swap never touches the last item, so the previous bag's last item
 * can be computed in O(pool size), even for an imported large customer number.
 */
export function pickCustomerEntry<T>(values: readonly T[], seed: number, customerNumber: number, channel: string): T {
  if (!values.length) throw new Error("顾客语料或角色列表不能为空。");
  if (!Number.isSafeInteger(customerNumber) || customerNumber < 1) throw new Error("顾客序号无效。");
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return values[(customerNumber - 1 + (hash(`${seed}:${channel}`) % 2)) % 2]!;
  const index = customerNumber - 1;
  const round = Math.floor(index / values.length);
  const bag = shuffled(values, hash(`${seed}:${channel}:${round}`));
  if (round > 0) {
    const previous = shuffled(values, hash(`${seed}:${channel}:${round - 1}`));
    if (bag[0] === previous[previous.length - 1]) [bag[0], bag[1]] = [bag[1]!, bag[0]!];
  }
  return bag[index % values.length]!;
}

export function customerProfileFor(state: VisitState): CustomerProfile {
  return pickCustomerEntry(CUSTOMER_PROFILES, state.customerSeed ?? LEGACY_CUSTOMER_SEED, state.customer.number, "appearance");
}

export function customerSpeechFor(state: VisitState, scene: CustomerScene): CustomerSpeechClip {
  const pool = scene === "checkout" && state.payment?.method === "cash" ? "checkoutCash" : scene;
  const entry = pickCustomerEntry(CUSTOMER_CORPUS[pool], state.customerSeed ?? LEGACY_CUSTOMER_SEED, state.customer.number, pool);
  return withCustomerVoice(state, entry);
}

/** Fixed local lines describe the persisted tender, never a newly drawn amount. */
export function cashTenderSpeechFor(state: VisitState): CustomerSpeechClip | null {
  const tenderedPence = state.payment?.method === "cash" ? state.payment.tenderedPence : undefined;
  if (typeof tenderedPence !== "number" || !Number.isSafeInteger(tenderedPence) || tenderedPence <= 0) return null;
  const id = tenderedPence === 500 ? "tender-cash-five-pounds"
    : tenderedPence === 1000 ? "tender-cash-ten-pounds" : "tender-cash-exact-amount";
  const entry = CUSTOMER_CORPUS.tenderCash.find((phrase) => phrase.id === id);
  if (!entry) throw new Error("缺少现金交款语料。");
  return withCustomerVoice(state, entry);
}

function withCustomerVoice(state: VisitState, entry: Omit<CustomerSpeechClip, "src">): CustomerSpeechClip {
  const voice = customerProfileFor(state).voice;
  return { ...entry, src: `/assets/sim3d/audio/customers/${voice}/${entry.id}.wav` };
}
