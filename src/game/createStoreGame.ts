import Phaser from "phaser";
import {
  StoreScene,
  type StoreCustomerView,
  type StoreProductView,
  type StoreShelfId,
  type StoreWorldCallbacks,
} from "./StoreScene";

export type {
  StoreCustomerView,
  StoreGridPoint,
  StoreInteraction,
  StoreProductView,
  StoreShelfId,
  StoreWorldCallbacks,
} from "./StoreScene";

export interface StoreGameController {
  spawnCustomer(customer: StoreCustomerView): void;
  setActiveShelf(shelfId: StoreShelfId | null): void;
  setCarriedProduct(product: StoreProductView | null): void;
  setCustomerInteraction(customerId: string, enabled: boolean): void;
  completeCustomer(customerId: string, successful?: boolean): void;
  showUpgrade(label?: string): void;
  setInteractionEnabled(enabled: boolean): void;
  destroy(): void;
}

function resolveParent(parent: HTMLElement | string): HTMLElement {
  if (typeof parent !== "string") {
    return parent;
  }

  const element = document.getElementById(parent);
  if (element === null) {
    throw new Error(`Cannot create the store game: no element has the id "${parent}".`);
  }

  return element;
}

export function createStoreGame(
  parent: HTMLElement | string,
  callbacks: StoreWorldCallbacks = {},
): StoreGameController {
  const parentElement = resolveParent(parent);
  const scene = new StoreScene(callbacks);
  const width = Math.max(parentElement.clientWidth, 640);
  const height = Math.max(parentElement.clientHeight, 460);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: parentElement,
    width,
    height,
    backgroundColor: "#d8e2d5",
    antialias: true,
    transparent: false,
    scene: [scene],
    scale: {
      parent: parentElement,
      mode: Phaser.Scale.RESIZE,
      width,
      height,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      roundPixels: false,
      antialiasGL: true,
    },
  });

  let destroyed = false;
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry === undefined || destroyed || !game.isBooted) {
            return;
          }

          const nextWidth = Math.max(Math.round(entry.contentRect.width), 1);
          const nextHeight = Math.max(Math.round(entry.contentRect.height), 1);
          game.scale.resize(nextWidth, nextHeight);
        });
  resizeObserver?.observe(parentElement);

  return {
    spawnCustomer: (customer) => scene.spawnCustomer(customer),
    setActiveShelf: (shelfId) => scene.setActiveShelf(shelfId),
    setCarriedProduct: (product) => scene.setCarriedProduct(product),
    setCustomerInteraction: (customerId, enabled) =>
      scene.setCustomerInteraction(customerId, enabled),
    completeCustomer: (customerId, successful = true) =>
      scene.completeCustomer(customerId, successful),
    showUpgrade: (label) => scene.showUpgrade(label),
    setInteractionEnabled: (enabled) => scene.setInteractionEnabled(enabled),
    destroy: () => {
      if (destroyed) {
        return;
      }

      destroyed = true;
      resizeObserver?.disconnect();
      game.destroy(true);
    },
  };
}
