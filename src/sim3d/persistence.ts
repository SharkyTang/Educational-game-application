import { createFirstDayState, migrateLegacySimState, migrateV4SimState, migrateV5SimState, migrateV6SimState,
  validateLegacySimState, validateSimState, validateV4SimState, validateV5SimState, validateV6SimState, type SimState } from "./domain";

/** Deliberately separate from the older 2D storage namespace; never migrate/delete it. */
export const SIM_STORAGE_KEY = "english-high-street:sim3d:v7";
export const SIM_BACKUP_KEY = `${SIM_STORAGE_KEY}:backup`;
/** These old keys are read-only migration sources, never overwritten or removed. */
export const SIM_V6_STORAGE_KEY = "english-high-street:sim3d:v6";
export const SIM_V6_BACKUP_KEY = `${SIM_V6_STORAGE_KEY}:backup`;
export const SIM_V5_STORAGE_KEY = "english-high-street:sim3d:v5";
export const SIM_V5_BACKUP_KEY = `${SIM_V5_STORAGE_KEY}:backup`;
export const SIM_V4_STORAGE_KEY = "english-high-street:sim3d:v4";
export const SIM_V4_BACKUP_KEY = `${SIM_V4_STORAGE_KEY}:backup`;
/** v4–v7 share one writer lock so an older open page cannot mutate a migration source. */
export const SIM_WRITER_LOCK = `${SIM_V4_STORAGE_KEY}:writer`;
export const SIM_LEGACY_STORAGE_KEY = "english-high-street:sim3d:v3";
export const SIM_LEGACY_BACKUP_KEY = `${SIM_LEGACY_STORAGE_KEY}:backup`;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SimLoadResult {
  state: SimState;
  source: "primary" | "backup" | "v6" | "v6-backup" | "v5" | "v5-backup" | "v4" | "v4-backup" | "legacy" | "legacy-backup" | "new";
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

function parseLegacySnapshot(raw: string | null): SimState | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return validateLegacySimState(value) ? migrateLegacySimState(value) : undefined;
  } catch { return undefined }
}

function parseV4Snapshot(raw: string | null): SimState | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return validateV4SimState(value) ? migrateV4SimState(value) : undefined;
  } catch { return undefined }
}

function parseV5Snapshot(raw: string | null): SimState | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return validateV5SimState(value) ? migrateV5SimState(value) : undefined;
  } catch { return undefined }
}

function parseV6Snapshot(raw: string | null): SimState | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return validateV6SimState(value) ? migrateV6SimState(value) : undefined;
  } catch { return undefined }
}

const PREVIOUS_KEYS = [SIM_V6_STORAGE_KEY, SIM_V6_BACKUP_KEY, SIM_V5_STORAGE_KEY, SIM_V5_BACKUP_KEY, SIM_V4_STORAGE_KEY, SIM_V4_BACKUP_KEY, SIM_LEGACY_STORAGE_KEY, SIM_LEGACY_BACKUP_KEY] as const;
type PreviousSnapshots = Record<(typeof PREVIOUS_KEYS)[number], string | null>;
function readPreviousSnapshots(storage: StorageLike): PreviousSnapshots {
  return {
    [SIM_V6_STORAGE_KEY]: storage.getItem(SIM_V6_STORAGE_KEY), [SIM_V6_BACKUP_KEY]: storage.getItem(SIM_V6_BACKUP_KEY),
    [SIM_V5_STORAGE_KEY]: storage.getItem(SIM_V5_STORAGE_KEY), [SIM_V5_BACKUP_KEY]: storage.getItem(SIM_V5_BACKUP_KEY),
    [SIM_V4_STORAGE_KEY]: storage.getItem(SIM_V4_STORAGE_KEY), [SIM_V4_BACKUP_KEY]: storage.getItem(SIM_V4_BACKUP_KEY),
    [SIM_LEGACY_STORAGE_KEY]: storage.getItem(SIM_LEGACY_STORAGE_KEY), [SIM_LEGACY_BACKUP_KEY]: storage.getItem(SIM_LEGACY_BACKUP_KEY),
  };
}

/** Read-only recovery: retain corrupt snapshots for diagnosis until the next explicit save. */
export function loadSimState(storage: StorageLike = browserStorage()): SimLoadResult {
  // Storage access errors are not hidden: the caller must tell the player saves are unavailable.
  const primaryRaw = storage.getItem(SIM_STORAGE_KEY);
  return loadSnapshot(primaryRaw, storage.getItem(SIM_BACKUP_KEY), readPreviousSnapshots(storage));
}

function loadSnapshot(primaryRaw: string | null, backupRaw: string | null, previous: PreviousSnapshots): SimLoadResult {
  const primary = parseSnapshot(primaryRaw);
  if (primary) return { state: primary, source: "primary" };

  const backup = parseSnapshot(backupRaw);
  if (backup) return {
    state: backup,
    source: "backup",
    warning: "当前存档不可用，已恢复上一份有效快照；最近一次操作可能需要重做。",
  };
  const v6 = parseV6Snapshot(previous[SIM_V6_STORAGE_KEY]);
  const v6Backup = v6 ? undefined : parseV6Snapshot(previous[SIM_V6_BACKUP_KEY]);
  if (v6 || v6Backup) return {
    state: (v6 ?? v6Backup)!, source: v6 ? "v6" : "v6-backup",
    warning: `${primaryRaw !== null || backupRaw !== null ? "当前回收存档不可恢复，已回到保留的 v6 进度；最近的回收与营业进度可能丢失。" : v6Backup ? "旧 v6 主存档不可用，已从旧备份迁移；最近一次操作可能需要重做。" : "已迁移原有自选进货进度。"}现金、库存、手持物品、待收订单和日结均保留；回收记录从零开始，不会额外发钱，旧档未修改。`,
  };
  const v6ProgressExists = primaryRaw !== null || backupRaw !== null || previous[SIM_V6_STORAGE_KEY] !== null || previous[SIM_V6_BACKUP_KEY] !== null;
  const v5 = parseV5Snapshot(previous[SIM_V5_STORAGE_KEY]);
  const v5Backup = v5 ? undefined : parseV5Snapshot(previous[SIM_V5_BACKUP_KEY]);
  if (v5 || v5Backup) return {
    state: (v5 ?? v5Backup)!, source: v5 ? "v5" : "v5-backup",
    warning: `${v6ProgressExists ? "当前自选进货存档不可恢复，已回到保留的 v5 进度；最近的进货与营业进度可能丢失。" : v5Backup ? "旧 v5 主存档不可用，已从旧备份迁移；最近一次操作可能需要重做。" : "已迁移原有小店配送进度。"}现金、已售商品、待收订单与购物流程均保留，不会重复扣款或发货；旧档未修改。`,
  };
  const newerProgressExists = v6ProgressExists || previous[SIM_V5_STORAGE_KEY] !== null || previous[SIM_V5_BACKUP_KEY] !== null;
  const v4 = parseV4Snapshot(previous[SIM_V4_STORAGE_KEY]);
  const v4Backup = v4 ? undefined : parseV4Snapshot(previous[SIM_V4_BACKUP_KEY]);
  if (v4 || v4Backup) return {
    state: (v4 ?? v4Backup)!, source: v4 ? "v4" : "v4-backup",
    warning: `${newerProgressExists ? "当前配送存档不可恢复，已回到保留的 v4 进度；最近的收货与营业进度可能丢失。" : v4Backup ? "旧 v4 主存档不可用，已从旧备份迁移；最近一次操作可能需要重做。" : "已迁移原有小店进度。"}已购货物保持原位，历史采购视为已收货，不会重复扣款或发货；旧档未修改。`,
  };
  const legacy = parseLegacySnapshot(previous[SIM_LEGACY_STORAGE_KEY]);
  const legacyBackup = legacy ? undefined : parseLegacySnapshot(previous[SIM_LEGACY_BACKUP_KEY]);
  if (legacy || legacyBackup) return {
    state: (legacy ?? legacyBackup)!, source: legacy ? "legacy" : "legacy-backup",
    warning: `${newerProgressExists || previous[SIM_V4_STORAGE_KEY] !== null || previous[SIM_V4_BACKUP_KEY] !== null ? "当前首日存档不可恢复，已回到保留的旧 3D 进度；之后的采购与营业进度可能丢失。" : legacyBackup ? "旧 3D 主存档不可用，已从旧备份迁移；最近一次操作可能需要重做。" : "已迁移旧 3D 试玩进度。"}货物、现金和交易均保留，旧档未修改；不会额外发放首日本金。`,
  };
  return {
    state: createFirstDayState(),
    source: "new",
    ...(primaryRaw !== null || backupRaw !== null || PREVIOUS_KEYS.some((key) => previous[key] !== null)
      ? { warning: "没有找到可恢复的有效 3D 存档，已开启新的首日；旧存档未被删除。" }
      : {}),
  };
}

/** Imported files are real complete game snapshots, not arbitrary JSON or legacy 2D saves. */
export function parseImportedSimState(raw: string): SimState {
  if (raw.length > 2_000_000) throw new Error("存档文件过大，请选择本游戏导出的 3D JSON 快照。");
  let value: unknown;
  try { value = JSON.parse(raw) }
  catch { throw new Error("文件不是可读取的 JSON，当前进度未改变。") }
  if (validateSimState(value)) return value;
  if (validateV6SimState(value)) return migrateV6SimState(value);
  if (validateV5SimState(value)) return migrateV5SimState(value);
  if (validateV4SimState(value)) return migrateV4SimState(value);
  if (validateLegacySimState(value)) return migrateLegacySimState(value);
  throw new Error("存档的版本、库存或金额校验未通过，当前进度未改变。旧版 2D 存档不能直接导入此小样。");
}

/**
 * One Web Lock spans the page lifetime. Older browsers use optimistic whole-snapshot
 * comparison, never a local revision counter (different tabs can produce equal revisions).
 */
export class SimSaveSession {
  private writable = false;
  private loaded = false;
  private expectedRaw: string | null = null;
  private expectedMigrationSources: PreviousSnapshots | null = null;
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
    const previous = readPreviousSnapshots(this.storage);
    const result = loadSnapshot(raw, this.storage.getItem(SIM_BACKUP_KEY), previous);
    this.expectedRaw = raw;
    this.expectedMigrationSources = ["v6", "v6-backup", "v5", "v5-backup", "v4", "v4-backup", "legacy", "legacy-backup"].includes(result.source) ? previous : null;
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
    if (this.expectedMigrationSources && PREVIOUS_KEYS.some((key) => this.storage.getItem(key) !== this.expectedMigrationSources![key])) {
      this.release();
      throw new SimSaveConflictError("旧版页面刚刚修改了迁移源，已停止写入。请关闭旧页面后重新读取进度再迁移。");
    }
  }

  save(state: SimState): void {
    this.assertCurrent();
    saveSimState(state, this.storage);
    this.expectedRaw = JSON.stringify(state);
    this.expectedMigrationSources = null;
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
    this.expectedMigrationSources = null;
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
