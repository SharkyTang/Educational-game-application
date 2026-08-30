import { describe, expect, it } from "vitest";
import { PointerAccess } from "../../src/sim3d/pointerAccess";

describe("first-person mouse and clickable UI", () => {
  it("releases for a customer/UI without pausing the shop", () => {
    const input = new PointerAccess();
    input.requestLock();
    expect(input.changed(true, true).mode).toBe("locked");
    input.releaseForUi(true);
    expect(input.mode).toBe("free");
    expect(input.changed(false, true)).toEqual({ pause: false, release: false, mode: "free" });
  });

  it("Escape or unexpected lock loss pauses while playing", () => {
    const input = new PointerAccess();
    input.requestLock(); input.changed(true, true);
    expect(input.changed(false, true).pause).toBe(true);
    expect(input.changed(false, true).pause).toBe(false);
  });

  it("never traps a late successful request over an already opened panel", () => {
    const input = new PointerAccess();
    input.requestLock(); input.releaseForUi(false);
    expect(input.changed(true, true)).toEqual({ pause: false, release: true, mode: "free" });
    expect(input.changed(false, true).pause).toBe(false);
  });

  it("falls back to drag and allows a later explicit lock request", () => {
    const input = new PointerAccess();
    input.requestLock(); input.rejected();
    expect(input.mode).toBe("drag");
    expect(input.changed(false, true).pause).toBe(false);
    input.requestLock();
    expect(input.changed(true, true).mode).toBe("locked");
  });

  it("does not recursively pause after the world was deactivated", () => {
    const input = new PointerAccess();
    input.requestLock(); input.changed(true, true);
    input.releaseForUi(true);
    expect(input.changed(false, false).pause).toBe(false);
  });
});
