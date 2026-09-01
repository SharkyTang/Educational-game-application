# 素材来源记录

## 小店背景音乐与操作音效（2026-08-31）

| 文件 / 资产 | 来源与许可 | 处理与用途 |
| --- | --- | --- |
| `public/assets/sim3d/audio/local-forecast.mp3` | Kevin MacLeod / incompetech.com，CC BY 4.0；原版 Local Forecast，ISRC `USUAN1300010`，93 BPM | 官方原始 MP3，未剪辑或转码，仅重命名；解码后整曲连续循环，随暂停保留位置，英语语音期间自动压低音量 |
| `src/sim3d/shopAudio.ts` 中四种短音效 | 本项目原创程序合成，无第三方采样资产 | 顾客进店门铃、成功上架轻碰、扫码提示、付款成功短音；只由对应成功状态变化触发 |

MP3 为 **6,611,177 字节**，44.1 kHz 立体声、320 kbps，官方标注时长 2:45。来源链接、作者许可、署名原文和 SHA-256 见 [music-SOURCES.md](../public/assets/sim3d/audio/music-SOURCES.md)；游戏内“声音与音乐”提供曲名、作者、来源与许可链接。音乐许可只适用于该音乐资产，不覆盖本项目其他代码或资源。

音乐在点击开始后才从同源资源加载，不调用音乐平台 API。四种反馈由 Web Audio 实时合成；音乐、音效、英语发音分别控制音量。文件完整性及播放状态检查不等同于主观听感验收，最终音量可在设置中调整。

## S1 首日本地语音（2026-08-31）

本轮保留 S0 的模型、材质和两条真人单词音频，新增八条**英式合成短句**。它们是预先在本机生成的 WAV，不是运行时联网 TTS，不收取调用费用，也不是 macOS 系统 `say` 导出的声音。

| 文件 / 资产 | 来源与许可 | 处理与用途 |
| --- | --- | --- |
| `audio/greeting.wav`、`card.wav`、`thanks.wav` | Piper / Cori medium；模型作者 Bryce Beattie 的[官方页面](https://brycebeattie.com/files/tts/)明确将该模型发布为 public domain | 英式女声合成；顾客入店问候、请求刷卡、付款后道谢 |
| `audio/milk-phrase.wav`、`bread-phrase.wav` | 同一 Cori 模型 | `A carton of milk.` / `A loaf of bread.`，与原单词真人音频分开 |
| `audio/repeat-request.wav`、`affirmative.wav`、`card-repeat.wav` | 同一 Cori 模型 | 请求重说、肯定回应与刷卡句变式；是否触发由应用流程控制，不因文件存在就宣称全部对话教学已实现 |
| `audio/phrase-SOURCES.md`、`phrase-manifest.json` | 本项目记录；原始来源和第三方许可分别保留 | 台词、模型及文件哈希、格式、大小、时长、响度和复现说明 |
| `scripts/generate-speech-clips.py` | 本项目制作脚本，离线调用 Piper 1.7.0（GPL-3.0-or-later） | 只用于制作；运行时与模型不随网页发布，脚本读取 `src/sim3d/speechClips.ts` 正本台词并校验模型哈希 |

表中 `audio/` 均位于 `public/assets/sim3d/audio/`。八条 WAV 合计 **636,230 字节**，22,050 Hz、单声道、16 位 PCM；语速较模型默认值放慢，多句之间增加 0.22 秒停顿，轻微边缘淡入淡出并限制峰值。详细许可边界与复现记录见 [phrase-SOURCES.md](../public/assets/sim3d/audio/phrase-SOURCES.md)，精确身份见 [phrase-manifest.json](../public/assets/sim3d/audio/phrase-manifest.json)。

Cori 模型约 63.5 MB，从作者官网给出的直链下载；模型、隔离 Python 环境和复现检查输出均在忽略的 `tmp/`，不会进入 GitHub 或浏览器包。不能把模型许可误写成对游戏整体的许可，也不能把这些合成句子署名给 Judith Franck。Piper 仅是离线制作工具，网页播放不加载该引擎。

文件完整性/波形检查不等于声音自然度验收；后者由用户试听确认。自动播报、浏览器播放与鼠标点击的本轮结果单列在 [S1 首日验证记录](./S1_FIRST_DAY.md#验证记录)，不挪用 S0 结果。

## 顾客与街头邻居（2026-09-01）

| 文件 / 资产 | 来源与许可 | 处理与用途 |
| --- | --- | --- |
| `customer.glb`、`customer-{male-01,female-02,male-02,female-03,male-03,female-04,male-04}.glb` | Microsoft Rocketbox 固定提交，MIT；完整声明见 `customer-LICENSE.txt` | 6 个购物顾客外形与 Sam / Ellis 2 个预留外形；转为自包含 GLB，保留 `idle` / `walk` |
| `audio/customers/{female,male}/*.wav` | Piper / Cori 女声与 Martin Clifton 男声；模型许可与固定哈希见独立来源记录 | 45 句顾客台词的男女两套离线 WAV，共 90 段；运行时不加载 TTS 模型 |
| `street-dog-patch.glb` | Quaternius Animated Animals Low Poly，CC0 | Sam 的真实动画陪伴犬 Patch；自包含 GLB，保留 `idle` / `walk` |
| `audio/street-neighbours/{sam,ellis}/*.wav` | 与顾客配音相同的已审查英国英语 Piper 模型 | 41 句双语街头邻居对话的离线 WAV，角色与声线固定 |

顾客模型来源、输入文件和转换哈希见 [customer-SOURCE.md](../public/assets/sim3d/customer-SOURCE.md)，台词、模型身份和全部 WAV 哈希见 [customer-phrase-SOURCES.md](../public/assets/sim3d/audio/customer-phrase-SOURCES.md)。Patch 的来源、CC0 声明、可重现转换与哈希见 [street-dog-SOURCE.md](../public/assets/sim3d/street-dog-SOURCE.md)；街头邻居配音见 [street-neighbour-SOURCES.md](../public/assets/sim3d/audio/street-neighbour-SOURCES.md)。各文件的许可只覆盖对应第三方资产，不传递给整个游戏或其他素材。

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
