import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AbstractMesh, Camera, DynamicTexture, Matrix, MeshBuilder, NullEngine, PBRMaterial, Ray, Scene,
  StandardMaterial, TransformNode, UniversalCamera, Vector3, VertexBuffer, Viewport,
} from "@babylonjs/core";
import { createDefaultCashDrawer, type CashDrawerState } from "../../src/sim3d/cashDrawer";
import { CASH_DENOMINATIONS_PENCE, type CashPaymentState } from "../../src/sim3d/cashPayment";
import { CashDrawerVisual } from "../../src/sim3d/cashDrawerVisual";
import { deriveCashVisualState, type CashVisualSnapshot } from "../../src/sim3d/cashVisualState";

describe("cash drawer visual projection, interaction and resource ownership", () => {
  let engine: NullEngine;
  let scene: Scene;
  let parent: TransformNode;

  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 800, renderHeight: 600, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const context = {
        fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
        fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "left", textBaseline: "middle", font: "12px Arial",
      };
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
    parent = new TransformNode("existing-counter", scene);
  });

  afterEach(() => { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); });

  function payment(overrides: Partial<CashPaymentState> = {}): CashPaymentState {
    return { method: "cash", tenderedPence: 500, tenderedCash: [500], tenderedCashRecorded: true,
      received: true, selectedChange: [], ...overrides };
  }

  function projection(overrides: Partial<Parameters<typeof deriveCashVisualState>[0]> = {}): CashVisualSnapshot {
    return deriveCashVisualState({ payment: payment(), cashDrawer: createDefaultCashDrawer(), amountPence: 400,
      checkout: true, open: true, canInteract: true, ...overrides });
  }

  function fullStacksProjection(open = true): CashVisualSnapshot {
    const drawer = createDefaultCashDrawer();
    for (const denomination of CASH_DENOMINATIONS_PENCE) drawer[denomination] = 18;
    // Both trays contain the complete 100-piece sequence while all 30 displayed
    // denomination stacks reach the six-piece geometry cap, including both notes.
    const pieces = CASH_DENOMINATIONS_PENCE.flatMap((denomination) => Array.from({ length: 10 }, () => denomination));
    const amountPence = pieces.reduce<number>((total, denomination) => total + denomination, 0);
    // An exact tender remains valid for this synthetic high-value sale. The
    // oversized change total is intentionally recoverable, not a completed sale.
    return projection({ open, amountPence, cashDrawer: drawer, payment: payment({ tenderedCash: pieces,
      tenderedPence: amountPence, selectedChange: pieces }) });
  }

  function closeup(width = 737, height = 420): { visual: CashDrawerVisual; camera: UniversalCamera; project(mesh: AbstractMesh, point: Vector3): Vector3 } {
    // Approved cashVisualViewport close-up contract; these are deliberately not
    // the independently positioned world-counter trays or its first-person camera.
    const camera = new UniversalCamera("cash-closeup-regression-camera", new Vector3(.18, 1.9, 1.61), scene);
    camera.setTarget(new Vector3(.18, 0, .19));
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.minZ = .01;
    camera.maxZ = 6;
    const aspect = Math.max(.5, width / height);
    const halfHeight = Math.max(.37, .52 / aspect);
    camera.orthoLeft = -halfHeight * aspect;
    camera.orthoRight = halfHeight * aspect;
    camera.orthoTop = halfHeight;
    camera.orthoBottom = -halfHeight;
    scene.activeCamera = camera;
    const transform = camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true));
    const viewport = new Viewport(0, 0, width, height);
    const visual = new CashDrawerVisual(scene, parent, { name: "closeup", reducedMotion: true,
      changePosition: { x: .46, y: -.02, z: .42 } });
    return { visual, camera, project(mesh, point) {
      return Vector3.Project(point, mesh.computeWorldMatrix(true), transform, viewport);
    } };
  }

  function group(name: string): TransformNode {
    const result = scene.getTransformNodeByName(name);
    expect(result, `expected piece group ${name}`).not.toBeNull();
    return result!;
  }

  function enabledPieces(root: TransformNode): TransformNode[] {
    return root.getChildTransformNodes().filter((node) => node.metadata?.kind === "cash-piece" && node.isEnabled());
  }

  function pieceSurface(root: TransformNode): AbstractMesh {
    const mesh = root.getChildMeshes()[0];
    expect(mesh).toBeDefined();
    return mesh!;
  }

  it("renders all ten real inventory slots, subtracts reservations and labels bounded stack summaries", () => {
    const visual = new CashDrawerVisual(scene, parent, { name: "inventory" });
    const state = projection({ payment: payment({ selectedChange: [50, 50] }) });
    const before = structuredClone(state);
    visual.update(state);
    for (const denomination of CASH_DENOMINATIONS_PENCE) {
      const slot = state.drawer.find((entry) => entry.denominationPence === denomination)!;
      const root = group(`inventory-drawer-${denomination}-stack`);
      expect(root.isDescendantOf(visual.slidingDrawer)).toBe(true);
      expect(root.metadata).toMatchObject({ actualCount: slot.actualCount, drawerCount: slot.drawerCount, reservedCount: slot.reservedCount });
      expect(enabledPieces(root)).toHaveLength(Math.min(slot.actualCount, 6));
      const countLabel = scene.getMeshByName(`inventory-drawer-${denomination}-count`)!;
      expect(countLabel.metadata.text).toContain(`× ${slot.actualCount}`);
      if (slot.actualCount > 6) expect(countLabel.metadata.text).toContain("堆叠示意 6 件");
    }
    expect(group("inventory-drawer-50-stack").metadata.actualCount).toBe(8);
    expect(enabledPieces(group("inventory-drawer-500-stack"))).toHaveLength(0);
    expect(enabledPieces(group("inventory-drawer-1000-stack"))).toHaveLength(0);
    expect(state).toEqual(before);
  });

  it("keeps customer tender outside the till before and after receiving, and dispatches only through the supplied callback", () => {
    const onAction = vi.fn(() => true);
    const visual = new CashDrawerVisual(scene, parent, { name: "receive", onAction });
    const awaiting = projection({ payment: payment({ received: false }) });
    visual.update(awaiting);
    const tender = pieceSurface(enabledPieces(group("receive-tender-500-stack"))[0]!);
    expect(visual.pick(tender)).toEqual({ kind: "receive" });
    expect(onAction).not.toHaveBeenCalled();
    expect(visual.activate(tender)).toBe(true);
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ type: "RECEIVE_CASH" });
    expect(enabledPieces(group("receive-drawer-500-stack"))).toHaveLength(0);
    expect(scene.getMeshByName("receive-tender-heading")!.metadata.text).toContain("顾客交款");

    const received = projection();
    visual.update(received);
    expect(visual.pick(tender)).toBe(false);
    expect(visual.activate(tender)).toBe(false);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(enabledPieces(group("receive-drawer-500-stack"))).toHaveLength(0);
    expect(scene.getMeshByName("receive-tender-heading")!.metadata.text).toContain("暂收区 · 尚未入账");
    const coin = pieceSurface(enabledPieces(group("receive-drawer-100-stack"))[0]!);
    expect(visual.activate(coin)).toBe(true);
    expect(onAction).toHaveBeenLastCalledWith({ type: "ADD_CHANGE", denominationPence: 100 });
    expect(received.drawer.find((entry) => entry.denominationPence === 100)!.actualCount).toBe(10);
  });

  it("retains all original change indices while exposing at most six real pick targets per denomination", () => {
    const onAction = vi.fn(() => true);
    const visual = new CashDrawerVisual(scene, parent, { name: "indices", onAction });
    const hundred = projection({ payment: payment({ selectedChange: Array(100).fill(1), tenderedCashRecorded: false }) });
    visual.update(hundred);
    const change = group("indices-change-1-stack");
    expect(change.metadata).toMatchObject({ actualCount: 100, displayedCount: 6, hiddenCount: 94,
      visibleIndices: [94, 95, 96, 97, 98, 99] });
    expect(change.metadata.indices).toEqual(Array.from({ length: 100 }, (_, index) => index));
    expect(enabledPieces(change)).toHaveLength(6);
    const targets = enabledPieces(change).map(pieceSurface);
    expect(targets.map((mesh) => visual.pick(mesh))).toEqual([94, 95, 96, 97, 98, 99].map((index) => ({ kind: "remove", index })));
    expect(scene.getMeshByName("indices-change-1-count")!.metadata.text).toContain("× 100");
    expect(scene.getMeshByName("indices-change-1-count")!.metadata.text).toContain("辅助列表");
    const drawerCoin = scene.getMeshByName("indices-asset-floor-1")!;
    expect(visual.pick(drawerCoin)).toBe(false);
    expect(visual.activate(targets[5])).toBe(true);
    expect(onAction).toHaveBeenLastCalledWith({ type: "REMOVE_CHANGE", index: 99 });

    visual.update(projection({ payment: payment({ selectedChange: [1, 50] }) }));
    expect(visual.pick(targets[0])).toEqual({ kind: "remove", index: 0 });
    for (const old of targets.slice(1)) expect(visual.pick(old)).toBe(false);
    const fifty = pieceSurface(enabledPieces(group("indices-change-50-stack"))[0]!);
    expect(visual.pick(fifty)).toEqual({ kind: "remove", index: 1 });
  });

  it("leaves empty compartments truly empty and removes stale visual stacks after a zero-count update", () => {
    const visual = new CashDrawerVisual(scene, parent, { name: "empty" });
    visual.update(projection());
    const onePence = enabledPieces(group("empty-drawer-1-stack"));
    expect(onePence).toHaveLength(6);
    const oldSurface = pieceSurface(onePence[0]!);
    const drawer: CashDrawerState = { ...createDefaultCashDrawer(), 1: 0 };
    visual.update(projection({ cashDrawer: drawer }));
    expect(enabledPieces(group("empty-drawer-1-stack"))).toHaveLength(0);
    expect(visual.pick(oldSurface)).toBe(false);
    expect(visual.pick(scene.getMeshByName("empty-asset-floor-1"))).toBe(false);
    expect(scene.getMeshByName("empty-drawer-1-count")!.metadata.text).toContain("× 0\n已用完");
  });

  it("denies picks from read-only, closed, card and cancelled sessions and cannot be redirected by mesh metadata", () => {
    const visual = new CashDrawerVisual(scene, parent, { name: "guards" });
    visual.update(projection());
    const own = pieceSurface(enabledPieces(group("guards-drawer-100-stack"))[0]!);
    const foreign = MeshBuilder.CreateBox("forged-cash-action", {}, scene);
    foreign.parent = visual.root;
    foreign.metadata = { kind: "add", denominationPence: 100 };
    expect(visual.pick(foreign)).toBe(false);
    own.metadata = { kind: "remove", index: 99 };
    expect(visual.pick(own)).toEqual({ kind: "add", denominationPence: 100 });
    for (const state of [projection({ canInteract: false }), projection({ open: false }),
      projection({ payment: { method: "card" } }), projection({ payment: null })]) {
      visual.update(state);
      expect(visual.pick(own)).toBe(false);
      expect(visual.activate(own)).toBe(false);
    }
    visual.update(projection());
    own.parent = parent;
    expect(visual.pick(own)).toBe(false);
  });

  it("copies the derived state so mutating a caller's old projection cannot enable disabled actions", () => {
    const visual = new CashDrawerVisual(scene, parent, { name: "immutable" });
    const state = projection({ canInteract: false });
    visual.update(state);
    const coin = pieceSurface(enabledPieces(group("immutable-drawer-100-stack"))[0]!);
    state.canInteract = true;
    state.drawer.find((slot) => slot.denominationPence === 100)!.canAdd = true;
    expect(visual.pick(coin)).toBe(false);
  });

  it("marks legacy tender as an amount-derived illustration without claiming recorded denominations", () => {
    const visual = new CashDrawerVisual(scene, parent, { name: "legacy" });
    visual.update(projection({ payment: payment({ tenderedCashRecorded: false }) }));
    expect(visual.root.metadata.tenderSource).toBe("derived");
    const label = scene.getMeshByName("legacy-tender-heading")!;
    expect(label.metadata.text).toContain("旧版未记录面额");
    expect(label.metadata.text).toContain("推导示意");
  });

  it("animates only the drawer transform and snaps immediately when reduced motion is enabled", () => {
    const visual = new CashDrawerVisual(scene, parent, { name: "motion", reducedMotion: false });
    const state = projection();
    const before = structuredClone(state);
    visual.update(state);
    expect(visual.openRatio).toBe(0);
    const retainedCoin = group("motion-drawer-100-stack").getChildTransformNodes().find((node) => node.metadata?.kind === "cash-piece")!;
    expect(retainedCoin.isEnabled()).toBe(false);
    const coin = pieceSurface(retainedCoin);
    expect(visual.pick(coin)).toBe(false);
    const roof = scene.getMeshByName("motion-asset-roof")!;
    expect(roof.isPickable).toBe(true);
    expect(visual.pick(roof)).toBe(false);
    visual.tick(120);
    expect(visual.openRatio).toBeCloseTo(.5);
    expect(visual.pick(coin)).toBe(false);
    expect(visual.slidingDrawer.position.z).toBeCloseTo(.135);
    visual.tick(Number.NaN);
    visual.tick(-50);
    expect(visual.openRatio).toBeCloseTo(.5);
    visual.tick(120);
    expect(visual.openRatio).toBe(1);
    expect(visual.pick(coin)).toEqual({ kind: "add", denominationPence: 100 });
    visual.update(projection({ open: false }));
    expect(visual.openRatio).toBe(1);
    expect(visual.pick(coin)).toBe(false);
    visual.tick(60);
    expect(visual.openRatio).toBeCloseTo(.75);
    visual.setReducedMotion(true);
    expect(visual.openRatio).toBe(0);
    visual.update(state);
    expect(visual.openRatio).toBe(1);
    expect(state).toEqual(before);
  });

  it("honours host-provided tray positions without moving or disposing existing counter geometry", () => {
    const unrelated = MeshBuilder.CreateBox("existing-pos", {}, scene);
    unrelated.parent = parent;
    const visual = new CashDrawerVisual(scene, parent, { name: "counter", tenderPosition: { x: -.09, y: -.02, z: -.95 },
      changePosition: { x: .49, y: -.02, z: -.59 } });
    expect(visual.tenderAnchor.position.asArray()).toEqual([-.09, -.02, -.95]);
    expect(visual.changeAnchor.position.asArray()).toEqual([.49, -.02, -.59]);
    expect(visual.tenderAnchor.metadata).toMatchObject({ width: .32, depth: .24 });
    expect(visual.changeAnchor.metadata).toMatchObject({ width: .32, depth: .24 });
    visual.dispose();
    expect(parent.isDisposed()).toBe(false);
    expect(unrelated.isDisposed()).toBe(false);
  });

  it("reuses unchanged groups and textures, bounds all display meshes, and safely disposes two independent instances", () => {
    // These lazily created Babylon resources belong to the host Scene, not to
    // the cash renderer. Initialise them before measuring owned-resource release.
    const existingMaterial = new PBRMaterial("existing-counter-material", scene);
    const defaultMaterial = scene.defaultMaterial;
    const before = { meshes: scene.meshes.length, nodes: scene.transformNodes.length, textures: scene.textures.length, materials: scene.materials.length };
    const first = new CashDrawerVisual(scene, parent, { name: "world" });
    const second = new CashDrawerVisual(scene, parent, { name: "preview" });
    const state = projection({ payment: payment({ selectedChange: CASH_DENOMINATIONS_PENCE.flatMap((denomination) => Array(10).fill(denomination)) }) });
    first.update(state);
    second.update(state);
    const total = { meshes: scene.meshes.length, textures: scene.textures.length, materials: scene.materials.length };
    const updates = scene.textures.filter((texture): texture is DynamicTexture => texture instanceof DynamicTexture).map((texture) => vi.spyOn(texture, "update"));
    for (let repetition = 0; repetition < 12; repetition += 1) first.update(structuredClone(state));
    expect({ meshes: scene.meshes.length, textures: scene.textures.length, materials: scene.materials.length }).toEqual(total);
    expect(updates.every((update) => update.mock.calls.length === 0)).toBe(true);
    for (const root of scene.transformNodes.filter((node) => /-stack$/.test(node.name))) expect(enabledPieces(root).length).toBeLessThanOrEqual(6);
    const secondCoin = pieceSurface(enabledPieces(group("preview-change-100-stack"))[0]!);
    expect(first.pick(secondCoin)).toBe(false);
    const liveMaterial = secondCoin.material!;
    first.dispose();
    first.dispose();
    expect(secondCoin.isDisposed()).toBe(false);
    expect(scene.materials).toContain(liveMaterial);
    expect(second.pick(secondCoin)).toEqual({ kind: "remove", index: 64 });
    second.dispose();
    expect(scene.meshes).toHaveLength(before.meshes);
    expect(scene.transformNodes).toHaveLength(before.nodes);
    expect(scene.textures).toHaveLength(before.textures);
    expect(scene.materials).toHaveLength(before.materials);
    expect(scene.materials).toContain(existingMaterial);
    expect(scene.materials).toContain(defaultMaterial);
    expect(first.pick(secondCoin)).toBe(false);
    expect(first.activate(secondCoin)).toBe(false);
  });

  it.each([[737, 420], [1024, 420], [280, 320], [320, 320], [360, 320]])(
    "keeps every fully stocked close-up vertex inside a %i × %i canvas with the drawer closed and open", (width, height) => {
      const { visual, project } = closeup(width, height);
      // The slide is a linear translation under an orthographic camera, so its
      // two endpoint bounds also enclose every intermediate animation position.
      for (const open of [false, true]) {
        const state = fullStacksProjection(open);
        const before = structuredClone(state);
        visual.update(state);
        expect(state.stage).toBe("received");
        expect(visual.openRatio).toBe(open ? 1 : 0);
        expect(enabledPieces(visual.root)).toHaveLength(open ? 180 : 120);
        expect([state.drawer, state.tenderStacks, state.changeStacks].every((stacks) => stacks.length === 10
          && stacks.every((stack) => stack.stackCount === 6))).toBe(true);
        const clipped: string[] = [];
        const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
        for (const mesh of visual.root.getChildMeshes().filter((candidate) => candidate.isEnabled() && candidate.isVisible)) {
          const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
          let outside = false;
          for (let index = 0; index < positions.length; index += 3) {
            const point = project(mesh, Vector3.FromArray(positions, index));
            bounds.left = Math.min(bounds.left, point.x);
            bounds.right = Math.max(bounds.right, point.x);
            bounds.top = Math.min(bounds.top, point.y);
            bounds.bottom = Math.max(bounds.bottom, point.y);
            outside ||= !Number.isFinite(point.x + point.y + point.z)
              || point.x < 0 || point.x > width || point.y < 0 || point.y > height || point.z < 0 || point.z > 1;
          }
          if (outside) clipped.push(mesh.name);
        }
        expect(clipped, `${open ? "open" : "closed"} geometry crosses the viewport or near/far plane`).toEqual([]);
        expect(Math.min(bounds.left, width - bounds.right, bounds.top, height - bounds.bottom)).toBeGreaterThan(8);
        expect(state).toEqual(before);
      }
    });

  it("projects every money print and count label upright and unmirrored from the cashier side", () => {
    const { visual, project } = closeup();
    visual.update(fullStacksProjection());
    const surfaces = visual.root.getChildMeshes().filter((mesh) => mesh.isEnabled()
      && (mesh.metadata?.kind === "cash-visual-label" || mesh.metadata?.kind === "cash-compartment-label" || mesh.name.endsWith("-print")));
    expect(surfaces.filter((mesh) => mesh.name.endsWith("-print"))).toHaveLength(180);
    for (const mesh of surfaces) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
      const left: Vector3[] = [], right: Vector3[] = [], top: Vector3[] = [], bottom: Vector3[] = [];
      for (let index = 0; index < uvs.length / 2; index += 1) {
        const point = project(mesh, Vector3.FromArray(positions, index * 3));
        (uvs[index * 2] === 0 ? left : right).push(point);
        // DynamicTexture's default inverted upload maps v=1 to the printed top.
        (uvs[index * 2 + 1] === 1 ? top : bottom).push(point);
      }
      const average = (points: Vector3[], axis: "x" | "y"): number => points.reduce((total, point) => total + point[axis], 0) / points.length;
      expect(average(right, "x"), `${mesh.name} text must not be horizontally mirrored`).toBeGreaterThan(average(left, "x"));
      expect(average(top, "y"), `${mesh.name} text must not be upside down`).toBeLessThan(average(bottom, "y"));
    }
  });

  it.each([20, 50, 100, 200])("keeps the %ip front-row inventory label visible at its centre and four inset corners", (denomination) => {
    const { visual, camera } = closeup();
    visual.update(fullStacksProjection());
    const label = scene.getMeshByName(`closeup-drawer-${denomination}-count`)!;
    const positions = label.getVerticesData(VertexBuffer.PositionKind)!;
    const direction = camera.getForwardRay().direction.normalize();
    // Stay 1% of the full label width/depth inside each edge so floating-point
    // triangle-edge misses cannot be mistaken for an actual occluding surface.
    const samples = [Vector3.Zero(), ...Array.from({ length: positions.length / 3 }, (_, index) => Vector3.FromArray(positions, index * 3).scale(.98))];
    expect(samples).toHaveLength(5);
    for (const [index, sample] of samples.entries()) {
      const target = Vector3.TransformCoordinates(sample, label.computeWorldMatrix(true));
      const ray = new Ray(target.subtract(direction.scale(3)), direction, 6);
      // Include non-pickable physical geometry: the front lip must not be
      // accidentally ignored just because it has no payment command attached.
      const hit = scene.pickWithRay(ray, (mesh) => mesh.isEnabled() && mesh.isVisible);
      expect(hit?.pickedMesh, `${label.name} sample ${index} is occluded by ${hit?.pickedMesh?.name}`).toBe(label);
      expect(hit?.distance).toBeCloseTo(3, 5);
    }
  });

  it.each([280, 320, 360])("hits the actual top coin, not its label or a divider, for all four front-row denominations at %ipx width", (width) => {
    const height = 320;
    const { visual, camera, project } = closeup(width, height);
    // The ordinary £5 tender for a £4.50 purchase requires 50p change. Keep the
    // normal float, including its different stack heights, rather than hiding
    // surrounding currency or replacing the renderer with a test-only mesh.
    const state = projection({ amountPence: 450 });
    const before = structuredClone(state);
    visual.update(state);
    expect(state.stage).toBe("received");
    expect(state.changeDuePence).toBe(50);
    expect(visual.openRatio).toBe(1);
    for (const denomination of [20, 50, 100, 200]) {
      const stack = enabledPieces(group(`closeup-drawer-${denomination}-stack`));
      expect(stack.length).toBeGreaterThan(0);
      const coin = stack.at(-1)!;
      const print = coin.getChildMeshes().find((mesh) => mesh.name.endsWith("-print"))!;
      expect(print).toBeDefined();
      expect(print.isEnabled() && print.isVisible && print.visibility > 0).toBe(true);
      // Project the physical print's centre to CSS pixels, then reconstruct the
      // actual orthographic picking ray through those viewport coordinates.
      const centre = project(print, Vector3.Zero());
      expect(centre.x).toBeGreaterThan(0);
      expect(centre.x).toBeLessThan(width);
      expect(centre.y).toBeGreaterThan(0);
      expect(centre.y).toBeLessThan(height);
      const ray = Ray.CreateNew(centre.x, centre.y, width, height, Matrix.Identity(),
        camera.getViewMatrix(true), camera.getProjectionMatrix(true));
      // Match the live viewport's visible-geometry predicate. In particular,
      // labels, the shell and non-action dividers must remain ray occluders.
      const hit = scene.pickWithRay(ray, (mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0);
      expect(hit?.pickedMesh, `${denomination}p coin centre is occluded by ${hit?.pickedMesh?.name}`).toBe(print);
      // The inventory label has the same add command, so checking only this
      // action would miss the original 50p coin-obscured-by-label regression.
      expect(visual.pick(hit?.pickedMesh)).toEqual({ kind: "add", denominationPence: denomination });
    }
    expect(state).toEqual(before);
  });

  it("draws one large count line while keeping the full explanatory label metadata", () => {
    const { visual } = closeup();
    visual.update(fullStacksProjection());
    const label = scene.getMeshByName("closeup-drawer-50-count")!;
    const texture = (label.material as StandardMaterial).diffuseTexture as DynamicTexture;
    const context = texture.getContext() as CanvasRenderingContext2D;
    expect(context.font).toBe("bold 134px Arial, sans-serif");
    expect(vi.mocked(context.fillText).mock.calls).toHaveLength(1);
    expect(vi.mocked(context.fillText).mock.calls[0]?.[0]).toBe("50p × 8");
    expect(label.metadata.text).toBe("50p × 8\n堆叠示意 6 件");
  });

  it("culls only hidden drawer contents while closed and restores the same physical pieces on opening", () => {
    const { visual } = closeup();
    const open = fullStacksProjection();
    visual.update(open);
    const pieces = enabledPieces(visual.slidingDrawer);
    expect(pieces).toHaveLength(60);
    const meshCount = scene.meshes.length;
    const closed = { ...open, open: false, canInteract: false };
    visual.update(closed);
    expect(enabledPieces(visual.slidingDrawer)).toHaveLength(0);
    expect(enabledPieces(visual.tenderAnchor)).toHaveLength(60);
    expect(enabledPieces(visual.changeAnchor)).toHaveLength(60);
    expect(scene.getMeshByName("closeup-asset-front")!.isEnabled()).toBe(true);
    expect(scene.meshes).toHaveLength(meshCount);
    expect(pieces.every((piece) => !piece.isDisposed())).toBe(true);
    visual.update(open);
    expect(enabledPieces(visual.slidingDrawer)).toEqual(pieces);
    expect(scene.meshes).toHaveLength(meshCount);
  });
});
