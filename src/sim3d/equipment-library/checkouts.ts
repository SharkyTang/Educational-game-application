import { Color3, MeshBuilder, TransformNode, type Scene } from "@babylonjs/core";
import { box, cylinder, equipmentMaterials, equipmentSign, finish, labelPlane, litSurface, printedMaterial, tube, type EquipmentBuilder } from "./geometry";

function screen(scene: Scene, root: TransformNode, wide: boolean): void {
  const mat = equipmentMaterials(scene);
  const centreX = wide ? -0.45 : -0.16;
  const centreY = wide ? 1.40 : 1.33;
  const mount = new TransformNode(`${root.name}-screen-mount`, scene);
  mount.parent = root; mount.position.set(centreX, centreY, 0.16); mount.rotation.x = 0.19;
  box(scene, mount, "screen-bezel", [0.56, 0.39, 0.065], [0, 0, 0], mat.dark);
  box(scene, mount, "screen-rear", [0.49, 0.33, 0.025], [0, 0, 0.044], mat.green);
  const display = printedMaterial(scene, `equipment-self-checkout-screen-${wide}`, 768, 512, (ctx) => {
    ctx.fillStyle = "#edf0e6"; ctx.fillRect(0, 0, 768, 512);
    ctx.fillStyle = "#294b3f"; ctx.fillRect(0, 0, 768, 84);
    ctx.fillStyle = "#f2ebd8"; ctx.font = "bold 30px Georgia, serif"; ctx.fillText("Corner Shop", 32, 53);
    ctx.font = "17px Arial, sans-serif"; ctx.fillText("SELF-CHECKOUT", 540, 50);
    ctx.fillStyle = "#294b3f"; ctx.font = "bold 39px Arial, sans-serif"; ctx.fillText("Hello, neighbour.", 36, 151);
    ctx.fillStyle = "#6d7d6a"; ctx.font = "23px Arial, sans-serif"; ctx.fillText("Ready when you are.", 37, 194);
    for (let i = 0; i < 3; i++) {
      const x = 45 + i * 244;
      ctx.strokeStyle = "#b1bca4"; ctx.lineWidth = 2; ctx.strokeRect(x, 236, 210, 100);
      ctx.fillStyle = "#365745"; ctx.font = "bold 30px Arial, sans-serif"; ctx.fillText(String(i + 1).padStart(2, "0"), x + 15, 278);
      ctx.font = "21px Arial, sans-serif"; ctx.fillText(["Scan items", "Pack your bag", "Choose payment"][i]!, x + 15, 312, 184);
    }
    ctx.fillStyle = "#365745"; ctx.fillRect(40, 375, 688, 89);
    ctx.fillStyle = "#f8f0de"; ctx.textAlign = "center"; ctx.font = "bold 31px Arial, sans-serif"; ctx.fillText("TOUCH TO START", 384, 431);
    ctx.font = "13px Arial, sans-serif"; ctx.fillStyle = "#738067"; ctx.fillText("Please ask a colleague if you need help.", 384, 494);
  });
  display.emissiveColor = new Color3(0.10, 0.11, 0.09);
  labelPlane(scene, mount, "touchscreen", 0.508, 0.339, [0, 0.01, -0.0345], display);
  cylinder(scene, root, "monitor-post", 0.075, 0.058, centreY - 0.89, [centreX, (centreY + 0.89) / 2, 0.21], mat.steel, 24);
  cylinder(scene, root, "monitor-base", 0.20, 0.16, 0.018, [centreX, 0.88, 0.21], mat.dark, 32);
}

function paymentTerminal(scene: Scene, root: TransformNode, wide: boolean): void {
  const mat = equipmentMaterials(scene);
  const mount = new TransformNode(`${root.name}-payment-terminal`, scene);
  mount.parent = root; mount.position.set(wide ? -0.67 : -0.39, 1.005, -0.27); mount.rotation.x = 0.50;
  cylinder(scene, root, "terminal-pole", 0.024, 0.024, 0.13, [wide ? -0.67 : -0.39, 0.94, -0.22], mat.steel, 16);
  box(scene, mount, "terminal-case", [0.137, 0.218, 0.038], [0, 0, 0], mat.dark);
  const display = printedMaterial(scene, "equipment-card-terminal-screen", 256, 192, (ctx) => {
    ctx.fillStyle = "#b8cbb7"; ctx.fillRect(0, 0, 256, 192);
    ctx.fillStyle = "#2c4c41"; ctx.textAlign = "center"; ctx.font = "bold 28px Arial, sans-serif";
    ctx.fillText("PAY HERE", 128, 58); ctx.font = "22px Arial, sans-serif"; ctx.fillText("Tap or insert", 128, 106);
    ctx.lineWidth = 6; ctx.strokeStyle = "#496b59";
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(118, 147, 9 + i * 11, -1.15, 1.15); ctx.stroke(); }
  });
  labelPlane(scene, mount, "terminal-screen", 0.109, 0.071, [0, 0.05, -0.0195], display);
  for (let row = 0; row < 4; row++) for (let column = 0; column < 3; column++) {
    const material = row === 3 ? litSurface(scene, `key-${column}`, ["#b56853", "#c5ad62", "#648d67"][column]!, 0.04) : mat.steel;
    box(scene, mount, `key-${row}-${column}`, [0.023, 0.017, 0.005], [(column - 1) * 0.032, -0.008 - row * 0.022, -0.022], material);
  }
  box(scene, mount, "card-insert-slot", [0.086, 0.005, 0.009], [0, -0.105, -0.019], mat.rubber);
}

function checkout(scene: Scene, root: TransformNode, wide: boolean): void {
  const mat = equipmentMaterials(scene);
  const width = wide ? 1.64 : 1.04;
  const depth = wide ? 0.96 : 0.82;
  const centreX = wide ? -0.46 : -0.17;
  const top = wide ? 0.86 : 0.87;
  box(scene, root, "floor-plinth", [width, 0.055, depth], [0, 0.0275, 0], mat.rubber);
  box(scene, root, "plinth-cover", [width - 0.03, 0.045, depth - 0.025], [0, 0.0775, 0], mat.steel);
  box(scene, root, "scan-cabinet", [0.57, top - 0.18, depth - 0.21], [centreX, (top - 0.18) / 2 + 0.10, 0], wide ? mat.green : mat.sage);
  box(scene, root, "front-service-panel", [0.49, 0.51, 0.022], [centreX, 0.425, -(depth - 0.21) / 2 - 0.006], mat.cream);
  for (const side of [-1, 1]) {
    box(scene, root, `service-panel-trim-${side}`, [0.012, 0.51, 0.008], [centreX + side * 0.234, 0.425, -(depth - 0.21) / 2 - 0.020], mat.steel);
  }
  box(scene, root, "worktop", [width - 0.045, 0.08, depth - 0.10], [0, top - 0.04, 0], mat.cream);
  box(scene, root, "worktop-front-bumper", [width - 0.065, 0.032, 0.018], [0, top - 0.045, -(depth - 0.10) / 2 - 0.009], mat.steel);
  const bagX = wide ? 0.43 : 0.32;
  const bagWidth = wide ? 0.66 : 0.31;
  // The worktop top is the exact base of all bagging envelopes in catalog.ts.
  box(scene, root, "bagging-front-leg", [0.045, top - 0.18, 0.045], [wide ? 0.75 : 0.46, (top - 0.18) / 2 + 0.10, -0.25], mat.steel);
  box(scene, root, "bagging-rear-leg", [0.045, top - 0.18, 0.045], [wide ? 0.75 : 0.46, (top - 0.18) / 2 + 0.10, 0.25], mat.steel);
  for (const z of [-0.30, 0.30]) {
    tube(scene, root, `bagging-guard-${z}`, [[bagX - bagWidth / 2 - 0.016, top, z], [bagX - bagWidth / 2 - 0.016, top + 0.06, z], [bagX + bagWidth / 2 + 0.016, top + 0.06, z], [bagX + bagWidth / 2 + 0.016, top, z]], 0.008, mat.steel, 8);
  }
  if (wide) {
    for (const x of [0.09, 0.77]) tube(scene, root, `bag-hanger-${x}`, [[x, top, 0.31], [x, top + 0.21, 0.31], [x, top + 0.21, 0.20]], 0.008, mat.steel, 8);
    box(scene, root, "bagging-pedestal", [0.65, 0.12, 0.63], [bagX, 0.18, 0], mat.green);
  }
  equipmentSign(scene, root, "bagging-sign", bagWidth, 0.04, [bagX, top - 0.045, -(depth - 0.10) / 2 - 0.020], wide ? "BAGGING AREA" : "ITEMS HERE");
  const glass = litSurface(scene, "scanner-glass", "#243e39", 0.08);
  box(scene, root, "scanner-rim", [0.33, 0.018, 0.26], [centreX + 0.055, top + 0.009, -0.075], mat.steel);
  box(scene, root, "scanner-window", [0.284, 0.008, 0.218], [centreX + 0.055, top + 0.020, -0.075], glass);
  box(scene, root, "scanner-red-beam", [0.242, 0.0015, 0.004], [centreX + 0.055, top + 0.0248, -0.075], litSurface(scene, "scanner-line", "#c55642", 0.5));
  box(scene, root, "receipt-mouth", [0.19, 0.028, 0.008], [centreX, 0.65, -(depth - 0.21) / 2 - 0.021], mat.dark);
  const receipt = printedMaterial(scene, "equipment-receipt", 256, 256, (ctx) => {
    ctx.fillStyle = "#f5f2e8"; ctx.fillRect(0, 0, 256, 256); ctx.fillStyle = "#526056"; ctx.textAlign = "center";
    ctx.font = "bold 21px Georgia, serif"; ctx.fillText("CORNER SHOP", 128, 39);
    ctx.font = "18px Arial, sans-serif"; ctx.fillText("Thank you!", 128, 77);
    for (let i = 0; i < 7; i++) ctx.fillRect(28, 113 + i * 13, 110 + (i % 3) * 23, 3);
  });
  labelPlane(scene, root, "receipt-paper", 0.12, 0.115, [centreX, 0.585, -(depth - 0.21) / 2 - 0.027], receipt);
  equipmentSign(scene, root, "front-brand", 0.32, 0.10, [centreX, 0.35, -(depth - 0.21) / 2 - 0.020], "SELF CHECKOUT", "CORNER SHOP", [0, 0, 0], true);
  for (let i = 0; i < 9; i++) box(scene, root, `cabinet-vent-${i}`, [0.265, 0.008, 0.004], [centreX, 0.165 + i * 0.012, -(depth - 0.21) / 2 - 0.021], mat.dark);
  screen(scene, root, wide); paymentTerminal(scene, root, wide);
  const indicatorX = wide ? -0.76 : -0.45;
  const height = wide ? 1.73 : 1.63;
  cylinder(scene, root, "assistance-light-post", 0.021, 0.021, height - 0.93, [indicatorX, (height + 0.77) / 2, 0.29], mat.steel, 16);
  cylinder(scene, root, "assistance-light", 0.058, 0.058, 0.08, [indicatorX, height - 0.04, 0.29], litSurface(scene, "ready-beacon", "#90b792", 0.34), 24);
  finish(MeshBuilder.CreateTorus(`${root.name}-beacon-ring`, { diameter: 0.055, thickness: 0.008, tessellation: 20 }, scene), root, mat.dark, [indicatorX, height - 0.081, 0.29]);
}

export const CHECKOUT_BUILDERS: Record<"self-checkout-compact" | "self-checkout-bagging", EquipmentBuilder> = {
  "self-checkout-compact": (scene, root) => checkout(scene, root, false),
  "self-checkout-bagging": (scene, root) => checkout(scene, root, true),
};
