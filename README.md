# Provider quota / 供应商额度

Provider balances, subscription quotas and OpenAI API spend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Desktop. Source, releases and issue tracker: [WXYS1209/dsh-quota-cordis](https://github.com/WXYS1209/dsh-quota-cordis). Version 0.6.0 was verified on DSH `0.2.2-rc.1`. Native Host/Client plugin, no npm runtime dependencies or install scripts.

## Install

```sh
# from npm (after first publish)
dsh plugin --profile desktop add dsh-quota-cordis

# from a local checkout
dsh plugin --profile desktop add /path/to/checkout
```

Requires DSH `0.2.2-rc.1` (declared via `engines.dsh`; no version exemptions).

## 入口

- 设置 → 供应商额度：全部已配置供应商。
- 输入框下方：固定高度单行摘要，点击后在独立 `shell.overlay` 层向上覆盖显示详情，不撑高输入区。支持 Escape / 点击外部 / 关闭按钮收起；切换会话或模型自动关闭。极短视口自动使用视口内受限浮层，内容独立滚动。
- Agent 工具 `provider_quota`：与 UI 相同查询逻辑，返回脱敏额度结果。

## 能力

- 从 Harness 供应商目录、设置与凭据服务发现已保存路由，不扫描其他应用或任意环境 Key。
- DeepSeek 官方 API Key：余额、充值余额、赠送余额。
- App 内 DeepSeek 登录账户：充值钱包、赠送钱包单独列示，不混同 API Key 账户。
- 国内 GLM / 国际 Z.AI Coding Plan 个人套餐：旧 Token / 新积分 / MCP 响应，返回明确窗口时显示 5h 或 weekly。
- OpenAI 官方 API：在「供应商额度 → API 额外配置」中为已识别的官方 OpenAI 路由输入独立 Admin Key；密钥写入 Harness credentials，不进 profile。查询 UTC 本月组织总支出并按币种统计，同时按 API Key 细分（组织级未归属成本单独列出）；不将组织费用当作当前推理 Key/路由专属花费或剩余余额，也不包含 ChatGPT/Codex 订阅。
- 内置 openai-codex：只读原生已保存 OAuth 授权，查询主订阅窗口（五小时、周限等以真实时长为准），与 OpenAI API 组织支出分开展示。
- 未支持的供应商、中转、自定义认证、其他 OAuth 显示原因，不误显示 0% 或现金余额。

## OpenAI 管理凭据

当 App 配置了受支持的 OpenAI 官方 API 路由时，**设置 → 供应商额度 → API额外配置** 会显示 Admin Key 输入框。输入框不会回显已保存的值；点击保存后，密钥通过 Harness credentials 服务写入 DSH 凭据存储，profile 配置中不包含密钥。插件只从 DSH credentials 的专用引用读取，不读取本机密钥文件、普通环境文件或模型推理 Key。

额度查询只通过 DSH credentials 服务解析专用引用 `OPENAI_ADMIN_KEY_DSH`、`OPENAI_ADMIN_KEY` 或 `OPENAI_ADMIN_API_KEY`；找不到时显示未配置，绝不回退读取 `~/.env.local` 或其他文件，也不使用普通环境推理 Key。成功结果缓存 15 分钟，手动刷新有 10 秒冷却。账期采用 UTC 月初至查询时刻，界面始终标注整个组织并提示账单可能延迟；尚未提供项目筛选，不把组织金额归因到单一模型路由。

## 订阅颜色阈值设置

设置 → 供应商额度 → 颜色设置。绿色、橙色、红色固定使用 Harness 主题颜色，不可修改颜色本身；用户配置剩余额度的 greenMin 与 orangeMin，要求整数 `0 <= orangeMin < greenMin <= 100`。默认 50 / 25；绿色为剩余 >= greenMin，橙色为剩余 >= orangeMin 且 < greenMin，其余红色。每个订阅窗口独立判断；摘要、进度条、数值和订阅状态指示使用同一策略，余额与费用不受影响。

恢复默认只改变草稿；点击保存才通过 Harness configEditor 修改本插件的 colorThresholds 配置并持久化至当前 profile，其他配置保留。没有使用浏览器 localStorage，也不手写 profile 文件。页面保存后 GET 回读一致才显示成功；配置不可写或冲突时明确报错。模型工具 quota_color_settings 与页面复用同一 Host 操作。

## Codex 授权与续期边界

仅对内置 openai-codex 及精确官方端点读取 llm-pi-ai/openai-codex 记录，使用 access 和 accountId 发起固定 wham/usage GET；不读取 refresh，不写入或自行续期 grant，不读取 Codex CLI 文件，不发起登录或推理。原生适配器正常调用时仍负责自己的令牌续期；若授权已过期或接近过期，额度插件显示明确续期提示，不伪造为零额度。

账户/授权指纹仅留 Host 内存，查询前后校验；授权变化、撤销或过期时不复用旧额度。当前只展示主 rate_limit 窗口，不合并 Spark 等模型专属 additional_rate_limits，也不将订阅 credits 解释为现金余额。wham 是客户端使用的监控端点，不是保证稳定的独立公开 API。

## 安全与刷新

密钥仅在 Host 使用，不输出到浏览器、日志或工具结果。额度请求只发向固定的官方 HTTPS 端点，拒绝重定向；不自动将中转 Key 交给官方；除已明确接入的原生 Codex grant 外不读取其他供应商 OAuth 凭据记录，不扫描其他 CLI 登录文件，不执行模型推理探测。GLM 认证跟随官方用量插件，使用裸 API Key 的 Authorization，不轮试多个区域。

客户端约 2 分钟刷新，隐藏页面时暂停；API Key 查询共享 Host 缓存与同凭据并发合并。API Key 手动刷新有 10 秒冷却；失败退避 2 分钟，可保留同一凭据最近成功值并标为过期。App 登录账户通过 Harness Host 账户服务读取当前授权的本机指纹，查询前后核对授权是否变化；令牌与指纹不返回前端、不写入缓存或日志。本版不跨调用缓存或合并账户余额，也不在失败时回退旧账户数据。查询缓存仅内存，卸载/重启清除。

余额/套餐网络请求 12 秒超时，响应最大 1 MiB；OpenAI Costs 整个分页查询限 25 秒、最多 8 页、每页 1 MiB，缺失或循环游标及不完整分页均拒绝返回部分总额。账户服务由 Harness 管理；其内部超时遵循平台。无需 npm 运行依赖或安装脚本。

## 限制

GLM monitor 端点是官方插件使用的接口，不是独立稳定公开 Reference；套餐类型、字段与窗口可能改变。未知响应不猜窗口。工具可查询额度不意味着 Harness 自动符合供应商套餐调用资格，使用范围请自行核实。多 Key 无法证明同账户时不合并展示；缓存按内存密钥散列隔离，散列不发往前端。

无支持范围内的凭据时，不会为了验证添加或修改供应商。视觉核验需在实际 Desktop 完成，注册成功不等于视觉验收。

## 当前验证（2026/11/10，UI 0.6.0）

- OpenAI Admin Key 表单位于额度页动态出现的「API 额外配置」Tab；密码输入不预填、不回显，显式保存到 DSH credentials，失败不显示保存成功。Admin Key 仅从 DSH credentials 专用引用读取，既有 API 推理 Key 不变。本次升级后 OpenAI 官方费用查询仍成功，凭据已可由 DSH 凭据服务解析。
- 默认阈值为绿色 50% / 橙色 25%；已有 profile 中显式保存的阈值不自动改写。
- 「设置 → 供应商额度」内提供「额度概览」「颜色设置」两个独立 Tab，支持点击、方向键、Home/End 切换。阈值直接在颜色设置表单中填写和保存，无需打开配置文件。
- 已移除原「插件」页中的独立额度设置入口；安装后读取确认原有自定义阈值保留，查询与持久化接口未改变。

- 已用原生授权真实查询 openai-codex：服务当前返回周限窗口、已用 100%；没有返回五小时窗口，因此不虚构该项。
- 已确认供应商额度设置页为 active、旧插件页配置入口已移除，配置服务可写；此前已通过同一 Host 设置操作验证持久化与回读，本次移动没有更改已保存的自定义阈值。
- 140 项测试通过，覆盖 Codex 窗口与账户隔离、Admin Key 表单到凭据存储（含密钥不回显）、阈值持久化、CSRF、自定义颜色联动与按 API Key 细分。
- Admin Key 状态只读取 DSH credentials 专用引用；没有保存值时明确返回未配置，不检查本机文件。若旧 Admin Key 只在本机文件中，需由用户复制到额度页 API 额外配置并保存。
- 尚未人工核验新 API 额外配置 Tab 的视觉布局。

- 底部订阅摘要逐额度项独立着色，例如五小时剩余 60% 为橙色、周限剩余 10% 为红色；绿色/橙色/红色默认采用 50% 与 25% 的剩余阈值，可在「供应商额度 → 颜色设置」修改，分隔符为中性色。摘要与详情统一使用「五小时」「周限」名称。

- 可见日期统一使用 `/`：默认 `YYYY/MM/DD HH:mm`，账期为 `YYYY/MM/DD`（保留 UTC 统计范围）。
- 重置行按用户指定显示 `重制于: MM/DD HH:mm (4h5m)`；倒计时每 15 秒更新，过期显示 `0h0m`，不触发额外额度请求，卸载自动清理。
- 订阅进度条颜色仅按剩余额度判定：默认 `>=50%` 使用绿色成功令牌，`>=25%` 使用橙色警告令牌；用户可在额度设置页调整阈值，其余红色错误令牌；保留已有的已用进度含义。

- 底部详情已改为独立根级覆盖层：30px 固定摘要高度，向上优先、视口约束、独立滚动、Escape / 外部点击 / 焦点移出关闭，显式关闭恢复触发器焦点。
- 金额默认 2 位小数（极小金额提高精度），精确值与路由来源移入「数据说明」；订阅以剩余百分比为主，账单明确组织范围。
- 当前版本安装 `application: applied`、无 warnings；已确认 `local-provider-quota.popup` 覆盖层与摘要 Slot 均 active。
- 保留先前 90 项基础测试覆盖（含 20 项纯日期/倒计时/独立额度配色/定位/状态函数和 UI 静态契约测试）；0.4.1 完整测试曾为 131 项；本版结果见上方 133 项测试；没有模拟 React/DOM，也不把这些测试当作真实页面视觉验收。

历史能力验证（2026-11-05）：

- 已通过插件管理器安装至当前 Desktop profile，结果 `application: applied`，无 warnings。
- 已确认原生设置页与 composer dock 的 live Slot 注册。
- 已通过安装后的 `provider_quota` 真实查询验证 DeepSeek API Key、DeepSeek App 登录账户、国内 GLM Coding Plan 积分窗口；0.2.1 已通过用户本机专用 Admin Key 真实查询 OpenAI 官方本月组织支出。
- 未认证 HTTP 请求额度端点返回 401。
- 70 项解析、费用分页、凭据读取、Host 集成与安全边界测试通过（含账户切换与授权指纹回归）；JavaScript 语法、双语元数据、资源导出及 SVG XML 校验通过。
- 国际 GLM 为合成样例测试，未用真实国际账户验证。
- 当前会话没有浏览器控制能力，尚未核验实际页面排版、浅深色视觉、浏览器控制台及图标最终渲染。Slot 注册不替代这些验证。

## 开发

```sh
npm run check
npm test
```

通过 Harness 插件管理器安装本地目录。不要手改当前 profile 文件。安装结果若要求刷新页面或重启，请遵循其 nextStep。源码目录采用本地链接安装时不可移动或删除。

## 接口研究参考

实现为本地轻量适配器；下列项目用于端点、字段语义与兼容边界研究，不整体复制其 UI 或账户扫描代码：

- https://api-docs.deepseek.com/api/get-user-balance/
- https://docs.bigmodel.cn/cn/coding-plan/overview.md
- https://docs.bigmodel.cn/cn/coding-plan/extension/usage-query-plugin.md
- https://github.com/zai-org/zai-coding-plugins （Apache-2.0）
- https://github.com/steipete/CodexBar/blob/main/docs/zai.md （MIT）
- https://github.com/sunshaobei/dsh-balance-panel （MIT）
- https://github.com/Francesco502/dsh-quota （Apache-2.0）
