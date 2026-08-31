import { afterEach, describe, expect, it, vi } from "vitest";
import { Vector3, type Engine, type Scene, type UniversalCamera } from "@babylonjs/core";
import { createFirstDayState, type PlayerPose, type SimState } from "../../src/sim3d/domain";
import {
  PLAYER_CARRY_WALK_SPEED, PLAYER_SPRINT_MULTIPLIER, PLAYER_WALK_SPEED, playerMovementSpeed,
} from "../../src/sim3d/playerMovement";
import { PointerAccess } from "../../src/sim3d/pointerAccess";
import { ShopWorld, type WorldCallbacks } from "../../src/sim3d/world";

type Collider = { minX: number; maxX: number; minZ: number; maxZ: number };

class CanvasDouble extends EventTarget {
  readonly focus = vi.fn();
}

class DocumentDouble extends EventTarget {
  hidden = false;
  pointerLockElement: CanvasDouble | null = null;
  readonly exitPointerLock = vi.fn(() => {
    this.pointerLockElement = null;
    this.dispatchEvent(new Event("pointerlockchange"));
  });
}

/**
 * The real ShopWorld prototype supplies movement, collision checks, input and
 * rendering. Only its WebGL/DOM dependencies are replaced; no production-only
 * test hook or second implementation of the movement rules is introduced.
 */
interface MovementRuntime {
  engine: Pick<Engine, "getDeltaTime" | "getFps">;
  scene: Pick<Scene, "render" | "animationsEnabled">;
  camera: Pick<UniversalCamera, "position" | "rotation">;
  canvas: CanvasDouble;
  state: SimState;
  callbacks: WorldCallbacks;
  colliders: Collider[];
  keys: Set<string>;
  lifetime: AbortController;
  pointerAccess: PointerAccess;
  pointerRequestGeneration: number;
  drag: { x: number; y: number } | null;
  active: boolean;
  disposed: boolean;
  canvasWasLost: boolean;
  reducedMotion: boolean;
  inspectionProduct: null;
  sensitivity: number;
  frameClock: number;
  viewClock: number;
  poseClock: number;
  movePlayer(dt: number): void;
  isFree(x: number, z: number): boolean;
  installInput(): void;
  setActive(active: boolean): void;
  setCursorFree(free: boolean): void;
  render(): void;
  getPose(): PlayerPose;
  updateCustomer(dt: number): void;
  updateTruck(dt: number): void;
  updateTarget(): void;
  updateGuide(): void;
}

const lifetimes: AbortController[] = [];

function createMovementWorld(keys: readonly string[] = [], held: SimState["held"] = { kind: "none" }) {
  let elapsedMilliseconds = 1000 / 60;
  const world = Object.create(ShopWorld.prototype) as MovementRuntime;
  const lifetime = new AbortController();
  lifetimes.push(lifetime);
  const renderScene = vi.fn();
  const updateCustomer = vi.fn<(dt: number) => void>();
  const updateTruck = vi.fn<(dt: number) => void>();
  const onPause = vi.fn(() => world.setActive(false));
  Object.assign(world, {
    engine: { getDeltaTime: () => elapsedMilliseconds, getFps: () => 60 },
    scene: { render: renderScene, animationsEnabled: true },
    camera: { position: new Vector3(0, 1.65, -12), rotation: Vector3.Zero() },
    canvas: new CanvasDouble(),
    state: { ...createFirstDayState(), held, crates: [] },
    callbacks: {
      onTarget: vi.fn(), onInteract: vi.fn(), onInspect: vi.fn(), onDrop: vi.fn(),
      onPause, onCustomerArrive: vi.fn(), onStatus: vi.fn(), onPointerMode: vi.fn(),
    },
    colliders: [], keys: new Set(keys), lifetime, pointerAccess: new PointerAccess(),
    pointerRequestGeneration: 0, drag: null, active: true, disposed: false,
    canvasWasLost: false, reducedMotion: true, inspectionProduct: null, sensitivity: 1,
    frameClock: 0, viewClock: 0, poseClock: 0,
    updateCustomer, updateTruck, updateTarget: vi.fn(), updateGuide: vi.fn(),
  });
  return {
    world, onPause, renderScene, updateCustomer, updateTruck,
    frame(milliseconds: number): void {
      elapsedMilliseconds = milliseconds;
      world.render();
    },
  };
}

function createInputWorld() {
  const harness = createMovementWorld();
  const windowDouble = new EventTarget();
  const documentDouble = new DocumentDouble();
  vi.stubGlobal("window", windowDouble);
  vi.stubGlobal("document", documentDouble);
  harness.world.installInput();
  function key(type: "keydown" | "keyup", code: string, repeat = false, modifiers: { shiftKey?: boolean } = {}): Event {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      code, repeat, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers,
    });
    windowDouble.dispatchEvent(event);
    return event;
  }
  function lockPointer(): void {
    harness.world.pointerAccess.requestLock();
    documentDouble.pointerLockElement = harness.world.canvas;
    documentDouble.dispatchEvent(new Event("pointerlockchange"));
  }
  return { ...harness, windowDouble, documentDouble, key, lockPointer };
}

afterEach(() => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("player movement speed selection", () => {
  it("raises normal and crate-carrying walking speeds while retaining a carrying penalty", () => {
    expect(PLAYER_WALK_SPEED).toBe(2.8);
    expect(PLAYER_CARRY_WALK_SPEED).toBe(2.2);
    expect(PLAYER_SPRINT_MULTIPLIER).toBe(1.8);
    expect(PLAYER_WALK_SPEED).toBeGreaterThan(1.85);
    expect(PLAYER_CARRY_WALK_SPEED).toBeGreaterThan(1.45);
    expect(PLAYER_CARRY_WALK_SPEED).toBeLessThan(PLAYER_WALK_SPEED);
  });

  it.each([false, true])("does not accelerate without Shift (carrying: %s)", (carrying) => {
    const keys: ReadonlySet<string> = new Set(["KeyW", "KeyD", "CapsLock"]);
    expect(playerMovementSpeed(keys, carrying)).toBe(carrying ? 2.2 : 2.8);
    expect([...keys]).toEqual(["KeyW", "KeyD", "CapsLock"]);
  });

  it.each([
    ["ShiftLeft"], ["ShiftRight"], ["ShiftLeft", "ShiftRight"],
  ])("uses one sprint multiplier for the held modifiers %j", (...modifiers) => {
    const keys = new Set(["KeyW", ...modifiers]);
    expect(playerMovementSpeed(keys, false)).toBeCloseTo(5.04, 10);
    expect(playerMovementSpeed(keys, true)).toBeCloseTo(3.96, 10);
  });

  it("reads the current key set each time instead of toggling or retaining a sprint state", () => {
    const keys = new Set(["KeyW"]);
    expect(playerMovementSpeed(keys, false)).toBe(2.8);
    keys.add("ShiftLeft");
    expect(playerMovementSpeed(keys, false)).toBeCloseTo(5.04, 10);
    keys.delete("ShiftLeft");
    expect(playerMovementSpeed(keys, false)).toBe(2.8);
    keys.add("ShiftRight");
    expect(playerMovementSpeed(keys, false)).toBeCloseTo(5.04, 10);
    keys.clear();
    expect(playerMovementSpeed(keys, false)).toBe(2.8);
  });
});

describe("real ShopWorld player movement", () => {
  it.each([
    { held: { kind: "none" } as const, speed: 2.8 },
    { held: { kind: "crate", crateId: "milk-crate" } as const, speed: 2.2 },
    { held: { kind: "item", itemId: "milk-1", returnTo: { kind: "shelf", productId: "milk", slot: 0 } } as const, speed: 2.8 },
  ])("walks at $speed metres/second with $held.kind held", ({ held, speed }) => {
    const { world } = createMovementWorld(["KeyW"], held);
    world.movePlayer(1);
    expect(world.camera.position.z).toBeCloseTo(-12 + speed, 10);
    expect(world.camera.position.x).toBe(0);
    expect(world.camera.position.y).toBe(1.65);
  });

  it.each(["ShiftLeft", "ShiftRight"])("applies %s to movement, including while carrying a crate", (modifier) => {
    const normal = createMovementWorld(["KeyW", modifier]).world;
    const carrying = createMovementWorld(["KeyW", modifier], { kind: "crate", crateId: "milk-crate" }).world;
    normal.movePlayer(1);
    carrying.movePlayer(1);
    expect(normal.camera.position.z).toBeCloseTo(-12 + 5.04, 10);
    expect(carrying.camera.position.z).toBeCloseTo(-12 + 3.96, 10);
  });

  it.each([
    { direction: ["KeyW", "KeyD"], x: Math.SQRT1_2, z: Math.SQRT1_2 },
    { direction: ["ArrowUp", "ArrowLeft"], x: -Math.SQRT1_2, z: Math.SQRT1_2 },
    { direction: ["KeyS", "ArrowRight"], x: Math.SQRT1_2, z: -Math.SQRT1_2 },
  ])("normalises sprinting diagonal keys $direction", ({ direction, x, z }) => {
    const { world } = createMovementWorld([...direction, "ShiftLeft"]);
    world.movePlayer(.5);
    expect(world.camera.position.x).toBeCloseTo(x * 5.04 * .5, 10);
    expect(world.camera.position.z + 12).toBeCloseTo(z * 5.04 * .5, 10);
    expect(Math.hypot(world.camera.position.x, world.camera.position.z + 12)).toBeCloseTo(5.04 * .5, 10);
  });

  it("moves relative to the view direction instead of fixed world axes", () => {
    const { world } = createMovementWorld(["ArrowUp", "ShiftRight"]);
    world.camera.rotation.y = Math.PI / 2;
    world.movePlayer(.5);
    expect(world.camera.position.x).toBeCloseTo(5.04 * .5, 10);
    expect(world.camera.position.z).toBeCloseTo(-12, 10);
  });

  it("does not move with only Shift or with opposing direction keys", () => {
    for (const keys of [["ShiftLeft"], ["ShiftRight"], ["ShiftLeft", "ShiftRight"], ["KeyW", "KeyS", "ShiftLeft"]]) {
      const { world, frame } = createMovementWorld(keys);
      const before = world.getPose();
      world.movePlayer(.05);
      frame(250);
      expect(world.getPose()).toEqual(before);
    }
  });

  it("does not speed up keyboard camera rotation when Shift is held", () => {
    const walking = createMovementWorld(["KeyJ", "KeyI"]).world;
    const sprinting = createMovementWorld(["KeyJ", "KeyI", "ShiftLeft"]).world;
    walking.movePlayer(.2);
    sprinting.movePlayer(.2);
    expect(sprinting.getPose()).toEqual(walking.getPose());
    expect(sprinting.camera.rotation.y).toBeCloseTo(-.32, 10);
    expect(sprinting.camera.rotation.x).toBeCloseTo(-.25, 10);
  });
});

describe("real input hold, repeat and release behavior", () => {
  it.each(["ShiftLeft", "ShiftRight"])("accepts %s without adding a movement step, including while W is already held", (modifier) => {
    const { world, key, frame } = createInputWorld();
    const movePlayer = vi.spyOn(world, "movePlayer");
    const initial = world.getPose();
    expect(key("keydown", modifier).defaultPrevented).toBe(true);
    expect(world.keys.has(modifier)).toBe(true);
    expect(world.getPose()).toEqual(initial);
    expect(movePlayer).not.toHaveBeenCalled();
    key("keyup", modifier);
    key("keydown", "KeyW");
    expect(movePlayer).toHaveBeenCalledExactlyOnceWith(.045);
    expect(world.camera.position.z).toBeCloseTo(-12 + 2.8 * .045, 10);
    const afterWalkingTap = world.getPose();
    key("keydown", modifier);
    expect(world.getPose()).toEqual(afterWalkingTap);
    expect(movePlayer).toHaveBeenCalledTimes(1);
    frame(100);
    expect(world.camera.position.z - afterWalkingTap.z).toBeCloseTo(5.04 * .1, 10);
    key("keyup", modifier);
    const afterSprint = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - afterSprint).toBeCloseTo(2.8 * .1, 10);
    expect(world.keys.has("KeyW")).toBe(true);
  });

  it.each([false, true])("keeps sprinting for a long hold with keyboard repeats set to %s", (repeatEvents) => {
    const { world, key, frame } = createInputWorld();
    key("keydown", "ShiftLeft");
    key("keydown", "KeyW");
    const start = world.camera.position.z;
    for (let frameIndex = 0; frameIndex < 180; frameIndex += 1) {
      if (repeatEvents && frameIndex % 10 === 0) {
        const beforeRepeat = world.getPose();
        key("keydown", "ShiftLeft", true);
        key("keydown", "KeyW", true);
        expect(world.getPose()).toEqual(beforeRepeat);
      }
      frame(1000 / 60);
    }
    expect(world.camera.position.z - start).toBeCloseTo(5.04 * 3, 8);
    expect(world.keys).toEqual(new Set(["ShiftLeft", "KeyW"]));
  });

  it("does not stack both Shift keys and keeps sprinting until both are released", () => {
    const { world, key, frame } = createInputWorld();
    key("keydown", "ShiftLeft");
    key("keydown", "ShiftRight");
    key("keydown", "ArrowUp");
    let start = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - start).toBeCloseTo(5.04 * .1, 10);
    key("keyup", "ShiftLeft");
    start = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - start).toBeCloseTo(5.04 * .1, 10);
    key("keyup", "ShiftRight");
    start = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - start).toBeCloseTo(2.8 * .1, 10);
  });

  it("stops immediately when the direction key is released even if Shift stays held", () => {
    const { world, key, frame } = createInputWorld();
    key("keydown", "ShiftRight");
    key("keydown", "KeyW");
    frame(100);
    key("keyup", "KeyW");
    const before = world.getPose();
    frame(250);
    expect(world.getPose()).toEqual(before);
    expect(world.keys).toEqual(new Set(["ShiftRight"]));
  });
});

describe("player elapsed-time and collision safety", () => {
  it.each([false, true])("covers the same distance at 10 and 60 fps (sprinting: %s)", (sprinting) => {
    const expected = sprinting ? 5.04 : 2.8;
    const distances = [10, 60].map((fps) => {
      const { world, frame, renderScene } = createMovementWorld(sprinting ? ["KeyW", "ShiftLeft"] : ["KeyW"]);
      for (let index = 0; index < fps; index += 1) frame(1000 / fps);
      expect(renderScene).toHaveBeenCalledTimes(fps);
      expect(world.camera.position.z + 12).toBeCloseTo(expected, 8);
      return world.camera.position.z;
    });
    expect(distances[0]).toBeCloseTo(distances[1]!, 8);
  });

  it("subdivides a 100 ms player frame and leaves the delivery truck timestep unchanged", () => {
    const { world, frame, updateTruck } = createMovementWorld(["KeyW", "ShiftLeft"]);
    const movePlayer = vi.spyOn(world, "movePlayer");
    frame(100);
    expect(movePlayer.mock.calls.map(([dt]) => dt)).toEqual([.05, .05]);
    expect(world.camera.position.z + 12).toBeCloseTo(5.04 * .1, 10);
    expect(updateTruck).toHaveBeenCalledExactlyOnceWith(.05);
  });

  it("caps a stalled frame at 250 ms and each player collision step at 50 ms", () => {
    const { world, frame } = createMovementWorld(["KeyW", "ShiftLeft"]);
    const movePlayer = vi.spyOn(world, "movePlayer");
    frame(5000);
    const steps = movePlayer.mock.calls.map(([dt]) => dt);
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(steps.every((dt) => dt > 0 && dt <= .05)).toBe(true);
    expect(steps.reduce((sum, dt) => sum + dt, 0)).toBeCloseTo(.25, 10);
    expect(world.camera.position.z + 12).toBeCloseTo(5.04 * .25, 10);
  });

  it("cannot sprint through a thin wall during a long frame", () => {
    const { world, frame } = createMovementWorld(["KeyW", "ShiftRight"]);
    world.colliders = [{ minX: -3, maxX: 3, minZ: -11.3, maxZ: -11.28 }];
    frame(5000);
    // A single 250 ms jump ends beyond this entire wall plus player radius.
    // Real 50 ms substeps must encounter and stop at the blocked interval.
    expect(world.camera.position.z).toBeGreaterThan(-12);
    expect(world.camera.position.z).toBeLessThanOrEqual(-11.3 - .24);
    expect(world.isFree(world.camera.position.x, world.camera.position.z)).toBe(true);
    const stopped = world.getPose();
    frame(250);
    expect(world.getPose()).toEqual(stopped);
  });

  it("slides along the free collision axis without penetrating a wall diagonally", () => {
    const { world, frame } = createMovementWorld(["KeyW", "KeyD", "ShiftLeft"]);
    world.colliders = [{ minX: .5, maxX: .52, minZ: -14, maxZ: -6 }];
    for (let index = 0; index < 20; index += 1) frame(50);
    expect(world.camera.position.x).toBeGreaterThan(0);
    expect(world.camera.position.x).toBeLessThanOrEqual(.5 - .24);
    expect(world.camera.position.z + 12).toBeCloseTo(5.04 * Math.SQRT1_2, 8);
    expect(world.isFree(world.camera.position.x, world.camera.position.z)).toBe(true);
  });

  it.each([0, -100])("does not move for a non-positive frame delta of %i ms", (milliseconds) => {
    const { world, frame } = createMovementWorld(["KeyW", "ShiftLeft"]);
    const before = world.getPose();
    frame(milliseconds);
    expect(world.getPose()).toEqual(before);
  });

  it.each(["disposed", "canvasWasLost"] as const)("does not move or render while %s", (flag) => {
    const { world, frame, renderScene } = createMovementWorld(["KeyW", "ShiftLeft"]);
    world[flag] = true;
    const before = world.getPose();
    frame(1000);
    expect(world.getPose()).toEqual(before);
    expect(renderScene).not.toHaveBeenCalled();
  });
});

describe("sprint input cleanup", () => {
  it.each([
    { reason: "pause", modifier: "ShiftLeft" },
    { reason: "cursor-free", modifier: "ShiftRight" },
  ] as const)("recognises still-held $modifier on a fresh movement press after $reason without automatically resuming", ({ reason, modifier }) => {
    const { world, key, frame, lockPointer } = createInputWorld();
    if (reason === "cursor-free") lockPointer();
    key("keydown", modifier, false, { shiftKey: true });
    key("keydown", "KeyW", false, { shiftKey: true });
    frame(100);
    const beforeClearing = world.getPose();
    if (reason === "pause") world.setActive(false);
    else world.setCursorFree(true);
    expect(world.keys.size).toBe(0);
    frame(100);
    expect(world.getPose()).toEqual(beforeClearing);
    if (reason === "pause") world.setActive(true);
    // A physically held key can repeat after returning to the game. Repeating
    // Shift alone must not restore movement or resurrect the cleared W key.
    key("keydown", modifier, true, { shiftKey: true });
    frame(100);
    expect(world.keys.size).toBe(0);
    expect(world.getPose()).toEqual(beforeClearing);

    key("keydown", "KeyW", false, { shiftKey: true });
    expect(world.keys).toEqual(new Set(["KeyW", "Shift"]));
    expect(world.camera.position.z - beforeClearing.z).toBeCloseTo(5.04 * .045, 10);
    const sprintStart = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - sprintStart).toBeCloseTo(5.04 * .1, 10);

    key("keyup", modifier, false, { shiftKey: false });
    expect(world.keys).toEqual(new Set(["KeyW"]));
    const walkStart = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - walkStart).toBeCloseTo(2.8 * .1, 10);
  });

  it("stays stationary with only the recovered Shift modifier after releasing the direction key", () => {
    const { world, key, frame } = createInputWorld();
    // No Shift keydown reached this world; the fresh W event reports the
    // still-held physical modifier after an earlier input reset.
    key("keydown", "KeyW", false, { shiftKey: true });
    key("keyup", "KeyW", false, { shiftKey: true });
    expect(world.keys).toEqual(new Set(["Shift"]));
    expect(playerMovementSpeed(world.keys, false)).toBeCloseTo(5.04, 10);
    const stationary = world.getPose();
    frame(250);
    expect(world.getPose()).toEqual(stationary);
    key("keyup", "ShiftRight", false, { shiftKey: false });
    expect(world.keys.size).toBe(0);
    frame(250);
    expect(world.getPose()).toEqual(stationary);
  });

  it("keeps sprinting when a newly pressed right Shift is released while left Shift remains held across a pause", () => {
    const { world, key, frame } = createInputWorld();
    key("keydown", "ShiftLeft", false, { shiftKey: true });
    world.setActive(false);
    world.setActive(true);
    expect(world.keys.size).toBe(0);
    const beforeMoving = world.getPose();

    key("keydown", "ShiftRight", false, { shiftKey: true });
    frame(100);
    expect(world.keys).toEqual(new Set(["ShiftRight"]));
    expect(world.getPose()).toEqual(beforeMoving);
    key("keydown", "KeyW", false, { shiftKey: true });
    expect(world.camera.position.z - beforeMoving.z).toBeCloseTo(5.04 * .045, 10);
    const bothHeldStart = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - bothHeldStart).toBeCloseTo(5.04 * .1, 10);

    // Left Shift's original keydown was cleared by pausing. Releasing the
    // tracked right Shift must retain the still-held modifier, not its side.
    key("keyup", "ShiftRight", false, { shiftKey: true });
    expect(world.keys).toEqual(new Set(["KeyW", "Shift"]));
    const leftHeldStart = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - leftHeldStart).toBeCloseTo(5.04 * .1, 10);

    key("keyup", "ShiftLeft", false, { shiftKey: false });
    expect(world.keys).toEqual(new Set(["KeyW"]));
    const releasedStart = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - releasedStart).toBeCloseTo(2.8 * .1, 10);
  });

  it.each(["blur", "hidden", "pause", "escape", "cursor-free", "pointer-unlock"] as const)("clears held Shift on %s and resumes at normal speed", (reason) => {
    const { world, key, frame, windowDouble, documentDouble, lockPointer } = createInputWorld();
    if (reason === "pointer-unlock" || reason === "cursor-free") lockPointer();
    key("keydown", "ShiftLeft");
    key("keydown", "ShiftRight");
    key("keydown", "KeyW");
    frame(100);
    const before = world.getPose();
    if (reason === "blur") windowDouble.dispatchEvent(new Event("blur"));
    else if (reason === "hidden") {
      documentDouble.hidden = true;
      documentDouble.dispatchEvent(new Event("visibilitychange"));
    } else if (reason === "pause") world.setActive(false);
    else if (reason === "escape") key("keydown", "Escape");
    else if (reason === "cursor-free") world.setCursorFree(true);
    else {
      documentDouble.pointerLockElement = null;
      documentDouble.dispatchEvent(new Event("pointerlockchange"));
    }
    expect(world.keys.size).toBe(0);
    if (reason === "cursor-free") {
      expect(world.active).toBe(true);
      expect(documentDouble.exitPointerLock).toHaveBeenCalledOnce();
    } else expect(world.active).toBe(false);
    frame(5000);
    expect(world.getPose()).toEqual(before);
    documentDouble.hidden = false;
    world.setActive(true);
    frame(100);
    expect(world.getPose()).toEqual(before);
    key("keydown", "KeyW");
    expect(world.camera.position.z - before.z).toBeCloseTo(2.8 * .045, 10);
    const resumed = world.camera.position.z;
    frame(100);
    expect(world.camera.position.z - resumed).toBeCloseTo(2.8 * .1, 10);
  });

  it("ignores new direction and Shift presses while paused", () => {
    const { world, key, frame } = createInputWorld();
    world.setActive(false);
    const before = world.getPose();
    key("keydown", "ShiftRight");
    key("keydown", "KeyW");
    frame(1000);
    expect(world.keys.size).toBe(0);
    expect(world.getPose()).toEqual(before);
    world.setActive(true);
    frame(100);
    expect(world.getPose()).toEqual(before);
  });

  it("does not clear held sprint keys on an unrelated visible-state notification", () => {
    const { world, key, documentDouble } = createInputWorld();
    key("keydown", "ShiftLeft");
    key("keydown", "KeyW");
    documentDouble.dispatchEvent(new Event("visibilitychange"));
    expect(world.active).toBe(true);
    expect(world.keys).toEqual(new Set(["ShiftLeft", "KeyW"]));
  });
});
