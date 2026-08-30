import type { GameState } from "../domain/types";

const DATABASE_NAME = "english-high-street-mvp";
const DATABASE_VERSION = 1;
const STORE_NAME = "saves";
const PRIMARY_KEY = "primary";
const FALLBACK_KEY = "english-high-street-mvp:fallback";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open save database"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Save operation failed"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error ?? new Error("Save transaction failed"));
  });
}

function isGameState(value: unknown): value is GameState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GameState>;
  return candidate.schemaVersion === 1 && typeof candidate.phase === "string";
}

export class SaveRepository {
  async load(): Promise<GameState | null> {
    try {
      const stored = await withStore<unknown>("readonly", (store) =>
        store.get(PRIMARY_KEY),
      );
      return isGameState(stored) ? stored : null;
    } catch {
      const fallback = localStorage.getItem(FALLBACK_KEY);
      if (!fallback) return null;

      try {
        const parsed: unknown = JSON.parse(fallback);
        return isGameState(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }

  async save(state: GameState): Promise<void> {
    const snapshot: GameState = {
      ...state,
      updatedAt: new Date().toISOString(),
    };

    try {
      await withStore<IDBValidKey>("readwrite", (store) =>
        store.put(snapshot, PRIMARY_KEY),
      );
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
    } catch {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
    }
  }

  async clear(): Promise<void> {
    try {
      await withStore<undefined>("readwrite", (store) =>
        store.delete(PRIMARY_KEY),
      );
    } finally {
      localStorage.removeItem(FALLBACK_KEY);
    }
  }

  async export(state: GameState): Promise<void> {
    const payload = JSON.stringify(state, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `english-high-street-save-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
