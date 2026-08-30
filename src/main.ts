import { App } from "./App";
import "./styles.css";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("App root not found");
}

const app = new App(root);
void app.init();
