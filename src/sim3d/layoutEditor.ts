import {
  FURNITURE_DEFINITIONS,
  FIXED_LAYOUT_OBSTACLES,
  RESERVED_LAYOUT_AREAS,
  SHOP_ENTRANCE,
  createDefaultShopLayout,
  furnitureBounds,
  layoutEquals,
  shopBounds,
  validateShopLayout,
  type FurnitureId,
  type FurniturePlacement,
  type ShopLayout,
} from "./shopLayout";
import type { LayoutCollider } from "./productLayout";
import "./layoutEditor.css";

export interface LayoutEditorCallbacks {
  /** Return false when saving fails; the editor keeps the complete draft. */
  onApply(layout: ShopLayout): boolean | void;
  onDirtyChange?(dirty: boolean): void;
}

export interface LayoutEditorOptions {
  editable: boolean;
  reason?: string;
  obstacles?: readonly LayoutCollider[];
  resetDraft?: boolean;
}

interface Point { x: number; z: number }
interface DragState {
  pointerId: number;
  placement: FurniturePlacement;
  start: Point;
  clientX: number;
  clientY: number;
  moved: boolean;
}

interface FixtureNodes {
  group: SVGGElement;
  body: SVGRectElement;
  front: SVGRectElement;
  arrow: SVGPathElement;
  label: SVGTextElement;
  title: SVGTitleElement;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const cloneLayout = (layout: ShopLayout): ShopLayout => ({
  expansion: layout.expansion,
  placements: layout.placements.map((placement) => ({ ...placement })),
});
const roundCoordinate = (coordinate: number): number => Math.round(coordinate * 1000) / 1000 || 0;
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

function svgNode<K extends keyof SVGElementTagNameMap>(document: Document, tag: K, attributes: Record<string, string | number>, content?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (content !== undefined) node.textContent = content;
  return node;
}

function rectAttributes(bounds: LayoutCollider): Record<string, number> {
  return { x: bounds.minX, y: -bounds.maxZ, width: bounds.maxX - bounds.minX, height: bounds.maxZ - bounds.minZ };
}

function assignAttributes(node: Element, attributes: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(attributes)) {
    const next = String(value);
    if (node.getAttribute(key) !== next) node.setAttribute(key, next);
  }
}

function setText(node: Element, content: string): void {
  if (node.textContent !== content) node.textContent = content;
}

/** Static DOM is created once so redraws never replace focused or dragged controls. */
export function layoutEditorMarkup(): string {
  return `<section class="s3-layout-editor" aria-labelledby="s3-layout-title">
    <div class="s3-layout-heading"><div><p class="s3-eyebrow">MAKE ROOM FOR YOUR SHOP</p><h3 id="s3-layout-title">店铺装修</h3></div><span id="s3-layout-dirty" class="s3-layout-dirty">已保存</span></div>
    <p id="s3-layout-description" class="s3-layout-description">准备或打烊后装修，商品随货架移动，收银设备整组移动。</p>
    <p id="s3-layout-lock" class="s3-layout-lock" role="status" hidden></p>
    <div class="s3-layout-workspace">
      <div class="s3-layout-map-wrap">
        <svg id="s3-layout-map" class="s3-layout-map" role="group" aria-labelledby="s3-layout-map-title" aria-describedby="s3-layout-map-description">
          <title id="s3-layout-map-title">店铺家具平面图</title>
          <desc id="s3-layout-map-description">上方是店内后方，下方是门口。点击或拖动编号家具，深色边与三角箭头表示商品正面或顾客侧。也可使用右侧选择框与移动按钮。</desc>
          <defs>
            <pattern id="s3-layout-grid" width="0.5" height="0.5" patternUnits="userSpaceOnUse"><path d="M .5 0 H 0 V .5" fill="none" stroke="#dddccd" stroke-width=".018"/></pattern>
            <pattern id="s3-layout-locked-pattern" width=".3" height=".3" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M 0 0 V .3" fill="none" stroke="#d8d8c8" stroke-width=".05"/></pattern>
          </defs>
          <g id="s3-layout-room"></g><g id="s3-layout-obstacles"></g><g id="s3-layout-fixtures"></g>
        </svg>
        <div class="s3-layout-legend" aria-label="平面图图例"><span><i class="s3-layout-key s3-layout-key-selected"></i>选中家具</span><span><i class="s3-layout-key s3-layout-key-front"></i>正面 / 顾客侧</span><span><i class="s3-layout-key s3-layout-key-blocked"></i>保留通道</span></div>
      </div>
      <aside class="s3-layout-controls" aria-label="家具调整">
        <label class="s3-layout-select-label" for="s3-layout-select">选择家具 <span>${FURNITURE_DEFINITIONS.length} 件</span></label>
        <select id="s3-layout-select" aria-describedby="s3-layout-selection-help">${FURNITURE_DEFINITIONS.map((definition, index) => `<option value="${escapeHtml(definition.id)}">${String(index + 1).padStart(2, "0")} · ${escapeHtml(definition.name)}</option>`).join("")}</select>
        <p id="s3-layout-selection-help" class="s3-layout-selection-help">货架连同商品移动；收银台连同扫码器、刷卡器一起移动。</p>
        <dl class="s3-layout-position"><div><dt>横向 X</dt><dd id="s3-layout-x"></dd></div><div><dt>纵向 Z</dt><dd id="s3-layout-z"></dd></div><div><dt>旋转</dt><dd id="s3-layout-rotation"></dd></div></dl>
        <p id="s3-layout-facing" class="s3-layout-facing"></p>
        <button id="s3-layout-rotate" class="s3-secondary-button s3-layout-rotate" type="button" aria-label="将选中的家具旋转90度">↻ 旋转 90° <kbd>R</kbd></button>
        <fieldset id="s3-layout-movement" class="s3-layout-movement"><legend>每次移动 0.1 米</legend><div class="s3-layout-nudge">
          <button type="button" class="s3-layout-nudge-up" data-layout-move="up" aria-label="将选中的家具向店铺后方移动0.1米">↑</button>
          <button type="button" class="s3-layout-nudge-left" data-layout-move="left" aria-label="将选中的家具向左移动0.1米">←</button>
          <span aria-hidden="true">移动</span>
          <button type="button" class="s3-layout-nudge-right" data-layout-move="right" aria-label="将选中的家具向右移动0.1米">→</button>
          <button type="button" class="s3-layout-nudge-down" data-layout-move="down" aria-label="将选中的家具向门口移动0.1米">↓</button>
        </div></fieldset>
        <p class="s3-layout-keyboard-help">拖动吸附 0.1 米网格。选中后也可按方向键移动、<kbd>R</kbd> 旋转；箭头指向服务侧。</p>
      </aside>
    </div>
    <p id="s3-layout-validation" class="s3-layout-validation" role="status" aria-live="polite" aria-atomic="true"></p>
    <div class="s3-layout-footer"><p>可以先移动多件家具，摆好后一起应用。</p><div class="s3-layout-actions"><button id="s3-layout-discard" class="s3-secondary-button" type="button" disabled>取消修改</button><button id="s3-layout-default" class="s3-secondary-button" type="button">恢复默认</button><button id="s3-layout-apply" class="s3-primary-button" type="button" disabled>应用布局</button></div></div>
  </section>`;
}

/** Owns an unsaved layout draft only; the game owns time, money and persistence. */
export class LayoutEditor {
  private readonly lifetime = new AbortController();
  private readonly root: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly fixtures = new Map<FurnitureId, FixtureNodes>();
  private baseline = createDefaultShopLayout();
  private draft = cloneLayout(this.baseline);
  private selected: FurnitureId = FURNITURE_DEFINITIONS[0]!.id;
  private options: LayoutEditorOptions = { editable: false };
  private obstacleSignature = "";
  private drag: DragState | null = null;
  private reportedDirty = false;
  private conflict = false;
  private applyError = "";
  private disposed = false;

  constructor(private readonly host: HTMLElement, private readonly callbacks: LayoutEditorCallbacks) {
    host.innerHTML = layoutEditorMarkup();
    this.root = this.el<HTMLElement>("s3-layout-title").closest<HTMLElement>(".s3-layout-editor")!;
    this.svg = this.el<SVGSVGElement>("s3-layout-map");
    this.createFixtures();
    this.drawRoom();
    this.drawObstacles();
    this.bindEvents();
    this.render();
  }

  setState(layout: ShopLayout, options: LayoutEditorOptions): void {
    if (this.disposed) return;
    const signature = (options.obstacles ?? []).map((obstacle) => `${obstacle.minX},${obstacle.maxX},${obstacle.minZ},${obstacle.maxZ}`).join(";");
    const obstaclesChanged = signature !== this.obstacleSignature;
    let changed = obstaclesChanged || options.editable !== this.options.editable || options.reason !== this.options.reason;
    const wasDirty = this.hasUnsavedChanges();
    const expansionChanged = this.draft.expansion !== layout.expansion;
    if (options.resetDraft || (!layoutEquals(layout, this.baseline) && (!wasDirty || layoutEquals(layout, this.draft)))) {
      this.finishDrag();
      this.baseline = cloneLayout(layout);
      this.draft = cloneLayout(layout);
      this.conflict = false;
      this.applyError = "";
      changed = true;
    } else if (!layoutEquals(layout, this.baseline)) {
      // Another game action must not silently replace an open, edited draft.
      const onlyExpansionChanged = layoutEquals({ ...layout, expansion: this.baseline.expansion }, this.baseline);
      this.baseline = cloneLayout(layout);
      this.draft.expansion = layout.expansion;
      this.conflict = !onlyExpansionChanged;
      changed = true;
    }
    this.options = { ...options, obstacles: options.obstacles?.map((obstacle) => ({ ...obstacle })) };
    this.obstacleSignature = signature;
    if (!options.editable) this.finishDrag();
    if (expansionChanged || options.resetDraft) this.drawRoom();
    if (obstaclesChanged) this.drawObstacles();
    if (changed) this.render();
  }

  hasUnsavedChanges(): boolean { return !layoutEquals(this.draft, this.baseline) }

  discard(): void {
    if (this.disposed) return;
    this.finishDrag();
    this.draft = cloneLayout(this.baseline);
    this.conflict = false;
    this.applyError = "";
    this.drawRoom();
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.finishDrag();
    this.lifetime.abort();
    this.disposed = true;
    this.host.replaceChildren();
  }

  private el<T extends Element = HTMLElement>(id: string): T {
    const element = this.host.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Layout editor element missing: ${id}`);
    return element;
  }

  private bindEvents(): void {
    const signal = this.lifetime.signal;
    this.el<HTMLSelectElement>("s3-layout-select").addEventListener("change", (event) => {
      this.select((event.target as HTMLSelectElement).value as FurnitureId);
    }, { signal });
    this.el("s3-layout-rotate").addEventListener("click", () => this.rotate(), { signal });
    this.el("s3-layout-discard").addEventListener("click", () => this.discard(), { signal });
    this.el("s3-layout-default").addEventListener("click", () => {
      if (!this.options.editable) return;
      this.finishDrag();
      this.draft = { ...createDefaultShopLayout(), expansion: this.baseline.expansion };
      this.conflict = false;
      this.applyError = "";
      this.render();
    }, { signal });
    this.el("s3-layout-apply").addEventListener("click", () => this.apply(), { signal });
    this.el("s3-layout-movement").addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-layout-move]");
      if (button?.dataset.layoutMove) this.move(button.dataset.layoutMove);
    }, { signal });
    this.svg.addEventListener("click", (event) => {
      const id = (event.target as Element | null)?.closest<SVGElement>("[data-layout-fixture]")?.dataset.layoutFixture;
      if (id) this.select(id as FurnitureId);
    }, { signal });
    this.svg.addEventListener("pointerdown", (event) => this.startDrag(event), { signal });
    this.svg.addEventListener("pointermove", (event) => this.moveDrag(event), { signal });
    this.svg.addEventListener("pointerup", (event) => { if (this.drag?.pointerId === event.pointerId) this.finishDrag() }, { signal });
    this.svg.addEventListener("pointercancel", (event) => {
      if (this.drag?.pointerId !== event.pointerId) return;
      const original = this.drag.placement;
      this.finishDrag();
      this.replacePlacement(original);
    }, { signal });
    this.svg.addEventListener("lostpointercapture", () => { this.drag = null; this.svg.removeAttribute("data-dragging") }, { signal });
    this.root.addEventListener("keydown", (event) => this.onKeyDown(event), { signal });
    this.root.addEventListener("keyup", (event) => { if (event.code !== "Escape") event.stopPropagation() }, { signal });
    // All controls belong to the dialog; they must not trigger a background game action.
    this.root.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
    this.root.addEventListener("click", (event) => event.stopPropagation(), { signal });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.code === "Escape") return; // The parent owns close/discard confirmation.
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const target = event.target as Element | null;
    if (target?.closest("select, input, textarea, [contenteditable='true']")) return;
    const direction: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (direction[event.code]) {
      event.preventDefault();
      this.move(direction[event.code]!);
    } else if (event.code === "KeyR") {
      event.preventDefault();
      if (!event.repeat) this.rotate();
    } else if (event.code === "Space" || event.code === "Enter") {
      const id = target?.closest<SVGElement>("[data-layout-fixture]")?.dataset.layoutFixture;
      if (id) { event.preventDefault(); this.select(id as FurnitureId) }
    } else if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyF", "KeyG", "KeyB", "KeyU", "KeyM"].includes(event.code)) {
      event.preventDefault();
    }
  }

  private select(id: FurnitureId): void {
    if (!this.fixtures.has(id) || this.selected === id) return;
    this.selected = id;
    this.render();
  }

  private selectedPlacement(): FurniturePlacement {
    return this.draft.placements.find((placement) => placement.id === this.selected)!;
  }

  private replacePlacement(placement: FurniturePlacement): void {
    this.draft.placements = this.draft.placements.map((entry) => entry.id === placement.id ? { ...placement } : entry);
    this.applyError = "";
    this.render();
  }

  private move(direction: string): void {
    if (!this.options.editable || this.drag) return;
    const placement = this.selectedPlacement();
    const offsets: Record<string, Point> = { up: { x: 0, z: .1 }, down: { x: 0, z: -.1 }, left: { x: -.1, z: 0 }, right: { x: .1, z: 0 } };
    const offset = offsets[direction];
    if (!offset) return;
    this.replacePlacement({ ...placement, x: roundCoordinate(placement.x + offset.x), z: roundCoordinate(placement.z + offset.z) });
  }

  private rotate(): void {
    if (!this.options.editable || this.drag) return;
    const placement = this.selectedPlacement();
    this.replacePlacement({ ...placement, rotation: ((placement.rotation + 1) % 4) as FurniturePlacement["rotation"] });
  }

  private mapPoint(event: PointerEvent): Point | null {
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return null;
    const point = this.svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, z: -local.y };
  }

  private startDrag(event: PointerEvent): void {
    if (event.button !== 0 || this.drag) return;
    const node = (event.target as Element | null)?.closest<SVGElement>("[data-layout-fixture]");
    const id = node?.dataset.layoutFixture as FurnitureId | undefined;
    if (!id || !this.fixtures.has(id)) return;
    event.preventDefault();
    this.select(id);
    node?.focus({ preventScroll: true });
    if (!this.options.editable) return;
    const start = this.mapPoint(event);
    if (!start) return;
    this.drag = { pointerId: event.pointerId, placement: { ...this.selectedPlacement() }, start, clientX: event.clientX, clientY: event.clientY, moved: false };
    this.svg.setPointerCapture(event.pointerId);
  }

  private moveDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId || !this.options.editable) return;
    event.preventDefault();
    if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 3) return;
    const point = this.mapPoint(event);
    if (!point) return;
    drag.moved = true;
    this.svg.setAttribute("data-dragging", "true");
    // Leave an untouched axis at its original position; default racks use .025 offsets.
    const snap = (initial: number, delta: number): number => Math.abs(delta) < .05 ? initial : Math.round((initial + delta) * 10) / 10 || 0;
    const x = snap(drag.placement.x, point.x - drag.start.x);
    const z = snap(drag.placement.z, point.z - drag.start.z);
    const current = this.selectedPlacement();
    if (current.x !== x || current.z !== z) this.replacePlacement({ ...drag.placement, x, z });
  }

  private finishDrag(): void {
    const pointerId = this.drag?.pointerId;
    this.drag = null;
    this.svg?.removeAttribute("data-dragging");
    if (pointerId !== undefined && this.svg.hasPointerCapture(pointerId)) this.svg.releasePointerCapture(pointerId);
  }

  private apply(): void {
    if (!this.options.editable || !this.hasUnsavedChanges() || this.conflict || !validateShopLayout(this.draft, this.options.obstacles).valid) return;
    this.finishDrag();
    const candidate = cloneLayout(this.draft);
    try {
      if (this.callbacks.onApply(candidate) === false) {
        this.applyError = "应用未完成，修改草稿已保留。请查看店铺提示后重试。";
      } else {
        this.baseline = cloneLayout(candidate);
        this.draft = cloneLayout(candidate);
        this.conflict = false;
        this.applyError = "";
      }
    } catch {
      this.applyError = "应用未完成，修改草稿已保留。请稍后重试。";
    }
    this.render();
  }

  private createFixtures(): void {
    const layer = this.el<SVGGElement>("s3-layout-fixtures");
    const document = this.host.ownerDocument;
    FURNITURE_DEFINITIONS.forEach((definition, index) => {
      const group = svgNode(document, "g", { class: "s3-layout-fixture", "data-layout-fixture": definition.id, "data-kind": definition.kind, tabindex: 0, role: "button", "aria-pressed": "false" });
      const title = svgNode(document, "title", {});
      const body = svgNode(document, "rect", { class: "s3-layout-fixture-body", rx: .05 });
      const front = svgNode(document, "rect", { class: "s3-layout-fixture-front", rx: .025 });
      const arrow = svgNode(document, "path", { class: "s3-layout-fixture-arrow" });
      const label = svgNode(document, "text", { class: "s3-layout-fixture-number", "text-anchor": "middle", "dominant-baseline": "central" }, String(index + 1).padStart(2, "0"));
      group.append(title, body, front, arrow, label);
      layer.append(group);
      this.fixtures.set(definition.id, { group, body, front, arrow, label, title });
    });
  }

  private drawRoom(): void {
    const document = this.host.ownerDocument;
    const room = this.el<SVGGElement>("s3-layout-room");
    const current = shopBounds(this.draft.expansion);
    const initial = shopBounds(0);
    const future = shopBounds(1);
    assignAttributes(this.svg, { viewBox: `${future.minX - .7} ${-future.maxZ - .5} ${future.maxX - future.minX + 1.4} ${future.maxZ - future.minZ + 1.25}` });
    const children: SVGElement[] = [
      svgNode(document, "rect", { ...rectAttributes(future), rx: .06, class: "s3-layout-future-floor" }),
      svgNode(document, "rect", { ...rectAttributes(current), rx: .03, class: "s3-layout-current-floor" }),
      svgNode(document, "rect", { ...rectAttributes(current), fill: "url(#s3-layout-grid)" }),
      svgNode(document, "rect", { ...rectAttributes(current), fill: "none", class: "s3-layout-wall" }),
    ];
    if (this.draft.expansion === 0) {
      children.push(
        svgNode(document, "rect", { x: future.minX, y: -future.maxZ, width: future.maxX - future.minX, height: future.maxZ - initial.maxZ, fill: "url(#s3-layout-locked-pattern)", class: "s3-layout-expansion-border" }),
        svgNode(document, "text", { x: 0, y: -(initial.maxZ + future.maxZ) / 2 - .08, "text-anchor": "middle", class: "s3-layout-expansion-title" }, "后方扩建区 · 尚未解锁"),
        svgNode(document, "text", { x: 0, y: -(initial.maxZ + future.maxZ) / 2 + .4, "text-anchor": "middle", class: "s3-layout-map-note" }, "购买扩建后增加 3 米进深"),
      );
    } else {
      children.push(
        svgNode(document, "path", { d: `M ${initial.minX} ${-initial.maxZ} H ${initial.maxX}`, class: "s3-layout-old-wall" }),
        svgNode(document, "text", { x: 0, y: -future.maxZ + .38, "text-anchor": "middle", class: "s3-layout-map-note" }, "扩建已完成 · 新增 3 米进深"),
      );
    }
    children.push(
      svgNode(document, "text", { x: 0, y: -future.maxZ - .19, "text-anchor": "middle", class: "s3-layout-map-note" }, "店内后方"),
      svgNode(document, "rect", { ...rectAttributes(SHOP_ENTRANCE), class: "s3-layout-entrance", rx: .07 }),
      svgNode(document, "text", { x: (SHOP_ENTRANCE.minX + SHOP_ENTRANCE.maxX) / 2, y: -(SHOP_ENTRANCE.minZ + SHOP_ENTRANCE.maxZ) / 2 + .08, "text-anchor": "middle", class: "s3-layout-entrance-label" }, "进出通道"),
      svgNode(document, "text", { x: 0, y: -current.minZ + .45, "text-anchor": "middle", class: "s3-layout-door-label" }, "↓ 店门 / 街道"),
    );
    room.replaceChildren(...children);
  }

  private drawObstacles(): void {
    const document = this.host.ownerDocument;
    const layer = this.el<SVGGElement>("s3-layout-obstacles");
    const children: SVGElement[] = [];
    RESERVED_LAYOUT_AREAS.forEach((area, index) => {
      const group = svgNode(document, "g", {});
      group.append(
        svgNode(document, "title", {}, area.name),
        svgNode(document, "rect", { ...rectAttributes(area), class: "s3-layout-reserved", rx: .035 }),
        svgNode(document, "text", { x: (area.minX + area.maxX) / 2, y: -(area.minZ + area.maxZ) / 2 + .045, "text-anchor": "middle", class: "s3-layout-obstacle-label" }, `卸货 ${index + 1}`),
      );
      children.push(group);
    });
    FIXED_LAYOUT_OBSTACLES.forEach((obstacle) => {
      const group = svgNode(document, "g", {});
      group.append(
        svgNode(document, "title", {}, "固定盆栽，请保留周围通道"),
        svgNode(document, "rect", { ...rectAttributes(obstacle), class: "s3-layout-fixed", rx: .12 }),
        svgNode(document, "text", { x: (obstacle.minX + obstacle.maxX) / 2, y: -(obstacle.minZ + obstacle.maxZ) / 2 + .04, "text-anchor": "middle", class: "s3-layout-obstacle-label" }, "盆栽"),
      );
      children.push(group);
    });
    (this.options.obstacles ?? []).forEach((obstacle) => {
      const group = svgNode(document, "g", {});
      group.append(
        svgNode(document, "title", {}, "地上的货箱，请回店内挪开后再装修"),
        svgNode(document, "rect", { ...rectAttributes(obstacle), class: "s3-layout-crate", rx: .025 }),
        svgNode(document, "text", { x: (obstacle.minX + obstacle.maxX) / 2, y: -(obstacle.minZ + obstacle.maxZ) / 2 + .04, "text-anchor": "middle", class: "s3-layout-obstacle-label" }, "货箱"),
      );
      children.push(group);
    });
    layer.replaceChildren(...children);
  }

  private render(): void {
    const validation = validateShopLayout(this.draft, this.options.obstacles);
    const dirty = this.hasUnsavedChanges();
    const selectedPlacement = this.selectedPlacement();
    const selectedDefinition = FURNITURE_DEFINITIONS.find((definition) => definition.id === this.selected)!;
    for (const definition of FURNITURE_DEFINITIONS) {
      const placement = this.draft.placements.find((entry) => entry.id === definition.id)!;
      const bounds = furnitureBounds(placement);
      const nodes = this.fixtures.get(definition.id)!;
      const selected = placement.id === this.selected;
      const invalid = !validation.valid && (selected || validation.furnitureId === placement.id);
      assignAttributes(nodes.group, { "aria-pressed": String(selected), "data-selected": String(selected), "data-valid": String(!invalid), "aria-label": `${definition.name}，${this.facingLabel(placement)}，旋转 ${placement.rotation * 90} 度${selected ? "，已选中" : ""}` });
      assignAttributes(nodes.body, rectAttributes(bounds));
      assignAttributes(nodes.label, { x: placement.x, y: -placement.z });
      const front = this.frontDirection(placement);
      const thickness = .09;
      const frontBounds: LayoutCollider = front.x !== 0
        ? { ...bounds, minX: front.x > 0 ? bounds.maxX - thickness : bounds.minX, maxX: front.x > 0 ? bounds.maxX : bounds.minX + thickness }
        : { ...bounds, minZ: front.z > 0 ? bounds.maxZ - thickness : bounds.minZ, maxZ: front.z > 0 ? bounds.maxZ : bounds.minZ + thickness };
      assignAttributes(nodes.front, rectAttributes(frontBounds));
      const edge = { x: front.x > 0 ? bounds.maxX : front.x < 0 ? bounds.minX : placement.x, z: front.z > 0 ? bounds.maxZ : front.z < 0 ? bounds.minZ : placement.z };
      const tip = { x: edge.x + front.x * .29, z: edge.z + front.z * .29 };
      const base = { x: edge.x + front.x * .08, z: edge.z + front.z * .08 };
      assignAttributes(nodes.arrow, { d: `M ${tip.x} ${-tip.z} L ${base.x - front.z * .12} ${-base.z - front.x * .12} L ${base.x + front.z * .12} ${-base.z + front.x * .12} Z` });
      setText(nodes.title, `${definition.name} · ${this.facingLabel(placement)} · X ${placement.x.toFixed(3)} / Z ${placement.z.toFixed(3)}`);
    }
    const select = this.el<HTMLSelectElement>("s3-layout-select");
    if (select.value !== this.selected) select.value = this.selected;
    setText(this.el("s3-layout-x"), `${selectedPlacement.x.toFixed(3)} m`);
    setText(this.el("s3-layout-z"), `${selectedPlacement.z.toFixed(3)} m`);
    setText(this.el("s3-layout-rotation"), `${selectedPlacement.rotation * 90}°`);
    setText(this.el("s3-layout-facing"), this.facingLabel(selectedPlacement));
    this.el("s3-layout-selection-help").textContent = selectedDefinition.id === "checkout-counter"
      ? "收银台、扫码器和刷卡器整组移动；请为顾客和店员两侧留出位置。"
      : "商品会跟随货架一起移动；请在深色正面一侧保留取货通道。";
    const lock = this.el<HTMLElement>("s3-layout-lock");
    lock.hidden = this.options.editable;
    setText(lock, this.options.reason || "当前只能查看布局。请在准备营业或打烊后装修。" );
    const status = this.el("s3-layout-validation");
    const error = this.applyError || (this.conflict ? "店铺布局已发生变化，草稿仍然保留。请取消修改或恢复默认后重新调整。" : !validation.valid ? `暂不可应用：${validation.reason || "请调整家具位置并保留通道。"}` : "");
    setText(status, error || (dirty ? "位置可用。应用后同步到店铺，商品也会一起移动。" : "布局已保存。选择一件家具，试着为小店腾出空间。"));
    assignAttributes(status, { "data-tone": error ? "error" : dirty ? "ready" : "neutral" });
    setText(this.el("s3-layout-dirty"), dirty ? "有未应用的修改" : "已保存");
    assignAttributes(this.el("s3-layout-dirty"), { "data-dirty": String(dirty) });
    assignAttributes(this.root, { "data-editable": String(this.options.editable) });
    this.el<HTMLButtonElement>("s3-layout-rotate").disabled = !this.options.editable;
    this.el<HTMLFieldSetElement>("s3-layout-movement").disabled = !this.options.editable;
    this.el<HTMLButtonElement>("s3-layout-discard").disabled = !dirty && !this.conflict;
    this.el<HTMLButtonElement>("s3-layout-default").disabled = !this.options.editable || (!this.conflict && layoutEquals(this.draft, { ...createDefaultShopLayout(), expansion: this.draft.expansion }));
    this.el<HTMLButtonElement>("s3-layout-apply").disabled = !this.options.editable || !dirty || !validation.valid || this.conflict;
    if (dirty !== this.reportedDirty) {
      this.reportedDirty = dirty;
      this.callbacks.onDirtyChange?.(dirty);
    }
  }

  private frontDirection(placement: FurniturePlacement): Point {
    const definition = FURNITURE_DEFINITIONS.find((entry) => entry.id === placement.id)!;
    const { x, z } = definition.front;
    switch (placement.rotation) {
      case 1: return { x: z, z: -x };
      case 2: return { x: -x, z: -z };
      case 3: return { x: -z, z: x };
      default: return { x, z };
    }
  }

  private facingLabel(placement: FurniturePlacement): string {
    const direction = this.frontDirection(placement);
    const side = placement.id === "checkout-counter" ? "顾客侧" : "商品正面";
    return `${side}${direction.x > 0 ? "朝右 →" : direction.x < 0 ? "朝左 ←" : direction.z > 0 ? "朝店铺后方 ↑" : "朝店门 ↓"}`;
  }
}
