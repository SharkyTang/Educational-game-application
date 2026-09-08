import { describe, expect, it, vi } from "vitest";
import { LayoutEditor } from "../../src/sim3d/layoutEditor";
import { createDefaultShopLayout } from "../../src/sim3d/shopLayout";
import { createEquipmentAssetState } from "../../src/sim3d/equipmentCommerce";
import type { EquipmentShopLayout } from "../../src/sim3d/equipmentLayout";
import { DEFAULT_WORKSTATION_PLACEMENT, WORKSTATION_ID } from "../../src/sim3d/workstation";

interface EditorHarness {
  draft: EquipmentShopLayout;
  baseline: EquipmentShopLayout;
  selected: string;
  options: { editable: boolean };
  applyError: string;
  callbacks: { onApply: ReturnType<typeof vi.fn> };
  hasUnsavedChanges(): boolean;
  move(direction: string): void;
  rotate(): void;
  toggleEquipment(): void;
  apply(): void;
  discard(): void;
}

/** Exercise the real draft/commit code without replacing the layout or collision validators. */
function harness(): EditorHarness {
  const baseline: EquipmentShopLayout = { ...createDefaultShopLayout(), equipment: [], workstation: { ...DEFAULT_WORKSTATION_PLACEMENT } };
  const editor = Object.create(LayoutEditor.prototype) as EditorHarness;
  Object.assign(editor, { baseline, draft: structuredClone(baseline), selected: WORKSTATION_ID, options: { editable: true },
    callbacks: { onApply: vi.fn() }, equipmentState: createEquipmentAssetState(), drag: null,
    disposed: false, conflict: false, applyError: "", render: vi.fn(), drawRoom: vi.fn() });
  return editor;
}

describe("management workstation renovation draft", () => {
  it("moves the computer alone, preserves the original placements, and discards the independent draft", () => {
    const editor = harness();
    const original = structuredClone(editor.baseline);
    editor.move("right");
    expect(editor.draft.workstation).toEqual({ x: -1.7, z: -4.15, rotation: 0 });
    expect(Object.keys(editor.draft.workstation!).sort()).toEqual(["rotation", "x", "z"]);
    expect(editor.draft.placements).toEqual(original.placements);
    expect(editor.baseline).toEqual(original);
    expect(editor.hasUnsavedChanges()).toBe(true);
    editor.discard();
    expect(editor.hasUnsavedChanges()).toBe(false);
    expect(editor.draft.workstation).toEqual(original.workstation);
    expect(editor.draft.workstation).not.toBe(editor.baseline.workstation);
  });

  it("rotates all four orientations and never sends the only computer to equipment storage", () => {
    const editor = harness();
    for (const rotation of [1, 2, 3, 0]) {
      editor.rotate(); expect(editor.draft.workstation!.rotation).toBe(rotation);
    }
    editor.toggleEquipment();
    expect(editor.draft.workstation).toEqual(DEFAULT_WORKSTATION_PLACEMENT);
    expect(editor.draft.equipment).toEqual([]);
    editor.options.editable = false;
    editor.move("right"); editor.rotate();
    expect(editor.hasUnsavedChanges()).toBe(false);
  });

  it("commits a valid computer relocation including its placement field and retains a failed save draft", () => {
    const editor = harness();
    editor.move("right");
    editor.callbacks.onApply.mockReturnValue(false);
    editor.apply();
    expect(editor.callbacks.onApply).toHaveBeenCalledTimes(1);
    expect(editor.callbacks.onApply.mock.calls[0]![0].workstation).toEqual({ x: -1.7, z: -4.15, rotation: 0 });
    expect(editor.hasUnsavedChanges()).toBe(true);
    expect(editor.applyError).toContain("草稿已保留");
    editor.callbacks.onApply.mockReturnValue(true);
    editor.apply();
    expect(editor.hasUnsavedChanges()).toBe(false);
    expect(editor.baseline.workstation).toEqual({ x: -1.7, z: -4.15, rotation: 0 });
  });

  it("does not apply a computer position that blocks the doorway or loses access to its screen", () => {
    const editor = harness();
    editor.draft.workstation = { x: 0, z: -4.15, rotation: 0 };
    editor.apply();
    expect(editor.callbacks.onApply).not.toHaveBeenCalled();
    editor.draft.workstation = { ...DEFAULT_WORKSTATION_PLACEMENT, rotation: 2 };
    editor.apply();
    expect(editor.callbacks.onApply).not.toHaveBeenCalled();
    expect(editor.hasUnsavedChanges()).toBe(true);
  });
});
