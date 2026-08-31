export {};

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("App root not found");
}

const query = new URLSearchParams(location.search);

// The asset library deliberately mounts without either game's save/session owner.
if (query.get("assets") === "1") {
  const { AssetLibraryApp } = await import("./sim3d/product-library/AssetLibraryApp");
  const app = new AssetLibraryApp(root);
  void app.init();
  if (import.meta.hot) import.meta.hot.dispose(() => app.dispose());
// Keep the earlier 2D prototype and its independent save available for comparison.
} else if (query.get("legacy") === "1") {
  void import("./styles.css");
  const { App } = await import("./App");
  const app = new App(root);
  void app.init();
} else {
  void import("./sim3d/styles.css");
  const { App3D } = await import("./sim3d/App3D");
  const app = new App3D(root);
  void app.init();
}
