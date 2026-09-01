# 英国街头邻居：表现与互动方案

## 目标与角色安排

这项功能让商业街更像有人生活的社区，同时保留人的尊严与选择权。游戏内称
角色为“街头邻居 / street neighbour”；文档描述处境时使用“正在经历无家可归
的人 / person experiencing homelessness”，不把“homeless”当作人的固定标签。

每天只出现一位邻居，由存档种子和营业日稳定决定，并隔日轮换：

- **Sam**：男性街坊，位于远侧超市旁长椅区域；伙伴犬 **Patch** 在身边。
- **Ellis**：女性街坊，位于近侧街边长椅旁；没有狗。

这不是在判断谁“更值得帮助”。两人有姓名、普通天气与街区话题、自己的
边界和不同外形。只让 Sam 带狗，是为了表现真实存在的人犬关系，同时避免把
“英国露宿者人人带狗”当成事实。Crisis 也提醒：街头露宿只是无家可归处境中
最可见的一部分，作品不应靠单一画面代表所有经历。

## 玩家流程

1. 玩家进入近距离后只显示“按 E 打招呼”，不会自动索要钱或强制打开面板。
2. 邻居先问玩家是否愿意聊；玩家可以“聊一会儿”或“先走了”。
3. 聊天内容从天气、街区、小店与个人边界中稳定抽取，并显示英语、中文与本地
   配音。Sam 可谈 Patch；摸狗前必须先问 Sam，并让 Patch 自己靠近。
4. 玩家可问“今天什么会有帮助？”，再自愿选择不给、给 £1 或给 £2。界面应
   明确金额从小店可用资金扣除；余额不足时禁用对应按钮。
5. 每位邻居每天最多接受一次金钱帮助，防止重复点击或读档刷状态。再次交谈仍
   可进行，只会说“今天已经帮过了”；不给钱不会扣好感、经验或成就，也不会
   出现责怪、失望表情或道德提示。

`streetNeighbourCorpus.json` 现有 41 句双语内容，覆盖：征求聊天同意、普通
街区聊天、先询问需要、Patch 的接近边界、£1/£2 对应感谢、当天已帮助、不给钱
无责怪，以及“本地外展服务”信息。最后一类只是角色对本地支持有所了解，不会
真的提交个人位置、创建 StreetLink 报告或把玩家带到伪造的求助流程。

## 产品边界

- 不使用“流浪汉”“乞丐”作为 UI 身份，也不把破损衣服、悲伤动作、硬币特效
  或犬吠当作人物识别符。
- 不为给钱设置爱心值、排行榜、任务奖励或经营收益；帮助不是资源交换。
- 不预设食物、饮品、衣物或狗用品一定合适。若未来增加实物帮助，应先询问
  偏好、过敏和狗主人意见，再扣除真实库存。
- 不允许绕过人的同意替其联系服务；不存储人物位置、健康或其他敏感信息。
- 不把 StreetLink 做成游戏按钮。英国各地服务范围和紧急规则会变化，真实求助
  信息只能放在独立、可维护的教育说明中，并注明地区与紧急情况边界。
- 若将来扩充第三、第四位街坊，应增加不同年龄、族裔、住房经历和是否养宠物的
  组合，并优先邀请有亲历经验的人审阅语气与视觉表现。

## 英国语境依据（2026-09-01 核验）

- [Crisis：Reframing homelessness in the United Kingdom](https://www.crisis.org.uk/ending-homelessness/homelessness-knowledge-hub/services-and-interventions/reframing-homelessness-in-the-united-kingdom-a-frameworks-messagememo-2018/)
  建议以尊严、相互依存和具体解决方案叙事，避免“我们/他们”、怜悯化和只展示
  街头露宿的单一画面。
- [Crisis：How to help someone experiencing homelessness](https://www.crisis.org.uk/ending-homelessness/how-to-help-someone-experiencing-homelessness/)
  强调没有一刀切的方法：安全时先打招呼、尊重不想交谈的选择、询问对方真正
  需要什么；如考虑转介 StreetLink，也应先征求本人意见。
- [Homeless Link：How language impacts EDI](https://homeless.org.uk/knowledge-hub/how-language-impacts-edi/)
  建议语言不确定时先询问，并以好奇、无评判的态度回应个人选择。
- [Dogs Trust Together Through Homelessness：Concerned about someone](https://www.dogstrusthopeproject.org.uk/about/concerned-about-someone-experiencing-homelessness)
  说明一些人和狗有很紧密的关系；接近或抚摸狗前要先获得主人的同意，并询问
  对方是否希望被转介，而不是擅自行动。
- [Dogs Trust：Building confidence around dogs](https://www.dogstrusthopeproject.org.uk/downloads/building-confidence-around-dogs.pdf)
  要求缓慢安静地接近、等待主人回答，并让狗自己决定是否互动。
- [StreetLink：What is StreetLink?](https://thestreetlink.org.uk/about)
  说明该平台把英格兰和威尔士正在街头露宿的成年人连接到当地外展支持；它会
  处理精确地点与人物描述，因此本游戏不模拟真实提交或收集这些数据。

这些来源用于内容与交互边界，不代表相关机构认可本游戏。真实政策、服务范围与
联系方式可能变化，发布教育链接前应重新核验。

## 内容与素材契约

- 人物选择和台词：`src/sim3d/streetNeighbourContent.ts` 与
  `src/sim3d/streetNeighbourCorpus.json`。
- 人物模型：与顾客使用相同的 Microsoft Rocketbox/MIT 管线，由独立模型任务
  提供 `customer-male-04.glb` 与 `customer-female-04.glb`。
- Patch：Quaternius 的真实 CC0 动画犬模型，来源、输入/输出哈希和转换步骤见
  `public/assets/sim3d/street-dog-SOURCE.md`。
- 配音：Sam 使用已审查的英国男声，Ellis 使用已审查的英国女声；41 个 WAV
  共 5,163,356 bytes，独立清单与来源见
  `public/assets/sim3d/audio/street-neighbour-SOURCES.md`。

自动测试校验种子/日期轮换、台词映射、无狗场景隔离、双语字段、WAV 格式与
哈希、GLB 内嵌性、动画名和许可证记录。2026-09-01 已在真实 Babylon.js 场景
人工走到 Ellis、Sam 与 Patch 身边，复核人物朝向、Patch 的体型与待机动作、
碰撞距离、双语字幕、同意式对话、£1 真实扣款及当天防重复；1374 项单测、
类型检查、生产构建和 43 项完整 Chromium 回归（双 worker、零重试）均通过。
