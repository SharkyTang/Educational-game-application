import { openSettings } from "./helpers/sim3d-computer";
import { receiveFixtureDeliveries } from "./helpers/sim3d-delivery";
import { expect, test, type Page } from "@playwright/test";
import { createFirstDayState, reduceSim, validateSimState, type SimCommand, type SimState } from "../../src/sim3d/domain";

interface ObservedSource {
  node: AudioBufferSourceNode;
  gain: GainNode | null;
  started: boolean;
  stopped: boolean;
  offset: number;
}
interface NativeAudioProbe { sources: ObservedSource[]; oscillatorStarts: number }
type ProbedWindow = Window & typeof globalThis & { __nativeAudioProbe: NativeAudioProbe };

/** Test-side observation only: the real music bytes, decoding, nodes and playback are untouched. */
async function observeNativeAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: NativeAudioProbe = { sources: [], oscillatorStarts: 0 };
    (window as ProbedWindow).__nativeAudioProbe = probe;
    const createSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const node = createSource.call(this);
      const observed: ObservedSource = { node, gain: null, started: false, stopped: false, offset: 0 };
      probe.sources.push(observed);
      const connect = node.connect;
      node.connect = function (...args: unknown[]) {
        if (args[0] instanceof GainNode) observed.gain = args[0];
        return Reflect.apply(connect, node, args);
      } as typeof node.connect;
      const start = node.start;
      node.start = (...args) => {
        start.apply(node, args);
        observed.started = true;
        observed.offset = args[1] ?? 0;
      };
      const stop = node.stop;
      node.stop = (...args) => { stop.apply(node, args); observed.stopped = true };
      node.addEventListener("ended", () => { observed.stopped = true });
      return node;
    };
    const createOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const node = createOscillator.call(this);
      const start = node.start;
      node.start = (...args) => { start.apply(node, args); probe.oscillatorStarts += 1 };
      return node;
    };
  });
}

async function musicState(page: Page) {
  return page.evaluate(() => {
    const probe = (window as ProbedWindow).__nativeAudioProbe;
    const music = probe.sources.filter((source) => source.started && source.node.loop && (source.node.buffer?.duration ?? 0) > 30);
    const latest = music.at(-1);
    return {
      sources: music.length,
      liveSources: music.filter((source) => !source.stopped && source.node.context.state === "running").length,
      oscillatorStarts: probe.oscillatorStarts,
      latest: latest ? {
        loop: latest.node.loop,
        stopped: latest.stopped,
        state: latest.node.context.state,
        duration: latest.node.buffer!.duration,
        offset: latest.offset,
        gain: latest.gain?.gain.value ?? 0,
      } : null,
    };
  });
}

function runtimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/sim3d/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

async function start(page: Page): Promise<void> {
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  await page.locator("#s3-start-button").click();
  await expect(page.locator("#s3-start")).toBeHidden();
}

async function soundSettings(page: Page): Promise<void> {
  await openSettings(page);
  await expect(page.locator("#s3-pause")).toBeVisible();
  if (!(await page.locator("#s3-music-volume").isVisible())) await page.getByText("声音与音乐", { exact: true }).click();
}

function step(state: SimState, command: SimCommand): SimState {
  const result = reduceSim(state, command);
  if (!result.changed || !validateSimState(result.state)) throw new Error(`${command.type}: ${result.message ?? "invalid audio fixture"}`);
  return result.state;
}

function approachingCheckout(): SimState {
  let state = step(createFirstDayState(), { type: "PURCHASE_STOCK", orderId: "audio-one-sale", lines: [{ productId: "milk", quantity: 1 }, { productId: "bread", quantity: 1 }] });
  state = receiveFixtureDeliveries(state);
  for (const productId of ["milk", "bread"] as const) {
    const item = state.items.find((entry) => entry.productId === productId)!;
    state = step(state, { type: "TAKE_ITEM", itemId: item.id });
    state = step(state, { type: "STOCK", productId, slot: 0 });
  }
  state = step(state, { type: "OPEN_STORE" });
  state = step(state, { type: "CUSTOMER_ADVANCE" });
  state = step(state, { type: "CUSTOMER_ADVANCE" });
  return step(state, { type: "SAVE_POSE", pose: { x: -2.62, z: -1.06, yaw: Math.PI, pitch: .56 } });
}

async function importSnapshot(page: Page, state: SimState): Promise<void> {
  expect(validateSimState(state)).toBe(true);
  await openSettings(page);
  await expect(page.locator("#s3-pause")).toBeVisible();
  await page.getByText("存档与试玩管理", { exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#s3-import").click();
  await (await chooser).setFiles({ name: "audio-gameplay-fixture.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(state)) });
  await expect(page.locator("#s3-import-confirm")).toBeVisible();
  await page.locator("#s3-import-confirm-button").click();
  await start(page);
}

test("shop music: real Local Forecast starts only after Start, loops, pauses and resumes from the saved musical position", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = runtimeErrors(page);
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/audio/local-forecast.mp3")) requests.push(request.url()) });
  await observeNativeAudio(page);
  await page.goto("/");
  await expect(page.locator("#s3-start-button")).toBeEnabled({ timeout: 45_000 });
  expect((await musicState(page)).sources).toBe(0);
  expect(requests).toEqual([]);
  await start(page);
  await expect.poll(async () => (await musicState(page)).liveSources, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await musicState(page)).latest?.gain ?? 0).toBeGreaterThan(.15);
  const playing = await musicState(page);
  expect(playing.latest).toMatchObject({ loop: true, stopped: false, state: "running", offset: 0 });
  expect(playing.latest!.duration).toBeGreaterThan(30);
  expect(await page.evaluate(() => {
    const music = (window as ProbedWindow).__nativeAudioProbe.sources.find((source) => source.started && source.node.loop)!;
    const buffer = music.node.buffer!;
    return buffer.getChannelData(0).subarray(0, buffer.sampleRate * 2).some((sample) => Math.abs(sample) > .001);
  })).toBe(true);
  await soundSettings(page);
  await expect(page.locator("#s3-music-status")).toContainText("已暂停");
  await expect.poll(async () => (await musicState(page)).latest?.state).toBe("suspended");
  expect((await musicState(page)).liveSources).toBe(0);
  expect((await musicState(page)).latest?.stopped).toBe(true);
  await page.locator("#s3-resume").click();
  await expect.poll(async () => (await musicState(page)).liveSources).toBe(1);
  const resumed = await musicState(page);
  expect(resumed.sources).toBe(2);
  expect(resumed.latest?.offset).toBeGreaterThan(0);
  expect(resumed.latest?.loop).toBe(true);
  expect(requests).toHaveLength(1); // Decoded music is reused; continuing does not fetch or overlap another song.
  expect(errors).toEqual([]);
});

test("shop music: independent volume controls and the off switch persist through a real reload", async ({ page }) => {
  test.setTimeout(100_000);
  const errors = runtimeErrors(page);
  await observeNativeAudio(page);
  await page.goto("/");
  await start(page);
  await expect.poll(async () => (await musicState(page)).liveSources, { timeout: 20_000 }).toBe(1);
  await soundSettings(page);
  await expect(page.locator("#s3-music-enabled")).toBeChecked();
  await expect(page.locator("#s3-music-volume")).toHaveValue("0.22");
  await expect(page.locator("#s3-effects-volume")).toHaveValue("0.5");
  await page.locator("#s3-music-volume").press("ArrowRight");
  await page.locator("#s3-effects-volume").press("ArrowLeft");
  await expect(page.locator("#s3-music-volume-value")).toHaveText("23%");
  await expect(page.locator("#s3-effects-volume-value")).toHaveText("45%");
  await expect(page.locator("#s3-volume")).toHaveValue("0.7");
  await page.locator("#s3-auto-speech").uncheck();
  await page.locator("#s3-music-enabled").uncheck();
  await expect(page.locator("#s3-music-status")).toContainText("已关闭");
  await page.locator("#s3-resume").click();
  expect((await musicState(page)).liveSources).toBe(0);
  await page.reload();
  await start(page);
  expect((await musicState(page)).sources).toBe(0);
  await soundSettings(page);
  await expect(page.locator("#s3-music-enabled")).not.toBeChecked();
  await expect(page.locator("#s3-music-volume")).toHaveValue("0.23");
  await expect(page.locator("#s3-effects-volume")).toHaveValue("0.45");
  await expect(page.locator("#s3-volume")).toHaveValue("0.7");
  await expect(page.locator("#s3-auto-speech")).not.toBeChecked();
  await page.locator("#s3-music-enabled").check();
  expect((await musicState(page)).liveSources).toBe(0); // Toggling within the paused panel must not start playback.
  await page.locator("#s3-resume").click();
  await expect.poll(async () => (await musicState(page)).liveSources, { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await musicState(page)).latest?.gain ?? 0).toBeGreaterThan(.2);
  expect(errors).toEqual([]);
});

test("shop sounds: recorded customer speech ducks and restores real music, scans and payment sound once", async ({ page }) => {
  test.setTimeout(110_000);
  const errors = runtimeErrors(page);
  await observeNativeAudio(page);
  await page.goto("/");
  await start(page);
  await importSnapshot(page, approachingCheckout());
  await expect(page.locator("#s3-receipt-title")).toHaveText("顾客想结账", { timeout: 25_000 });
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });
  expect((await musicState(page)).oscillatorStarts).toBe(0); // Restoring a save does not replay its doorbell or stocking history.
  await expect.poll(async () => (await musicState(page)).latest?.gain ?? 0).toBeGreaterThan(.15);
  await page.keyboard.press("r");
  await expect(page.locator("#s3-customer-audio-status")).toContainText("正在播放", { timeout: 5_000 });
  await expect.poll(async () => (await musicState(page)).latest?.gain ?? 1).toBeLessThan(.08);
  expect((await musicState(page)).liveSources).toBe(1);
  await expect(page.locator("#s3-customer-audio-status")).toContainText("播放结束", { timeout: 12_000 });
  await expect.poll(async () => (await musicState(page)).latest?.gain ?? 0).toBeGreaterThan(.15);
  expect((await musicState(page)).oscillatorStarts).toBe(0);
  await expect(page.locator("#s3-target-label")).toContainText("收银台");
  await page.keyboard.press("e");
  await expect(page.locator("#s3-scan-milk")).toHaveText("已扫描");
  expect((await musicState(page)).oscillatorStarts).toBe(1);
  await page.keyboard.press("e");
  await expect(page.locator("#s3-scan-bread")).toHaveText("已扫描");
  expect((await musicState(page)).oscillatorStarts).toBe(2);
  await page.keyboard.press("e");
  await expect(page.locator("#s3-receipt-title")).toHaveText("本单已收款");
  await expect(page.locator("#s3-cash")).toHaveText("£13.70");
  expect((await musicState(page)).oscillatorStarts).toBe(5); // Two one-tone scans plus the three-tone payment confirmation.
  await page.keyboard.press("e");
  expect((await musicState(page)).oscillatorStarts).toBe(5);
  await expect(page.locator("#s3-cash")).toHaveText("£13.70");
  expect(errors).toEqual([]);
});
