# 小店商品素材库 v1

本轮开始时，可复用的 3D 商品只有 **牛奶、面包 2 种**。本库保留这两款模型，并新增 **28 种**，合计 **30 种 / 6 类**。

这是可查看、导出和复用的**商品美术素材库**，不是把 30 种商品自动加入经营。`milk`、`bread` 已接入游戏；其他 28 种的订单、库存规则、定价和音频仍需在后续关卡设计中接入。原首日进度不会被素材库读取或改写。

## 打开与调用

游戏首页点击 **商品素材库**，或在本地游戏地址后加 `?assets=1`。例如 `npm run dev` 默认启动后打开 [商品素材库](http://localhost:4173/?assets=1)。本次独立核验使用 [4210 端口预览](http://127.0.0.1:4210/?assets=1)。

- 按分类或中英文搜索，选择商品查看真实 3D 模型。
- 拖动旋转、滚轮缩放；也可使用旋转与复位按钮。
- 每件商品附有英文、中文、计量表达、推荐陈列位置和模型尺寸。
- 可以复制 ID / 调用代码，下载单品 GLB 或完整 JSON 清单。
- 模型、标签、尺寸和调用接口是同一套数据；预览不是另一张替代图片。

## 完整清单

| 分类 | ID | 英文 | 中文 | 常用表达 |
| --- | --- | --- | --- | --- |
| 饮料 | `milk` | milk | 牛奶 | a carton of milk |
| 饮料 | `water` | sparkling water | 气泡水 | a bottle of sparkling water |
| 饮料 | `orange-juice` | orange juice | 橙汁 | a carton of orange juice |
| 饮料 | `cola` | cola | 可乐 | a can of cola |
| 烘焙与零食 | `bread` | bread | 面包 | a loaf of bread |
| 烘焙与零食 | `crisps` | crisps | 薯片 | a packet of crisps |
| 烘焙与零食 | `biscuits` | biscuits | 饼干 | a packet of biscuits |
| 烘焙与零食 | `chocolate` | chocolate | 巧克力 | a bar of chocolate |
| 冷藏食品 | `yoghurt` | yoghurt | 酸奶 | a pot of yoghurt |
| 冷藏食品 | `cheese` | cheese | 奶酪 | a block of cheese |
| 冷藏食品 | `butter` | butter | 黄油 | a pack of butter |
| 冷藏食品 | `eggs` | eggs | 鸡蛋 | a box of eggs |
| 蔬菜与水果 | `apple` | apple | 苹果 | an apple |
| 蔬菜与水果 | `banana` | bananas | 香蕉 | a bunch of bananas |
| 蔬菜与水果 | `orange` | orange | 橙子 | an orange |
| 蔬菜与水果 | `tomato` | tomato | 番茄 | a tomato |
| 蔬菜与水果 | `potato` | potatoes | 土豆 | a bag of potatoes |
| 蔬菜与水果 | `carrot` | carrot | 胡萝卜 | a carrot |
| 蔬菜与水果 | `lettuce` | lettuce | 生菜 | a head of lettuce |
| 蔬菜与水果 | `cucumber` | cucumber | 黄瓜 | a cucumber |
| 粮食与冲饮 | `cereal` | cereal | 早餐麦片 | a box of cereal |
| 粮食与冲饮 | `pasta` | pasta | 意大利面 | a packet of pasta |
| 粮食与冲饮 | `rice` | rice | 大米 | a bag of rice |
| 粮食与冲饮 | `flour` | flour | 面粉 | a bag of flour |
| 粮食与冲饮 | `sugar` | sugar | 白糖 | a bag of sugar |
| 粮食与冲饮 | `tea` | tea | 茶 | a box of tea |
| 粮食与冲饮 | `coffee` | coffee | 咖啡 | a jar of coffee |
| 日用品 | `soap` | soap | 香皂 | a bar of soap |
| 日用品 | `shampoo` | shampoo | 洗发水 | a bottle of shampoo |
| 日用品 | `tissues` | tissues | 抽纸 | a box of tissues |

`water` 延续旧版的「气泡水」身份，不把同一 ID 改成矿泉水。新选品是本轮素材规划，不宣称原 PRD 已冻结了这 30 个 SKU。PRD 的研究版目标还包括音频、任务和教学验证，不能用模型数量替代完成度。

## 文件与接口

| 位置 | 内容 |
| --- | --- |
| `public/assets/sim3d/products/` | 可直接复用的单品 GLB、真实渲染 PNG 缩略图、清单与来源说明 |
| `src/sim3d/product-library/catalog.ts` | 唯一商品目录、6 类分类、双语表达、模型路径、接入状态 |
| `src/sim3d/product-library/index.ts` | 统一 `createProductAsset` 工厂、米制尺寸和根节点元数据 |
| `src/sim3d/product-library/fresh-packaged.ts` | 饮料、零食、冷藏包装商品几何 |
| `src/sim3d/product-library/pantry-household.ts` | 粮食、冲饮、日用品几何 |
| `src/sim3d/product-library/produce.ts` | 果蔬形状、果皮、叶片、果梗和纸袋 |
| `src/sim3d/product-library/geometry.ts` | PBR 材质缓存、印刷标签、通用几何与网格合并 |
| `src/sim3d/product-library/AssetLibraryApp.ts` | 独立预览、筛选、导出；不创建游戏存档会话 |

在 `src/` 内的调用示例：

```ts
import { createProductAsset, PRODUCT_ASSETS } from "./sim3d/product-library";

const product = createProductAsset(scene, "orange-juice", "shelf-orange-juice-01");
product.position.set(0, 0.9, 0); // 米，底部放在货架表面
const definition = PRODUCT_ASSETS["orange-juice"];
console.log(definition.phraseEn, product.metadata.dimensions);

// 根节点销毁不销毁Scene级缓存材质；整个场景结束时再dispose Scene。
product.dispose(false, false);
```

不需要程序化源代码时，可直接加载 `public/assets/sim3d/products/<id>.glb`；网页 URL 为 `/assets/sim3d/products/<id>.glb`。例如 `/assets/sim3d/products/apple.glb`。贴图内嵌 GLB，不依赖个人机器路径。

### 模型约定

- 单位是**米**，Babylon 场景中正面朝 `-Z`；GLB 使用 glTF 的标准坐标约定，由官方导出器做转换。
- 30 款素材都以底部中心为原点，水平包围盒居中。牛奶/面包保留既有几何，仅在素材库工厂内统一锚点；游戏原工厂及摆放不变。
- 根节点元数据有 `productId`、`assetType: "product"`、`baseAnchored`、`units`、`front`、`dimensions` 和素材版本。
- `size` 是目录名义尺寸，`metadata.dimensions` 是实际模型包围盒尺寸；预览根据真实包围盒取景。
- 未知 ID 会报错，不会误生成面包；每个实例有独立节点和身份，同 Scene 内可共享材质。
- 新商品由同一工厂创建，可用于货箱、货架、手持和近看；接入领域规则前不可当作已有库存。

## 来源与边界

本轮新增商品是项目内原创程序化几何、PBR 材质和 Canvas 排版包装，不是外购模型，也不是二维商品图片。水果、叶片、瓶罐、包装折口和抽纸为实际网格；标签是原创训练商品包装，不使用真实品牌或认证标志。

牛奶和面包沿用 `src/sim3d/assets.ts` 的模型；面包外皮贴图继续遵守 [原素材来源记录](./ASSET_SOURCES.md)。没有更换现有真人录音、没有把新增 28 种标为「已配音」，也没有修改既有素材授权。

当前模型适合继续做小店原型与关卡接入。几何、导出、浏览器显示与学习效果是不同的验收事项；自动化通过不表示已经完成人工美术审定、多设备性能验证或全部教学任务。

## 验证

`npm run check` 检查类型、单测与构建；`npm run test:e2e` 检查现有流程与素材库交互。新增测试覆盖 30 个模型的有效顶点/法线、尺寸、根节点、材质缓存、非法 ID、双语目录，以及筛选、空结果、切换模型、GLB 导出和窄屏布局。真实界面另用浏览器检查。

独立制作/回归可运行 `npm run test:e2e -- --config=playwright.assets.config.ts`：使用 4211 端口与 `tmp/product-library-dist/` 独立生产构建，避免和经营回归抢端口，也避免并行源文件修改触发热更新、打断批量导出。

导出回归将模型、预览和 JSON 清单暂存到忽略的 `tmp/product-library-exports/`。最终选定 GLB / PNG / JSON 复制到上述正式素材目录，测试报告和临时运行结果不入库。
