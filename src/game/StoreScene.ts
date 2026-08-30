import Phaser from "phaser";

export const STORE_SCENE_KEY = "StoreScene";

export type StoreShelfId = "chiller" | "pantry" | "snacks";

export interface StoreGridPoint {
  gridX: number;
  gridY: number;
}

export interface StoreCustomerView {
  id: string;
  name: string;
  avatarColour?: number;
}

export interface StoreProductView {
  id: string;
  nameEn?: string;
  colour?: number;
}

export type StoreInteraction =
  | { kind: "shelf"; shelfId: StoreShelfId }
  | { kind: "counter" }
  | { kind: "customer"; customerId: string };

export interface StoreWorldCallbacks {
  onInteraction?: (interaction: StoreInteraction) => void;
  onGroundClick?: (destination: StoreGridPoint) => void;
  onPlayerArrived?: (destination: StoreGridPoint) => void;
}

interface GridPoint {
  x: number;
  y: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface BlockedRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface ShelfVisual {
  container: Phaser.GameObjects.Container;
  highlight: Phaser.GameObjects.Graphics;
  hitZone: Phaser.GameObjects.Zone;
}

interface CustomerVisual {
  container: Phaser.GameObjects.Container;
  hitZone: Phaser.GameObjects.Zone;
}

interface IsoBounds extends BlockedRect {
  width: number;
  depth: number;
}

interface PathNode {
  x: number;
  y: number;
  g: number;
  f: number;
  parentKey: string | null;
}

const DESIGN_WIDTH = 1120;
const DESIGN_HEIGHT = 720;
const STORE_COLUMNS = 10;
const STORE_ROWS = 8;
const TILE_WIDTH = 82;
const TILE_HEIGHT = 42;
const HALF_TILE_WIDTH = TILE_WIDTH / 2;
const HALF_TILE_HEIGHT = TILE_HEIGHT / 2;
const STORE_ORIGIN_X = DESIGN_WIDTH / 2;
const STORE_ORIGIN_Y = 154;
const NAV_STEP = 0.5;
const PLAYER_SPEED = 178;
const CHARACTER_DEPTH_BASE = 2_000;

const PALETTE = {
  navy: 0x1f3342,
  navyLight: 0x315165,
  cream: 0xf4eddd,
  creamDark: 0xd9cdb8,
  warmWhite: 0xfffbf2,
  sage: 0x7f957d,
  sageDark: 0x526b59,
  teal: 0x547d7b,
  mustard: 0xd8a739,
  mustardLight: 0xf1ce74,
  terracotta: 0xb8674e,
  brick: 0x934b3f,
  wood: 0xa87345,
  woodDark: 0x704a31,
  glass: 0x9fc8cd,
  floorA: 0xe9ddc8,
  floorB: 0xddd4c3,
  ink: 0x202b31,
  leaf: 0x5f805a,
  leafLight: 0x88a46f,
} as const;

const SHELF_BOUNDS: Record<StoreShelfId, IsoBounds> = {
  chiller: {
    minX: 0.7,
    maxX: 2.9,
    minY: 0.55,
    maxY: 1.45,
    width: 2.2,
    depth: 0.9,
  },
  pantry: {
    minX: 2.85,
    maxX: 4.2,
    minY: 2.15,
    maxY: 5.15,
    width: 1.35,
    depth: 3,
  },
  snacks: {
    minX: 5.05,
    maxX: 6.4,
    minY: 1.75,
    maxY: 4.55,
    width: 1.35,
    depth: 2.8,
  },
};

const COUNTER_BOUNDS: IsoBounds = {
  minX: 6.95,
  maxX: 9.25,
  minY: 4.65,
  maxY: 5.9,
  width: 2.3,
  depth: 1.25,
};

const PLANT_BOUNDS: BlockedRect = {
  minX: 0.35,
  maxX: 1.35,
  minY: 6.25,
  maxY: 7.45,
};

const BLOCKED_RECTS: BlockedRect[] = [
  ...Object.values(SHELF_BOUNDS),
  COUNTER_BOUNDS,
  PLANT_BOUNDS,
];

const CUSTOMER_QUEUE: GridPoint[] = [
  { x: 9.05, y: 6.45 },
  { x: 8.15, y: 7.05 },
  { x: 7.05, y: 7.25 },
  { x: 5.95, y: 7.2 },
];

const CUSTOMER_DOOR: GridPoint = { x: 9.35, y: 0.85 };

function project(gridX: number, gridY: number): ScreenPoint {
  return {
    x: STORE_ORIGIN_X + (gridX - gridY) * HALF_TILE_WIDTH,
    y: STORE_ORIGIN_Y + (gridX + gridY) * HALF_TILE_HEIGHT,
  };
}

function unproject(screenX: number, screenY: number): GridPoint {
  const difference = (screenX - STORE_ORIGIN_X) / HALF_TILE_WIDTH;
  const sum = (screenY - STORE_ORIGIN_Y) / HALF_TILE_HEIGHT;

  return {
    x: (difference + sum) / 2,
    y: (sum - difference) / 2,
  };
}

function vector(point: ScreenPoint): Phaser.Math.Vector2 {
  return new Phaser.Math.Vector2(point.x, point.y);
}

function fillPolygon(
  graphics: Phaser.GameObjects.Graphics,
  colour: number,
  points: ScreenPoint[],
  alpha = 1,
): void {
  graphics.fillStyle(colour, alpha);
  graphics.fillPoints(points.map(vector), true, true);
}

function strokePolygon(
  graphics: Phaser.GameObjects.Graphics,
  colour: number,
  width: number,
  points: ScreenPoint[],
  alpha = 1,
): void {
  graphics.lineStyle(width, colour, alpha);
  graphics.strokePoints(points.map(vector), true, true);
}

function localIsoCorners(width: number, depth: number): ScreenPoint[] {
  return [
    { x: 0, y: 0 },
    { x: width * HALF_TILE_WIDTH, y: width * HALF_TILE_HEIGHT },
    {
      x: (width - depth) * HALF_TILE_WIDTH,
      y: (width + depth) * HALF_TILE_HEIGHT,
    },
    { x: -depth * HALF_TILE_WIDTH, y: depth * HALF_TILE_HEIGHT },
  ];
}

function drawIsoCuboid(
  graphics: Phaser.GameObjects.Graphics,
  width: number,
  depth: number,
  height: number,
  topColour: number,
  rightColour: number,
  leftColour: number,
): void {
  const [back, right, front, left] = localIsoCorners(width, depth);

  if (back === undefined || right === undefined || front === undefined || left === undefined) {
    return;
  }

  const raised = (point: ScreenPoint): ScreenPoint => ({
    x: point.x,
    y: point.y - height,
  });

  fillPolygon(graphics, leftColour, [left, front, raised(front), raised(left)]);
  fillPolygon(graphics, rightColour, [right, front, raised(front), raised(right)]);
  fillPolygon(graphics, topColour, [
    raised(back),
    raised(right),
    raised(front),
    raised(left),
  ]);

  graphics.lineStyle(1.5, PALETTE.woodDark, 0.38);
  graphics.strokePoints(
    [raised(back), raised(right), raised(front), raised(left)].map(vector),
    true,
    true,
  );
}

function pointInsideRect(point: GridPoint, rect: BlockedRect, padding = 0): boolean {
  return (
    point.x >= rect.minX - padding &&
    point.x <= rect.maxX + padding &&
    point.y >= rect.minY - padding &&
    point.y <= rect.maxY + padding
  );
}

function nodeKey(x: number, y: number): string {
  return `${x},${y}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export class StoreScene extends Phaser.Scene {
  private readonly callbacks: Readonly<StoreWorldCallbacks>;
  private readonly shelves = new Map<StoreShelfId, ShelfVisual>();
  private readonly customers = new Map<string, CustomerVisual>();
  private readonly queuedCustomers = new Map<string, StoreCustomerView>();
  private readonly interactiveObjects: Phaser.GameObjects.GameObject[] = [];

  private isReady = false;
  private interactionEnabled = true;
  private activeShelfId: StoreShelfId | null = null;
  private pendingProduct: StoreProductView | null = null;
  private pendingUpgradeLabel: string | null = null;

  private floor!: Phaser.GameObjects.Graphics;
  private destinationMarker!: Phaser.GameObjects.Graphics;
  private player!: Phaser.GameObjects.Container;
  private carriedProductGraphics!: Phaser.GameObjects.Graphics;
  private carriedProductLabel!: Phaser.GameObjects.Text;
  private counterHighlight!: Phaser.GameObjects.Graphics;
  private upgradeTerminal!: Phaser.GameObjects.Container;
  private upgradeToast!: Phaser.GameObjects.Container;
  private upgradeToastLabel!: Phaser.GameObjects.Text;

  private playerGridPosition: GridPoint = { x: 5.8, y: 6.45 };
  private playerPath: GridPoint[] = [];

  constructor(callbacks: StoreWorldCallbacks = {}) {
    super({ key: STORE_SCENE_KEY });
    this.callbacks = callbacks;
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#d8e2d5");
    this.game.canvas.setAttribute(
      "aria-label",
      "A warm isometric British corner shop. Click the floor to move and click highlighted people or fixtures to interact.",
    );

    this.drawAmbientBackdrop();
    this.createFloor();
    this.drawWallsAndShopfront();
    this.createChiller();
    this.createAisleShelf("pantry", SHELF_BOUNDS.pantry, "PANTRY", [
      PALETTE.terracotta,
      PALETTE.mustard,
      PALETTE.sage,
    ]);
    this.createAisleShelf("snacks", SHELF_BOUNDS.snacks, "SNACKS", [
      PALETTE.mustard,
      PALETTE.teal,
      PALETTE.brick,
    ]);
    this.createCounter();
    this.createPlant();
    this.createPlayer();
    this.createUpgradeVisuals();

    this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    this.handleResize(this.scale.gameSize);

    this.isReady = true;
    this.applyActiveShelf();
    this.applyCarriedProduct();
    this.applyInteractionEnabled();

    for (const customer of this.queuedCustomers.values()) {
      this.createCustomer(customer);
    }
    this.queuedCustomers.clear();

    if (this.pendingUpgradeLabel !== null) {
      const label = this.pendingUpgradeLabel;
      this.pendingUpgradeLabel = null;
      this.showUpgrade(label);
    }
  }

  update(_time: number, delta: number): void {
    this.updatePlayerMovement(delta);
  }

  spawnCustomer(customer: StoreCustomerView): void {
    if (!this.isReady) {
      this.queuedCustomers.set(customer.id, customer);
      return;
    }

    if (this.customers.has(customer.id)) {
      return;
    }

    this.createCustomer(customer);
  }

  setActiveShelf(shelfId: StoreShelfId | null): void {
    this.activeShelfId = shelfId;

    if (this.isReady) {
      this.applyActiveShelf();
    }
  }

  setCarriedProduct(product: StoreProductView | null): void {
    this.pendingProduct = product;

    if (this.isReady) {
      this.applyCarriedProduct();
    }
  }

  setCustomerInteraction(customerId: string, enabled: boolean): void {
    const customer = this.customers.get(customerId);
    if (customer?.hitZone.input) {
      customer.hitZone.input.enabled = enabled && this.interactionEnabled;
    }
  }

  completeCustomer(customerId: string, successful = true): void {
    if (!this.isReady) {
      this.queuedCustomers.delete(customerId);
      return;
    }

    const customer = this.customers.get(customerId);
    if (customer === undefined) {
      return;
    }

    customer.hitZone.input && (customer.hitZone.input.enabled = false);
    this.tweens.killTweensOf(customer.container);

    const feedback = this.add
      .text(
        customer.container.x,
        customer.container.y - 102,
        successful ? "+ 谢谢!" : "See you",
        {
          fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
          fontSize: "14px",
          fontStyle: "bold",
          color: successful ? "#315b45" : "#5b4a43",
          backgroundColor: successful ? "#f4edc8" : "#f5eee5",
          padding: { x: 8, y: 5 },
        },
      )
      .setOrigin(0.5, 1)
      .setDepth(4_500);

    this.tweens.add({
      targets: feedback,
      y: feedback.y - 14,
      alpha: 0,
      duration: 700,
      ease: "Sine.easeOut",
      onComplete: () => feedback.destroy(),
    });

    this.time.delayedCall(300, () => {
      const route: GridPoint[] = [
        { x: 9.45, y: 6.45 },
        { x: 9.45, y: 3.4 },
        CUSTOMER_DOOR,
      ];
      this.moveCustomerAlongRoute(customer, route, () => {
        const interactiveIndex = this.interactiveObjects.indexOf(customer.hitZone);
        if (interactiveIndex >= 0) {
          this.interactiveObjects.splice(interactiveIndex, 1);
        }
        customer.hitZone.destroy();
        customer.container.destroy(true);
        this.customers.delete(customerId);
      });
    });
  }

  showUpgrade(label = "Self-checkout unlocked"): void {
    if (!this.isReady) {
      this.pendingUpgradeLabel = label;
      return;
    }

    this.upgradeTerminal.setVisible(true);
    this.upgradeToastLabel.setText(label);
    this.upgradeToast.setVisible(true).setAlpha(0).setScale(0.9);
    this.upgradeToast.y = 100;

    this.tweens.killTweensOf(this.upgradeToast);
    this.tweens.add({
      targets: this.upgradeToast,
      y: 78,
      alpha: 1,
      scaleX: 1,
      scaleY: 1,
      duration: 360,
      ease: "Back.easeOut",
    });

    this.tweens.add({
      targets: this.upgradeTerminal,
      scaleX: 1.08,
      scaleY: 1.08,
      yoyo: true,
      repeat: 2,
      duration: 220,
      ease: "Sine.easeInOut",
    });

    this.time.delayedCall(1_900, () => {
      if (!this.upgradeToast.active) {
        return;
      }

      this.tweens.add({
        targets: this.upgradeToast,
        y: 62,
        alpha: 0,
        duration: 320,
        ease: "Sine.easeIn",
        onComplete: () => this.upgradeToast.setVisible(false),
      });
    });
  }

  setInteractionEnabled(enabled: boolean): void {
    this.interactionEnabled = enabled;

    if (this.isReady) {
      this.applyInteractionEnabled();
    }
  }

  private drawAmbientBackdrop(): void {
    const graphics = this.add.graphics().setDepth(-50);

    graphics.fillStyle(0xcbd8c9, 1);
    graphics.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);

    graphics.fillStyle(0xb7c8b4, 0.72);
    graphics.fillEllipse(165, 590, 390, 170);
    graphics.fillEllipse(935, 602, 420, 180);

    graphics.fillStyle(PALETTE.warmWhite, 0.34);
    graphics.fillCircle(194, 108, 74);
    graphics.fillCircle(920, 132, 92);

    const shadow = project(5, 4);
    graphics.fillStyle(PALETTE.navy, 0.16);
    graphics.fillEllipse(shadow.x, shadow.y + 62, 760, 260);
  }

  private createFloor(): void {
    this.floor = this.add.graphics().setDepth(0).setName("store-floor");

    for (let x = 0; x < STORE_COLUMNS; x += 1) {
      for (let y = 0; y < STORE_ROWS; y += 1) {
        const corners = [
          project(x, y),
          project(x + 1, y),
          project(x + 1, y + 1),
          project(x, y + 1),
        ];
        const colour = (x + y) % 2 === 0 ? PALETTE.floorA : PALETTE.floorB;
        fillPolygon(this.floor, colour, corners);
        strokePolygon(this.floor, PALETTE.creamDark, 0.8, corners, 0.58);
      }
    }

    const floorPolygon = new Phaser.Geom.Polygon([
      project(0, 0),
      project(STORE_COLUMNS, 0),
      project(STORE_COLUMNS, STORE_ROWS),
      project(0, STORE_ROWS),
    ]);
    this.floor.setInteractive(floorPolygon, Phaser.Geom.Polygon.Contains);
    this.floor.input && (this.floor.input.cursor = "pointer");
    this.floor.on(
      Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN,
      (pointer: Phaser.Input.Pointer) => this.handleFloorClick(pointer),
    );
    this.interactiveObjects.push(this.floor);

    this.destinationMarker = this.add.graphics().setDepth(1_950).setVisible(false);
    const markerPoints = localIsoCorners(0.34, 0.34);
    fillPolygon(this.destinationMarker, PALETTE.mustardLight, markerPoints, 0.7);
    strokePolygon(this.destinationMarker, PALETTE.navy, 2, markerPoints, 0.75);
  }

  private drawWallsAndShopfront(): void {
    const walls = this.add.graphics().setDepth(10);
    const backCorner = project(0, 0);
    const rightCorner = project(STORE_COLUMNS, 0);
    const leftCorner = project(0, STORE_ROWS);
    const wallHeight = 126;

    fillPolygon(walls, PALETTE.cream, [
      backCorner,
      rightCorner,
      { x: rightCorner.x, y: rightCorner.y - wallHeight },
      { x: backCorner.x, y: backCorner.y - wallHeight },
    ]);
    fillPolygon(walls, 0xe5d8c3, [
      backCorner,
      leftCorner,
      { x: leftCorner.x, y: leftCorner.y - wallHeight },
      { x: backCorner.x, y: backCorner.y - wallHeight },
    ]);

    walls.lineStyle(5, PALETTE.sageDark, 0.8);
    walls.lineBetween(backCorner.x, backCorner.y, rightCorner.x, rightCorner.y);
    walls.lineBetween(backCorner.x, backCorner.y, leftCorner.x, leftCorner.y);

    this.drawWallWindow(walls, 1.25, 3.25, wallHeight);
    this.drawDoor(walls, 8.15, 9.45, wallHeight);

    const sign = this.add.graphics().setDepth(18);
    sign.fillStyle(PALETTE.navy, 1);
    sign.fillRoundedRect(STORE_ORIGIN_X - 122, 23, 244, 58, 10);
    sign.lineStyle(3, PALETTE.mustard, 1);
    sign.strokeRoundedRect(STORE_ORIGIN_X - 117, 28, 234, 48, 8);

    this.add
      .text(STORE_ORIGIN_X, 50, "CORNER & CO.", {
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: "22px",
        fontStyle: "bold",
        color: "#fff7df",
        letterSpacing: 2,
      })
      .setOrigin(0.5)
      .setDepth(19);

    this.add
      .text(STORE_ORIGIN_X, 87, "GROCERIES  ·  LOCAL  ·  OPEN", {
        fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
        fontSize: "10px",
        fontStyle: "bold",
        color: "#40584d",
        letterSpacing: 1.2,
      })
      .setOrigin(0.5)
      .setDepth(19);

    const pendant = this.add.graphics().setDepth(24);
    for (const x of [422, 702]) {
      pendant.lineStyle(2, PALETTE.navy, 0.48);
      pendant.lineBetween(x, 88, x, 135);
      pendant.fillStyle(PALETTE.mustard, 1);
      pendant.fillEllipse(x, 141, 34, 16);
      pendant.fillStyle(PALETTE.mustardLight, 0.18);
      pendant.fillTriangle(x - 17, 142, x + 17, 142, x, 245);
    }
  }

  private drawWallWindow(
    graphics: Phaser.GameObjects.Graphics,
    startY: number,
    endY: number,
    wallHeight: number,
  ): void {
    const lowerStart = project(0, startY);
    const lowerEnd = project(0, endY);
    const windowBottomOffset = 28;
    const windowHeight = wallHeight - 48;
    const points = [
      { x: lowerStart.x, y: lowerStart.y - windowBottomOffset },
      { x: lowerEnd.x, y: lowerEnd.y - windowBottomOffset },
      { x: lowerEnd.x, y: lowerEnd.y - windowBottomOffset - windowHeight },
      { x: lowerStart.x, y: lowerStart.y - windowBottomOffset - windowHeight },
    ];

    fillPolygon(graphics, PALETTE.navy, points);
    const inset = points.map((point, index) => ({
      x: point.x + (index < 2 ? 3 : -3),
      y: point.y + (index === 0 || index === 3 ? -1 : 1),
    }));
    fillPolygon(graphics, PALETTE.glass, inset, 0.74);

    graphics.lineStyle(3, PALETTE.cream, 0.82);
    const middleBottom = {
      x: (points[0]?.x ?? 0) + ((points[1]?.x ?? 0) - (points[0]?.x ?? 0)) / 2,
      y: (points[0]?.y ?? 0) + ((points[1]?.y ?? 0) - (points[0]?.y ?? 0)) / 2,
    };
    const middleTop = {
      x: (points[3]?.x ?? 0) + ((points[2]?.x ?? 0) - (points[3]?.x ?? 0)) / 2,
      y: (points[3]?.y ?? 0) + ((points[2]?.y ?? 0) - (points[3]?.y ?? 0)) / 2,
    };
    graphics.lineBetween(middleBottom.x, middleBottom.y, middleTop.x, middleTop.y);
  }

  private drawDoor(
    graphics: Phaser.GameObjects.Graphics,
    startX: number,
    endX: number,
    wallHeight: number,
  ): void {
    const lowerStart = project(startX, 0);
    const lowerEnd = project(endX, 0);
    const doorHeight = wallHeight - 12;
    const doorPoints = [
      lowerStart,
      lowerEnd,
      { x: lowerEnd.x, y: lowerEnd.y - doorHeight },
      { x: lowerStart.x, y: lowerStart.y - doorHeight },
    ];

    fillPolygon(graphics, PALETTE.brick, doorPoints);

    const inset = doorPoints.map((point, index) => ({
      x: point.x + (index === 0 || index === 3 ? 5 : -5),
      y: point.y + (index < 2 ? -5 : 6),
    }));
    fillPolygon(graphics, PALETTE.navyLight, inset);

    const glassBottomLeft = {
      x: inset[0]?.x ?? 0,
      y: (inset[0]?.y ?? 0) - 34,
    };
    const glassBottomRight = {
      x: inset[1]?.x ?? 0,
      y: (inset[1]?.y ?? 0) - 34,
    };
    const glassTopRight = {
      x: inset[2]?.x ?? 0,
      y: (inset[2]?.y ?? 0) + 15,
    };
    const glassTopLeft = {
      x: inset[3]?.x ?? 0,
      y: (inset[3]?.y ?? 0) + 15,
    };
    fillPolygon(
      graphics,
      PALETTE.glass,
      [glassBottomLeft, glassBottomRight, glassTopRight, glassTopLeft],
      0.76,
    );
    graphics.fillStyle(PALETTE.mustardLight, 1);
    graphics.fillCircle(lowerStart.x + 36, lowerStart.y - 49, 4);
  }

  private createChiller(): void {
    const bounds = SHELF_BOUNDS.chiller;
    const base = project(bounds.minX, bounds.minY);
    const container = this.add.container(base.x, base.y);
    const graphics = this.add.graphics();
    drawIsoCuboid(
      graphics,
      bounds.width,
      bounds.depth,
      110,
      0xe9f2ed,
      PALETTE.sageDark,
      PALETTE.teal,
    );

    const front = localIsoCorners(bounds.width, bounds.depth)[2];
    if (front !== undefined) {
      graphics.fillStyle(PALETTE.glass, 0.86);
      graphics.fillRoundedRect(front.x - 65, front.y - 95, 56, 73, 3);
      graphics.fillRoundedRect(front.x - 4, front.y - 95, 56, 73, 3);
      graphics.lineStyle(2, PALETTE.warmWhite, 0.75);
      graphics.strokeRoundedRect(front.x - 65, front.y - 95, 56, 73, 3);
      graphics.strokeRoundedRect(front.x - 4, front.y - 95, 56, 73, 3);
      graphics.lineStyle(3, PALETTE.navy, 0.55);
      graphics.lineBetween(front.x - 12, front.y - 86, front.x - 12, front.y - 35);
      graphics.lineBetween(front.x + 58, front.y - 86, front.x + 58, front.y - 35);

      for (let row = 0; row < 2; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          const colour = column % 2 === 0 ? 0xf4f1e7 : 0x7db2bf;
          graphics.fillStyle(colour, 0.9);
          graphics.fillRoundedRect(
            front.x - 57 + column * 21,
            front.y - 80 + row * 28,
            10,
            19,
            2,
          );
        }
      }
    }

    const label = this.add
      .text(9, -78, "CHILLED", {
        fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
        fontSize: "11px",
        fontStyle: "bold",
        color: "#eff7f0",
        backgroundColor: "#38534a",
        padding: { x: 7, y: 3 },
        letterSpacing: 1,
      })
      .setOrigin(0.5);

    const highlight = this.createFurnitureHighlight(bounds, 113);
    container.add([graphics, highlight, label]);
    container.setDepth(this.furnitureDepth(bounds));

    const hitZone = this.createFurnitureHitZone(container, bounds, 116, () => {
      this.emitInteraction({ kind: "shelf", shelfId: "chiller" });
    });

    this.shelves.set("chiller", { container, highlight, hitZone });
  }

  private createAisleShelf(
    shelfId: Exclude<StoreShelfId, "chiller">,
    bounds: IsoBounds,
    labelText: string,
    productColours: readonly number[],
  ): void {
    const base = project(bounds.minX, bounds.minY);
    const container = this.add.container(base.x, base.y);
    const graphics = this.add.graphics();

    drawIsoCuboid(
      graphics,
      bounds.width,
      bounds.depth,
      74,
      0xc99862,
      PALETTE.woodDark,
      PALETTE.wood,
    );

    const corners = localIsoCorners(bounds.width, bounds.depth);
    const front = corners[2];
    const left = corners[3];
    if (front !== undefined && left !== undefined) {
      graphics.lineStyle(3, PALETTE.creamDark, 0.86);
      for (const offset of [28, 51]) {
        graphics.lineBetween(left.x, left.y - offset, front.x, front.y - offset);
      }

      for (let row = 0; row < 2; row += 1) {
        for (let item = 0; item < 6; item += 1) {
          const colour = productColours[item % productColours.length] ?? PALETTE.sage;
          graphics.fillStyle(colour, 1);
          graphics.fillRoundedRect(
            left.x + 8 + item * 16,
            left.y - 67 + row * 25 + item * 7.2,
            13,
            17,
            2,
          );
          graphics.fillStyle(PALETTE.warmWhite, 0.72);
          graphics.fillRect(
            left.x + 11 + item * 16,
            left.y - 59 + row * 25 + item * 7.2,
            7,
            2,
          );
        }
      }
    }

    const label = this.add
      .text((bounds.width - bounds.depth) * HALF_TILE_WIDTH * 0.5, -88, labelText, {
        fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
        fontSize: "10px",
        fontStyle: "bold",
        color: "#fff7e7",
        backgroundColor: "#263d4a",
        padding: { x: 7, y: 3 },
        letterSpacing: 1,
      })
      .setOrigin(0.5);

    const highlight = this.createFurnitureHighlight(bounds, 78);
    container.add([graphics, highlight, label]);
    container.setDepth(this.furnitureDepth(bounds));

    const hitZone = this.createFurnitureHitZone(container, bounds, 84, () => {
      this.emitInteraction({ kind: "shelf", shelfId });
    });
    this.shelves.set(shelfId, { container, highlight, hitZone });
  }

  private createCounter(): void {
    const bounds = COUNTER_BOUNDS;
    const base = project(bounds.minX, bounds.minY);
    const container = this.add.container(base.x, base.y);
    const graphics = this.add.graphics();

    drawIsoCuboid(
      graphics,
      bounds.width,
      bounds.depth,
      58,
      0xc48b54,
      PALETTE.navy,
      PALETTE.navyLight,
    );

    const counterTop = localIsoCorners(bounds.width, bounds.depth)[2];
    if (counterTop !== undefined) {
      graphics.fillStyle(PALETTE.mustard, 1);
      graphics.fillRoundedRect(counterTop.x - 75, counterTop.y - 80, 38, 22, 4);
      graphics.fillStyle(PALETTE.ink, 1);
      graphics.fillRoundedRect(counterTop.x - 70, counterTop.y - 76, 28, 12, 3);
      graphics.fillStyle(PALETTE.sage, 1);
      graphics.fillRoundedRect(counterTop.x + 2, counterTop.y - 70, 24, 30, 3);
      graphics.fillStyle(PALETTE.warmWhite, 0.85);
      graphics.fillRect(counterTop.x + 7, counterTop.y - 65, 14, 12);
    }

    const label = this.add
      .text((bounds.width - bounds.depth) * HALF_TILE_WIDTH * 0.5, -73, "TILL", {
        fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
        fontSize: "10px",
        fontStyle: "bold",
        color: "#fff7e7",
        backgroundColor: "#9f553f",
        padding: { x: 8, y: 3 },
        letterSpacing: 1.2,
      })
      .setOrigin(0.5);

    this.counterHighlight = this.createFurnitureHighlight(bounds, 64);
    container.add([graphics, this.counterHighlight, label]);
    container.setDepth(this.furnitureDepth(bounds));

    this.createFurnitureHitZone(container, bounds, 78, () => {
      this.emitInteraction({ kind: "counter" });
    });
  }

  private createFurnitureHighlight(
    bounds: IsoBounds,
    height: number,
  ): Phaser.GameObjects.Graphics {
    const highlight = this.add.graphics().setVisible(false).setAlpha(1);
    const corners = localIsoCorners(bounds.width, bounds.depth).map((point) => ({
      x: point.x,
      y: point.y - height,
    }));
    fillPolygon(highlight, PALETTE.mustardLight, corners, 0.22);
    strokePolygon(highlight, PALETTE.mustard, 4, corners, 1);
    return highlight;
  }

  private createFurnitureHitZone(
    container: Phaser.GameObjects.Container,
    bounds: IsoBounds,
    height: number,
    onClick: () => void,
  ): Phaser.GameObjects.Zone {
    const corners = localIsoCorners(bounds.width, bounds.depth);
    const centerX = (bounds.width - bounds.depth) * HALF_TILE_WIDTH * 0.5;
    const baseY = (bounds.width + bounds.depth) * HALF_TILE_HEIGHT * 0.5;
    const width = (bounds.width + bounds.depth) * HALF_TILE_WIDTH + 24;
    const hitZone = this.add
      .zone(container.x + centerX, container.y + baseY - height * 0.45, width, height + 46)
      .setDepth(container.depth + 80)
      .setInteractive({ useHandCursor: true });

    hitZone.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, onClick);
    this.interactiveObjects.push(hitZone);

    const first = corners[0];
    if (first === undefined) {
      hitZone.setPosition(container.x, container.y);
    }

    return hitZone;
  }

  private createPlant(): void {
    const position = project(0.82, 6.72);
    const container = this.add.container(position.x, position.y);
    const graphics = this.add.graphics();

    drawIsoCuboid(
      graphics,
      0.58,
      0.58,
      29,
      PALETTE.terracotta,
      0x8e4939,
      0xb7654b,
    );

    graphics.fillStyle(PALETTE.leaf, 1);
    graphics.fillEllipse(-12, -50, 20, 44);
    graphics.fillEllipse(10, -58, 22, 50);
    graphics.fillEllipse(26, -43, 19, 38);
    graphics.fillEllipse(-28, -39, 20, 38);
    graphics.fillStyle(PALETTE.leafLight, 1);
    graphics.fillEllipse(0, -73, 18, 45);
    graphics.fillEllipse(19, -67, 15, 37);

    container.add(graphics);
    container.setDepth(CHARACTER_DEPTH_BASE + position.y);
  }

  private createPlayer(): void {
    const position = project(this.playerGridPosition.x, this.playerGridPosition.y);
    this.player = this.add.container(position.x, position.y);
    const person = this.add.graphics();
    this.drawAdult(person, PALETTE.mustard, 0xd9a27f, 0x4a3328, true);

    this.carriedProductGraphics = this.add.graphics().setVisible(false);
    this.carriedProductLabel = this.add
      .text(28, -48, "", {
        fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
        fontSize: "8px",
        fontStyle: "bold",
        color: "#263741",
        backgroundColor: "#fff8e8",
        padding: { x: 3, y: 2 },
      })
      .setOrigin(0.5)
      .setVisible(false);

    const playerBadge = this.add
      .text(0, -104, "YOU", {
        fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
        fontSize: "9px",
        fontStyle: "bold",
        color: "#fff8e7",
        backgroundColor: "#203644",
        padding: { x: 6, y: 3 },
        letterSpacing: 0.8,
      })
      .setOrigin(0.5);

    this.player.add([
      person,
      this.carriedProductGraphics,
      this.carriedProductLabel,
      playerBadge,
    ]);
    this.player.setDepth(CHARACTER_DEPTH_BASE + position.y);
  }

  private drawAdult(
    graphics: Phaser.GameObjects.Graphics,
    clothingColour: number,
    skinColour: number,
    hairColour: number,
    apron: boolean,
  ): void {
    graphics.fillStyle(PALETTE.navy, 0.18);
    graphics.fillEllipse(0, -1, 42, 14);

    graphics.fillStyle(0x34424c, 1);
    graphics.fillRoundedRect(-14, -36, 10, 35, 4);
    graphics.fillRoundedRect(4, -36, 10, 35, 4);
    graphics.fillStyle(0x292f33, 1);
    graphics.fillRoundedRect(-17, -8, 14, 8, 4);
    graphics.fillRoundedRect(3, -8, 14, 8, 4);

    graphics.fillStyle(clothingColour, 1);
    fillPolygon(graphics, clothingColour, [
      { x: -19, y: -78 },
      { x: 17, y: -78 },
      { x: 21, y: -36 },
      { x: -21, y: -36 },
    ]);
    graphics.fillRoundedRect(-29, -75, 12, 37, 6);
    graphics.fillRoundedRect(17, -75, 12, 37, 6);

    graphics.fillStyle(skinColour, 1);
    graphics.fillCircle(-23, -37, 6);
    graphics.fillCircle(23, -37, 6);
    graphics.fillRoundedRect(-5, -88, 10, 12, 4);
    graphics.fillCircle(0, -96, 12);

    graphics.fillStyle(hairColour, 1);
    graphics.fillEllipse(0, -102, 23, 13);
    graphics.fillRoundedRect(-12, -102, 6, 11, 3);

    if (apron) {
      graphics.fillStyle(PALETTE.navy, 1);
      fillPolygon(graphics, PALETTE.navy, [
        { x: -12, y: -72 },
        { x: 12, y: -72 },
        { x: 15, y: -38 },
        { x: -15, y: -38 },
      ]);
      graphics.lineStyle(2, PALETTE.mustardLight, 0.85);
      graphics.lineBetween(-10, -72, -15, -79);
      graphics.lineBetween(10, -72, 15, -79);
      graphics.fillStyle(PALETTE.mustardLight, 0.9);
      graphics.fillRect(-6, -52, 12, 2);
    }
  }

  private createCustomer(customer: StoreCustomerView): void {
    const start = project(CUSTOMER_DOOR.x, CUSTOMER_DOOR.y);
    const container = this.add.container(start.x, start.y);
    const person = this.add.graphics();
    const clothing = customer.avatarColour ?? PALETTE.terracotta;
    const skinPalette = [0x8d5c43, 0xb8795d, 0xd8a17f, 0xf0c4a5];
    const skinColour = skinPalette[this.customers.size % skinPalette.length] ?? 0xd8a17f;
    const hairPalette = [0x30241e, 0x55382b, 0x2f343a, 0x896a4b];
    const hairColour = hairPalette[this.customers.size % hairPalette.length] ?? 0x30241e;
    this.drawAdult(person, clothing, skinColour, hairColour, false);

    const name = this.add
      .text(0, -113, customer.name, {
        fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
        fontSize: "10px",
        fontStyle: "bold",
        color: "#24343d",
        backgroundColor: "#fffaf0",
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5);

    const speech = this.add.graphics();
    speech.fillStyle(PALETTE.warmWhite, 0.96);
    speech.fillCircle(25, -99, 12);
    speech.fillTriangle(18, -92, 14, -84, 26, -90);
    speech.fillStyle(PALETTE.navy, 1);
    speech.fillCircle(25, -99, 2.5);

    container.add([person, speech, name]);
    container.setDepth(CHARACTER_DEPTH_BASE + start.y);

    const hitZone = this.add
      .zone(start.x, start.y - 51, 50, 112)
      .setDepth(6_100)
      .setInteractive({ useHandCursor: true });
    hitZone.on(Phaser.Input.Events.GAMEOBJECT_POINTER_DOWN, () => {
      this.emitInteraction({ kind: "customer", customerId: customer.id });
    });
    this.interactiveObjects.push(hitZone);

    const visual: CustomerVisual = { container, hitZone };
    this.customers.set(customer.id, visual);

    const queueIndex = Math.min(this.customers.size - 1, CUSTOMER_QUEUE.length - 1);
    const queuePosition = CUSTOMER_QUEUE[queueIndex] ?? CUSTOMER_QUEUE[0];
    if (queuePosition === undefined) {
      return;
    }

    this.moveCustomerAlongRoute(visual, [
      { x: 9.45, y: 3.25 },
      { x: 9.45, y: 6.45 },
      queuePosition,
    ]);
  }

  private moveCustomerAlongRoute(
    customer: CustomerVisual,
    route: GridPoint[],
    onComplete?: () => void,
  ): void {
    const next = route[0];
    if (next === undefined) {
      onComplete?.();
      return;
    }

    const destination = project(next.x, next.y);
    const distance = Phaser.Math.Distance.Between(
      customer.container.x,
      customer.container.y,
      destination.x,
      destination.y,
    );

    this.tweens.add({
      targets: customer.container,
      x: destination.x,
      y: destination.y,
      duration: Math.max(260, (distance / 116) * 1_000),
      ease: "Sine.easeInOut",
      onUpdate: () => {
        customer.container.setDepth(CHARACTER_DEPTH_BASE + customer.container.y);
        customer.hitZone
          .setPosition(customer.container.x, customer.container.y - 51)
          .setDepth(6_100);
      },
      onComplete: () => {
        this.moveCustomerAlongRoute(customer, route.slice(1), onComplete);
      },
    });
  }

  private createUpgradeVisuals(): void {
    const terminalPosition = project(8.25, 4.72);
    this.upgradeTerminal = this.add
      .container(terminalPosition.x, terminalPosition.y - 70)
      .setDepth(3_100)
      .setVisible(false);

    const terminal = this.add.graphics();
    terminal.fillStyle(PALETTE.navy, 1);
    terminal.fillRoundedRect(-15, -37, 30, 34, 5);
    terminal.fillStyle(PALETTE.teal, 1);
    terminal.fillRoundedRect(-11, -33, 22, 16, 3);
    terminal.fillStyle(PALETTE.mustardLight, 1);
    terminal.fillCircle(0, -9, 4);
    terminal.lineStyle(4, PALETTE.navy, 1);
    terminal.lineBetween(0, -3, 0, 19);
    terminal.fillStyle(PALETTE.cream, 1);
    terminal.fillEllipse(0, 20, 34, 12);
    this.upgradeTerminal.add(terminal);

    this.upgradeToast = this.add.container(STORE_ORIGIN_X, 78).setDepth(8_000).setVisible(false);
    const toastBackground = this.add.graphics();
    toastBackground.fillStyle(PALETTE.navy, 0.98);
    toastBackground.fillRoundedRect(-162, -27, 324, 54, 12);
    toastBackground.lineStyle(3, PALETTE.mustardLight, 1);
    toastBackground.strokeRoundedRect(-157, -22, 314, 44, 9);
    toastBackground.fillStyle(PALETTE.mustardLight, 1);
    toastBackground.fillCircle(-132, 0, 13);
    toastBackground.fillStyle(PALETTE.navy, 1);
    toastBackground.fillCircle(-132, 0, 4);

    this.upgradeToastLabel = this.add
      .text(14, 0, "", {
        fontFamily: '"Avenir Next", "Trebuchet MS", sans-serif',
        fontSize: "15px",
        fontStyle: "bold",
        color: "#fff6dc",
        align: "center",
      })
      .setOrigin(0.5);
    this.upgradeToast.add([toastBackground, this.upgradeToastLabel]);
  }

  private applyActiveShelf(): void {
    for (const [shelfId, visual] of this.shelves) {
      const active = shelfId === this.activeShelfId;
      visual.highlight.setVisible(active).setAlpha(active ? 1 : 0);
    }
  }

  private applyCarriedProduct(): void {
    this.carriedProductGraphics.clear();

    if (this.pendingProduct === null) {
      this.carriedProductGraphics.setVisible(false);
      this.carriedProductLabel.setVisible(false);
      return;
    }

    const colour = this.pendingProduct.colour ?? PALETTE.mustard;
    this.carriedProductGraphics.setVisible(true);
    this.carriedProductGraphics.fillStyle(PALETTE.cream, 1);
    this.carriedProductGraphics.fillRoundedRect(15, -67, 26, 29, 4);
    this.carriedProductGraphics.fillStyle(colour, 1);
    this.carriedProductGraphics.fillRoundedRect(18, -63, 20, 19, 3);
    this.carriedProductGraphics.fillStyle(PALETTE.warmWhite, 0.82);
    this.carriedProductGraphics.fillRect(22, -55, 12, 3);

    const label = this.pendingProduct.nameEn ?? this.pendingProduct.id;
    this.carriedProductLabel.setText(label.toUpperCase()).setVisible(true);
  }

  private applyInteractionEnabled(): void {
    for (const object of this.interactiveObjects) {
      if (object.active && object.input) {
        object.input.enabled = this.interactionEnabled;
      }
    }
    this.input.setDefaultCursor(this.interactionEnabled ? "default" : "not-allowed");
  }

  private emitInteraction(interaction: StoreInteraction): void {
    if (!this.interactionEnabled) {
      return;
    }
    this.callbacks.onInteraction?.(interaction);
  }

  private handleFloorClick(pointer: Phaser.Input.Pointer): void {
    if (!this.interactionEnabled) {
      return;
    }

    const requested = unproject(pointer.worldX, pointer.worldY);
    const destination = this.findNearestWalkable({
      x: clamp(requested.x, 0.5, STORE_COLUMNS - 0.5),
      y: clamp(requested.y, 0.5, STORE_ROWS - 0.5),
    });

    if (destination === null) {
      return;
    }

    const path = this.findPath(this.playerGridPosition, destination);
    if (path.length === 0) {
      return;
    }

    this.playerPath = path;
    const markerPosition = project(destination.x, destination.y);
    this.destinationMarker.setPosition(markerPosition.x, markerPosition.y).setVisible(true);

    this.callbacks.onGroundClick?.({
      gridX: destination.x,
      gridY: destination.y,
    });
  }

  private updatePlayerMovement(delta: number): void {
    const target = this.playerPath[0];
    if (target === undefined) {
      return;
    }

    const destination = project(target.x, target.y);
    const distance = Phaser.Math.Distance.Between(
      this.player.x,
      this.player.y,
      destination.x,
      destination.y,
    );
    const step = (PLAYER_SPEED * delta) / 1_000;

    if (distance <= step || distance < 0.5) {
      this.player.setPosition(destination.x, destination.y);
      this.playerGridPosition = target;
      this.playerPath.shift();
    } else {
      const ratio = step / distance;
      this.player.x += (destination.x - this.player.x) * ratio;
      this.player.y += (destination.y - this.player.y) * ratio;
      this.playerGridPosition = unproject(this.player.x, this.player.y);
    }

    this.player.setDepth(CHARACTER_DEPTH_BASE + this.player.y);

    if (this.playerPath.length === 0) {
      this.destinationMarker.setVisible(false);
      this.callbacks.onPlayerArrived?.({
        gridX: this.playerGridPosition.x,
        gridY: this.playerGridPosition.y,
      });
    }
  }

  private findNearestWalkable(point: GridPoint): GridPoint | null {
    const snapped = {
      x: Math.round(point.x / NAV_STEP) * NAV_STEP,
      y: Math.round(point.y / NAV_STEP) * NAV_STEP,
    };

    if (this.isWalkable(snapped)) {
      return snapped;
    }

    for (let radius = 1; radius <= 6; radius += 1) {
      const candidates: GridPoint[] = [];
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== radius) {
            continue;
          }
          candidates.push({
            x: snapped.x + offsetX * NAV_STEP,
            y: snapped.y + offsetY * NAV_STEP,
          });
        }
      }

      candidates.sort(
        (a, b) =>
          Phaser.Math.Distance.Between(point.x, point.y, a.x, a.y) -
          Phaser.Math.Distance.Between(point.x, point.y, b.x, b.y),
      );
      const walkable = candidates.find((candidate) => this.isWalkable(candidate));
      if (walkable !== undefined) {
        return walkable;
      }
    }

    return null;
  }

  private findPath(start: GridPoint, destination: GridPoint): GridPoint[] {
    const toNode = (point: GridPoint): GridPoint => ({
      x: Math.round(point.x / NAV_STEP),
      y: Math.round(point.y / NAV_STEP),
    });
    const fromNode = (point: GridPoint): GridPoint => ({
      x: point.x * NAV_STEP,
      y: point.y * NAV_STEP,
    });
    const startNode = toNode(start);
    const goalNode = toNode(destination);
    const startKey = nodeKey(startNode.x, startNode.y);
    const goalKey = nodeKey(goalNode.x, goalNode.y);
    const open = new Map<string, PathNode>();
    const closed = new Map<string, PathNode>();
    const heuristic = (x: number, y: number): number =>
      Math.hypot(goalNode.x - x, goalNode.y - y);

    open.set(startKey, {
      x: startNode.x,
      y: startNode.y,
      g: 0,
      f: heuristic(startNode.x, startNode.y),
      parentKey: null,
    });

    const directions = [
      { x: 1, y: 0, cost: 1 },
      { x: -1, y: 0, cost: 1 },
      { x: 0, y: 1, cost: 1 },
      { x: 0, y: -1, cost: 1 },
      { x: 1, y: 1, cost: Math.SQRT2 },
      { x: -1, y: 1, cost: Math.SQRT2 },
      { x: 1, y: -1, cost: Math.SQRT2 },
      { x: -1, y: -1, cost: Math.SQRT2 },
    ];

    while (open.size > 0) {
      let current: PathNode | undefined;
      for (const candidate of open.values()) {
        if (current === undefined || candidate.f < current.f) {
          current = candidate;
        }
      }

      if (current === undefined) {
        break;
      }

      const currentKey = nodeKey(current.x, current.y);
      open.delete(currentKey);
      closed.set(currentKey, current);

      if (currentKey === goalKey) {
        const path: GridPoint[] = [];
        let trace: PathNode | undefined = current;
        while (trace !== undefined && trace.parentKey !== null) {
          path.unshift(fromNode({ x: trace.x, y: trace.y }));
          trace = closed.get(trace.parentKey) ?? open.get(trace.parentKey);
        }
        return path;
      }

      for (const direction of directions) {
        const nextX = current.x + direction.x;
        const nextY = current.y + direction.y;
        const nextKey = nodeKey(nextX, nextY);
        const worldPoint = fromNode({ x: nextX, y: nextY });

        if (closed.has(nextKey) || !this.isWalkable(worldPoint)) {
          continue;
        }

        if (direction.x !== 0 && direction.y !== 0) {
          const horizontal = fromNode({ x: current.x + direction.x, y: current.y });
          const vertical = fromNode({ x: current.x, y: current.y + direction.y });
          if (!this.isWalkable(horizontal) || !this.isWalkable(vertical)) {
            continue;
          }
        }

        const tentativeG = current.g + direction.cost;
        const existing = open.get(nextKey);
        if (existing !== undefined && tentativeG >= existing.g) {
          continue;
        }

        open.set(nextKey, {
          x: nextX,
          y: nextY,
          g: tentativeG,
          f: tentativeG + heuristic(nextX, nextY),
          parentKey: currentKey,
        });
      }
    }

    return [];
  }

  private isWalkable(point: GridPoint): boolean {
    if (
      point.x < 0.35 ||
      point.x > STORE_COLUMNS - 0.35 ||
      point.y < 0.35 ||
      point.y > STORE_ROWS - 0.35
    ) {
      return false;
    }

    return !BLOCKED_RECTS.some((rect) => pointInsideRect(point, rect, 0.16));
  }

  private furnitureDepth(bounds: IsoBounds): number {
    const front = project(bounds.maxX, bounds.maxY);
    return CHARACTER_DEPTH_BASE + front.y;
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const scale = Math.min(gameSize.width / DESIGN_WIDTH, gameSize.height / DESIGN_HEIGHT);
    this.cameras.main.setZoom(Math.max(0.01, scale));
    this.cameras.main.centerOn(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
  }

  private handleShutdown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
  }
}
