export type PointerMode = "locked" | "free" | "drag";

/** Distinguishes an intentional UI unlock from Escape or an unexpected browser unlock. */
export class PointerAccess {
  private wantsLock = false;
  private hasLock = false;
  private releasing = false;
  private fallback = false;

  get mode(): PointerMode { return this.hasLock && this.wantsLock ? "locked" : this.fallback ? "drag" : "free" }

  requestLock(): void { this.wantsLock = true; this.fallback = false; this.releasing = false }

  releaseForUi(currentlyLocked: boolean): void {
    this.wantsLock = false;
    this.releasing ||= currentlyLocked;
  }

  rejected(): void {
    this.wantsLock = false;
    this.hasLock = false;
    this.releasing = false;
    this.fallback = true;
  }

  changed(locked: boolean, playing: boolean): { pause: boolean; release: boolean; mode: PointerMode } {
    const previouslyLocked = this.hasLock;
    this.hasLock = locked;
    if (locked && !this.wantsLock) {
      // A pending request may resolve after the player has opened a UI panel.
      this.releasing = true;
      return { pause: false, release: true, mode: this.mode };
    }
    const pause = !locked && previouslyLocked && this.wantsLock && !this.releasing && playing;
    if (!locked) {
      this.releasing = false;
      this.wantsLock = false;
    }
    return { pause, release: false, mode: this.mode };
  }
}
