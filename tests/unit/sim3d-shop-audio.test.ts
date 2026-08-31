import { describe, expect, it, vi } from "vitest";
import { ShopAudio, type ShopAudioSettings, type ShopEffect } from "../../src/sim3d/shopAudio";

/** Tiny Web Audio boundary doubles; the actual ShopAudio state machine is tested. */
class Parameter {
  value = 1;
  cancelScheduledValues = vi.fn();
  cancelAndHoldAtTime = vi.fn();
  setValueAtTime = vi.fn((value: number, _time: number) => { this.value = value });
  setTargetAtTime = vi.fn((value: number, _time: number, _constant: number) => { this.value = value });
  linearRampToValueAtTime = vi.fn((value: number, _time: number) => { this.value = value });
  exponentialRampToValueAtTime = vi.fn((value: number, _time: number) => { this.value = value });
}

class Node {
  connect = vi.fn();
  disconnect = vi.fn();
}

class Gain extends Node { gain = new Parameter() }

class Source extends Node {
  buffer: AudioBuffer | null = null;
  loop = false;
  onended: (() => void) | null = null;
  running = false;
  start = vi.fn((_when: number, _offset: number) => {
    if (this.context.failStart) throw new Error("source could not start");
    this.running = true;
  });
  stop = vi.fn(() => { this.running = false });
  constructor(private readonly context: Context) { super() }
}

class Oscillator extends Node {
  type: OscillatorType = "sine";
  frequency = new Parameter();
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  end(): void { this.onended?.() }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no });
  return { promise, resolve, reject };
}

const buffer = { duration: 60 } as AudioBuffer;
const bytes = new ArrayBuffer(8);
const defaults: ShopAudioSettings = { musicEnabled: true, musicVolume: .22, effectsVolume: .5 };

class Context {
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  readonly gains: Gain[] = [];
  readonly sources: Source[] = [];
  readonly oscillators: Oscillator[] = [];
  failStart = false;
  resume = vi.fn(async () => { this.changeState("running") });
  suspend = vi.fn(async () => { this.changeState("suspended") });
  close = vi.fn(async () => { this.changeState("closed") });
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => buffer);
  createGain(): Gain { const node = new Gain(); this.gains.push(node); return node }
  createBufferSource(): Source { const node = new Source(this); this.sources.push(node); return node }
  createOscillator(): Oscillator { const node = new Oscillator(); this.oscillators.push(node); return node }
  changeState(state: AudioContextState): void { this.state = state; this.onstatechange?.() }
  get musicGain(): Parameter { return this.gains[0]!.gain }
  get effectsGain(): Parameter { return this.gains[1]!.gain }
  get playing(): Source[] { return this.sources.filter((source) => source.running) }
}

function setup() {
  const context = new Context();
  const onStatus = vi.fn<(status: string) => void>();
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const fetchMusic = vi.fn(async (_url: string, _signal: AbortSignal) => bytes);
  const audio = new ShopAudio({ onStatus }, { createContext, fetchMusic });
  return { audio, context, onStatus, createContext, fetchMusic };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 12; i += 1) await Promise.resolve() };
const start = async (audio: ShopAudio): Promise<void> => { audio.setActive(true); audio.unlock(); await settle() };

describe("shop background music lifecycle", () => {
  it("does not create audio or download before the first user gesture, then starts one continuously looping buffer", async () => {
    const { audio, context, onStatus, createContext, fetchMusic } = setup();
    audio.setSettings(defaults);
    audio.setActive(true);
    expect(createContext).not.toHaveBeenCalled();
    expect(fetchMusic).not.toHaveBeenCalled();
    audio.unlock();
    expect(context.resume).toHaveBeenCalledOnce(); // Synchronous inside unlock, before awaiting.
    await settle();
    expect(fetchMusic).toHaveBeenCalledWith("/assets/sim3d/audio/local-forecast.mp3", expect.any(AbortSignal));
    expect(context.decodeAudioData).toHaveBeenCalledWith(bytes);
    expect(context.playing).toHaveLength(1);
    const source = context.sources[0]!;
    expect(source.buffer).toBe(buffer);
    expect(source.loop).toBe(true);
    expect(source.start).toHaveBeenCalledWith(0, 0);
    context.currentTime = 125;
    audio.setActive(true);
    audio.unlock();
    audio.unlock();
    audio.setSettings(defaults);
    await settle();
    expect(context.sources).toHaveLength(1);
    expect(fetchMusic).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 循环播放");
  });

  it("also accepts unlock before setActive within the same click", async () => {
    const { audio, context } = setup();
    audio.unlock();
    audio.setActive(true);
    await settle();
    expect(context.playing).toHaveLength(1);
  });

  it("stops music and every scheduled effect synchronously on pause, then resumes the saved loop offset", async () => {
    const { audio, context } = setup();
    await start(audio);
    audio.playEffect("doorbell");
    context.currentTime = 73.25;
    audio.setActive(false);
    expect(context.playing).toHaveLength(0);
    expect(context.sources[0]!.stop).toHaveBeenCalledOnce();
    expect(context.oscillators.every((node) => node.stop.mock.calls.some((args) => args.length === 0))).toBe(true);
    expect(context.musicGain.value).toBe(0);
    expect(context.effectsGain.value).toBe(0);
    expect(context.suspend).toHaveBeenCalledOnce();
    context.currentTime = 173.25;
    audio.setActive(true);
    audio.unlock();
    await settle();
    expect(context.playing).toHaveLength(1);
    expect(context.sources[1]!.start).toHaveBeenCalledWith(0, 13.25);
  });

  it("caches a decode that finishes while paused without starting it", async () => {
    const { audio, context, fetchMusic, onStatus } = setup();
    const decoding = deferred<AudioBuffer>();
    context.decodeAudioData.mockImplementation(() => decoding.promise);
    audio.setActive(true);
    audio.unlock();
    await settle();
    audio.setActive(false);
    decoding.resolve(buffer);
    await settle();
    expect(context.sources).toHaveLength(0);
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 已暂停");
    await start(audio);
    expect(fetchMusic).toHaveBeenCalledOnce();
    expect(context.playing).toHaveLength(1);
  });

  it("aborts disabled music and ignores a stale decode, without muting independent effects", async () => {
    const { audio, context, fetchMusic, onStatus } = setup();
    const decoding = deferred<AudioBuffer>();
    context.decodeAudioData.mockImplementationOnce(() => decoding.promise);
    audio.setActive(true);
    audio.unlock();
    await settle();
    const signal = fetchMusic.mock.calls[0]![1];
    audio.setSettings({ ...defaults, musicEnabled: false });
    expect(signal.aborted).toBe(true);
    audio.playEffect("scan");
    expect(context.oscillators).toHaveLength(1);
    decoding.resolve(buffer);
    await settle();
    expect(context.sources).toHaveLength(0);
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 已关闭");
    audio.setSettings(defaults);
    await settle();
    expect(fetchMusic).toHaveBeenCalledTimes(2);
    expect(context.playing).toHaveLength(1);
  });

  it("never fetches disabled music, and restores effects after pause even with music off", async () => {
    const { audio, context, fetchMusic } = setup();
    audio.setSettings({ ...defaults, musicEnabled: false });
    await start(audio);
    audio.setActive(false);
    await start(audio);
    audio.playEffect("stock");
    expect(fetchMusic).not.toHaveBeenCalled();
    expect(context.sources).toHaveLength(0);
    expect(context.effectsGain.value).toBe(defaults.effectsVolume);
    expect(context.oscillators).toHaveLength(2);
  });

  it("resumes a previously unlocked context on focus without another click and keeps its music position", async () => {
    const { audio, context, createContext, fetchMusic } = setup();
    await start(audio);
    context.currentTime = 8.5;
    audio.setActive(false);
    await settle();
    audio.setActive(true);
    await settle();
    expect(context.state).toBe("running");
    expect(context.sources[1]!.start).toHaveBeenCalledWith(0, 8.5);
    expect(context.playing).toHaveLength(1);
    expect(createContext).toHaveBeenCalledOnce();
    expect(fetchMusic).toHaveBeenCalledOnce();
  });

  it("restores independent effects after focus even when background music failed", async () => {
    const { audio, context, fetchMusic } = setup();
    fetchMusic.mockRejectedValueOnce(new Error("offline"));
    await start(audio);
    audio.setActive(false);
    await settle();
    audio.setActive(true);
    await settle();
    audio.playEffect("scan");
    expect(context.effectsGain.value).toBe(.5);
    expect(context.oscillators).toHaveLength(1);
    expect(fetchMusic).toHaveBeenCalledOnce(); // Focus is not a music-download retry.
  });

  it("queues a focus resume behind an in-flight suspend rather than trusting the old running state", async () => {
    const { audio, context } = setup();
    await start(audio);
    const suspending = deferred<void>();
    context.suspend.mockImplementationOnce(() => suspending.promise);
    audio.setActive(false);
    expect(context.state).toBe("running");
    context.resume.mockImplementationOnce(async () => { await suspending.promise; context.changeState("running") });
    audio.setActive(true);
    expect(context.resume).toHaveBeenCalledTimes(2);
    context.changeState("suspended");
    suspending.resolve();
    await settle();
    expect(context.state).toBe("running");
    expect(context.playing).toHaveLength(1);
  });

  it("suspends an inactive context if the browser resumes it asynchronously", async () => {
    const { audio, context } = setup();
    await start(audio);
    audio.setActive(false);
    await settle();
    context.changeState("running");
    await settle();
    expect(context.state).toBe("suspended");
    expect(context.playing).toHaveLength(0);
  });

  it("does not restart while a late resume resolves after the game was paused", async () => {
    const { audio, context } = setup();
    const resuming = deferred<void>();
    context.resume.mockImplementationOnce(() => resuming.promise);
    audio.setActive(true);
    audio.unlock();
    audio.setActive(false);
    context.changeState("running");
    resuming.resolve();
    await settle();
    expect(context.playing).toHaveLength(0);
    expect(context.state).toBe("suspended");
  });

  it("lets a fresh user gesture resume even while an older resume promise is pending", async () => {
    const { audio, context, onStatus } = setup();
    const oldResume = deferred<void>();
    context.resume.mockImplementationOnce(() => oldResume.promise);
    audio.setActive(true);
    audio.unlock();
    audio.setActive(false);
    await start(audio);
    oldResume.reject(new Error("old interrupted resume"));
    await settle();
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(context.playing).toHaveLength(1);
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 循环播放");
  });
});

describe("speech priority and original shop feedback", () => {
  it("smoothly ducks music to 22 percent and effects to 55 percent, then restores their own levels", async () => {
    const { audio, context } = setup();
    await start(audio);
    audio.setSpeechActive(true);
    expect(context.musicGain.setTargetAtTime).toHaveBeenLastCalledWith(.22 * .22, 0, .045);
    expect(context.effectsGain.setTargetAtTime).toHaveBeenLastCalledWith(.5 * .55, 0, .045);
    audio.setSpeechActive(false);
    expect(context.musicGain.setTargetAtTime).toHaveBeenLastCalledWith(.22, 0, .16);
    expect(context.effectsGain.setTargetAtTime).toHaveBeenLastCalledWith(.5, 0, .16);
    expect(context.playing).toHaveLength(1);
    expect(context.sources).toHaveLength(1);
  });

  it("applies finite safe defaults and clamps volume limits, with zero stopping music/effects", async () => {
    const { audio, context, onStatus } = setup();
    await start(audio);
    audio.setSettings({ musicEnabled: true, musicVolume: Number.NaN, effectsVolume: Number.POSITIVE_INFINITY });
    expect(context.musicGain.value).toBe(.22);
    expect(context.effectsGain.value).toBe(.5);
    audio.setSettings({ musicEnabled: true, musicVolume: 8, effectsVolume: 7 });
    expect(context.musicGain.value).toBe(1);
    expect(context.effectsGain.value).toBe(1);
    audio.playEffect("payment");
    audio.setSettings({ musicEnabled: true, musicVolume: -3, effectsVolume: -2 });
    const count = context.oscillators.length;
    audio.playEffect("scan");
    expect(context.musicGain.value).toBe(0);
    expect(context.effectsGain.value).toBe(0);
    expect(context.playing).toHaveLength(0);
    expect(context.oscillators).toHaveLength(count);
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 已静音");
  });

  it.each(["doorbell", "stock", "scan", "payment"] as ShopEffect[])("synthesises a short, cleaned-up %s cue only during active play", async (kind) => {
    const { audio, context, fetchMusic } = setup();
    audio.playEffect(kind);
    expect(context.oscillators).toHaveLength(0);
    audio.setSettings({ ...defaults, musicEnabled: false });
    await start(audio);
    audio.playEffect(kind);
    expect(context.oscillators.length).toBeGreaterThan(0);
    for (const oscillator of context.oscillators) {
      expect(oscillator.start).toHaveBeenCalledOnce();
      expect(oscillator.stop).toHaveBeenCalledOnce();
      expect(oscillator.stop.mock.calls[0]![0]).toBeLessThan(1);
      oscillator.end();
      expect(oscillator.disconnect).toHaveBeenCalledOnce();
    }
    audio.setActive(false);
    const count = context.oscillators.length;
    audio.playEffect(kind);
    expect(context.oscillators).toHaveLength(count);
    expect(fetchMusic).not.toHaveBeenCalled();
  });

  it("bounds overlapping synth voices even when interactions arrive rapidly", async () => {
    const { audio, context } = setup();
    await start(audio);
    for (let i = 0; i < 30; i += 1) audio.playEffect("payment");
    expect(context.oscillators.filter((oscillator) => oscillator.disconnect.mock.calls.length === 0)).toHaveLength(24);
    audio.dispose();
    expect(context.oscillators.every((oscillator) => oscillator.disconnect.mock.calls.length > 0)).toBe(true);
  });
});

describe("audio failures and teardown", () => {
  it("reports unavailable music without throwing or repeatedly fetching, and retries only on an explicit unlock", async () => {
    const { audio, context, fetchMusic, onStatus } = setup();
    fetchMusic.mockRejectedValueOnce(new Error("offline"));
    await start(audio);
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 暂不可用");
    for (let i = 0; i < 5; i += 1) { audio.setActive(true); audio.setSettings(defaults); audio.setSpeechActive(i % 2 === 0) }
    await settle();
    expect(fetchMusic).toHaveBeenCalledOnce();
    audio.playEffect("scan");
    expect(context.oscillators).toHaveLength(1);
    audio.unlock();
    await settle();
    expect(fetchMusic).toHaveBeenCalledTimes(2);
    expect(context.playing).toHaveLength(1);
  });

  it("handles decoder failure, then retries when music is explicitly re-enabled", async () => {
    const { audio, context, onStatus } = setup();
    context.decodeAudioData.mockRejectedValueOnce(new Error("bad mp3"));
    await start(audio);
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 暂不可用");
    audio.setSettings({ ...defaults, musicEnabled: false });
    audio.setSettings(defaults);
    await settle();
    expect(context.playing).toHaveLength(1);
  });

  it("handles source start failure without stacking sources, and reuses the decoded buffer on retry", async () => {
    const { audio, context, fetchMusic, onStatus } = setup();
    context.failStart = true;
    await start(audio);
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 暂不可用");
    expect(context.playing).toHaveLength(0);
    context.failStart = false;
    audio.unlock();
    await settle();
    expect(context.playing).toHaveLength(1);
    expect(fetchMusic).toHaveBeenCalledOnce();
  });

  it("catches unavailable audio hardware and rejected resumes without throwing into the game", async () => {
    const onStatus = vi.fn();
    const unavailable = new ShopAudio({ onStatus }, { createContext: () => null });
    unavailable.setActive(true);
    expect(() => unavailable.unlock()).not.toThrow();
    expect(onStatus).toHaveBeenLastCalledWith("背景音乐：Local Forecast · 暂不可用");
    const { audio, context } = setup();
    context.resume.mockRejectedValueOnce(new Error("not allowed"));
    await start(audio);
    expect(context.playing).toHaveLength(0);
    audio.unlock();
    await settle();
    expect(context.playing).toHaveLength(1);
  });

  it("invalidates a load from an externally closed context before opening a new one", async () => {
    const { audio, context, createContext, fetchMusic } = setup();
    const firstDownload = deferred<ArrayBuffer>();
    fetchMusic.mockImplementationOnce(() => firstDownload.promise);
    await start(audio);
    context.changeState("closed");
    const replacement = new Context();
    createContext.mockReturnValueOnce(replacement as unknown as AudioContext);
    audio.unlock();
    await settle();
    firstDownload.resolve(bytes);
    await settle();
    expect(context.sources).toHaveLength(0);
    expect(replacement.playing).toHaveLength(1);
    expect(fetchMusic).toHaveBeenCalledTimes(2);
  });

  it("emits statuses only when changed and fully disposes without resurrection from late work", async () => {
    const { audio, context, fetchMusic, onStatus } = setup();
    const loading = deferred<ArrayBuffer>();
    fetchMusic.mockImplementationOnce(() => loading.promise);
    await start(audio);
    const signal = fetchMusic.mock.calls[0]![1];
    audio.playEffect("doorbell");
    audio.dispose();
    audio.dispose();
    loading.resolve(bytes);
    await settle();
    audio.setActive(true);
    audio.unlock();
    audio.playEffect("payment");
    expect(signal.aborted).toBe(true);
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.sources).toHaveLength(0);
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(context.oscillators).toHaveLength(3);
    expect(context.oscillators.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    const statuses = onStatus.mock.calls.map(([status]) => status);
    expect(statuses.every((status, index) => index === 0 || status !== statuses[index - 1])).toBe(true);
    expect(statuses.at(-1)).toBe("背景音乐：Local Forecast · 已暂停");
  });
});
