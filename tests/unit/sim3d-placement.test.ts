import { afterEach, describe, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Scene, TransformNode } from "@babylonjs/core";
import { placeCustomerVisual } from "../../src/sim3d/modelPlacement";

describe("customer model coordinate frame", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose() });

  it.each([[0, -4.35, 0], [-.94, -2.15, -Math.PI / 2], [1.65, .35, Math.PI / 2]])(
    "keeps visual and basket together at route point (%s, %s, %s)", (x, z, yaw) => {
      const engine = new NullEngine(); engines.push(engine);
      const scene = new Scene(engine);
      const pathRoot = new TransformNode("route", scene);
      pathRoot.position.set(x, 0, z); pathRoot.rotation.y = yaw;
      const visual = new TransformNode("visual", scene);
      // Reproduce the bug where a loaded visual was already under its translated parent.
      visual.parent = pathRoot;
      const body = MeshBuilder.CreateBox("body", { width: .4, height: 1.8, depth: .25 }, scene);
      body.position.set(.12, .9, -.08); body.parent = visual;
      placeCustomerVisual(visual, pathRoot);
      const bounds = visual.getHierarchyBoundingVectors(true);
      expect(bounds.max.y - bounds.min.y).toBeCloseTo(1.68, 5);
      expect(bounds.min.y).toBeCloseTo(0, 5);
      expect((bounds.max.x + bounds.min.x) / 2).toBeCloseTo(x, 5);
      expect((bounds.max.z + bounds.min.z) / 2).toBeCloseTo(z, 5);
      expect(pathRoot.position.x).toBe(x);
      expect(pathRoot.position.z).toBe(z);
    },
  );
  it("rejects a model without measurable geometry", () => {
    const engine = new NullEngine(); engines.push(engine);
    const scene = new Scene(engine);
    expect(() => placeCustomerVisual(new TransformNode("empty", scene), new TransformNode("route", scene))).toThrow("有效几何体");
  });
});
