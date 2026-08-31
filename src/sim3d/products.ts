import {
  PRODUCT_ASSETS, PRODUCT_ASSET_IDS, isProductAssetId,
  type ProductAssetId, type ProductCategoryId, type ProductShelf,
} from "./product-library/catalog";

export const PRODUCT_IDS = PRODUCT_ASSET_IDS;
export type ProductId = ProductAssetId;
export type CrateId = `${ProductId}-crate`;
export interface ProductDefinition {
  nameEn: string;
  nameZh: string;
  unitEn: string;
  phraseEn: string;
  phraseZh: string;
  category: ProductCategoryId;
  shelf: ProductShelf;
  pricePence: number;
  costPence: number;
}

/** Fixed game-economy prices in pence, not claims about real-world retail prices. */
const PRICES: Record<ProductId, readonly [cost: number, price: number]> = {
  milk: [90, 160], bread: [140, 240], water: [45, 95], "orange-juice": [110, 190], cola: [65, 120],
  crisps: [55, 110], biscuits: [85, 150], chocolate: [70, 130], yoghurt: [50, 100], cheese: [160, 275],
  butter: [120, 210], eggs: [150, 250], apple: [30, 65], banana: [85, 150], orange: [35, 70],
  tomato: [30, 60], potato: [100, 180], carrot: [20, 45], lettuce: [55, 105], cucumber: [45, 90],
  cereal: [150, 260], pasta: [85, 150], rice: [140, 240], flour: [80, 145], sugar: [75, 135],
  tea: [140, 240], coffee: [250, 420], soap: [70, 135], shampoo: [190, 320], tissues: [95, 175],
};

export const PRODUCTS = Object.freeze(Object.fromEntries(PRODUCT_IDS.map((id) => {
  const asset = PRODUCT_ASSETS[id];
  const [costPence, pricePence] = PRICES[id];
  return [id, Object.freeze({
    nameEn: asset.nameEn, nameZh: asset.nameZh, unitEn: asset.unitEn, phraseEn: asset.phraseEn,
    phraseZh: asset.phraseZh, category: asset.category, shelf: asset.shelf, costPence, pricePence,
  })];
}))) as Readonly<Record<ProductId, ProductDefinition>>;

export const isProductId = (value: unknown): value is ProductId => isProductAssetId(value);
