/** A separate audio bed: teaching speech keeps its own player and has priority. */
export type ShopEffect = "doorbell" | "stock" | "scan" | "payment";

export interface ShopAudioSettings {
  musicEnabled: boolean;
  musicVolume: number;
  effectsVolume: number;
}

export interface ShopAudioDependencies {
  createContext(): AudioContext | null;
  fetchMusic(url: string, signal: AbortSignal): Promise<ArrayBuffer>;
}

const MUSIC_URL = "/assets/sim3d/audio/local-forecast.mp3";
const DEFAULTS: ShopAudioSettings = { musicEnabled: true, musicVolume: .22, effectsVolume: .5 };
const MUSIC_DUCK = .22;
const EFFECTS_DUCK = .55;
const MAX_VOICES = 24;

interface Tone {
  frequency: number;
  delay: number;
  duration: number;
  level: number;
  type?: OscillatorType;
  endFrequency?: number;
}

interface Voice { oscillator: OscillatorNode; gain: GainNode }

// Original, deliberately short synthesised cues; no additional sampled assets.
const EFFECTS: Record<ShopEffect, readonly Tone[]> = {
  doorbell: [
    { frequency: 880, delay: 0, duration: .48, level: .14 },
    { frequency: 1760, delay: 0, duration: .26, level: .025 },
    { frequency: 659.25, delay: .2, duration: .6, level: .13 },
  ],
  stock: [
    { frequency: 180, endFrequency: 88, delay: 0, duration: .14, level: .23 },
    { frequency: 330, endFrequency: 160, delay: .008, duration: .065, level: .045, type: "triangle" },
  ],
  scan: [{ frequency: 1320, delay: 0, duration: .095, level: .16 }],
  payment: [
    { frequency: 523.25, delay: 0, duration: .2, level: .13 },
    { frequency: 659.25, delay: .085, duration: .22, level: .12 },
    { frequency: 783.99, delay: .17, duration: .3, level: .12 },
  ],
};

const volume = (value: number, fallback: number): number => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

const browserDependencies: ShopAudioDependencies = {
  createContext: () => {
    const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Constructor ? new Constructor() : null;
  },
  fetchMusic: async (url, signal) => {
    const response = await fetch(url, { signal, cache: "force-cache" });
    if (!response.ok) throw new Error(`Background music request failed: ${response.status}`);
    return response.arrayBuffer();
  },
};

export class ShopAudio {
  private readonly dependencies: ShopAudioDependencies;
  private readonly onStatus?: (status: string) => void;
  private settings: ShopAudioSettings = { ...DEFAULTS };
  private context: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private effectsGain: GainNode | null = null;
  private musicBuffer: AudioBuffer | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicOffset = 0;
  private musicStartedAt = 0;
  private readonly voices = new Set<Voice>();
  private active = false;
  private speechActive = false;
  private disposed = false;
  private loading = false;
  private loadGeneration = 0;
  private loadController: AbortController | null = null;
  private resumingContext: AudioContext | null = null;
  private suspendingContext: AudioContext | null = null;
  private unlockedContext: AudioContext | null = null;
  private resumeGeneration = 0;
  private contextFailed = false;
  private musicFailed = false;
  private status = "";

  constructor(options: { onStatus?: (status: string) => void } = {}, dependencies: Partial<ShopAudioDependencies> = {}) {
    this.onStatus = options.onStatus;
    this.dependencies = { ...browserDependencies, ...dependencies };
  }

  /** Must be called directly in a Start/Continue click, before any await. */
  unlock(): void {
    if (this.disposed) return;
    this.contextFailed = false;
    this.musicFailed = false;
    if (this.context?.state === "closed") this.releaseContext();
    const context = this.context ?? this.createContext();
    if (!context) { this.reportStatus(); return }
    this.resumeContext(context);
    this.syncMusic();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) {
      this.speechActive = false;
      this.stopMusic();
      this.stopEffects();
      this.applyLevels(true);
      this.suspendContext();
    } else {
      this.applyLevels();
      // Returning to an inspection after focus does not offer another Start
      // button. Resume only a context that a previous real gesture unlocked.
      if (this.context && this.unlockedContext === this.context && (this.context.state !== "running" || this.suspendingContext === this.context)) this.resumeContext(this.context);
      this.syncMusic();
    }
    this.reportStatus();
  }

  setSettings(settings: ShopAudioSettings): void {
    if (this.disposed) return;
    const next: ShopAudioSettings = {
      musicEnabled: settings.musicEnabled !== false,
      musicVolume: volume(settings.musicVolume, DEFAULTS.musicVolume),
      effectsVolume: volume(settings.effectsVolume, DEFAULTS.effectsVolume),
    };
    const enabledNow = !this.settings.musicEnabled && next.musicEnabled;
    const changed = Object.keys(next).some((key) => next[key as keyof ShopAudioSettings] !== this.settings[key as keyof ShopAudioSettings]);
    this.settings = next;
    if (enabledNow) this.musicFailed = false;
    if (!next.musicEnabled) this.cancelLoad();
    if (next.effectsVolume === 0) this.stopEffects();
    if (changed) this.applyLevels();
    this.syncMusic();
  }

  setSpeechActive(active: boolean): void {
    if (this.disposed || this.speechActive === active) return;
    this.speechActive = active;
    this.applyLevels();
  }

  playEffect(kind: ShopEffect): void {
    const context = this.context;
    if (this.disposed || !this.active || this.contextFailed || !context || context.state !== "running" || !this.effectsGain || this.settings.effectsVolume === 0) return;
    for (const tone of EFFECTS[kind]) {
      while (this.voices.size >= MAX_VOICES) this.stopVoice(this.voices.values().next().value!);
      let voice: Voice | undefined;
      try {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        voice = { oscillator, gain };
        this.voices.add(voice);
        const start = context.currentTime + tone.delay;
        oscillator.type = tone.type ?? "sine";
        oscillator.frequency.setValueAtTime(tone.frequency, start);
        if (tone.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequency, start + tone.duration);
        gain.gain.setValueAtTime(.0001, start);
        gain.gain.linearRampToValueAtTime(tone.level, start + .006);
        gain.gain.exponentialRampToValueAtTime(.0001, start + tone.duration);
        oscillator.connect(gain);
        gain.connect(this.effectsGain);
        const currentVoice = voice;
        oscillator.onended = () => this.stopVoice(currentVoice, false);
        oscillator.start(start);
        oscillator.stop(start + tone.duration + .012);
      } catch { if (voice) this.stopVoice(voice) }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.cancelLoad();
    this.releaseContext();
    this.musicBuffer = null;
    this.reportStatus();
  }

  private createContext(): AudioContext | null {
    let context: AudioContext | null = null;
    try {
      context = this.dependencies.createContext();
      if (!context) throw new Error("Web Audio is unavailable");
      this.context = context;
      this.musicGain = context.createGain();
      this.effectsGain = context.createGain();
      this.musicGain.gain.value = 0;
      this.effectsGain.gain.value = 0;
      this.musicGain.connect(context.destination);
      this.effectsGain.connect(context.destination);
      const createdContext = context;
      context.onstatechange = () => {
        if (this.disposed || this.context !== createdContext) return;
        if (createdContext.state === "running") this.unlockedContext = createdContext;
        if (createdContext.state === "running" && this.active) this.syncMusic();
        else { this.stopMusic(); this.stopEffects(); this.reportStatus() }
        if (createdContext.state === "running" && !this.active) queueMicrotask(() => {
          if (!this.disposed && this.context === createdContext && !this.active) this.suspendContext();
        });
      };
      this.applyLevels(true);
      return context;
    } catch {
      this.releaseContext();
      this.contextFailed = true;
      return null;
    }
  }

  private resumeContext(context: AudioContext): void {
    if (this.resumingContext === context && context.state === "running" && this.suspendingContext !== context) return;
    const generation = ++this.resumeGeneration;
    this.resumingContext = context;
    const current = (): boolean => !this.disposed && this.context === context && generation === this.resumeGeneration;
    const failed = (): void => {
      if (!current()) return;
      this.contextFailed = true;
      this.stopMusic();
      this.stopEffects();
    };
    const finished = (): void => {
      if (generation !== this.resumeGeneration) return;
      if (this.resumingContext === context) this.resumingContext = null;
      if (!this.disposed && this.context === context) this.reportStatus();
    };
    try {
      // Explicit unlock calls resume synchronously inside the user activation.
      void context.resume().then(() => {
        if (!current()) return;
        if (!this.active) { this.suspendContext(); return }
        if (context.state !== "running") { failed(); return }
        this.unlockedContext = context;
        this.contextFailed = false;
        this.syncMusic();
      }, failed).finally(finished);
    } catch { failed(); finished() }
  }

  private syncMusic(): void {
    const context = this.context;
    if (!this.active || !this.settings.musicEnabled || this.settings.musicVolume === 0 || this.contextFailed) this.stopMusic();
    else if (context && !this.musicFailed) {
      if (!this.musicBuffer && !this.loading) this.loadMusic(context);
      if (this.musicBuffer && !this.musicSource && context.state === "running") this.startMusic(context);
    }
    this.reportStatus();
  }

  private loadMusic(context: AudioContext): void {
    const generation = ++this.loadGeneration;
    const controller = new AbortController();
    this.loadController = controller;
    this.loading = true;
    const current = (): boolean => !this.disposed && generation === this.loadGeneration && this.context === context;
    void (async () => {
      try {
        const bytes = await this.dependencies.fetchMusic(MUSIC_URL, controller.signal);
        if (!current()) return;
        const buffer = await context.decodeAudioData(bytes);
        if (!current()) return;
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error("Background music has no duration");
        this.musicBuffer = buffer;
      } catch { if (current() && !controller.signal.aborted) this.musicFailed = true }
      finally {
        if (current()) {
          this.loading = false;
          this.loadController = null;
          this.syncMusic();
        }
      }
    })();
  }

  private startMusic(context: AudioContext): void {
    let source: AudioBufferSourceNode | undefined;
    try {
      source = context.createBufferSource();
      source.buffer = this.musicBuffer;
      source.loop = true;
      source.connect(this.musicGain!);
      this.musicOffset %= this.musicBuffer!.duration;
      this.musicStartedAt = context.currentTime;
      this.musicSource = source;
      source.onended = () => {
        if (this.musicSource !== source) return;
        this.stopMusic();
        this.musicFailed = true;
        this.reportStatus();
      };
      this.musicGain!.gain.cancelScheduledValues(context.currentTime);
      this.musicGain!.gain.setValueAtTime(0, context.currentTime);
      source.start(0, this.musicOffset);
      this.applyLevels();
    } catch {
      this.stopMusic();
      try { source?.disconnect() } catch { /* An already disconnected source is safe. */ }
      this.musicFailed = true;
    }
  }

  private stopMusic(): void {
    const source = this.musicSource;
    if (!source) return;
    this.musicSource = null;
    if (this.context && this.musicBuffer) this.musicOffset = (this.musicOffset + Math.max(0, this.context.currentTime - this.musicStartedAt)) % this.musicBuffer.duration;
    source.onended = null;
    try { source.stop() } catch { /* Starting may already have failed. */ }
    try { source.disconnect() } catch { /* The context may already be closed. */ }
  }

  private applyLevels(immediate = false): void {
    const context = this.context;
    if (!context) return;
    const music = this.active && this.settings.musicEnabled ? this.settings.musicVolume * (this.speechActive ? MUSIC_DUCK : 1) : 0;
    const effects = this.active ? this.settings.effectsVolume * (this.speechActive ? EFFECTS_DUCK : 1) : 0;
    for (const [node, target] of [[this.musicGain, music], [this.effectsGain, effects]] as const) {
      if (!node) continue;
      try {
        const param = node.gain;
        if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(context.currentTime);
        else { param.cancelScheduledValues(context.currentTime); param.setValueAtTime(param.value, context.currentTime) }
        if (immediate || target === 0) param.setValueAtTime(target, context.currentTime);
        else param.setTargetAtTime(target, context.currentTime, this.speechActive ? .045 : .16);
      } catch { /* Audio teardown must never interrupt the game. */ }
    }
  }

  private stopVoice(voice: Voice, stop = true): void {
    if (!this.voices.delete(voice)) return;
    voice.oscillator.onended = null;
    if (stop) { try { voice.oscillator.stop() } catch { /* Already ended or not started. */ } }
    try { voice.oscillator.disconnect(); voice.gain.disconnect() } catch { /* Already disconnected. */ }
  }

  private stopEffects(): void { for (const voice of this.voices) this.stopVoice(voice) }

  private suspendContext(): void {
    const context = this.context;
    if (!context || context.state !== "running" || this.suspendingContext === context) return;
    this.suspendingContext = context;
    const finished = (): void => { if (this.suspendingContext === context) this.suspendingContext = null };
    try { void context.suspend().catch(() => { /* Sources were already stopped, so no background sound can leak. */ }).finally(finished) }
    catch { finished() }
  }

  private cancelLoad(): void {
    this.loadGeneration += 1;
    this.loadController?.abort();
    this.loadController = null;
    this.loading = false;
  }

  private releaseContext(): void {
    this.cancelLoad();
    this.resumeGeneration += 1;
    this.stopMusic();
    this.stopEffects();
    const context = this.context;
    if (context) {
      context.onstatechange = null;
      try { void context.close().catch(() => { /* Closed contexts need no further work. */ }) } catch { /* Already closed. */ }
    }
    try { this.musicGain?.disconnect(); this.effectsGain?.disconnect() } catch { /* Already disconnected. */ }
    this.context = null;
    this.musicGain = null;
    this.effectsGain = null;
    this.resumingContext = null;
    this.suspendingContext = null;
    this.unlockedContext = null;
  }

  private reportStatus(): void {
    const state = !this.settings.musicEnabled ? "已关闭"
      : this.disposed || !this.active ? "已暂停"
      : this.settings.musicVolume === 0 ? "已静音"
      : this.contextFailed || this.musicFailed ? "暂不可用"
      : this.musicSource && this.context?.state === "running" ? "循环播放"
      : this.loading || this.resumingContext ? "加载中" : "等待开始或继续";
    const next = `背景音乐：Local Forecast · ${state}`;
    if (next === this.status) return;
    this.status = next;
    try { this.onStatus?.(next) } catch { /* A status view is not allowed to break audio cleanup. */ }
  }
}
