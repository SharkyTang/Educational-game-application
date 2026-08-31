/** Metres per second; carrying a crate stays a little slower than empty hands. */
export const PLAYER_WALK_SPEED = 2.8;
export const PLAYER_CARRY_WALK_SPEED = 2.2;
export const PLAYER_SPRINT_MULTIPLIER = 1.8;

/** Hold either Shift to sprint. There is no toggle, timer or stamina limit. */
export function playerMovementSpeed(keys: ReadonlySet<string>, carryingCrate: boolean): number {
  const walking = carryingCrate ? PLAYER_CARRY_WALK_SPEED : PLAYER_WALK_SPEED;
  // "Shift" is the modifier snapshot when a new direction is pressed after
  // input cleanup, while the physical Shift key has remained held throughout.
  const sprinting = keys.has("ShiftLeft") || keys.has("ShiftRight") || keys.has("Shift");
  return walking * (sprinting ? PLAYER_SPRINT_MULTIPLIER : 1);
}
