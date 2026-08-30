export {};

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("App root not found");
}

// Keep the earlier 2D prototype and its independent save available for comparison.
if (new URLSearchParams(location.search).get("legacy") === "1") {
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
