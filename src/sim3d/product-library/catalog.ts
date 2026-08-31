/** Shared visual catalogue; the shop's audited prices and stock rules live in products.ts/domain.ts. */
export const PRODUCT_CATEGORIES = [
  { id: "drinks", nameZh: "饮料", nameEn: "Drinks" },
  { id: "bakery", nameZh: "烘焙与零食", nameEn: "Bakery & snacks" },
  { id: "chilled", nameZh: "冷藏食品", nameEn: "Chilled food" },
  { id: "produce", nameZh: "蔬菜与水果", nameEn: "Fruit & vegetables" },
  { id: "pantry", nameZh: "粮食与冲饮", nameEn: "Pantry" },
  { id: "household", nameZh: "日用品", nameEn: "Household" },
] as const;

export type ProductCategoryId = (typeof PRODUCT_CATEGORIES)[number]["id"];
export type ProductShelf = "chiller" | "bakery" | "ambient" | "produce" | "household";

interface AssetDefinition {
  nameEn: string;
  nameZh: string;
  category: ProductCategoryId;
  unitEn: string;
  phraseEn: string;
  phraseZh: string;
  shelf: ProductShelf;
  /** Nominal envelope in metres; the factory also records measured bounds. */
  size: readonly [number, number, number];
  appearance: string;
}

const definitions = {
  milk: { nameEn: "milk", nameZh: "牛奶", category: "drinks", unitEn: "carton", phraseEn: "a carton of milk", phraseZh: "一盒牛奶", shelf: "chiller", size: [0.087, 0.241, 0.087], appearance: "折顶纸盒、蓝色旋盖与双面标签" },
  bread: { nameEn: "bread", nameZh: "面包", category: "bakery", unitEn: "loaf", phraseEn: "a loaf of bread", phraseZh: "一条面包", shelf: "bakery", size: [0.348, 0.146, 0.154], appearance: "烤色外皮、四道割口与透明束口包装" },
  water: { nameEn: "sparkling water", nameZh: "气泡水", category: "drinks", unitEn: "bottle", phraseEn: "a bottle of sparkling water", phraseZh: "一瓶气泡水", shelf: "chiller", size: [0.068, 0.24, 0.068], appearance: "有瓶肩和凹槽的透明瓶身、蓝绿旋盖" },
  "orange-juice": { nameEn: "orange juice", nameZh: "橙汁", category: "drinks", unitEn: "carton", phraseEn: "a carton of orange juice", phraseZh: "一盒橙汁", shelf: "chiller", size: [0.075, 0.215, 0.075], appearance: "带旋盖的橙色折顶纸盒、橙瓣标识" },
  cola: { nameEn: "cola", nameZh: "可乐", category: "drinks", unitEn: "can", phraseEn: "a can of cola", phraseZh: "一罐可乐", shelf: "chiller", size: [0.066, 0.122, 0.066], appearance: "金属易拉罐、卷边与独立拉环" },
  crisps: { nameEn: "crisps", nameZh: "薯片", category: "bakery", unitEn: "packet", phraseEn: "a packet of crisps", phraseZh: "一包薯片", shelf: "ambient", size: [0.145, 0.215, 0.065], appearance: "鼓起的枕形袋、上下压封边与薯片图案" },
  biscuits: { nameEn: "biscuits", nameZh: "饼干", category: "bakery", unitEn: "packet", phraseEn: "a packet of biscuits", phraseZh: "一包饼干", shelf: "ambient", size: [0.195, 0.075, 0.075], appearance: "横放卷筒包装、两端封口与圆饼图案" },
  chocolate: { nameEn: "chocolate", nameZh: "巧克力", category: "bakery", unitEn: "bar", phraseEn: "a bar of chocolate", phraseZh: "一块巧克力", shelf: "ambient", size: [0.088, 0.17, 0.016], appearance: "薄片包装、折边铝箔与巧克力格纹" },
  yoghurt: { nameEn: "yoghurt", nameZh: "酸奶", category: "chilled", unitEn: "pot", phraseEn: "a pot of yoghurt", phraseZh: "一杯酸奶", shelf: "chiller", size: [0.09, 0.108, 0.09], appearance: "上宽下窄杯身、铝箔盖与揭盖耳" },
  cheese: { nameEn: "cheese", nameZh: "奶酪", category: "chilled", unitEn: "block", phraseEn: "a block of cheese", phraseZh: "一块奶酪", shelf: "chiller", size: [0.13, 0.085, 0.048], appearance: "切块黄奶酪、半透明包膜与纸腰封" },
  butter: { nameEn: "butter", nameZh: "黄油", category: "chilled", unitEn: "pack", phraseEn: "a pack of butter", phraseZh: "一包黄油", shelf: "chiller", size: [0.115, 0.045, 0.07], appearance: "矮长方形金色纸包、端部折边" },
  eggs: { nameEn: "eggs", nameZh: "鸡蛋", category: "chilled", unitEn: "box", phraseEn: "a box of eggs", phraseZh: "一盒鸡蛋", shelf: "chiller", size: [0.16, 0.07, 0.112], appearance: "六格纸浆蛋托、可见蛋形与纸套" },
  apple: { nameEn: "apple", nameZh: "苹果", category: "produce", unitEn: "apple", phraseEn: "an apple", phraseZh: "一个苹果", shelf: "produce", size: [0.081, 0.086, 0.081], appearance: "带肩部起伏和凹顶的红苹果、果梗与叶片" },
  banana: { nameEn: "bananas", nameZh: "香蕉", category: "produce", unitEn: "bunch", phraseEn: "a bunch of bananas", phraseZh: "一把香蕉", shelf: "produce", size: [0.21, 0.12, 0.14], appearance: "三根弧形香蕉、棱面果皮与深色端头" },
  orange: { nameEn: "orange", nameZh: "橙子", category: "produce", unitEn: "orange", phraseEn: "an orange", phraseZh: "一个橙子", shelf: "produce", size: [0.083, 0.087, 0.083], appearance: "有细密起伏的橙皮、顶部果蒂" },
  tomato: { nameEn: "tomato", nameZh: "番茄", category: "produce", unitEn: "tomato", phraseEn: "a tomato", phraseZh: "一个番茄", shelf: "produce", size: [0.086, 0.072, 0.086], appearance: "略扁的分瓣红果与五角绿色萼片" },
  potato: { nameEn: "potatoes", nameZh: "土豆", category: "produce", unitEn: "bag", phraseEn: "a bag of potatoes", phraseZh: "一袋土豆", shelf: "produce", size: [0.15, 0.185, 0.09], appearance: "纸袋中的不规则土豆、可见芽眼与提口" },
  carrot: { nameEn: "carrot", nameZh: "胡萝卜", category: "produce", unitEn: "carrot", phraseEn: "a carrot", phraseZh: "一根胡萝卜", shelf: "produce", size: [0.055, 0.24, 0.055], appearance: "渐细锥形根部、横向纹路与短叶柄" },
  lettuce: { nameEn: "lettuce", nameZh: "生菜", category: "produce", unitEn: "head", phraseEn: "a head of lettuce", phraseZh: "一颗生菜", shelf: "produce", size: [0.16, 0.13, 0.16], appearance: "由内向外包裹的起伏叶片与浅色叶脉" },
  cucumber: { nameEn: "cucumber", nameZh: "黄瓜", category: "produce", unitEn: "cucumber", phraseEn: "a cucumber", phraseZh: "一根黄瓜", shelf: "produce", size: [0.05, 0.23, 0.05], appearance: "略弯长果、收窄两端与深浅纵纹" },
  cereal: { nameEn: "cereal", nameZh: "早餐麦片", category: "pantry", unitEn: "box", phraseEn: "a box of cereal", phraseZh: "一盒早餐麦片", shelf: "ambient", size: [0.17, 0.25, 0.065], appearance: "直立纸盒、盒顶折缝与麦穗图案" },
  pasta: { nameEn: "pasta", nameZh: "意大利面", category: "pantry", unitEn: "packet", phraseEn: "a packet of pasta", phraseZh: "一包意大利面", shelf: "ambient", size: [0.10, 0.27, 0.048], appearance: "长形开窗袋、窗内独立直条意面" },
  rice: { nameEn: "rice", nameZh: "大米", category: "pantry", unitEn: "bag", phraseEn: "a bag of rice", phraseZh: "一袋大米", shelf: "ambient", size: [0.135, 0.19, 0.065], appearance: "米色鼓袋、透明视窗与米粒" },
  flour: { nameEn: "flour", nameZh: "面粉", category: "pantry", unitEn: "bag", phraseEn: "a bag of flour", phraseZh: "一袋面粉", shelf: "ambient", size: [0.12, 0.195, 0.075], appearance: "卷口纸袋、面粉标签与麦穗线条" },
  sugar: { nameEn: "sugar", nameZh: "白糖", category: "pantry", unitEn: "bag", phraseEn: "a bag of sugar", phraseZh: "一袋白糖", shelf: "ambient", size: [0.10, 0.16, 0.065], appearance: "蓝白糖袋、折叠封口与糖粒图案" },
  tea: { nameEn: "tea", nameZh: "茶", category: "pantry", unitEn: "box", phraseEn: "a box of tea", phraseZh: "一盒茶", shelf: "ambient", size: [0.125, 0.105, 0.062], appearance: "森林绿茶盒、顶盖接缝与茶叶图案" },
  coffee: { nameEn: "coffee", nameZh: "咖啡", category: "pantry", unitEn: "jar", phraseEn: "a jar of coffee", phraseZh: "一罐咖啡", shelf: "ambient", size: [0.085, 0.145, 0.085], appearance: "棕色可见内容物罐身、深色旋盖与咖啡豆图案" },
  soap: { nameEn: "soap", nameZh: "香皂", category: "household", unitEn: "bar", phraseEn: "a bar of soap", phraseZh: "一块香皂", shelf: "household", size: [0.092, 0.038, 0.06], appearance: "圆润皂块与中间环绕纸套" },
  shampoo: { nameEn: "shampoo", nameZh: "洗发水", category: "household", unitEn: "bottle", phraseEn: "a bottle of shampoo", phraseZh: "一瓶洗发水", shelf: "household", size: [0.075, 0.205, 0.05], appearance: "扁圆瓶肩、翻盖接缝与护理标签" },
  tissues: { nameEn: "tissues", nameZh: "抽纸", category: "household", unitEn: "box", phraseEn: "a box of tissues", phraseZh: "一盒抽纸", shelf: "household", size: [0.22, 0.145, 0.115], appearance: "长方形纸盒、椭圆抽口与立体抽出纸张" },
} as const satisfies Record<string, AssetDefinition>;

export type ProductAssetId = keyof typeof definitions;
export interface ProductAssetDefinition extends AssetDefinition {
  id: ProductAssetId;
  modelReady: true;
  modelUrl: string;
  thumbnailUrl: string;
  gameplay: "active" | "library-only";
  audio: { wordUrl: string; phraseUrl: string } | null;
}

export const PRODUCT_LIBRARY_VERSION = "corner-shop-products@1.0.0";
export const PRODUCT_ASSET_IDS = Object.freeze(Object.keys(definitions) as ProductAssetId[]);
export const PRODUCT_ASSETS = Object.freeze(Object.fromEntries(PRODUCT_ASSET_IDS.map((id) => [id, Object.freeze({
  ...definitions[id], id, modelReady: true,
  modelUrl: `/assets/sim3d/products/${id}.glb`, thumbnailUrl: `/assets/sim3d/products/${id}.png`,
  gameplay: "active",
  audio: id === "milk" || id === "bread" ? {
    wordUrl: `/assets/sim3d/audio/${id}.ogg`, phraseUrl: `/assets/sim3d/audio/${id}-phrase.wav`,
  } : null,
})]))) as Readonly<Record<ProductAssetId, ProductAssetDefinition>>;
export const PRODUCT_ASSET_LIST = Object.freeze(PRODUCT_ASSET_IDS.map((id) => PRODUCT_ASSETS[id]));

export function isProductAssetId(value: unknown): value is ProductAssetId {
  return typeof value === "string" && Object.hasOwn(PRODUCT_ASSETS, value);
}

export function filterProductAssets(query = "", category?: ProductCategoryId): ProductAssetDefinition[] {
  const needle = query.trim().toLocaleLowerCase();
  return PRODUCT_ASSET_LIST.filter((asset) => (!category || asset.category === category)
    && (!needle || `${asset.id} ${asset.nameEn} ${asset.nameZh} ${asset.phraseEn} ${asset.appearance}`.toLocaleLowerCase().includes(needle)));
}

export function productAssetCode(id: ProductAssetId): string {
  if (!isProductAssetId(id)) throw new Error(`Unknown product asset: ${String(id)}`);
  return `import { createProductAsset } from "./sim3d/product-library";\n\nconst product = createProductAsset(scene, "${id}", "shelf-${id}-01");\nproduct.position.set(0, 0.9, 0); // 米；底部对齐货架表面`;
}

export function productLibraryManifest(): object {
  return {
    version: PRODUCT_LIBRARY_VERSION, units: "metres", origin: "bottom-centre", front: "-Z",
    source: "Project-authored procedural Babylon.js geometry and PBR materials; milk/bread retain their recorded texture sources.",
    gameplayNote: "All 30 products are integrated with selectable procurement, delivery, stocking and checkout. Recorded word and phrase audio remains available only for milk and bread; other products use optional browser speech in the game. Model integration is not evidence of language mastery.",
    factory: "src/sim3d/product-library/index.ts#createProductAsset", categories: PRODUCT_CATEGORIES,
    products: PRODUCT_ASSET_LIST,
  };
}
