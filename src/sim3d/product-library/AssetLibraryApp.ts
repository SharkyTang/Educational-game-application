import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HemisphericLight,
  ImageProcessingConfiguration, MeshBuilder, PBRMaterial, Scene, ShadowGenerator,
  Vector3, type Mesh, type TransformNode,
} from "@babylonjs/core";
import {
  PRODUCT_ASSET_LIST, PRODUCT_ASSETS, PRODUCT_CATEGORIES, filterProductAssets,
  isProductAssetId, productAssetCode, productLibraryManifest,
  type ProductAssetId, type ProductCategoryId, type ProductShelf,
} from "./catalog";
import { createProductAsset } from "./index";
import "./library.css";

const SHELF_LABELS: Record<ProductShelf, string> = {
  chiller: "冷藏柜", bakery: "面包陈列架", ambient: "常温货架", produce: "生鲜果蔬区", household: "日用品货架",
};
const FRONT_ALPHA = -Math.PI / 2 - 0.34;
const FRONT_BETA = Math.PI / 2 - 0.25;
const ICON_SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
const ICON_BOX = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5"/></svg>';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** An isolated art viewer. It deliberately has no dependency on game state or persistence. */
export class AssetLibraryApp {
  private readonly events = new AbortController();
  private readonly urls = new Set<string>();
  private readonly timers = new Set<number>();
  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private camera: ArcRotateCamera | null = null;
  private shadow: ShadowGenerator | null = null;
  private plinth: Mesh | null = null;
  private model: TransformNode | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame = 0;
  private selected: ProductAssetId = "milk";
  private category: ProductCategoryId | undefined;
  private query = "";
  private selectionVersion = 0;
  private disposed = false;
  private ready = false;
  private exporting = false;
  private contextLost = false;
  private initialized = false;
  private boundsSize = new Vector3(0.1, 0.2, 0.1);
  private boundsCentre = new Vector3(0, 0.1, 0);
  private readonly hadBodyClass: boolean;

  constructor(private readonly root: HTMLElement) {
    this.hadBodyClass = document.body.classList.contains("product-library-page");
    document.body.classList.add("product-library-page");
    this.root.classList.add("product-library-host");
    const requested = new URLSearchParams(location.search).get("product");
    if (isProductAssetId(requested)) this.selected = requested;
  }

  async init(): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    this.renderShell();
    this.bindEvents();
    this.renderList();
    this.renderDetails();
    try {
      this.createScene();
      await this.selectProduct(this.selected);
    } catch (error) {
      this.previewFailure(error);
    }
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
    this.model = null;
    this.camera = null;
    this.root.classList.remove("product-library-host");
    if (!this.hadBodyClass) document.body.classList.remove("product-library-page");
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing library element: ${selector}`);
    return element;
  }

  private renderShell(): void {
    const activeCount = PRODUCT_ASSET_LIST.filter((asset) => asset.gameplay === "active").length;
    this.root.innerHTML = `
      <main class="product-library-app" aria-labelledby="pl-title">
        <header class="pl-masthead">
          <a class="pl-wordmark" href="/" aria-label="Corner Shop，返回游戏"><span class="pl-brand-mark">cs.</span><span>Corner Shop<small>THE PRODUCT COLLECTION</small></span></a>
          <a class="pl-back" id="pl-back-game" href="/">← <span>返回游戏</span></a>
        </header>
        <section class="pl-intro">
          <div><p class="pl-eyebrow">ASSET LIBRARY · VOL. 01</p><h1 id="pl-title">商品素材库<span>为你的小店，准备就绪。</span></h1><p class="pl-intro-note">可旋转查看的真实 3D 商品，独立保存，随时调用。</p></div>
          <div class="pl-overview" aria-label="制作与接入进度">
            <div><strong id="pl-total">${PRODUCT_ASSET_LIST.length}</strong><span>商品模型已制作</span></div>
            <div><strong id="pl-active">${String(activeCount).padStart(2, "0")}</strong><span>已接入游戏</span></div>
            <div><strong id="pl-pending">${PRODUCT_ASSET_LIST.length - activeCount}</strong><span>素材就绪 · 待接入</span></div>
          </div>
        </section>
        <div class="pl-section-line"><p><span class="pl-dot"></span> ${PRODUCT_CATEGORIES.length} 个分类 <span class="pl-line-divider">/</span> 统一米制 · 底部锚点</p><button type="button" class="pl-link-button" id="pl-download-manifest" data-pl-action="manifest">↓ 下载 JSON 清单</button></div>
        <div class="pl-workspace">
          <aside class="pl-catalogue" aria-label="浏览商品素材">
            <div class="pl-search-wrap">${ICON_SEARCH}<input id="pl-search" type="search" placeholder="中文、English 或 ID" aria-label="搜索商品" aria-describedby="pl-result-count" autocomplete="off" spellcheck="false" /></div>
            <nav class="pl-categories" aria-label="商品分类">
              <button type="button" data-category="all" aria-pressed="true">全部商品<span>${PRODUCT_ASSET_LIST.length}</span></button>
              ${PRODUCT_CATEGORIES.map((category) => `<button type="button" data-category="${category.id}" aria-pressed="false">${category.nameZh}<span>${PRODUCT_ASSET_LIST.filter((asset) => asset.category === category.id).length}</span></button>`).join("")}
            </nav>
            <div class="pl-list-heading"><h2>商品目录</h2><span id="pl-result-count" aria-live="polite"></span></div>
            <ul class="pl-product-list" id="pl-product-list" aria-label="商品列表"></ul>
            <div class="pl-empty" id="pl-empty" hidden><span class="pl-empty-icon">${ICON_SEARCH}</span><h3>没有找到这个商品</h3><p>试试中文名称、英文或商品 ID；也可以清除筛选，浏览全部素材。</p><button type="button" id="pl-clear-filters" data-pl-action="clear" class="pl-secondary">清除筛选</button></div>
            <p class="pl-catalogue-foot">选择商品，在右侧检查模型与调用信息。</p>
          </aside>
          <section class="pl-preview" aria-label="实时三维预览">
            <div class="pl-stage" id="pl-stage">
              <div class="pl-stage-heading"><span class="pl-stage-kicker">${ICON_BOX} LIVE 3D PREVIEW</span><span id="pl-model-state" data-state="loading" role="status">正在准备模型…</span></div>
              <canvas id="pl-canvas" class="pl-canvas" tabindex="0" aria-label="商品三维模型。拖动旋转，滚轮或双指缩放；也可使用下方按钮。"></canvas>
              <div class="pl-preview-error" id="pl-preview-error" role="alert" hidden><h3>暂时无法显示 3D 预览</h3><p id="pl-preview-error-text"></p><button type="button" class="pl-secondary" data-pl-action="reload">重新加载预览</button></div>
              <div class="pl-stage-bottom"><p id="pl-stage-caption"></p><span>1:1 MODEL · METRES</span></div>
            </div>
            <div class="pl-view-toolbar"><p>拖动旋转 · 滚轮 / 双指缩放</p><div class="pl-view-buttons" role="group" aria-label="模型视角控制"><button type="button" data-pl-action="left" id="pl-rotate-left" aria-label="向左旋转模型视角 45 度" title="向左旋转">↶</button><button type="button" data-pl-action="right" id="pl-rotate-right" aria-label="向右旋转模型视角 45 度" title="向右旋转">↷</button><button type="button" data-pl-action="zoom-in" aria-label="放大模型" title="放大">＋</button><button type="button" data-pl-action="zoom-out" aria-label="缩小模型" title="缩小">−</button><button type="button" data-pl-action="reset" id="pl-reset-view" class="pl-reset-view">复位视角</button></div></div>
            <div class="pl-preview-note"><span>模型规格</span><p>底部中心为原点，正面朝向 −Z。单品 GLB 包含几何与材质，不包含展台、灯光或相机。</p></div>
          </section>
          <aside class="pl-detail" aria-label="所选商品信息">
            <div class="pl-detail-top"><p class="pl-eyebrow" id="pl-detail-category"></p><span class="pl-status-badge" id="pl-gameplay-status"></span></div>
            <h2 id="pl-product-name"></h2><p class="pl-name-en" id="pl-product-english" lang="en"></p>
            <div class="pl-id-line"><code id="pl-product-id"></code><button type="button" id="pl-copy-id" data-pl-action="copy-id" class="pl-link-button">复制 ID</button></div>
            <p class="pl-appearance" id="pl-appearance"></p>
            <dl class="pl-specs"><div><dt>单位短语</dt><dd><span id="pl-phrase-en" lang="en"></span><small id="pl-phrase-zh"></small></dd></div><div><dt>推荐陈列</dt><dd id="pl-shelf"></dd></div><div><dt>实际尺寸</dt><dd><span id="pl-bounds">正在测量…</span><small>宽 × 高 × 深 · 厘米</small></dd></div><div><dt>语音素材</dt><dd id="pl-audio-status"></dd></div></dl>
            <div class="pl-model-stats" aria-label="当前模型实际统计"><div><strong id="pl-mesh-count">—</strong><span>网格</span></div><div><strong id="pl-triangle-count">—</strong><span>三角面</span></div><div><strong id="pl-material-count">—</strong><span>材质</span></div></div>
            <div class="pl-export-actions"><button type="button" class="pl-primary" id="pl-download-glb" data-pl-action="glb" disabled>↓ 下载单品 GLB</button><button type="button" class="pl-secondary" id="pl-copy-code" data-pl-action="copy-code">复制调用代码</button></div>
            <details class="pl-code-details"><summary>查看调用示例</summary><pre><code id="pl-code"></code></pre></details>
            <section id="pl-copy-fallback" class="pl-copy-fallback" aria-label="手动复制文本" hidden><label for="pl-copy-text">浏览器未允许自动复制，请手动复制：</label><textarea id="pl-copy-text" readonly rows="4" spellcheck="false"></textarea><button type="button" class="pl-link-button" data-pl-action="select-copy">选中全部文本</button></section>
            <p class="pl-notice" id="pl-notice" role="status" aria-live="polite">本页不会读取或修改你的游戏存档。</p>
          </aside>
        </div>
        <footer class="pl-footer"><p><strong>素材制作 ≠ 玩法接入。</strong> 牛奶与面包已接入首日经营；其余 ${PRODUCT_ASSET_LIST.length - activeCount} 件已有模型，后续仍需配置订单、价格、库存规则与教学配音。</p><span>CORNER SHOP · PRODUCT LIBRARY 01</span></footer>
      </main>`;
  }

  private bindEvents(): void {
    const options = { signal: this.events.signal };
    this.element<HTMLInputElement>("#pl-search").addEventListener("input", () => {
      this.query = this.element<HTMLInputElement>("#pl-search").value;
      this.applyFilter();
    }, options);
    this.root.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>("button");
      if (!button || button.disabled || !this.root.contains(button)) return;
      const id = button.dataset.productId;
      if (isProductAssetId(id)) { void this.selectProduct(id); return; }
      const category = button.dataset.category;
      if (category) {
        this.category = PRODUCT_CATEGORIES.find((entry) => entry.id === category)?.id;
        this.applyFilter();
        return;
      }
      const action = button.dataset.plAction;
      if (action === "clear") {
        this.query = ""; this.category = undefined;
        this.element<HTMLInputElement>("#pl-search").value = "";
        this.applyFilter();
        this.element<HTMLInputElement>("#pl-search").focus();
      } else if (action === "copy-id") void this.copyText(this.selected, "商品 ID 已复制。");
      else if (action === "copy-code") void this.copyText(productAssetCode(this.selected), "调用代码已复制。");
      else if (action === "select-copy") this.element<HTMLTextAreaElement>("#pl-copy-text").select();
      else if (action === "manifest") {
        this.download(new Blob([JSON.stringify(productLibraryManifest(), null, 2)], { type: "application/json;charset=utf-8" }), "corner-shop-product-library.json");
        this.notice("已下载全部商品的 JSON 清单，包含素材状态与调用信息。");
      } else if (action === "glb") void this.exportGlb();
      else if (action === "reload") location.reload();
      else if (action) this.changeView(action);
    }, options);
    const canvas = this.element<HTMLCanvasElement>("#pl-canvas");
    canvas.addEventListener("keydown", (event) => {
      const actions: Record<string, string> = { ArrowLeft: "left", ArrowRight: "right", "+": "zoom-in", "=": "zoom-in", "-": "zoom-out", "0": "reset", Home: "reset" };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      this.changeView(action);
    }, options);
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.ready = false;
      this.selectionVersion += 1;
      this.setModelState("paused", "图形上下文已暂停");
      this.element("#pl-preview-error").hidden = false;
      this.element("#pl-preview-error-text").textContent = "浏览器暂时失去了图形连接，正在等待恢复。你仍可查看目录和复制调用代码。";
      this.syncControls();
    }, options);
    canvas.addEventListener("webglcontextrestored", () => {
      if (this.disposed) return;
      this.contextLost = false;
      this.element("#pl-preview-error").hidden = true;
      if (!this.exporting) void this.selectProduct(this.selected);
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
      if (event.persisted && !this.disposed) {
        this.engine?.resize();
        this.engine?.runRenderLoop(this.renderFrame);
      }
    }, options);
    this.resizeObserver = new ResizeObserver(this.scheduleResize);
    this.resizeObserver.observe(canvas);
  }

  private createScene(): void {
    const canvas = this.element<HTMLCanvasElement>("#pl-canvas");
    this.engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false, powerPreference: "low-power" });
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.75));
    const scene = this.scene = new Scene(this.engine);
    scene.clearColor = Color4.FromHexString("#eee9dcff");
    scene.ambientColor = new Color3(0.075, 0.075, 0.065);
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.imageProcessingConfiguration.exposure = 0.96;
    scene.imageProcessingConfiguration.contrast = 1.08;
    const camera = this.camera = new ArcRotateCamera("library-camera", FRONT_ALPHA, FRONT_BETA, 0.75, this.boundsCentre, scene);
    camera.minZ = 0.002;
    camera.maxZ = 20;
    camera.fov = 0.6;
    camera.lowerBetaLimit = 0.12;
    camera.upperBetaLimit = Math.PI * 0.51;
    camera.panningSensibility = 0;
    camera.wheelDeltaPercentage = 0.012;
    camera.pinchDeltaPercentage = 0.008;
    camera.inertia = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.65;
    camera.angularSensibilityX = 1600;
    camera.angularSensibilityY = 1600;
    camera.attachControl(canvas, false);
    // Camera keyboard inputs are replaced by the explicit, labelled controls above.
    camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");
    const sky = new HemisphericLight("library-soft-fill", new Vector3(0.3, 1, -0.4), scene);
    sky.intensity = 0.63;
    sky.diffuse = new Color3(1, 0.98, 0.93);
    sky.groundColor = new Color3(0.62, 0.60, 0.52);
    const key = new DirectionalLight("library-key", new Vector3(0.5, -1.4, 0.75), scene);
    key.position.set(-0.7, 1.8, -1.1);
    key.intensity = 1.8;
    key.diffuse = new Color3(1, 0.95, 0.83);
    key.shadowMinZ = 0.1;
    key.shadowMaxZ = 5;
    const rim = new DirectionalLight("library-rim", new Vector3(-0.6, -0.25, -0.6), scene);
    rim.intensity = 0.72;
    rim.diffuse = new Color3(0.87, 0.93, 1);
    this.shadow = new ShadowGenerator(1024, key);
    this.shadow.usePercentageCloserFiltering = true;
    this.shadow.bias = 0.0003;
    this.shadow.normalBias = 0.0005;
    this.shadow.setDarkness(0.3);
    this.plinth = MeshBuilder.CreateCylinder("library-display-plinth", { diameter: 1, height: 0.012, tessellation: 96 }, scene);
    this.plinth.position.y = -0.0065;
    this.plinth.receiveShadows = true;
    this.plinth.isPickable = false;
    const plinthMaterial = new PBRMaterial("library-plinth-paper", scene);
    plinthMaterial.albedoColor = Color3.FromHexString("#e1dac8");
    plinthMaterial.roughness = 0.95;
    plinthMaterial.metallic = 0;
    this.plinth.material = plinthMaterial;
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
    const assets = filterProductAssets(this.query, this.category);
    this.element("#pl-result-count").textContent = `${assets.length} 件`;
    this.element("#pl-empty").hidden = assets.length > 0;
    this.element("#pl-product-list").innerHTML = assets.map((asset) => {
      return `<li><button type="button" data-product-id="${asset.id}" aria-pressed="${asset.id === this.selected}"${this.exporting ? " disabled" : ""}><img class="pl-item-thumbnail" src="${escapeHtml(asset.thumbnailUrl)}" alt="" width="40" height="40" loading="lazy" decoding="async" /><span class="pl-item-name">${escapeHtml(asset.nameZh)}<small lang="en">${escapeHtml(asset.nameEn)}</small></span><span class="pl-item-status${asset.gameplay === "active" ? " is-active" : ""}" aria-label="${asset.gameplay === "active" ? "已接入游戏" : "素材就绪，待接入"}"></span></button></li>`;
    }).join("");
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-category]")) button.setAttribute("aria-pressed", String(button.dataset.category === (this.category ?? "all")));
  }

  private applyFilter(): void {
    if (this.exporting) return;
    this.renderList();
    const assets = filterProductAssets(this.query, this.category);
    if (assets.length && !assets.some((asset) => asset.id === this.selected)) void this.selectProduct(assets[0]!.id);
  }

  private renderDetails(): void {
    const asset = PRODUCT_ASSETS[this.selected];
    const category = PRODUCT_CATEGORIES.find((entry) => entry.id === asset.category)!;
    this.element("#pl-detail-category").textContent = `${category.nameEn.toUpperCase()} / ${category.nameZh}`;
    this.element("#pl-product-name").textContent = asset.nameZh;
    this.element("#pl-product-english").textContent = asset.nameEn;
    this.element("#pl-product-id").textContent = asset.id;
    this.element("#pl-appearance").textContent = asset.appearance;
    this.element("#pl-phrase-en").textContent = asset.phraseEn;
    this.element("#pl-phrase-zh").textContent = asset.phraseZh;
    this.element("#pl-shelf").textContent = SHELF_LABELS[asset.shelf];
    this.element("#pl-audio-status").textContent = asset.audio ? "已配音 · 单词与短语" : "待配音 · 暂无音频";
    this.element("#pl-audio-status").classList.toggle("pl-pending-audio", !asset.audio);
    this.element("#pl-gameplay-status").textContent = asset.gameplay === "active" ? "已接入游戏" : "素材就绪 · 待接入";
    this.element("#pl-gameplay-status").classList.toggle("is-active", asset.gameplay === "active");
    this.element("#pl-code").textContent = productAssetCode(asset.id);
    this.element("#pl-stage-caption").textContent = `${asset.nameZh} / ${asset.nameEn}`;
    this.element("#pl-copy-fallback").hidden = true;
    this.element<HTMLCanvasElement>("#pl-canvas").setAttribute("aria-label", `${asset.nameZh}三维模型。拖动旋转，滚轮或双指缩放；也可使用下方按钮。`);
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-product-id]")) button.setAttribute("aria-pressed", String(button.dataset.productId === this.selected));
  }

  private async selectProduct(id: ProductAssetId): Promise<void> {
    if (this.disposed || this.exporting) return;
    const version = ++this.selectionVersion;
    this.selected = id;
    this.ready = false;
    this.renderDetails();
    this.setModelState("loading", "正在加载模型…");
    this.element("#pl-preview-error").hidden = true;
    this.element("#pl-bounds").textContent = "正在测量…";
    for (const selector of ["#pl-mesh-count", "#pl-triangle-count", "#pl-material-count"]) this.element(selector).textContent = "—";
    this.syncControls();
    const url = new URL(location.href);
    url.searchParams.set("assets", "1");
    url.searchParams.set("product", id);
    history.replaceState(null, "", url);
    if (!this.scene || this.contextLost) {
      this.previewFailure(new Error(this.contextLost ? "图形连接尚未恢复，请稍后重试。" : "当前浏览器无法初始化 WebGL。请使用支持 WebGL 的浏览器重新打开。"));
      return;
    }
    try {
      if (this.model) {
        for (const mesh of this.model.getChildMeshes()) this.shadow?.removeShadowCaster(mesh, false);
        // Factory materials are scene-cached and must remain usable when revisiting a product.
        this.model.dispose(false, false);
        this.model = null;
      }
      const model = this.model = createProductAsset(this.scene, id, `library-${id}`);
      model.computeWorldMatrix(true);
      const meshes = model.getChildMeshes().filter((mesh) => mesh.getTotalVertices() > 0);
      if (!meshes.length) throw new Error("该模型没有可预览的几何数据。");
      for (const mesh of meshes) mesh.computeWorldMatrix(true);
      const { min, max } = model.getHierarchyBoundingVectors(true);
      this.boundsSize = max.subtract(min);
      this.boundsCentre = min.add(max).scale(0.5);
      if (!this.boundsSize.asArray().every((value) => Number.isFinite(value) && value > 0)) throw new Error("模型尺寸无效，请检查素材几何。");
      if (this.plinth) {
        const diameter = Math.max(this.boundsSize.x, this.boundsSize.z, this.boundsSize.y * 0.65) * 1.65;
        this.plinth.scaling.set(diameter, 1, diameter);
        this.plinth.position.x = this.boundsCentre.x;
        this.plinth.position.z = this.boundsCentre.z;
      }
      for (const mesh of meshes) this.shadow?.addShadowCaster(mesh, false);
      this.fitCamera(true);
      this.element("#pl-mesh-count").textContent = String(meshes.length);
      this.element("#pl-triangle-count").textContent = Math.round(meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0)).toLocaleString("en-GB");
      this.element("#pl-material-count").textContent = String(new Set(meshes.map((mesh) => mesh.material).filter(Boolean)).size);
      this.element("#pl-bounds").textContent = this.boundsSize.asArray().map((value) => (value * 100).toFixed(1)).join(" × ");
      await this.scene.whenReadyAsync();
      if (this.disposed || version !== this.selectionVersion) return;
      this.ready = true;
      this.setModelState("ready", "模型已加载");
      this.syncControls();
    } catch (error) {
      if (!this.disposed && version === this.selectionVersion) this.previewFailure(error);
    }
  }

  private fitCamera(reset: boolean): void {
    if (!this.camera || !this.engine) return;
    const camera = this.camera;
    const aspect = Math.max(0.25, this.engine.getRenderWidth() / Math.max(1, this.engine.getRenderHeight()));
    const horizontalFov = 2 * Math.atan(Math.tan(camera.fov / 2) * aspect);
    const halfFov = Math.min(camera.fov, horizontalFov) / 2;
    const radius = this.boundsSize.length() * 0.5 / Math.sin(halfFov) * 1.24;
    camera.setTarget(this.boundsCentre);
    camera.radius = radius;
    camera.lowerRadiusLimit = radius * 0.46;
    camera.upperRadiusLimit = radius * 2.2;
    camera.inertialAlphaOffset = 0;
    camera.inertialBetaOffset = 0;
    camera.inertialRadiusOffset = 0;
    if (reset) { camera.alpha = FRONT_ALPHA; camera.beta = FRONT_BETA; }
  }

  private changeView(action: string): void {
    if (!this.camera || !this.ready || this.contextLost) return;
    if (action === "left") this.camera.alpha -= Math.PI / 4;
    else if (action === "right") this.camera.alpha += Math.PI / 4;
    else if (action === "zoom-in" || action === "zoom-out") {
      this.camera.radius = Math.max(this.camera.lowerRadiusLimit ?? 0.01, Math.min(this.camera.upperRadiusLimit ?? 20, this.camera.radius * (action === "zoom-in" ? 0.82 : 1.22)));
    } else if (action === "reset") this.fitCamera(true);
  }

  private setModelState(state: string, message: string): void {
    if (this.disposed) return;
    const element = this.element("#pl-model-state");
    element.dataset.state = state;
    element.dataset.productId = this.selected;
    element.textContent = message;
  }

  private syncControls(): void {
    if (this.disposed) return;
    this.element<HTMLButtonElement>("#pl-download-glb").disabled = !this.ready || this.exporting || this.contextLost;
    this.element<HTMLButtonElement>("#pl-download-glb").textContent = this.exporting ? "正在打包 GLB…" : "↓ 下载单品 GLB";
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(".pl-view-buttons button")) button.disabled = !this.ready || this.contextLost;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-product-id], [data-category], #pl-clear-filters")) button.disabled = this.exporting;
    this.element<HTMLInputElement>("#pl-search").disabled = this.exporting;
  }

  private previewFailure(error: unknown): void {
    if (this.disposed) return;
    this.ready = false;
    this.setModelState("error", "预览暂不可用");
    this.element("#pl-preview-error").hidden = false;
    this.element("#pl-preview-error-text").textContent = error instanceof Error ? error.message : "图形加载出现问题，请重新加载。";
    this.syncControls();
  }

  private notice(message: string): void {
    if (!this.disposed) this.element("#pl-notice").textContent = message;
  }

  private async copyText(value: string, success: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (this.disposed) return;
      this.element("#pl-copy-fallback").hidden = true;
      this.notice(success);
    } catch {
      if (this.disposed) return;
      this.element("#pl-copy-fallback").hidden = false;
      const field = this.element<HTMLTextAreaElement>("#pl-copy-text");
      field.value = value;
      field.focus();
      field.select();
      this.notice("自动复制未完成；下方文本已选中，可手动复制。");
    }
  }

  private download(blob: Blob, name: string): void {
    if (this.disposed) return;
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.hidden = true;
    this.root.append(anchor);
    anchor.click();
    anchor.remove();
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      this.urls.delete(url);
      this.timers.delete(timer);
    }, 30_000);
    this.timers.add(timer);
  }

  private async exportGlb(): Promise<void> {
    if (!this.ready || !this.model || !this.scene || this.exporting || this.contextLost) return;
    const model = this.model;
    const scene = this.scene;
    const id = this.selected;
    this.exporting = true;
    this.syncControls();
    this.notice("正在将当前商品的几何与材质打包为 GLB，请稍候。");
    try {
      const { GLTF2Export } = await import("@babylonjs/serializers/glTF/2.0");
      if (this.disposed || this.contextLost) return;
      const filename = `corner-shop-${id}`;
      const result = await GLTF2Export.GLBAsync(scene, filename, {
        shouldExportNode: (node) => node === model || node.isDescendantOf(model),
        shouldExportAnimation: () => false,
        removeNoopRootNodes: false,
        metadataSelector: (metadata: unknown) => metadata,
      });
      if (this.disposed || this.contextLost) return;
      const file = result.files[`${filename}.glb`];
      if (!(file instanceof Blob)) throw new Error("导出器未返回有效的 GLB 文件。");
      this.download(file, `${filename}.glb`);
      this.notice(`${PRODUCT_ASSETS[id].nameZh} GLB 已下载，仅包含所选商品，不含展台或灯光。`);
    } catch (error) {
      this.notice(`GLB 下载未完成：${error instanceof Error ? error.message : "请重新尝试"}。也可以先复制调用代码。`);
    } finally {
      this.exporting = false;
      this.syncControls();
      // Context restoration may have happened while the asynchronous exporter
      // still owned this root. Rebuild only after it has relinquished the model.
      if (!this.disposed && !this.contextLost && !this.ready) void this.selectProduct(this.selected);
    }
  }
}
