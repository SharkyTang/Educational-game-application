import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HemisphericLight,
  ImageProcessingConfiguration, MeshBuilder, PBRMaterial, Scene, ShadowGenerator,
  StandardMaterial, TransformNode, Vector3, type Mesh,
} from "@babylonjs/core";
import {
  EQUIPMENT_ASSET_LIST, EQUIPMENT_ASSETS, EQUIPMENT_CATEGORIES, equipmentAssetCode,
  equipmentLibraryManifest, filterEquipmentAssets, isEquipmentAssetId,
  type EquipmentAssetId, type EquipmentCategoryId, type EquipmentMount, type EquipmentSlot,
} from "./catalog";
import { createEquipmentAsset, equipmentSlotWorldPosition, getEquipmentSlots } from "./index";
import "./equipment.css";

const FRONT_ALPHA = -Math.PI / 2 - 0.46;
const MOUNT_NAMES: Record<EquipmentMount, string> = { shelf: "层板", basket: "分格篮", hook: "挂钩", bagging: "暂存台" };
const SEARCH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
const CUBE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function centimetres(values: readonly number[]): string {
  return values.map((value) => (value * 100).toFixed(1)).join(" × ");
}

/** An independent equipment-art viewer: no game inventory, checkout or persistence is mounted. */
export class EquipmentLibraryApp {
  private readonly events = new AbortController();
  private readonly urls = new Set<string>();
  private readonly timers = new Set<number>();
  private readonly hadBodyClass: boolean;
  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private camera: ArcRotateCamera | null = null;
  private shadow: ShadowGenerator | null = null;
  private plinth: Mesh | null = null;
  private model: TransformNode | null = null;
  private slotMarkers: TransformNode | null = null;
  private slotMaterial: StandardMaterial | null = null;
  private slots: EquipmentSlot[] = [];
  private showSlots = false;
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame = 0;
  private selected: EquipmentAssetId = "self-checkout-compact";
  private category: EquipmentCategoryId | undefined;
  private query = "";
  private selectionVersion = 0;
  private ready = false;
  private exporting = false;
  private contextLost = false;
  private initialized = false;
  private disposed = false;
  private boundsSize = new Vector3(1, 1.6, 0.8);
  private boundsCentre = new Vector3(0, 0.8, 0);

  constructor(private readonly root: HTMLElement) {
    this.hadBodyClass = document.body.classList.contains("equipment-library-page");
    document.body.classList.add("equipment-library-page");
    this.root.classList.add("equipment-library-host");
    const requested = new URLSearchParams(location.search).get("equipment");
    if (isEquipmentAssetId(requested)) this.selected = requested;
  }

  async init(): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    this.renderShell();
    this.bindEvents();
    this.renderList();
    this.renderDefinition();
    try {
      this.createScene();
      await this.selectEquipment(this.selected);
    } catch (error) { this.previewFailure(error); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selectionVersion += 1;
    this.events.abort();
    this.resizeObserver?.disconnect();
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    for (const timer of this.timers) window.clearTimeout(timer);
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.timers.clear();
    this.urls.clear();
    this.engine?.stopRenderLoop(this.renderFrame);
    this.camera?.detachControl();
    this.shadow?.dispose();
    this.scene?.dispose();
    this.engine?.dispose();
    this.scene = null;
    this.engine = null;
    this.camera = null;
    this.shadow = null;
    this.plinth = null;
    this.model = null;
    this.slotMarkers = null;
    this.slotMaterial = null;
    this.slots = [];
    this.root.classList.remove("equipment-library-host");
    if (!this.hadBodyClass) document.body.classList.remove("equipment-library-page");
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing equipment library element: ${selector}`);
    return element;
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <main class="equipment-library-app" aria-labelledby="el-title">
        <header class="el-masthead"><a class="el-wordmark" href="/" aria-label="Corner Shop，返回小店"><span class="el-brand-mark">cs.</span><span>Corner Shop<small>THE EQUIPMENT COLLECTION</small></span></a><a class="el-back" id="el-back-game" href="/">← 返回小店</a></header>
        <nav class="el-library-nav" aria-label="素材库导航"><a href="/?assets=1" id="el-products-link">商品素材</a><a href="/?assets=equipment" aria-current="page">店铺设备<span>${EQUIPMENT_ASSET_LIST.length}</span></a></nav>
        <section class="el-intro"><div><p class="el-eyebrow">ASSET LIBRARY · VOL. 02</p><h1 id="el-title">店铺设备素材库</h1><p class="el-intro-note">收银台、横式冷柜与陈列架。查看真实模型，按尺寸与陈列位调用。</p></div><div class="el-overview" aria-label="设备素材制作进度"><div><strong id="el-total">${EQUIPMENT_ASSET_LIST.length}</strong><span>设备模型已制作</span></div><div><strong>03</strong><span>设备分类</span></div><div><strong id="el-integrated">00</strong><span>已接入经营</span></div></div></section>
        <div class="el-section-line"><p><span class="el-dot"></span> 米制模型 <span>/</span> 底部锚点 <span>/</span> 独立陈列位</p><button type="button" class="el-link-button" id="el-download-manifest" data-el-action="manifest">↓ 下载 JSON 清单</button></div>
        <div class="el-workspace">
          <aside class="el-catalogue" aria-label="浏览设备素材"><div class="el-search-wrap">${SEARCH_ICON}<input id="el-search" type="search" placeholder="中文、English 或型号 ID" aria-label="搜索设备" aria-describedby="el-result-count" autocomplete="off" spellcheck="false" /></div><nav class="el-categories" aria-label="设备分类"><button type="button" data-el-category="all" aria-pressed="true">全部设备<span>${EQUIPMENT_ASSET_LIST.length}</span></button>${EQUIPMENT_CATEGORIES.map((category) => `<button type="button" data-el-category="${category.id}" aria-pressed="false">${category.nameZh}<span>${EQUIPMENT_ASSET_LIST.filter((asset) => asset.category === category.id).length}</span></button>`).join("")}</nav><div class="el-list-heading"><h2>设备目录</h2><span id="el-result-count" aria-live="polite"></span></div><ul id="el-equipment-list" class="el-equipment-list" aria-label="设备列表"></ul><div class="el-empty" id="el-empty" hidden><span class="el-empty-icon">${SEARCH_ICON}</span><h3>没有找到这款设备</h3><p>试试中文、英文、型号 ID，或清除筛选查看全部设备。</p><button type="button" id="el-clear-filters" class="el-secondary" data-el-action="clear">清除筛选</button></div><p class="el-catalogue-foot">缩略图来自真实模型；选择后可旋转检查。</p></aside>
          <section class="el-preview" aria-label="设备实时三维预览"><div class="el-stage" id="el-stage"><div class="el-stage-heading"><span class="el-stage-kicker">${CUBE_ICON} LIVE 3D PREVIEW</span><span id="el-model-state" data-state="loading" role="status">正在准备模型…</span></div><canvas id="el-canvas" class="el-canvas" tabindex="0" aria-label="设备三维模型。拖动旋转，滚轮或双指缩放，也可使用下方视角按钮。"></canvas><div id="el-preview-error" class="el-preview-error" role="alert" hidden><h3>暂时无法显示 3D 预览</h3><p id="el-preview-error-text"></p><button type="button" class="el-secondary" data-el-action="reload">重新加载预览</button></div><div class="el-stage-bottom"><p id="el-stage-caption"></p><span>METRES · BOTTOM-CENTRE ORIGIN</span></div></div><div class="el-view-toolbar"><p>拖动旋转 · 滚轮 / 双指缩放</p><div class="el-view-buttons" role="group" aria-label="设备视角控制"><button type="button" data-el-action="left" id="el-rotate-left" aria-label="向左旋转设备视角 45 度" title="向左旋转">↶</button><button type="button" data-el-action="right" id="el-rotate-right" aria-label="向右旋转设备视角 45 度" title="向右旋转">↷</button><button type="button" data-el-action="zoom-in" aria-label="放大设备" title="放大">＋</button><button type="button" data-el-action="zoom-out" aria-label="缩小设备" title="缩小">−</button><button type="button" data-el-action="reset" id="el-reset-view" class="el-reset-view">复位视角</button></div></div><div class="el-slot-switch-row"><label class="el-slot-toggle"><input id="el-show-slots" type="checkbox" aria-controls="el-canvas el-slot-preview-status" /><span>显示陈列位</span></label><span id="el-slot-preview-status" data-visible-count="0" role="status">陈列位线框已隐藏</span></div><p class="el-preview-note">线框标示每个位置可用的宽、高、深，不代表已有商品；导出不包含线框、展台、相机或灯光。</p></section>
          <aside class="el-detail" aria-label="所选设备规格"><div class="el-detail-top"><p id="el-detail-category" class="el-eyebrow"></p><span id="el-gameplay-status" class="el-status-badge">素材就绪 · 未接入经营</span></div><h2 id="el-equipment-name"></h2><p class="el-name-en" id="el-equipment-english" lang="en"></p><div class="el-id-line"><code id="el-equipment-id"></code><button type="button" id="el-copy-id" class="el-link-button" data-el-action="copy-id">复制 ID</button></div><p class="el-description" id="el-description"></p><dl class="el-specs"><div><dt>型号样式</dt><dd id="el-style"></dd></div><div><dt>实际尺寸</dt><dd><span id="el-bounds">正在测量…</span><small>宽 × 高 × 深 · 米</small></dd></div><div><dt>设备占地</dt><dd><span id="el-footprint">正在测量…</span><small>宽 × 深；不含操作通道</small></dd></div><div><dt>建议通道</dt><dd><span id="el-clearance"></span><small>设备正面额外预留；非通行合规认证</small></dd></div></dl><div class="el-capacity-box"><div><strong id="el-slot-count">—</strong><span id="el-capacity-label"></span></div><p>每位净空：<span id="el-slot-size">正在测量…</span><small>宽 × 高 × 深 · 厘米；不是升数或现货库存</small></p></div><details class="el-slot-details"><summary id="el-slot-details-summary">查看陈列位坐标</summary><div class="el-slot-table-wrap" tabindex="0" role="region" aria-label="设备局部陈列位明细"><table><thead><tr><th scope="col">位置 / 支撑</th><th scope="col">底部坐标 m</th><th scope="col">净空 cm</th></tr></thead><tbody id="el-slot-table"></tbody></table></div><p>局部坐标会随设备根节点整体移动、旋转；调用示例可取得世界坐标。挂钩位还需商品具备合适挂点。</p></details><div class="el-model-stats" aria-label="当前设备模型实际统计"><div><strong id="el-mesh-count">—</strong><span>网格</span></div><div><strong id="el-triangle-count">—</strong><span>三角面</span></div><div><strong id="el-material-count">—</strong><span>材质</span></div></div><p id="el-integration-note" class="el-integration-note"></p><div class="el-export-actions"><button type="button" class="el-primary" id="el-download-glb" data-el-action="glb" disabled>↓ 下载设备 GLB</button><button type="button" class="el-secondary" id="el-copy-code" data-el-action="copy-code">复制调用代码</button></div><details class="el-code-details"><summary>查看调用示例</summary><pre><code id="el-code"></code></pre></details><section id="el-copy-fallback" class="el-copy-fallback" aria-label="手动复制设备信息" hidden><label for="el-copy-text">浏览器未允许自动复制，请手动复制：</label><textarea id="el-copy-text" rows="4" readonly spellcheck="false"></textarea><button type="button" class="el-link-button" data-el-action="select-copy">选中全部文本</button></section><p id="el-notice" class="el-notice" role="status" aria-live="polite">本页不会读取或修改游戏存档。</p></aside>
        </div><footer class="el-footer"><p><strong>陈列容量是模型规格，不是经营状态。</strong> 设备购买、摆放保存、库存扩容、自助结算与制冷逻辑均需另行接入。请匹配商品尺寸、支撑方式与朝向。</p><span>CORNER SHOP · EQUIPMENT LIBRARY 02</span></footer>
      </main>`;
  }

  private bindEvents(): void {
    const options = { signal: this.events.signal };
    this.element<HTMLInputElement>("#el-search").addEventListener("input", () => {
      this.query = this.element<HTMLInputElement>("#el-search").value;
      this.applyFilter();
    }, options);
    this.element<HTMLInputElement>("#el-show-slots").addEventListener("change", () => {
      this.showSlots = this.element<HTMLInputElement>("#el-show-slots").checked;
      this.updateSlotMarkers();
    }, options);
    this.root.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>("button");
      if (!button || button.disabled || !this.root.contains(button)) return;
      const id = button.dataset.equipmentId;
      if (isEquipmentAssetId(id)) { void this.selectEquipment(id); return; }
      const category = button.dataset.elCategory;
      if (category) { this.category = EQUIPMENT_CATEGORIES.find((entry) => entry.id === category)?.id; this.applyFilter(); return; }
      const action = button.dataset.elAction;
      if (action === "clear") {
        this.query = ""; this.category = undefined;
        this.element<HTMLInputElement>("#el-search").value = "";
        this.applyFilter();
        this.element<HTMLInputElement>("#el-search").focus();
      } else if (action === "copy-id") void this.copyText(this.selected, "设备 ID 已复制。");
      else if (action === "copy-code") void this.copyText(equipmentAssetCode(this.selected), "设备调用代码已复制。");
      else if (action === "select-copy") this.element<HTMLTextAreaElement>("#el-copy-text").select();
      else if (action === "manifest") {
        this.download(new Blob([JSON.stringify(equipmentLibraryManifest(), null, 2)], { type: "application/json;charset=utf-8" }), "corner-shop-equipment-library.json");
        this.notice("设备 JSON 清单已下载，包含型号、尺寸与陈列位定义。");
      } else if (action === "glb") void this.exportGlb();
      else if (action === "reload") location.reload();
      else if (action) this.changeView(action);
    }, options);
    const canvas = this.element<HTMLCanvasElement>("#el-canvas");
    canvas.addEventListener("keydown", (event) => {
      const actions: Record<string, string> = { ArrowLeft: "left", ArrowRight: "right", "+": "zoom-in", "=": "zoom-in", "-": "zoom-out", "0": "reset", Home: "reset" };
      const action = actions[event.key];
      if (action) { event.preventDefault(); this.changeView(action); }
    }, options);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.engine?.stopRenderLoop(this.renderFrame);
      else this.engine?.runRenderLoop(this.renderFrame);
    }, options);
    window.addEventListener("resize", this.scheduleResize, options);
    window.addEventListener("pagehide", (event) => {
      if (event.persisted) this.engine?.stopRenderLoop(this.renderFrame);
      else this.dispose();
    }, options);
    window.addEventListener("pageshow", (event) => {
      if (event.persisted && !this.disposed) { this.engine?.resize(); this.engine?.runRenderLoop(this.renderFrame); }
    }, options);
    this.resizeObserver = new ResizeObserver(this.scheduleResize);
    this.resizeObserver.observe(canvas);
  }

  private createScene(): void {
    const canvas = this.element<HTMLCanvasElement>("#el-canvas");
    this.engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false, powerPreference: "low-power" });
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.75));
    // Babylon's restored observable runs after rebuilding its GPU resources,
    // unlike the browser's earlier raw webglcontextrestored event.
    this.engine.onContextLostObservable.add(() => {
      if (this.disposed) return;
      this.contextLost = true; this.ready = false; this.selectionVersion += 1;
      this.setModelState("paused", "图形连接已暂停");
      this.element("#el-preview-error").hidden = false;
      this.element("#el-preview-error-text").textContent = "浏览器正在恢复图形连接。目录和调用信息仍可查看，也可以重新加载。";
      this.syncControls();
    });
    this.engine.onContextRestoredObservable.add(() => {
      if (this.disposed) return;
      this.contextLost = false;
      this.element("#el-preview-error").hidden = true;
      if (!this.exporting) void this.selectEquipment(this.selected);
    });
    const scene = this.scene = new Scene(this.engine);
    scene.clearColor = Color4.FromHexString("#eee9dcff");
    scene.ambientColor = new Color3(0.075, 0.075, 0.065);
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.imageProcessingConfiguration.exposure = 0.96;
    scene.imageProcessingConfiguration.contrast = 1.08;
    const camera = this.camera = new ArcRotateCamera("equipment-library-camera", FRONT_ALPHA, 1.17, 4.5, this.boundsCentre, scene);
    camera.minZ = 0.01; camera.maxZ = 80; camera.fov = 0.64;
    camera.lowerBetaLimit = 0.12; camera.upperBetaLimit = Math.PI * 0.51;
    camera.panningSensibility = 0; camera.wheelDeltaPercentage = 0.012; camera.pinchDeltaPercentage = 0.008;
    camera.inertia = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.65;
    camera.angularSensibilityX = 1600; camera.angularSensibilityY = 1600;
    camera.attachControl(canvas, false);
    camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");
    const sky = new HemisphericLight("equipment-library-fill", new Vector3(0.3, 1, -0.4), scene);
    sky.intensity = 0.63; sky.diffuse = new Color3(1, 0.98, 0.93); sky.groundColor = new Color3(0.62, 0.60, 0.52);
    const key = new DirectionalLight("equipment-library-key", new Vector3(0.5, -1.4, 0.75), scene);
    key.position.set(-4, 7, -5); key.intensity = 1.8; key.diffuse = new Color3(1, 0.95, 0.83);
    key.shadowMinZ = 0.1; key.shadowMaxZ = 25;
    const rim = new DirectionalLight("equipment-library-rim", new Vector3(-0.6, -0.25, -0.6), scene);
    rim.intensity = 0.72; rim.diffuse = new Color3(0.87, 0.93, 1);
    this.shadow = new ShadowGenerator(1024, key);
    this.shadow.usePercentageCloserFiltering = true; this.shadow.bias = 0.0003; this.shadow.normalBias = 0.003; this.shadow.setDarkness(0.3);
    this.plinth = MeshBuilder.CreateCylinder("equipment-library-plinth", { diameter: 1, height: 0.04, tessellation: 96 }, scene);
    this.plinth.position.y = -0.0205; this.plinth.receiveShadows = true; this.plinth.isPickable = false;
    const paper = new PBRMaterial("equipment-library-plinth-paper", scene);
    paper.albedoColor = Color3.FromHexString("#e1dac8"); paper.roughness = 0.95; paper.metallic = 0;
    this.plinth.material = paper;
    this.slotMaterial = new StandardMaterial("equipment-slot-envelope-material", scene);
    this.slotMaterial.emissiveColor = Color3.FromHexString("#467e53");
    this.slotMaterial.diffuseColor = Color3.FromHexString("#467e53");
    this.slotMaterial.disableLighting = true; this.slotMaterial.alpha = 0.62;
    this.slotMaterial.wireframe = true; this.slotMaterial.backFaceCulling = false;
    this.engine.resize();
    this.engine.runRenderLoop(this.renderFrame);
  }

  private readonly renderFrame = (): void => {
    if (this.disposed || this.contextLost || !this.scene) return;
    try { this.scene.render(); }
    catch (error) { this.engine?.stopRenderLoop(this.renderFrame); this.previewFailure(error); }
  };

  private readonly scheduleResize = (): void => {
    if (this.disposed || this.resizeFrame) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = 0;
      if (this.disposed) return;
      this.engine?.resize();
      if (this.model) this.fitCamera(false);
    });
  };

  private renderList(): void {
    const assets = filterEquipmentAssets(this.query, this.category);
    this.element("#el-result-count").textContent = `${assets.length} 款`;
    this.element("#el-empty").hidden = assets.length > 0;
    this.element("#el-equipment-list").innerHTML = assets.map((asset) => `<li><button type="button" data-equipment-id="${asset.id}" aria-pressed="${asset.id === this.selected}"${this.exporting ? " disabled" : ""}><img class="el-item-thumbnail" src="${escapeHtml(asset.thumbnailUrl)}" alt="" width="44" height="44" loading="lazy" decoding="async" /><span class="el-item-name">${escapeHtml(asset.nameZh)}<small lang="en">${escapeHtml(asset.nameEn)}</small></span></button></li>`).join("");
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-el-category]")) button.setAttribute("aria-pressed", String(button.dataset.elCategory === (this.category ?? "all")));
  }

  private applyFilter(): void {
    if (this.exporting) return;
    this.renderList();
    const assets = filterEquipmentAssets(this.query, this.category);
    if (assets.length && !assets.some((asset) => asset.id === this.selected)) void this.selectEquipment(assets[0]!.id);
  }

  private renderDefinition(): void {
    const asset = EQUIPMENT_ASSETS[this.selected];
    const category = EQUIPMENT_CATEGORIES.find((entry) => entry.id === asset.category)!;
    this.element("#el-detail-category").textContent = category.nameEn.toUpperCase();
    this.element("#el-equipment-name").textContent = asset.nameZh;
    this.element("#el-equipment-english").textContent = asset.nameEn;
    this.element("#el-equipment-id").textContent = asset.id;
    this.element("#el-description").textContent = asset.description;
    this.element("#el-style").textContent = asset.style;
    this.element("#el-clearance").textContent = `正面 ≥ ${asset.suggestedFrontClearance.toFixed(2)} 米（建议）`;
    this.element("#el-capacity-label").textContent = asset.capacityLabel;
    this.element("#el-integration-note").textContent = asset.category === "checkout"
      ? "这是自助收银台美术模型，触屏与支付终端为展示，不执行真实结算或收款。"
      : asset.category === "refrigeration"
        ? "这是冷柜美术模型，陈列位不代表现货库存；尚未接入购买、制冷或经营扩容。"
        : "这是陈列设备美术模型，陈列位不代表现货库存；尚未接入设备购买、经营扩容或摆放保存。";
    this.element("#el-code").textContent = equipmentAssetCode(asset.id);
    this.element("#el-stage-caption").textContent = asset.nameZh;
    this.element("#el-copy-fallback").hidden = true;
    this.element<HTMLCanvasElement>("#el-canvas").setAttribute("aria-label", `${asset.nameZh}三维模型。拖动旋转，滚轮或双指缩放，也可使用下方视角按钮。`);
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-equipment-id]")) button.setAttribute("aria-pressed", String(button.dataset.equipmentId === this.selected));
  }

  private async selectEquipment(id: EquipmentAssetId): Promise<void> {
    if (this.disposed || this.exporting) return;
    const version = ++this.selectionVersion;
    this.selected = id; this.ready = false; this.slots = [];
    this.slotMarkers?.dispose(false, false); this.slotMarkers = null;
    this.renderDefinition();
    this.setModelState("loading", "正在加载模型…");
    this.element("#el-preview-error").hidden = true;
    for (const selector of ["#el-bounds", "#el-footprint", "#el-slot-size"]) this.element(selector).textContent = "正在测量…";
    for (const selector of ["#el-mesh-count", "#el-triangle-count", "#el-material-count", "#el-slot-count"]) this.element(selector).textContent = "—";
    this.element("#el-slot-table").replaceChildren();
    this.element("#el-slot-details-summary").textContent = "查看陈列位坐标";
    this.setMarkerStatus(0);
    this.syncControls();
    const url = new URL(location.href);
    url.searchParams.set("assets", "equipment"); url.searchParams.set("equipment", id); url.searchParams.delete("product");
    history.replaceState(null, "", url);
    if (!this.scene || this.contextLost) {
      this.previewFailure(new Error(this.contextLost ? "图形连接尚未恢复，请稍候。" : "当前浏览器无法初始化 WebGL，请使用支持 WebGL 的浏览器。"));
      return;
    }
    try {
      if (this.model) {
        for (const mesh of this.model.getChildMeshes()) this.shadow?.removeShadowCaster(mesh, false);
        this.model.dispose(false, false); this.model = null;
      }
      const model = this.model = createEquipmentAsset(this.scene, id, `library-equipment-${id}`);
      model.computeWorldMatrix(true);
      const meshes = model.getChildMeshes().filter((mesh) => mesh.getTotalVertices() > 0);
      if (!meshes.length) throw new Error("设备没有可显示的几何数据。");
      for (const mesh of meshes) mesh.computeWorldMatrix(true);
      const bounds = model.getHierarchyBoundingVectors(true);
      this.boundsSize = bounds.max.subtract(bounds.min); this.boundsCentre = bounds.max.add(bounds.min).scale(0.5);
      if (!this.boundsSize.asArray().every((value) => Number.isFinite(value) && value > 0)) throw new Error("设备尺寸无效，请检查模型。");
      this.slots = getEquipmentSlots(model);
      for (const mesh of meshes) this.shadow?.addShadowCaster(mesh, false);
      if (this.plinth) {
        const diameter = Math.max(this.boundsSize.x, this.boundsSize.z) * 1.32;
        this.plinth.scaling.set(diameter, 1, diameter);
        this.plinth.position.x = this.boundsCentre.x; this.plinth.position.z = this.boundsCentre.z;
      }
      this.fitCamera(true);
      this.element("#el-mesh-count").textContent = String(meshes.length);
      this.element("#el-triangle-count").textContent = Math.round(meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0)).toLocaleString("en-GB");
      this.element("#el-material-count").textContent = String(new Set(meshes.map((mesh) => mesh.material).filter(Boolean)).size);
      this.element("#el-bounds").textContent = this.boundsSize.asArray().map((value) => value.toFixed(2)).join(" × ");
      const footprint = model.metadata?.footprint as { width?: number; depth?: number } | undefined;
      const width = typeof footprint?.width === "number" && footprint.width > 0 ? footprint.width : this.boundsSize.x;
      const depth = typeof footprint?.depth === "number" && footprint.depth > 0 ? footprint.depth : this.boundsSize.z;
      this.element("#el-footprint").textContent = `${width.toFixed(2)} × ${depth.toFixed(2)} 米 · ${(width * depth).toFixed(2)} m²`;
      this.renderSlotDetails();
      await this.scene.whenReadyAsync();
      if (this.disposed || version !== this.selectionVersion) return;
      this.ready = true;
      this.setModelState("ready", "模型已加载");
      this.updateSlotMarkers();
      this.syncControls();
    } catch (error) {
      if (!this.disposed && version === this.selectionVersion) this.previewFailure(error);
    }
  }

  private renderSlotDetails(): void {
    this.element("#el-slot-count").textContent = String(this.slots.length);
    const sizes = [...new Set(this.slots.map((slot) => centimetres(slot.maxSize)))];
    this.element("#el-slot-size").textContent = sizes.length === 1 ? sizes[0]! : `${sizes.length} 种净空（详见坐标表）`;
    this.element("#el-slot-details-summary").textContent = `查看 ${this.slots.length} 个陈列位坐标`;
    this.element("#el-slot-table").innerHTML = this.slots.map((slot) => `<tr><th scope="row">${escapeHtml(slot.id)}<small>${MOUNT_NAMES[slot.mount]} · ${Math.round(slot.rotationY * 180 / Math.PI)}°</small></th><td>${slot.position.map((value) => value.toFixed(2)).join(" / ")}</td><td>${centimetres(slot.maxSize)}</td></tr>`).join("");
  }

  private updateSlotMarkers(): void {
    if (this.disposed || !this.scene || !this.model || !this.ready || this.contextLost) { this.setMarkerStatus(0); return; }
    if (this.showSlots && !this.slotMarkers) {
      // Deliberately NOT parented to the equipment: markers must never enter an exported asset.
      this.slotMarkers = new TransformNode("equipment-placement-markers", this.scene);
      for (const slot of this.slots) {
        const marker = MeshBuilder.CreateBox(`equipment-slot-marker-${slot.id}`, { width: slot.maxSize[0], height: slot.maxSize[1], depth: slot.maxSize[2] }, this.scene);
        marker.parent = this.slotMarkers;
        marker.position.copyFrom(equipmentSlotWorldPosition(this.model, slot.id)).addInPlace(new Vector3(0, slot.maxSize[1] / 2, 0));
        marker.rotation.y = slot.rotationY;
        marker.material = this.slotMaterial; marker.isPickable = false;
      }
    }
    this.slotMarkers?.setEnabled(this.showSlots);
    this.setMarkerStatus(this.showSlots ? this.slots.length : 0);
  }

  private setMarkerStatus(count: number): void {
    if (this.disposed) return;
    const status = this.element("#el-slot-preview-status");
    status.dataset.visibleCount = String(count);
    status.textContent = count ? `显示 ${count} 个陈列位线框` : "陈列位线框已隐藏";
  }

  private fitCamera(reset: boolean): void {
    if (!this.camera || !this.engine) return;
    const camera = this.camera;
    const aspect = Math.max(0.25, this.engine.getRenderWidth() / Math.max(1, this.engine.getRenderHeight()));
    const halfFov = Math.min(camera.fov, 2 * Math.atan(Math.tan(camera.fov / 2) * aspect)) / 2;
    const radius = this.boundsSize.length() * 0.5 / Math.sin(halfFov) * 1.2;
    camera.setTarget(this.boundsCentre); camera.radius = radius;
    camera.lowerRadiusLimit = radius * 0.46; camera.upperRadiusLimit = radius * 2.2;
    camera.inertialAlphaOffset = 0; camera.inertialBetaOffset = 0; camera.inertialRadiusOffset = 0;
    if (reset) { camera.alpha = FRONT_ALPHA; camera.beta = EQUIPMENT_ASSETS[this.selected].category === "refrigeration" ? 0.99 : 1.17; }
  }

  private changeView(action: string): void {
    if (!this.camera || !this.ready || this.contextLost) return;
    if (action === "left") this.camera.alpha -= Math.PI / 4;
    else if (action === "right") this.camera.alpha += Math.PI / 4;
    else if (action === "zoom-in" || action === "zoom-out") this.camera.radius = Math.max(this.camera.lowerRadiusLimit ?? 0.01, Math.min(this.camera.upperRadiusLimit ?? 80, this.camera.radius * (action === "zoom-in" ? 0.82 : 1.22)));
    else if (action === "reset") this.fitCamera(true);
  }

  private setModelState(state: string, text: string): void {
    if (this.disposed) return;
    const status = this.element("#el-model-state");
    status.dataset.state = state; status.dataset.equipmentId = this.selected; status.textContent = text;
  }

  private syncControls(): void {
    if (this.disposed) return;
    this.element<HTMLButtonElement>("#el-download-glb").disabled = !this.ready || this.exporting || this.contextLost;
    this.element<HTMLButtonElement>("#el-download-glb").textContent = this.exporting ? "正在打包 GLB…" : "↓ 下载设备 GLB";
    this.element<HTMLInputElement>("#el-search").disabled = this.exporting;
    this.element<HTMLInputElement>("#el-show-slots").disabled = !this.ready || this.exporting || this.contextLost;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-equipment-id], [data-el-category], #el-clear-filters")) button.disabled = this.exporting;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(".el-view-buttons button")) button.disabled = !this.ready || this.contextLost;
  }

  private previewFailure(error: unknown): void {
    if (this.disposed) return;
    this.ready = false;
    this.slotMarkers?.setEnabled(false); this.setMarkerStatus(0);
    this.setModelState("error", "预览暂不可用");
    this.element("#el-preview-error").hidden = false;
    this.element("#el-preview-error-text").textContent = error instanceof Error ? error.message : "图形加载出现问题，请重新加载。";
    this.syncControls();
  }

  private notice(text: string): void {
    if (!this.disposed) this.element("#el-notice").textContent = text;
  }

  private async copyText(value: string, success: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (this.disposed) return;
      this.element("#el-copy-fallback").hidden = true; this.notice(success);
    } catch {
      if (this.disposed) return;
      this.element("#el-copy-fallback").hidden = false;
      const field = this.element<HTMLTextAreaElement>("#el-copy-text");
      field.value = value; field.focus(); field.select();
      this.notice("自动复制未完成；文本已选中，可手动复制。");
    }
  }

  private download(blob: Blob, name: string): void {
    if (this.disposed) return;
    const url = URL.createObjectURL(blob); this.urls.add(url);
    const link = document.createElement("a");
    link.href = url; link.download = name; link.hidden = true;
    this.root.append(link); link.click(); link.remove();
    const timer = window.setTimeout(() => { URL.revokeObjectURL(url); this.urls.delete(url); this.timers.delete(timer); }, 30_000);
    this.timers.add(timer);
  }

  private async exportGlb(): Promise<void> {
    if (!this.ready || !this.model || !this.scene || this.exporting || this.contextLost) return;
    const model = this.model; const scene = this.scene; const id = this.selected;
    this.exporting = true; this.syncControls();
    this.notice("正在打包设备几何、材质与陈列位元数据，请稍候。");
    try {
      const { GLTF2Export } = await import("@babylonjs/serializers/glTF/2.0");
      if (this.disposed || this.contextLost) return;
      const name = `corner-shop-${id}`;
      const result = await GLTF2Export.GLBAsync(scene, name, {
        shouldExportNode: (node) => node === model || node.isDescendantOf(model),
        shouldExportAnimation: () => false, removeNoopRootNodes: false,
        metadataSelector: (metadata: unknown) => metadata,
      });
      if (this.disposed || this.contextLost) return;
      const file = result.files[`${name}.glb`];
      if (!(file instanceof Blob)) throw new Error("导出器没有返回有效 GLB 文件。");
      this.download(file, `${name}.glb`);
      this.notice(`${EQUIPMENT_ASSETS[id].nameZh} GLB 已下载；不含陈列位线框、展台或灯光。`);
    } catch (error) {
      this.notice(`设备 GLB 下载未完成：${error instanceof Error ? error.message : "请重新尝试"}。也可先复制调用代码。`);
    } finally {
      this.exporting = false; this.syncControls();
      if (!this.disposed && !this.contextLost && !this.ready) void this.selectEquipment(this.selected);
    }
  }
}
