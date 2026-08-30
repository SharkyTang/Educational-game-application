# 素材来源记录

## 第一人称 3D S0（2026-08-30）

| 文件 / 资产 | 来源与许可 | 处理与用途 |
| --- | --- | --- |
| `public/assets/sim3d/customer.glb` | Microsoft Rocketbox，模型和动作库 MIT；固定提交 `0943055db6ec570bcef9f2c8b41c9e5467c808f9` | Female_Adult_01 成人模型、idle / walk；转 GLB、压缩贴图内嵌、去除水平根位移，约 1.61 MiB |
| `public/assets/sim3d/customer-LICENSE.txt` | 上述库的完整 MIT 声明 | 随资产保留，转换过程见 [customer-SOURCE.md](../public/assets/sim3d/customer-SOURCE.md) |
| `public/assets/sim3d/audio/milk.ogg`、`bread.ogg` | Judith Franck / Association Shtooka，CC BY 3.0 US | 英式真人单词录音，未剪辑；实际下载源、元数据与哈希见 [audio-SOURCES.md](../public/assets/sim3d/audio/audio-SOURCES.md)，游戏近看页附署名、许可与来源链接 |
| `public/assets/sim3d/oak-floor.png` | 本任务由 OpenAI 图像工具生成 | 平铺橡木颜色贴图；原图 `exec-cf2043ff-9eeb-461c-9aa0-23b5e3d0eef8.png` 保留在 Codex 归档 |
| `public/assets/sim3d/bread-crust.png` | 本任务由 OpenAI 图像工具生成 | 面包表面颜色贴图；原图 `exec-0bd56941-3c0c-4705-a033-8cf04a8fb866.png` 保留在 Codex 归档 |
| 商品、房间、家具、货箱、手部与提篮几何 | 本项目程序化制作 | 真实形状网格、PBR 材质与程序排版标签；手部仍是小样精度 |

3D 商品、顾客和货架独立参与渲染及状态变化，不是整张背景贴图。没有付费素材或运行时外部图像接口。临时 FBX/TGA/转换器缓存放在忽略的 `tmp/customer-source/`，不发布。

### 生成贴图的原始提示

橡木贴图：

> Create exactly one production-ready square seamless tileable BASE COLOR texture for a first-person 3D British corner shop game. Material: clean gently worn warm honey-beige European oak floor boards, actual believable oak fine grain and subtle pores, 5 long straight parallel boards across square, board lengths gently staggered. Orthographic flat straight-down scan, uniform diffuse neutral lighting, NO perspective, NO room, NO objects, NO text or labels, NO AO cast shadows, NO specular highlights, NO vignette, NO border. Soft warm medium-light oak, fine realistic details restrained for a small cosy grocery shop, NOT rustic damaged wood, NOT orange. Texture must tile on ALL four edges, grain running vertically. Fill full square 1024x1024. This is a utilitarian game surface albedo map, not a scene or mood board.

面包表面贴图：

> Create exactly ONE square seamless tileable photorealistic base-color game texture: the fine porous golden brown baked CRUST SURFACE of a fresh white bread loaf, close up surface scan, small natural toasted freckles and minute bubbles, warm wheat-gold base with gentle caramel speckles, matte soft flour-dusted areas only sparse. Flat uniform neutral diffuse illumination. No loaf silhouette, no sliced bread, no plates, no objects, no score cuts, no perspective, no shadows, no highlights, no text. No large cracks. Fill full square edge-to-edge with consistent realistic microtexture suitable for wrapping over a rounded 3D bread mesh. Seamless on all edges. 1024x1024 square, beautiful believable fine baked surface, not stone, not reptile skin.

1024 是提示中的请求尺寸，不是工具实际返回尺寸的断言。运行资源保留实际生成图；没有额外虚构法线或粗糙度贴图。

## 历史 2D MVP

| 文件 | 来源 | 处理 | 用途 |
| --- | --- | --- | --- |
| `public/assets/corner-shop-concept.jpg` | 先前 Codex 任务 `01a04cf0-d051-7091-9ef7-81443c48ba2d` 中由 OpenAI 图像工具生成，用户明确选定并喜欢的便利店方向 | 从原始 PNG 转为 JPEG quality 82；原 PNG 仍保存在 Codex 生成图像归档 | 首页、进货页和升级预览 |
| `public/assets/supermarket-concept.jpg` | 同一任务中由 OpenAI 图像工具生成，用户确认喜欢的大商超方向 | 从原始 PNG 转为 JPEG quality 82；原 PNG 仍保存在 Codex 生成图像归档 | MVP 完成页的长期成长预告 |

旧版店内世界由 Phaser Graphics 分层绘制，仅用于 `?legacy=1` 历史入口，不是当前 3D 场景。
