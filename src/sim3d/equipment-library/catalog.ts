/** Independent furniture art catalogue. It does not register purchases, stock or checkout logic. */
export type EquipmentPoint = readonly [number, number, number];
export type EquipmentMount = "shelf" | "basket" | "hook" | "bagging";
export interface EquipmentSlot {
  readonly id: string;
  /** Bottom centre of the display envelope, in local metres. */
  readonly position: EquipmentPoint;
  readonly maxSize: EquipmentPoint;
  readonly rotationY: number;
  readonly mount: EquipmentMount;
}
export const EQUIPMENT_CATEGORIES = [
  { id: "checkout", nameZh: "自助收银台", nameEn: "Self-checkout" },
  { id: "refrigeration", nameZh: "横式冷柜", nameEn: "Refrigerated cases" },
  { id: "display", nameZh: "货架与陈列柜", nameEn: "Shelves & displays" },
] as const;
export type EquipmentCategoryId = (typeof EQUIPMENT_CATEGORIES)[number]["id"];

interface EquipmentSpec {
  nameZh: string;
  nameEn: string;
  category: EquipmentCategoryId;
  size: EquipmentPoint;
  description: string;
  style: string;
  capacityLabel: "商品陈列位" | "台面暂存位";
  placementSlots: readonly EquipmentSlot[];
  recommendedProducts: readonly string[];
  /** Additional clear aisle space in front, not a collision or accessibility certification. */
  suggestedFrontClearance: number;
}

function grid(columns: number, rows: number, spanX: number, spanZ: number, heights: readonly number[], maxSize: EquipmentPoint, mount: EquipmentMount, centreZ = 0): EquipmentSlot[] {
  const slots: EquipmentSlot[] = [];
  for (const y of heights) for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    slots.push({ id: `slot-${String(slots.length + 1).padStart(2, "0")}`,
      position: [(column - (columns - 1) / 2) * spanX / columns, y, centreZ + (row - (rows - 1) / 2) * spanZ / rows],
      maxSize, rotationY: 0, mount });
  }
  return slots;
}
function doubleSided(columns: number, spanX: number, heights: readonly number[], maxSize: EquipmentPoint, sideZ: number): EquipmentSlot[] {
  const slots = [-1, 1].flatMap((side) => grid(columns, 1, spanX, 0, heights, maxSize, "shelf", side * sideZ)
    .map((slot) => ({ ...slot, rotationY: side === -1 ? 0 : Math.PI })));
  return slots.map((slot, index) => ({ ...slot, id: `slot-${String(index + 1).padStart(2, "0")}` }));
}

const definitions = {
  "self-checkout-compact": {
    nameZh: "紧凑自助收银台", nameEn: "Compact self-checkout", category: "checkout", size: [1.04, 1.63, 0.82],
    description: "立式触屏、扫码窗、支付终端、小票口与右侧商品暂存台。", style: "小店紧凑型 · 鼠尾草绿与象牙白", capacityLabel: "台面暂存位",
    placementSlots: grid(1, 2, 0, 0.42, [0.87], [0.28, 0.30, 0.19], "bagging").map((slot) => ({ ...slot, position: [0.32, slot.position[1], slot.position[2]] as EquipmentPoint })),
    recommendedProducts: ["milk", "cola", "apple"], suggestedFrontClearance: 1.05,
  },
  "self-checkout-bagging": {
    nameZh: "宽台自助收银台", nameEn: "Self-checkout with bagging station", category: "checkout", size: [1.64, 1.73, 0.96],
    description: "独立扫描台、加宽装袋区、触屏与状态灯，提供更宽的商品暂存面。", style: "超市宽台型 · 深绿金属", capacityLabel: "台面暂存位",
    placementSlots: grid(2, 2, 0.65, 0.50, [0.86], [0.29, 0.30, 0.22], "bagging").map((slot) => ({ ...slot, position: [slot.position[0] + 0.43, slot.position[1], slot.position[2]] as EquipmentPoint })),
    recommendedProducts: ["milk", "crisps", "apple"], suggestedFrontClearance: 1.2,
  },
  "chest-chiller-compact": {
    nameZh: "双层横式冷柜 · 24位", nameEn: "Compact chest chiller", category: "refrigeration", size: [1.30, 1.00, 0.90],
    description: "横向玻璃滑盖、双层分格篮与前置散热格栅，适合小店冷藏区。", style: "紧凑滑盖型", capacityLabel: "商品陈列位",
    placementSlots: grid(4, 3, 1.04, 0.66, [0.26, 0.57], [0.23, 0.25, 0.19], "basket"), recommendedProducts: ["milk", "yoghurt", "butter"], suggestedFrontClearance: 0.95,
  },
  "chest-chiller-wide": {
    nameZh: "加宽横式冷柜 · 48位", nameEn: "Wide chest chiller", category: "refrigeration", size: [1.96, 1.04, 1.04],
    description: "加宽双滑盖、双层分格篮、缓冲护条与独立压缩机检修面。", style: "大容量双滑盖型", capacityLabel: "商品陈列位",
    placementSlots: grid(6, 4, 1.68, 0.80, [0.26, 0.59], [0.25, 0.27, 0.17], "basket"), recommendedProducts: ["milk", "orange-juice", "eggs"], suggestedFrontClearance: 1.05,
  },
  "island-chiller": {
    nameZh: "岛式横柜 · 72位", nameEn: "Large island chiller", category: "refrigeration", size: [2.82, 1.06, 1.08],
    description: "长岛式柜体、三段玻璃滑盖与双层分区篮，适合扩建后的冷藏陈列。", style: "超市岛式长柜", capacityLabel: "商品陈列位",
    placementSlots: grid(9, 4, 2.52, 0.84, [0.26, 0.60], [0.25, 0.27, 0.18], "basket"), recommendedProducts: ["milk", "cheese", "water"], suggestedFrontClearance: 1.15,
  },
  "wall-shelf-narrow": {
    nameZh: "窄款壁式货架 · 12位", nameEn: "Narrow wall shelf", category: "display", size: [0.98, 1.92, 0.52],
    description: "四层浅壁架、侧立柱、价格条与可调层板孔，适合狭窄墙面。", style: "单面 · 窄款金属架", capacityLabel: "商品陈列位",
    placementSlots: grid(3, 1, 0.78, 0, [0.22, 0.62, 1.02, 1.42], [0.23, 0.34, 0.36], "shelf", -0.01), recommendedProducts: ["cereal", "tea", "shampoo"], suggestedFrontClearance: 0.9,
  },
  "wall-shelf-wide": {
    nameZh: "宽款壁式货架 · 24位", nameEn: "Wide wall shelf", category: "display", size: [1.68, 2.10, 0.64],
    description: "四层加宽货架、加固背板和价签轨，适合粮食、冲饮与日用品。", style: "单面 · 加宽木金属架", capacityLabel: "商品陈列位",
    placementSlots: grid(6, 1, 1.44, 0, [0.22, 0.67, 1.12, 1.57], [0.22, 0.36, 0.46], "shelf"), recommendedProducts: ["rice", "flour", "coffee"], suggestedFrontClearance: 1.05,
  },
  "gondola-low": {
    nameZh: "低款双面货架 · 32位", nameEn: "Low double-sided gondola", category: "display", size: [1.42, 1.50, 0.92],
    description: "低矮中央货架、正反四层陈列与双面价签轨，保持店内视线通透。", style: "双面 · 低矮中央架", capacityLabel: "商品陈列位",
    placementSlots: doubleSided(4, 1.20, [0.18, 0.51, 0.84, 1.17], [0.27, 0.25, 0.31], 0.255), recommendedProducts: ["biscuits", "chocolate", "soap"], suggestedFrontClearance: 1.05,
  },
  "gondola-tall": {
    nameZh: "高款双面货架 · 48位", nameEn: "Tall double-sided gondola", category: "display", size: [2.04, 1.96, 1.00],
    description: "正反四层长货架、中间加固隔板和可替换分类牌，适合更大的店面。", style: "双面 · 加长高款架", capacityLabel: "商品陈列位",
    placementSlots: doubleSided(6, 1.74, [0.20, 0.62, 1.04, 1.46], [0.26, 0.35, 0.34], 0.275), recommendedProducts: ["cereal", "crisps", "tissues"], suggestedFrontClearance: 1.15,
  },
  "produce-tiered": {
    nameZh: "阶梯果蔬架 · 12位", nameEn: "Tiered produce display", category: "display", size: [1.44, 1.48, 0.90],
    description: "三阶四列木质果蔬格、前挡边和独立价签，陈列高度依次升高。", style: "单面 · 原木阶梯格", capacityLabel: "商品陈列位",
    placementSlots: [0.25, 0.65, 1.05].flatMap((y, tier) => grid(4, 1, 1.16, 0, [y], [0.245, 0.28, 0.29], "basket", (tier - 1) * 0.23)).map((slot, index) => ({ ...slot, id: `slot-${String(index + 1).padStart(2, "0")}` })),
    recommendedProducts: ["apple", "orange", "lettuce"], suggestedFrontClearance: 1.0,
  },
  "bakery-glass": {
    nameZh: "玻璃面包陈列柜 · 12位", nameEn: "Glass bakery cabinet", category: "display", size: [1.72, 1.66, 0.72],
    description: "三层宽托盘、玻璃侧板和前开门，横向陈列位可放整条面包。", style: "单面 · 木纹玻璃柜", capacityLabel: "商品陈列位",
    placementSlots: grid(4, 1, 1.52, 0, [0.30, 0.72, 1.14], [0.355, 0.32, 0.48], "shelf"), recommendedProducts: ["bread", "biscuits"], suggestedFrontClearance: 1.05,
  },
  "pegboard-snacks": {
    nameZh: "零食挂架 · 12位", nameEn: "Pegboard snack display", category: "display", size: [1.32, 1.94, 0.56],
    description: "三排四列挂钩、孔板背板与稳定底座，适合有挂孔的袋装小物。", style: "单面 · 孔板挂钩架", capacityLabel: "商品陈列位",
    placementSlots: grid(4, 1, 1.08, 0, [0.38, 0.83, 1.28], [0.23, 0.34, 0.10], "hook", -0.16), recommendedProducts: ["crisps"], suggestedFrontClearance: 0.9,
  },
} as const satisfies Record<string, EquipmentSpec>;

export type EquipmentAssetId = keyof typeof definitions;
export interface EquipmentServicePoint {
  readonly id: string;
  readonly role: "customer" | "restock";
  readonly position: EquipmentPoint;
  readonly facing: EquipmentPoint;
}
export interface EquipmentAssetDefinition extends EquipmentSpec {
  readonly id: EquipmentAssetId;
  readonly capacity: number;
  readonly modelUrl: string;
  readonly thumbnailUrl: string;
  readonly modelReady: true;
  readonly gameplay: "library-only";
  readonly servicePoints: readonly EquipmentServicePoint[];
}
export const EQUIPMENT_LIBRARY_VERSION = "corner-shop-equipment@1.0.0";
export const EQUIPMENT_ASSET_IDS = Object.freeze(Object.keys(definitions) as EquipmentAssetId[]);
function equipmentDefinition(id: EquipmentAssetId): EquipmentAssetDefinition {
  const definition = definitions[id];
  const servicePoints: EquipmentServicePoint[] = [
    { id: "front", role: "customer",
      position: [0, 0, -definition.size[2] / 2 - 0.65], facing: [0, 0, 1] },
  ];
  if (id === "gondola-low" || id === "gondola-tall" || id === "island-chiller") {
    servicePoints.push({ id: "back", role: "customer", position: [0, 0, definition.size[2] / 2 + 0.65], facing: [0, 0, -1] });
  }
  return Object.freeze({
    ...definition, id, capacity: definition.placementSlots.length, modelReady: true, gameplay: "library-only",
    size: Object.freeze([...definition.size] as [number, number, number]),
    recommendedProducts: Object.freeze([...definition.recommendedProducts]),
    placementSlots: Object.freeze(definition.placementSlots.map((slot) => Object.freeze({ ...slot,
      position: Object.freeze([...slot.position] as [number, number, number]), maxSize: Object.freeze([...slot.maxSize] as [number, number, number]),
    }))),
    modelUrl: `/assets/sim3d/equipment/${id}.glb`, thumbnailUrl: `/assets/sim3d/equipment/${id}.png`,
    servicePoints: Object.freeze(servicePoints.map((point) => Object.freeze({ ...point,
      position: Object.freeze([...point.position] as [number, number, number]), facing: Object.freeze([...point.facing] as [number, number, number]),
    }))),
  });
}
export const EQUIPMENT_ASSETS = Object.freeze(Object.fromEntries(EQUIPMENT_ASSET_IDS.map((id) => [id, equipmentDefinition(id)]))) as Readonly<Record<EquipmentAssetId, EquipmentAssetDefinition>>;
export const EQUIPMENT_ASSET_LIST = Object.freeze(EQUIPMENT_ASSET_IDS.map((id) => EQUIPMENT_ASSETS[id]));
export function isEquipmentAssetId(value: unknown): value is EquipmentAssetId {
  return typeof value === "string" && Object.hasOwn(EQUIPMENT_ASSETS, value);
}
export function filterEquipmentAssets(query = "", category?: EquipmentCategoryId): EquipmentAssetDefinition[] {
  const search = query.trim().toLocaleLowerCase();
  return EQUIPMENT_ASSET_LIST.filter((asset) => (!category || asset.category === category)
    && `${asset.id} ${asset.nameZh} ${asset.nameEn} ${asset.style} ${asset.description} ${asset.capacity}`.toLocaleLowerCase().includes(search));
}
export function equipmentAssetCode(id: EquipmentAssetId): string {
  if (!isEquipmentAssetId(id)) throw new Error(`Unknown equipment asset: ${String(id)}`);
  return `import { createEquipmentAsset, equipmentSlotWorldPosition } from "./sim3d/equipment-library";\n\nconst equipment = createEquipmentAsset(scene, "${id}", "shop-${id}-01");\nequipment.position.set(0, 0, 0); // 米；原点在设备底部中心\nconst firstSlot = equipmentSlotWorldPosition(equipment, "slot-01");\n// 容量为美术陈列位，购买、库存和自助结算需另行接入。`;
}
export function equipmentLibraryManifest(): object {
  return { version: EQUIPMENT_LIBRARY_VERSION, units: "metres", origin: "bottom-centre", front: "-Z",
    source: "Project-authored procedural Babylon.js geometry and original equipment signage.",
    integrationNote: "Art assets only. No equipment purchase, stock capacity, self-checkout automation, refrigeration or saved layout is activated by this library.",
    capacityNote: "Each capacity is the count of labelled standard display envelopes, not litres, warehouse stock, customer throughput or guaranteed fit for every product. Match maxSize and mount before placing a product.",
    factory: "src/sim3d/equipment-library/index.ts#createEquipmentAsset", categories: EQUIPMENT_CATEGORIES, equipment: EQUIPMENT_ASSET_LIST };
}
