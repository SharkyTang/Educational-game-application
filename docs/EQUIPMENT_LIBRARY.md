# 设备素材库

本轮新增 12 款可复用的原生 Babylon.js 设备模型：2 款自助收银台、3 款横式冷柜、7 款货架与陈列柜。保留已有 30 种商品模型。

进入游戏首页的「商品素材库」，再点「设备素材」；也可直接打开 `/?assets=equipment`。设备页支持中英文搜索、分类、旋转缩放、显示陈列位、复制 ID／调用代码、下载单个 GLB 和完整 JSON 清单。

## 已制作的款式

尺寸单位为米，顺序为宽 × 高 × 深；占地为宽 × 深。

| ID | 设备 | 尺寸 | 标准位置数 |
| --- | --- | --- | --- |
| `self-checkout-compact` | 紧凑自助收银台 | 1.04 × 1.63 × 0.82 | 2 个台面暂存位 |
| `self-checkout-bagging` | 宽台自助收银台 | 1.64 × 1.73 × 0.96 | 4 个台面暂存位 |
| `chest-chiller-compact` | 紧凑双层横式冷柜 | 1.30 × 1.00 × 0.90 | 24 个商品陈列位 |
| `chest-chiller-wide` | 加宽双层横式冷柜 | 1.96 × 1.04 × 1.04 | 48 个商品陈列位 |
| `island-chiller` | 大型岛式横柜 | 2.82 × 1.06 × 1.08 | 72 个商品陈列位 |
| `wall-shelf-narrow` | 窄款四层壁式货架 | 0.98 × 1.92 × 0.52 | 12 个商品陈列位 |
| `wall-shelf-wide` | 宽款四层壁式货架 | 1.68 × 2.10 × 0.64 | 24 个商品陈列位 |
| `gondola-low` | 低款四层双面货架 | 1.42 × 1.50 × 0.92 | 32 个商品陈列位 |
| `gondola-tall` | 高款四层双面货架 | 2.04 × 1.96 × 1.00 | 48 个商品陈列位 |
| `produce-tiered` | 三阶木质果蔬架 | 1.44 × 1.48 × 0.90 | 12 个商品陈列位 |
| `bakery-glass` | 三层玻璃面包柜 | 1.72 × 1.66 × 0.72 | 12 个商品陈列位 |
| `pegboard-snacks` | 三排孔板零食挂架 | 1.32 × 1.94 × 0.56 | 12 个商品陈列位 |

这些是独立空设备，有真实层板、篮底、分隔、玻璃、价签轨及收银终端等几何。不同容量同时对应不同尺寸与结构，不是给同一模型改一个数字。屏幕、小票、标牌采用项目自制图案；屏幕内容只是模型贴图。

## 容量与接入边界

`capacity` 是 `placementSlots.length`，表示标准美术陈列包围盒的数量，不是冷柜升数、仓库存量、每种商品可堆叠件数、承重或每分钟结账人数。自助收银台的 2／4 位只指台面暂存位置。

每个位置提供底部中心 `position`、允许尺寸 `maxSize`（宽／高／深）、本地 `rotationY` 和安装方式 `mount`。相邻位置互不重叠；货架和冷柜的底部有实际承托，挂架则使用上方挂钩。推荐商品只提示尺寸用途，不能代替游戏的冷藏分类、库存规则或挂装适配。挂装商品还需要挂孔／夹持连接，不能仅凭尺寸相符就悬空放置。

本轮只做素材库：**没有开启新设备购买、自助自动结账、扩大游戏库存、冷藏保鲜、开门／滑盖动画或新的装修家具选项**。`EquipmentAssetId` 独立于经营商品 `ProductId` 与装修家具标识；导入或浏览素材不会读写游戏存档。后续接入这些功能时，需要单独制定价格、解锁条件、碰撞、库存映射和顾客行为。

## 调用与摆放

工厂入口：`src/sim3d/equipment-library/index.ts`。坐标单位为米，原点在设备底部中心，Y 向上，默认正面朝 −Z。正向 `rotation.y = Math.PI / 2` 与项目现有布局的 90° 正 yaw 一致。

```ts
import { Vector3 } from "@babylonjs/core";
import {
  createEquipmentAsset, getEquipmentSlots, equipmentSlotFits,
  equipmentSlotWorldPosition, equipmentServiceWorldPosition,
} from "./sim3d/equipment-library";
import { createProductAsset } from "./sim3d/product-library";

const cabinet = createEquipmentAsset(scene, "bakery-glass", "bakery-cabinet-01");
cabinet.position.set(2, 0, -3);
cabinet.rotation.y = Math.PI / 2;

// 使用工厂返回的本地位置；不要手工重新推算层高。
const slot = getEquipmentSlots(cabinet)[0]!;
const loaf = createProductAsset(scene, "bread", "bakery-loaf-01");
const { width, height, depth } = loaf.metadata.dimensions;
if (!equipmentSlotFits(slot, [width, height, depth])) {
  loaf.dispose(false, false);
  throw new Error("商品超过该陈列位的尺寸限制");
}
loaf.parent = cabinet;
loaf.position.copyFrom(Vector3.FromArray(slot.position));
loaf.rotation.y = slot.rotationY;

const displayWorld = equipmentSlotWorldPosition(cabinet, slot.id);
const customerWorld = equipmentServiceWorldPosition(cabinet, "front");
```

`getEquipmentSlots` 返回副本，不会把一个实例的摆放修改传播给其他实例或目录。双面货架背面的 `rotationY` 为 π，商品正面朝向背面通道；设备旋转后，挂在设备下面的商品随之旋转。世界坐标助手同时考虑设备的父节点、位置、缩放与旋转。保持设备单位缩放最便于对照真实尺寸；如果缩放，应同步重新计算碰撞与通道距离。

`root.metadata` 附带实测 `dimensions`、`footprint`、`placementSlots`、`servicePoints` 和版本。尺寸与占地是未旋转的设备局部尺寸，不是摆进场景后的世界包围盒。所有设备都有 `front` 顾客服务参考点，双面货架和岛柜另有 `back`；点位在对应边缘外 0.65 米，`facing` 是指向设备的本地方向。设备旋转后可用 `Vector3.TransformNormal(Vector3.FromArray(point.facing), cabinet.computeWorldMatrix(true)).normalize()` 转为世界方向。这些点只是规划参考，不会自动加入寻路或顾客队列。`suggestedFrontClearance` 是设计建议通道宽度，不代表已经验证可通行，也不是无障碍或消防认证。

移除单个实例使用 `root.dispose(false, false)`，保留同场景其他实例共享的材质；整个预览关闭时销毁 Scene 与 Engine。不要对一个实例强制销毁共享材质。

## 文件与可再生成性

- 原始几何：`src/sim3d/equipment-library/checkouts.ts`、`refrigeration.ts`、`displays.ts`。
- 目录／陈列锚点：`src/sim3d/equipment-library/catalog.ts`。
- 出厂文件：`public/assets/sim3d/equipment/<id>.glb`、`<id>.png`、`catalog.json`。
- 来源说明：`public/assets/sim3d/equipment/SOURCES.md`。
- 交互预览：`src/sim3d/equipment-library/EquipmentLibraryApp.ts`。

GLB 包含单个空设备的几何、材质、嵌入贴图和元数据，不包含预览展台、灯光、相机、陈列位辅助线或商品。JSON 的摆放契约使用项目的 Babylon 坐标；在其他 glTF 引擎中使用时，需要尊重导出根节点变换和该引擎的左右手坐标约定，不要把 `extras` 中的本地位置直接当作世界坐标。

```sh
npm run check
npm run test:e2e -- --config=playwright.equipment.config.ts
```

设备专项使用独立生产构建与 4213 端口，避免共享代码的热更新中断导出。批量导出测试把每款真实 GLB、真实模型截图和目录 JSON 写入忽略的 `tmp/equipment-library-exports/`；确认预览与测试后再更新 `public/assets/sim3d/equipment/` 对应文件。公开文件测试核对目录一致性、PNG、GLB 内嵌资源及有限顶点／法线。几何测试核对尺寸、底部锚点、陈列净空、承托和变换，不替代后续游戏中的寻路、库存或物理验收。
