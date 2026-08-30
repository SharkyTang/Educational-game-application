import { createInitialSimState, validateSimState, type SimState } from "./domain";

/** Deliberately separate from the older 2D storage namespace; never migrate/delete it. */
export const SIM_STORAGE_KEY = "english-high-street:sim3d:v3";
export const SIM_BACKUP_KEY = `${SIM_STORAGE_KEY}:backup`;
export const SIM_WRITER_LOCK = `${SIM_STORAGE_KEY}:writer`;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SimLoadResult {
  state: SimState;
  source: "primary" | "backup" | "new";
  warning?: string;
}

export interface SimLockManager {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: object | null) => Promise<void>,
  ): Promise<unknown>;
}

export class SimSaveConflictError extends Error {
  constructor(message = "另一页面已修改这份存档，本页已停止写入。请下载本页快照，或关闭另一页面后读取最新进度。") {
    super(message);
    this.name = "SimSaveConflictError";
  }
}

function browserStorage(): StorageLike {
  if (typeof localStorage === "undefined") throw new Error("当前环境无法使用本地存档。");
  return localStorage;
}

function browserLocks(): SimLockManager | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  return { request: (name, options, callback) => navigator.locks.request(name, options, (lock) => callback(lock)) };
}

function parseSnapshot(raw: string | null): SimState | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return validateSimState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only recovery: retain corrupt snapshots for diagnosis until the next explicit save. */
export function loadSimState(storage: StorageLike = browserStorage()): SimLoadResult {
  // Storage access errors are not hidden: the caller must tell the player saves are unavailable.
  const primaryRaw = storage.getItem(SIM_STORAGE_KEY);
  return loadSnapshot(primaryRaw, storage.getItem(SIM_BACKUP_KEY));
}

function loadSnapshot(primaryRaw: string | null, backupRaw: string | null): SimLoadResult {
  const primary = parseSnapshot(primaryRaw);
  if (primary) return { state: primary, source: "primary" };

  const backup = parseSnapshot(backupRaw);
  if (backup) return {
    state: backup,
    source: "backup",
    warning: "当前存档不可用，已恢复上一份有效快照；最近一次操作可能需要重做。",
  };
  return {
    state: createInitialSimState(),
    source: "new",
    ...(primaryRaw !== null || backupRaw !== null
      ? { warning: "没有找到可恢复的有效 3D 存档，已开启新的试玩；旧存档未被删除。" }
      : {}),
  };
}

/** Imported files are real complete game snapshots, not arbitrary JSON or legacy 2D saves. */
export function parseImportedSimState(raw: string): SimState {
  if (raw.length > 2_000_000) throw new Error("存档文件过大，请选择本游戏导出的 3D JSON 快照。");
  let value: unknown;
  try { value = JSON.parse(raw) }
  catch { throw new Error("文件不是可读取的 JSON，当前进度未改变。") }
  if (!validateSimState(value)) throw new Error("存档的版本、库存或金额校验未通过，当前进度未改变。旧版 2D 存档不能直接导入此小样。");
  return value;
}

/**
 * One Web Lock spans the page lifetime. Older browsers use optimistic whole-snapshot
 * comparison, never a local revision counter (different tabs can produce equal revisions).
 */
export class SimSaveSession {
  private writable = false;
  private loaded = false;
  private expectedRaw: string | null = null;
  private releaseLock: (() => void) | null = null;
  private resolveAdmission: ((allowed: boolean) => void) | null = null;
  private requesting: Promise<boolean> | null = null;
  private lockCompletion: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly storage: StorageLike = browserStorage(),
    private readonly locks: SimLockManager | null = browserLocks(),
  ) {}

  get canWrite(): boolean { return this.writable }
  get strategy(): "web-locks" | "snapshot-cas" { return this.locks ? "web-locks" : "snapshot-cas" }

  async acquire(): Promise<boolean> {
    if (this.writable) return true;
    if (this.requesting) return this.requesting;
    this.loaded = false;
    const generation = ++this.generation;
    let resolve!: (allowed: boolean) => void;
    let reject!: (reason: unknown) => void;
    const admission = new Promise<boolean>((accept, decline) => { resolve = accept; reject = decline });
    this.requesting = admission;
    this.resolveAdmission = resolve;
    if (!this.locks) {
      this.writable = true;
      resolve(true);
    } else {
      // Reacquiring the same session must wait for its prior lock's actual release,
      // not merely for the callback's release signal to have been sent.
      this.lockCompletion = this.lockCompletion.then(() => this.locks!.request(SIM_WRITER_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock || generation !== this.generation) { resolve(false); return }
        this.writable = true;
        await new Promise<void>((release) => {
          this.releaseLock = release;
          resolve(true);
        });
        if (generation === this.generation) {
          this.writable = false;
          this.releaseLock = null;
        }
      })).then(() => undefined).catch((error: unknown) => {
        if (generation === this.generation) this.writable = false;
        reject(error);
      });
    }
    try { return await admission }
    finally {
      if (this.requesting === admission) {
        this.requesting = null;
        this.resolveAdmission = null;
      }
    }
  }

  /** Refresh only while intentionally acquiring/continuing, never silently merge live inventory. */
  load(): SimLoadResult {
    const raw = this.storage.getItem(SIM_STORAGE_KEY);
    const result = loadSnapshot(raw, this.storage.getItem(SIM_BACKUP_KEY));
    this.expectedRaw = raw;
    this.loaded = true;
    return result;
  }

  assertCurrent(): void {
    if (!this.writable) throw new SimSaveConflictError("此页面没有存档写入权，不能修改进度或设置。请关闭另一营业页面后再尝试接管。");
    if (!this.loaded) throw new Error("尚未读取完整存档，不能写入。");
    if (this.storage.getItem(SIM_STORAGE_KEY) !== this.expectedRaw) {
      this.release();
      throw new SimSaveConflictError();
    }
  }

  save(state: SimState): void {
    this.assertCurrent();
    saveSimState(state, this.storage);
    this.expectedRaw = JSON.stringify(state);
  }

  /** A storage event from another page freezes this page before its next interaction. */
  observeExternalSnapshot(raw: string | null): boolean {
    if (this.writable && this.loaded && raw !== this.expectedRaw) {
      this.release();
      return true;
    }
    return false;
  }

  release(): Promise<void> {
    this.generation += 1;
    this.writable = false;
    this.loaded = false;
    this.resolveAdmission?.(false);
    this.resolveAdmission = null;
    this.requesting = null;
    this.releaseLock?.();
    this.releaseLock = null;
    return this.lockCompletion;
  }
}

/** Save the entire world atomically under one key, preserving the last valid snapshot first. */
export function saveSimState(state: SimState, storage: StorageLike = browserStorage()): void {
  if (!validateSimState(state)) throw new Error("存档校验失败，原存档未被覆盖。");
  const serialized = JSON.stringify(state);
  const previous = storage.getItem(SIM_STORAGE_KEY);
  if (previous === serialized) return;
  // Do not replace a good backup with an unreadable primary during recovery.
  if (parseSnapshot(previous)) storage.setItem(SIM_BACKUP_KEY, previous!);
  // Quota/security/write failures intentionally propagate. Never report a failed write as saved.
  storage.setItem(SIM_STORAGE_KEY, serialized);
}
