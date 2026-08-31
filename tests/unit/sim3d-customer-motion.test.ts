import { afterEach, describe, expect, it, vi } from "vitest";
import { Vector3, type Engine, type Scene, type TransformNode, type UniversalCamera } from "@babylonjs/core";
import {
  CUSTOMER_EXIT_STOP_SECONDS, CUSTOMER_STOP_SECONDS, CUSTOMER_WALK_SPEED,
} from "../../src/sim3d/customerSelection";
import { createFirstDayState, type CustomerPhase, type PlayerPose, type Position, type SimState } from "../../src/sim3d/domain";
import { ShopWorld, type WorldCallbacks } from "../../src/sim3d/world";

/**
 * Deliberately expose only the runtime members these contracts exercise. The
 * prototype supplies the real movement, route-reset, pose and render methods;
 * the constructor is skipped so no WebGL canvas, model downloads or DOM input
 * listeners are needed. No application-only test bridge is introduced.
 */
interface MotionRuntime {
  engine: Pick<Engine, "getDeltaTime" | "getFps">;
  scene: Pick<Scene, "render">;
  camera: Pick<UniversalCamera, "position" | "rotation">;
  customer: Pick<TransformNode, "position" | "rotation" | "isEnabled" | "setEnabled">;
  state: SimState;
  callbacks: Pick<WorldCallbacks, "onCustomerArrive" | "onFrame">;
  active: boolean;
  disposed: boolean;
  canvasWasLost: boolean;
  reducedMotion: boolean;
  customerPhase: CustomerPhase;
  route: Position[];
  routeIndex: number;
  arrivalDelay: number;
  arrivedRevision: number;
  frameClock: number;
  viewClock: number;
  poseClock: number;
  keys: Set<string>;
  updateCustomer(dt: number): void;
  setCustomerRoute(initial: boolean): void;
  render(): void;
  getPose(): PlayerPose;
  movePlayer(dt: number): void;
  updateTruck(dt: number): void;
  updateTarget(): void;
  updateGuide(): void;
  playCustomerAnimation(walking: boolean): void;
}

function createMotionWorld(phase: CustomerPhase = "to-milk") {
  let elapsedMilliseconds = 1000 / 60;
  let enabled = true;
  const onArrive = vi.fn<WorldCallbacks["onCustomerArrive"]>();
  const onFrame = vi.fn<NonNullable<WorldCallbacks["onFrame"]>>();
  const animate = vi.fn<(walking: boolean) => void>();
  const movePlayer = vi.fn<(dt: number) => void>();
  const updateTruck = vi.fn<(dt: number) => void>();
  const renderScene = vi.fn();
  const world = Object.create(ShopWorld.prototype) as MotionRuntime;
  Object.assign(world, {
    engine: { getDeltaTime: () => elapsedMilliseconds, getFps: () => 59.6 },
    scene: { render: renderScene },
    camera: { position: new Vector3(3, 1.65, -3), rotation: new Vector3(-.1, .4, 0) },
    customer: {
      position: Vector3.Zero(), rotation: Vector3.Zero(),
      isEnabled: () => enabled,
      setEnabled: (value: boolean) => { enabled = value },
    },
    state: { ...createFirstDayState(), revision: 7, customer: { phase, number: 1 } },
    callbacks: { onCustomerArrive: onArrive, onFrame },
    active: true, disposed: false, canvasWasLost: false, reducedMotion: true,
    customerPhase: phase, route: [{ x: 10, z: 0 }], routeIndex: 0,
    arrivalDelay: 0, arrivedRevision: -1, frameClock: 0, viewClock: 0, poseClock: 0,
    keys: new Set<string>(),
    movePlayer, updateTruck, playCustomerAnimation: animate,
    updateTarget: vi.fn(), updateGuide: vi.fn(),
  });
  return {
    world, onArrive, onFrame, animate, movePlayer, updateTruck, renderScene,
    frame(milliseconds: number): void {
      elapsedMilliseconds = milliseconds;
      world.render();
    },
  };
}

function advanceCustomer(world: MotionRuntime, seconds: number): void {
  let remaining = seconds;
  while (remaining > 1e-10) {
    const step = Math.min(.05, remaining);
    world.updateCustomer(step);
    remaining -= step;
  }
}

afterEach(() => { vi.restoreAllMocks() });

describe("real ShopWorld customer movement", () => {
  it("travels 1.41 metres in one second, including a normalised diagonal route", () => {
    const { world, animate, onArrive } = createMotionWorld();
    world.route = [{ x: 8, z: 6 }];
    advanceCustomer(world, 1);
    expect(CUSTOMER_WALK_SPEED).toBeCloseTo(1.41, 8);
    expect(world.customer.position.x).toBeCloseTo(1.41 * .8, 8);
    expect(world.customer.position.z).toBeCloseTo(1.41 * .6, 8);
    expect(Math.hypot(world.customer.position.x, world.customer.position.z)).toBeCloseTo(1.41, 8);
    expect(world.customer.position.y).toBe(0);
    expect(animate).toHaveBeenLastCalledWith(true);
    expect(onArrive).not.toHaveBeenCalled();
  });

  it("covers the same real-time distance at 10 fps and 60 fps", () => {
    const distances = [10, 60].map((fps) => {
      const { world, frame, renderScene } = createMotionWorld();
      for (let index = 0; index < fps; index += 1) frame(1000 / fps);
      expect(renderScene).toHaveBeenCalledTimes(fps);
      expect(world.customer.position.x).toBeCloseTo(1.41, 8);
      expect(world.customer.position.z).toBe(0);
      return world.customer.position.x;
    });
    expect(distances[0]).toBeCloseTo(distances[1]!, 8);
  });

  it("does not move a paused customer or accumulate a paused arrival delay", () => {
    const { world, frame, movePlayer, updateTruck, onArrive, renderScene } = createMotionWorld();
    world.active = false;
    const updateCustomer = vi.spyOn(world, "updateCustomer");
    frame(1000);
    expect(updateCustomer).not.toHaveBeenCalled();
    expect(movePlayer).not.toHaveBeenCalled();
    expect(updateTruck).not.toHaveBeenCalled();
    expect(world.customer.position.equals(Vector3.Zero())).toBe(true);
    world.route = [];
    world.arrivalDelay = CUSTOMER_STOP_SECONDS - .01;
    world.updateCustomer(.05);
    expect(world.arrivalDelay).toBeCloseTo(CUSTOMER_STOP_SECONDS - .01, 8);
    expect(onArrive).not.toHaveBeenCalled();
    expect(renderScene).toHaveBeenCalledOnce();
  });

  it("does not move a disabled customer", () => {
    const { world, frame, onArrive, animate } = createMotionWorld();
    world.customer.setEnabled(false);
    frame(1000);
    expect(world.customer.position.equals(Vector3.Zero())).toBe(true);
    expect(world.routeIndex).toBe(0);
    expect(animate).not.toHaveBeenCalled();
    expect(onArrive).not.toHaveBeenCalled();
  });

  it("waits in the idle animation when the player blocks the route, then resumes", () => {
    const { world, frame, animate, onArrive } = createMotionWorld();
    world.camera.position.set(.5, 1.65, 0);
    frame(1000);
    expect(world.customer.position.equals(Vector3.Zero())).toBe(true);
    expect(world.routeIndex).toBe(0);
    expect(world.arrivalDelay).toBe(0);
    expect(animate).toHaveBeenLastCalledWith(false);
    expect(onArrive).not.toHaveBeenCalled();
    world.camera.position.set(3, 1.65, -3);
    frame(100);
    expect(world.customer.position.x).toBeCloseTo(CUSTOMER_WALK_SPEED * .1, 8);
    expect(animate).toHaveBeenLastCalledWith(true);
  });

  it("checks player blocking within a long frame instead of taking one large step through the safety radius", () => {
    const { world, frame, animate, onArrive } = createMotionWorld();
    world.camera.position.set(.62, 1.65, 0);
    frame(4000);
    // At most one 50 ms step can enter the blocking radius before the next
    // substep must recheck it. One unsplit 250 ms step would reach x = .3525.
    expect(world.customer.position.x).toBeGreaterThanOrEqual(0);
    expect(world.customer.position.x).toBeLessThanOrEqual(CUSTOMER_WALK_SPEED * .05 + 1e-10);
    expect(world.customer.position.x).toBeLessThan(world.camera.position.x);
    expect(animate).toHaveBeenLastCalledWith(false);
    expect(onArrive).not.toHaveBeenCalled();
  });

  it("does not overshoot a nearby route endpoint during a long frame", () => {
    const { world, frame, onArrive } = createMotionWorld();
    world.route = [{ x: .09, z: 0 }];
    frame(2000);
    // Route completion has a 4.5 cm proximity tolerance; it must never jump
    // past the waypoint or bypass the separate stop before advancing phase.
    expect(world.customer.position.x).toBeGreaterThanOrEqual(.09 - .045);
    expect(world.customer.position.x).toBeLessThanOrEqual(.09 + 1e-10);
    expect(world.routeIndex).toBe(1);
    expect(onArrive).not.toHaveBeenCalled();
  });
});

describe("customer phase stops and single arrival notifications", () => {
  it.each([
    { phase: "to-milk", seconds: .35 },
    { phase: "to-bread", seconds: .35 },
    { phase: "to-checkout", seconds: .35 },
    { phase: "leaving", seconds: .1 },
  ] as const)("waits $seconds seconds at the end of $phase and notifies only once", ({ phase, seconds }) => {
    const { world, onArrive, animate } = createMotionWorld(phase);
    world.route = [];
    expect(phase === "leaving" ? CUSTOMER_EXIT_STOP_SECONDS : CUSTOMER_STOP_SECONDS).toBe(seconds);
    advanceCustomer(world, seconds - .001);
    expect(onArrive).not.toHaveBeenCalled();
    advanceCustomer(world, .002);
    expect(onArrive).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenLastCalledWith(false);
    expect(world.arrivedRevision).toBe(world.state.revision);
    advanceCustomer(world, 2);
    expect(onArrive).toHaveBeenCalledOnce();
  });

  it("does not emit duplicate arrivals across the remaining substeps of the same frame", () => {
    const { world, frame, onArrive } = createMotionWorld();
    world.route = [];
    world.arrivalDelay = CUSTOMER_STOP_SECONDS - .01;
    frame(250);
    expect(onArrive).toHaveBeenCalledOnce();
    frame(250);
    expect(onArrive).toHaveBeenCalledOnce();
  });

  it.each(["outside", "checkout", "complete"] as const)("does not auto-advance the stationary %s phase", (phase) => {
    const { world, onArrive } = createMotionWorld(phase);
    world.route = [];
    advanceCustomer(world, 2);
    expect(onArrive).not.toHaveBeenCalled();
    expect(world.arrivalDelay).toBe(0);
  });

  it("resets the stop and arrival guard for a new route without reusing the previous phase's wait", () => {
    const { world, onArrive } = createMotionWorld();
    world.route = [];
    advanceCustomer(world, CUSTOMER_STOP_SECONDS + .001);
    expect(onArrive).toHaveBeenCalledOnce();
    world.state = {
      ...world.state, revision: world.state.revision + 1,
      customer: { ...world.state.customer, phase: "to-bread" },
    };
    world.setCustomerRoute(false);
    expect(world.customerPhase).toBe("to-bread");
    expect(world.route.length).toBeGreaterThan(0);
    expect(world.routeIndex).toBe(0);
    expect(world.arrivalDelay).toBe(0);
    expect(world.arrivedRevision).toBe(-1);
    world.routeIndex = world.route.length;
    advanceCustomer(world, CUSTOMER_STOP_SECONDS - .001);
    expect(onArrive).toHaveBeenCalledOnce();
    advanceCustomer(world, .002);
    expect(onArrive).toHaveBeenCalledTimes(2);
  });
});

describe("real render-loop elapsed-time accounting", () => {
  it("gives NPCs 100 ms at 10 fps in substeps, while player and truck keep their 50 ms cap", () => {
    const { world, frame, movePlayer, updateTruck } = createMotionWorld();
    const updateCustomer = vi.spyOn(world, "updateCustomer");
    frame(100);
    expect(updateCustomer).toHaveBeenCalledTimes(2);
    expect(updateCustomer.mock.calls.map(([dt]) => dt)).toEqual([.05, .05]);
    expect(world.customer.position.x).toBeCloseTo(CUSTOMER_WALK_SPEED * .1, 8);
    expect(movePlayer).toHaveBeenCalledExactlyOnceWith(.05);
    expect(updateTruck).toHaveBeenCalledExactlyOnceWith(.05);
  });

  it("caps a multi-second frame at 250 ms for NPCs, never passing more than 50 ms to one movement step", () => {
    const { world, frame, movePlayer, updateTruck } = createMotionWorld();
    const updateCustomer = vi.spyOn(world, "updateCustomer");
    frame(5000);
    const steps = updateCustomer.mock.calls.map(([dt]) => dt);
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(steps.every((dt) => dt > 0 && dt <= .05)).toBe(true);
    expect(steps.reduce((sum, dt) => sum + dt, 0)).toBeCloseTo(.25, 10);
    expect(world.customer.position.x).toBeCloseTo(CUSTOMER_WALK_SPEED * .25, 8);
    expect(movePlayer).toHaveBeenCalledExactlyOnceWith(.05);
    expect(updateTruck).toHaveBeenCalledExactlyOnceWith(.05);
  });

  it("accumulates elapsed frame time for the 100 ms onFrame cadence, not the capped player timestep", () => {
    const { world, frame, onFrame } = createMotionWorld();
    frame(75);
    expect(onFrame).not.toHaveBeenCalled();
    frame(25);
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(60, world.getPose());
    expect(onFrame.mock.calls[0]![1]).toEqual({ x: 3, z: -3, yaw: .4, pitch: -.1 });
    frame(100);
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("does not bank paused time for a burst of customer movement on resume", () => {
    const { world, frame } = createMotionWorld();
    world.active = false;
    frame(5000);
    world.active = true;
    frame(1000 / 60);
    expect(world.customer.position.x).toBeCloseTo(CUSTOMER_WALK_SPEED / 60, 8);
  });

  it.each([0, -100])("never moves backwards for a non-positive frame delta of %i ms", (milliseconds) => {
    const { world, frame, onArrive } = createMotionWorld();
    frame(milliseconds);
    expect(world.customer.position.equals(Vector3.Zero())).toBe(true);
    expect(onArrive).not.toHaveBeenCalled();
  });

  it.each(["disposed", "canvasWasLost"] as const)("does no simulation or rendering while %s", (flag) => {
    const { world, frame, renderScene, onFrame, movePlayer, updateTruck } = createMotionWorld();
    world[flag] = true;
    const updateCustomer = vi.spyOn(world, "updateCustomer");
    frame(1000);
    expect(updateCustomer).not.toHaveBeenCalled();
    expect(movePlayer).not.toHaveBeenCalled();
    expect(updateTruck).not.toHaveBeenCalled();
    expect(renderScene).not.toHaveBeenCalled();
    expect(onFrame).not.toHaveBeenCalled();
  });
});
