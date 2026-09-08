/** A single saved delivery vehicle serves paid orders in purchase order. */
export const DELIVERY_PREPARE_MS = 6_000;
export const DELIVERY_ARRIVE_MS = 6_000;
export const DELIVERY_DEPART_MS = 4_000;
export const DELIVERY_TRUCK_START_X = -25;
export const DELIVERY_TRUCK_STOP_X = 3;
export const DELIVERY_TRUCK_EXIT_X = 25;
export const DELIVERY_TRUCK_Z = -9.1;

export type DeliveryPhase = "idle" | "preparing" | "arriving" | "ready" | "departing";
export interface DeliveryState {
  phase: DeliveryPhase;
  orderId: string | null;
  /** Elapsed active time within this phase, never a wall-clock timestamp. */
  elapsedMs: number;
  /** Only driving phases may be blocked by someone in the vehicle corridor. */
  blocked: boolean;
}
export interface DeliveryOrder { id: string; receivedDay: number | null }

export function createDeliveryState(): DeliveryState {
  return { phase: "idle", orderId: null, elapsedMs: 0, blocked: false };
}

/** Old paid deliveries were already available; retain the oldest ready receipt. */
export function migrateDeliveryState(orders: readonly DeliveryOrder[]): DeliveryState {
  const first = orders.find((order) => order.receivedDay === null);
  return first ? { phase: "ready", orderId: first.id, elapsedMs: 0, blocked: false } : createDeliveryState();
}

/** Called atomically after a purchase: a parked or departing vehicle cannot skip its current order. */
export function queueDelivery(state: DeliveryState, orders: readonly DeliveryOrder[]): DeliveryState {
  if (state.phase !== "idle") return state;
  const first = orders.find((order) => order.receivedDay === null);
  return first ? { phase: "preparing", orderId: first.id, elapsedMs: 0, blocked: false } : state;
}

export function validateDeliveryState(value: unknown, orders: readonly DeliveryOrder[]): value is DeliveryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<DeliveryState>;
  if (typeof state.elapsedMs !== "number" || !Number.isFinite(state.elapsedMs) || state.elapsedMs < 0
    || typeof state.blocked !== "boolean") return false;
  const pendingIndex = orders.findIndex((order) => order.receivedDay === null);
  // Receiving the second order before the first would make the FIFO ledger untrue.
  if (pendingIndex >= 0 && orders.slice(pendingIndex).some((order) => order.receivedDay !== null)) return false;
  if (state.phase === "idle") return state.orderId === null && state.elapsedMs === 0 && !state.blocked && pendingIndex < 0;
  if (typeof state.orderId !== "string" || !state.orderId) return false;
  if (state.phase === "departing") {
    const lastReceived = orders[pendingIndex < 0 ? orders.length - 1 : pendingIndex - 1];
    return !!lastReceived && lastReceived.id === state.orderId && lastReceived.receivedDay !== null
      && state.elapsedMs < DELIVERY_DEPART_MS;
  }
  if (pendingIndex < 0 || orders[pendingIndex]!.id !== state.orderId) return false;
  if (state.phase === "preparing") return !state.blocked && state.elapsedMs < DELIVERY_PREPARE_MS;
  if (state.phase === "arriving") return state.elapsedMs < DELIVERY_ARRIVE_MS;
  return state.phase === "ready" && state.elapsedMs === 0 && !state.blocked;
}

/** Advances only the truck. The caller supplies foreground/pause gating independently of the shop clock. */
export function advanceDeliveryTime(
  state: DeliveryState, orders: readonly DeliveryOrder[], elapsedMs: number, blocked: boolean,
): DeliveryState {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || typeof blocked !== "boolean"
    || !validateDeliveryState(state, orders) || state.phase === "ready" || state.phase === "idle") return state;
  let next = { ...state };
  let remaining = elapsedMs;
  while (remaining > 0) {
    if (next.phase === "arriving" || next.phase === "departing") {
      next.blocked = blocked;
      if (blocked) break;
    }
    const duration = next.phase === "preparing" ? DELIVERY_PREPARE_MS
      : next.phase === "arriving" ? DELIVERY_ARRIVE_MS : DELIVERY_DEPART_MS;
    const step = Math.min(remaining, duration - next.elapsedMs);
    next.elapsedMs += step;
    remaining -= step;
    if (next.elapsedMs < duration) break;
    if (next.phase === "preparing") next = { phase: "arriving", orderId: next.orderId, elapsedMs: 0, blocked: false };
    else if (next.phase === "arriving") {
      next = { phase: "ready", orderId: next.orderId, elapsedMs: 0, blocked: false };
      break; // Arrival must wait for an explicit receipt, regardless of the delta size.
    } else {
      next = queueDelivery(createDeliveryState(), orders);
      if (next.phase === "idle") break;
    }
  }
  return next.phase === state.phase && next.orderId === state.orderId && next.elapsedMs === state.elapsedMs && next.blocked === state.blocked
    ? state : next;
}

/** The receiving reducer changes the matching order and its items before applying this transition. */
export function departDelivery(state: DeliveryState, orderId: string): DeliveryState {
  return state.phase === "ready" && state.orderId === orderId
    ? { phase: "departing", orderId, elapsedMs: 0, blocked: false } : state;
}

export function deliveryRemainingMs(state: DeliveryState): number {
  return state.phase === "preparing" ? DELIVERY_PREPARE_MS - state.elapsedMs + DELIVERY_ARRIVE_MS
    : state.phase === "arriving" ? DELIVERY_ARRIVE_MS - state.elapsedMs
      : state.phase === "departing" ? DELIVERY_DEPART_MS - state.elapsedMs : 0;
}

/** One authoritative position makes refresh, safe driving and the countdown agree. */
export function deliveryTruckX(state: DeliveryState): number {
  return state.phase === "arriving" ? DELIVERY_TRUCK_START_X
      + (DELIVERY_TRUCK_STOP_X - DELIVERY_TRUCK_START_X) * state.elapsedMs / DELIVERY_ARRIVE_MS
    : state.phase === "ready" ? DELIVERY_TRUCK_STOP_X
      : state.phase === "departing" ? DELIVERY_TRUCK_STOP_X
        + (DELIVERY_TRUCK_EXIT_X - DELIVERY_TRUCK_STOP_X) * state.elapsedMs / DELIVERY_DEPART_MS
        : state.phase === "preparing" ? DELIVERY_TRUCK_START_X : DELIVERY_TRUCK_EXIT_X;
}

export interface DeliveryTimeActivity {
  phase: string; mode: string; writable: boolean; foreground: boolean; hidden: boolean; learningPlayback: boolean;
}
export function isDeliveryTimeRunning(activity: DeliveryTimeActivity): boolean {
  return ["preparing", "open", "closing"].includes(activity.phase)
    && (activity.mode === "playing" || activity.mode === "cashier") && activity.writable
    && activity.foreground && !activity.hidden && !activity.learningPlayback;
}
