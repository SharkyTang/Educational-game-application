import { describe, expect, it } from "vitest";
import corpus from "../../src/sim3d/streetNeighbourCorpus.json";
import {
  STREET_NEIGHBOUR_PROFILES,
  streetNeighbourForDay,
  streetNeighbourSpeechFor,
  type StreetNeighbourId,
  type StreetNeighbourScene,
} from "../../src/sim3d/streetNeighbourContent";

const PROFILE_IDS = ["sam", "ellis"] as const satisfies readonly StreetNeighbourId[];
const SHARED_SCENES = [
  "consent", "chat", "needs", "donationOne", "donationTwo", "alreadyHelped", "noDonation", "outreach",
] as const satisfies readonly StreetNeighbourScene[];

describe("respectful, deterministic street-neighbour content", () => {
  it("defines two named adult neighbours with safe street placements and only Sam's companion dog", () => {
    expect(STREET_NEIGHBOUR_PROFILES.map((profile) => profile.id)).toEqual(PROFILE_IDS);
    expect(STREET_NEIGHBOUR_PROFILES.map((profile) => profile.name)).toEqual(["Sam", "Ellis"]);
    expect(STREET_NEIGHBOUR_PROFILES.map((profile) => profile.model)).toEqual([
      "customer-male-04.glb", "customer-female-04.glb",
    ]);
    expect(STREET_NEIGHBOUR_PROFILES.map((profile) => profile.voice)).toEqual(["male", "female"]);
    for (const profile of STREET_NEIGHBOUR_PROFILES) {
      expect(profile.height).toBeGreaterThan(1.5);
      expect(profile.height).toBeLessThan(2);
      expect(Number.isFinite(profile.position.x)).toBe(true);
      expect(Number.isFinite(profile.position.z)).toBe(true);
      expect(Number.isFinite(profile.yaw)).toBe(true);
    }
    const sam = STREET_NEIGHBOUR_PROFILES[0]!;
    expect(sam).toMatchObject({ id: "sam", hasDog: true, position: { x: 13.25, z: -15.7 } });
    expect(sam.dog).toEqual({
      name: "Patch", model: "street-dog-patch.glb", height: .52,
      position: { x: .72, z: .18 }, yaw: .18,
    });
    expect(STREET_NEIGHBOUR_PROFILES[1]).toMatchObject({
      id: "ellis", hasDog: false, position: { x: -6.55, z: -6.15 },
    });
    expect(STREET_NEIGHBOUR_PROFILES[1]!.dog).toBeUndefined();
  });

  it("keeps a stable save-specific start and alternates neighbours every business day", () => {
    for (const customerSeed of [0, 1, 31, 123456, 0xffff_ffff]) {
      const first = streetNeighbourForDay({ customerSeed, dayNumber: 1 });
      const second = streetNeighbourForDay({ customerSeed, dayNumber: 2 });
      const third = streetNeighbourForDay({ customerSeed, dayNumber: 3 });
      expect(second.id).not.toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(streetNeighbourForDay({ customerSeed, dayNumber: 1 })).toBe(first);
    }
    expect(streetNeighbourForDay({ dayNumber: 4 })).toBe(streetNeighbourForDay({ dayNumber: 4 }));
    expect(STREET_NEIGHBOUR_PROFILES).toContain(streetNeighbourForDay({ dayNumber: Number.MAX_SAFE_INTEGER }));
    expect(() => streetNeighbourForDay({ dayNumber: 0 })).toThrow("营业日必须是正整数");
    expect(() => streetNeighbourForDay({ dayNumber: 1.5 })).toThrow("营业日必须是正整数");
  });

  it("keeps one versioned bilingual corpus with unique IDs and ordinary, non-stigmatising language", () => {
    expect(corpus.version).toBe(1);
    expect(Object.keys(corpus).sort()).toEqual(["profiles", "version"]);
    expect(Object.keys(corpus.profiles)).toEqual(PROFILE_IDS);
    const phrases = Object.entries(corpus.profiles).flatMap(([profileId, scenes]) =>
      Object.entries(scenes).flatMap(([scene, entries]) => entries.map((entry) => ({ profileId, scene, ...entry }))),
    );
    expect(phrases).toHaveLength(41);
    expect(new Set(phrases.map((phrase) => phrase.id)).size).toBe(phrases.length);
    expect(new Set(phrases.map((phrase) => phrase.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())).size)
      .toBe(phrases.length);
    for (const phrase of phrases) {
      expect(Object.keys(phrase).sort()).toEqual(["id", "profileId", "scene", "text", "zh"]);
      expect(phrase.id).toMatch(new RegExp(`^${phrase.profileId}-[a-z]+(?:-[a-z]+)*$`));
      expect(phrase.text).toBe(phrase.text.trim());
      expect(phrase.text).toMatch(/[A-Za-z]/);
      expect(phrase.zh).toBe(phrase.zh.trim());
      expect(phrase.zh).toMatch(/\p{Script=Han}/u);
      expect(`${phrase.text} ${phrase.zh}`).not.toMatch(/\b(the homeless|beggar|vagrant|deserve|charity case)\b|流浪汉|乞丐/i);
    }
    expect(Object.keys(corpus.profiles.sam)).toEqual([...SHARED_SCENES.slice(0, 3), "dog", ...SHARED_SCENES.slice(3)]);
    expect(Object.keys(corpus.profiles.ellis)).toEqual(SHARED_SCENES);
    expect(corpus.profiles.sam.dog.every((phrase) => /Patch/.test(phrase.text))).toBe(true);
    expect(corpus.profiles.sam.dog.some((phrase) => /ask me before petting/i.test(phrase.text))).toBe(true);
  });

  it("maps each scene to a stable local clip and never invents dog dialogue for Ellis", () => {
    for (const profileId of PROFILE_IDS) {
      for (const scene of SHARED_SCENES) {
        const clips = Array.from({ length: 16 }, (_, index) => streetNeighbourSpeechFor(profileId, scene, {
          customerSeed: 91234, dayNumber: 7, interactionNumber: index + 1,
        }));
        expect(clips.every(Boolean)).toBe(true);
        const entries = corpus.profiles[profileId][scene];
        expect(new Set(clips.map((clip) => clip!.id))).toEqual(new Set(entries.map((entry) => entry.id)));
        for (const clip of clips) {
          expect(clip!.src).toBe(`/assets/sim3d/audio/street-neighbours/${profileId}/${clip!.id}.wav`);
          expect(entries).toContainEqual({ id: clip!.id, text: clip!.text, zh: clip!.zh });
        }
        expect(streetNeighbourSpeechFor(profileId, scene, { customerSeed: 91234, dayNumber: 7, interactionNumber: 3 }))
          .toEqual(clips[2]);
      }
    }
    expect(streetNeighbourSpeechFor("sam", "dog", { dayNumber: 1 })).not.toBeNull();
    expect(streetNeighbourSpeechFor("ellis", "dog", { dayNumber: 1 })).toBeNull();
    expect(() => streetNeighbourSpeechFor("sam", "chat", { dayNumber: 1, interactionNumber: 0 }))
      .toThrow("交谈次数必须是正整数");
  });

  it("keeps help optional, exact and free from blame or escalating rewards", () => {
    for (const profileId of PROFILE_IDS) {
      const profile = corpus.profiles[profileId];
      expect(profile.consent.some((phrase) => /chat|talk/i.test(phrase.text))).toBe(true);
      expect(profile.donationOne.some((phrase) => /pound/i.test(phrase.text))).toBe(true);
      expect(profile.donationTwo.some((phrase) => /two pounds/i.test(phrase.text))).toBe(true);
      expect(profile.alreadyHelped.every((phrase) => /already|enough/i.test(phrase.text))).toBe(true);
      expect(profile.noDonation.every((phrase) => /no worries|all right|fine|no problem/i.test(phrase.text))).toBe(true);
      expect(profile.noDonation.every((phrase) => !/money|pound|give|should|disappoint|sorry/i.test(phrase.text))).toBe(true);
      expect(profile.outreach.some((phrase) => /ask me|check with me/i.test(phrase.text))).toBe(true);
    }
  });
});
