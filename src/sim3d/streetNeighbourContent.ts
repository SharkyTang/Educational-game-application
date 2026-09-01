import corpusJson from "./streetNeighbourCorpus.json" with { type: "json" };

export type StreetNeighbourId = "sam" | "ellis";
export type StreetNeighbourVoice = "male" | "female";
export type StreetNeighbourScene =
  | "consent"
  | "chat"
  | "needs"
  | "dog"
  | "donationOne"
  | "donationTwo"
  | "alreadyHelped"
  | "noDonation"
  | "outreach";

export interface StreetNeighbourDogProfile {
  name: "Patch";
  model: "street-dog-patch.glb";
  height: number;
  /** Local x/z offset from Sam's actor root, not a world coordinate. */
  position: { x: number; z: number };
  yaw: number;
}

export interface StreetNeighbourProfile {
  id: StreetNeighbourId;
  name: string;
  model: string;
  height: number;
  /** World position on the pavement; chosen to keep the main route clear. */
  position: { x: number; z: number };
  yaw: number;
  voice: StreetNeighbourVoice;
  hasDog: boolean;
  dog?: StreetNeighbourDogProfile;
}

export interface StreetNeighbourSpeechClip {
  id: string;
  text: string;
  zh: string;
  src: string;
}

export interface StreetNeighbourDayInput {
  customerSeed?: number;
  dayNumber: number;
}

export interface StreetNeighbourSpeechInput extends StreetNeighbourDayInput {
  /** One-based counter for repeated conversations on the same day. */
  interactionNumber?: number;
}

type CorpusEntry = Omit<StreetNeighbourSpeechClip, "src">;
type ProfileCorpus = Partial<Record<StreetNeighbourScene, readonly CorpusEntry[]>>;
type StreetNeighbourCorpus = {
  version: number;
  profiles: Record<StreetNeighbourId, ProfileCorpus>;
};

const corpus = corpusJson as StreetNeighbourCorpus;
const LEGACY_STREET_NEIGHBOUR_SEED = 31;

export const STREET_NEIGHBOUR_PROFILES: readonly StreetNeighbourProfile[] = [
  {
    id: "sam",
    name: "Sam",
    model: "customer-male-04.glb",
    height: 1.78,
    position: { x: 13.25, z: -15.70 },
    yaw: -Math.PI / 2,
    voice: "male",
    hasDog: true,
    dog: {
      name: "Patch",
      model: "street-dog-patch.glb",
      height: .52,
      position: { x: .72, z: .18 },
      yaw: .18,
    },
  },
  {
    id: "ellis",
    name: "Ellis",
    model: "customer-female-04.glb",
    height: 1.68,
    position: { x: -6.55, z: -6.15 },
    yaw: Math.PI / 2,
    voice: "female",
    hasDog: false,
  },
] as const;

export const STREET_NEIGHBOUR_CORPUS = corpus.profiles;

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}必须是正整数。`);
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return result >>> 0;
}

/** Stable per save and alternates the two neighbours every in-game day. */
export function streetNeighbourForDay(input: StreetNeighbourDayInput): StreetNeighbourProfile {
  validatePositiveInteger(input.dayNumber, "营业日");
  const seed = input.customerSeed ?? LEGACY_STREET_NEIGHBOUR_SEED;
  const start = hash(`${seed}:street-neighbour`) % STREET_NEIGHBOUR_PROFILES.length;
  const dayOffset = (input.dayNumber - 1) % STREET_NEIGHBOUR_PROFILES.length;
  return STREET_NEIGHBOUR_PROFILES[(start + dayOffset) % STREET_NEIGHBOUR_PROFILES.length]!;
}

/** Deterministic local line selection; unsupported scenes (such as dog for Ellis) return null. */
export function streetNeighbourSpeechFor(
  neighbourId: StreetNeighbourId,
  scene: StreetNeighbourScene,
  input: StreetNeighbourSpeechInput,
): StreetNeighbourSpeechClip | null {
  validatePositiveInteger(input.dayNumber, "营业日");
  const interactionNumber = input.interactionNumber ?? 1;
  validatePositiveInteger(interactionNumber, "交谈次数");
  const entries = STREET_NEIGHBOUR_CORPUS[neighbourId][scene];
  if (!entries?.length) return null;
  const seed = input.customerSeed ?? LEGACY_STREET_NEIGHBOUR_SEED;
  const index = hash(`${seed}:${input.dayNumber}:${interactionNumber}:${neighbourId}:${scene}`) % entries.length;
  const entry = entries[index]!;
  return {
    ...entry,
    src: `/assets/sim3d/audio/street-neighbours/${neighbourId}/${entry.id}.wav`,
  };
}
