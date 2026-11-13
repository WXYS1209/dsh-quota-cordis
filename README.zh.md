# 供应商额度 Provider quota

[English](README.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Desktop 的供应商余额、订阅额度与 OpenAI API 支出插件。原生 Host/Client 实现——无 npm 运行时依赖，无安装脚本。

- npm：[`dsh-quota-cordis`](https://www.npmjs.com/package/dsh-quota-cordis)
- MIT 许可证

## 安装

```sh
dsh plugin --profile desktop add dsh-quota-cordis

# 或从本地目录安装
dsh plugin --profile desktop add /path/to/checkout
```

## 功能入口

- **设置 → 供应商额度** 页面，包含三个标签：
  - *额度概览*——列出全部已配置供应商，按订阅、账户、API 支出分组。
  - *颜色设置*——配置固定绿/橙/红色板的剩余额度阈值（默认 50 / 25），通过 profile 持久化。
  - *API 额外配置*（配置了官方 OpenAI API 路由时显示）——录入 OpenAI Admin Key；密钥保存在 DSH 凭据存储，不写入 profile，也不回显。
- **输入框下方摘要**——固定高度单行显示当前供应商；点击后在独立浮层向上展开，不撑高输入区。
- **Agent 工具 `provider_quota`**——返回与界面相同的脱敏额度数据。

## 供应商支持

发现是通用的：DeepSeek Harness 中配置的每个供应商都会列出，不支持的会说明原因，而不是显示伪造的数字。额度查询按供应商逐一适配；**仅标记为“已验证”的行经过端到端验证；“预览”行尚未完成端到端验证；其他行仅供参考。**

| 供应商 | 展示内容 | 验证情况 |
|---|---|---|
| DeepSeek（官方 API Key） | 可用 / 充值 / 赠送余额 | 已验证 |
| DeepSeek 账户（App 内登录） | 充值与赠送钱包，分开列示 | 已验证 |
| GLM Coding Plan 国内（`open.bigmodel.cn`） | 订阅额度窗口（旧 Token、积分、MCP 形态） | 已验证 |
| GLM Coding Plan 国际（`api.z.ai`） | 同样的窗口模型 | 预览：仅通过合成测试，待真实账户验证 |
| OpenAI API + 独立 Admin Key | 官方 UTC 本月/当日组织支出与 API Key 细分 | 已验证 |
| 内置 `openai-codex` 订阅 | 主额度窗口（有报告时为五小时 / 周限） | 已验证 |
| OpenCode Go（`opencode-go`） | Go 套餐额度窗口（有报告时为五小时 / 周 / 月度） | 预览：仅通过合成测试，待有 Go 额度的账户进行实时验证 |
| MiniMax 中国 M Plan | 剩余额度 | 已验证（真实账户验收） |
| 其他供应商与中转 | 仅显示状态和原因 | 不适用 |

## 配置说明

- **OpenAI Admin Key**——仅用于组织级 Costs 查询与可选的 API Key 名称查询。通过 Harness 凭据服务保存，优先于任何本机文件；插件不读取 `~/.env.local`，也不使用模型推理 Key。
- **颜色阈值**——通过 `configEditor` 保存到 profile；“恢复默认”只修改草稿，点击保存才生效。
- OpenAI 支出卡片以官方 Costs API 为整个组织的 UTC 当月累计与每日支出权威来源。API Key 细分优先显示 Admin 接口允许查询到的 Key 名称；不可用时回退显示 ID。账单数据可能滞后于控制台，且不是剩余余额。
- OpenCode 额度仅适用于 OpenCode Go 套餐和 `opencode-go` 路由；不会把通用 OpenCode Zen 路由当作 Go 订阅查询。
- MiniMax 额度使用官方中国 M Plan 接口 `https://www.minimax.cn/v1/token_plan/remains`，把当前供应商密钥作为 Bearer Token 发送（见[官方 FAQ](https://platform.minimax.cn/docs/m-plan/faq.md)）。此功能针对订阅 Key；普通 API Key 与 M Plan 订阅 Key 不通用，且本插件不会查询未有官方文档的按量付费余额接口。只解析服务端报告的剩余百分比；图片/视频条目依据 FAQ 仅展示周窗口，不根据含义有歧义的 `*_usage_count` 字段推算百分比。尚待真实账户验证。

## 隐私与安全

- 凭据仅在本地 Host 解析和使用；标准化结果不包含任何凭据。
- 额度请求只发往固定的官方 HTTPS 端点并拒绝重定向；不发起推理调用、不扫描本机文件、不向中转传递凭据。
- Codex 适配器只读取已有的原生 `openai-codex` 授权——不读刷新令牌、CLI 文件或 Cookie——需要续期时明确提示，而不是猜测。

## 限制

- GLM monitor 端点跟随官方用量插件，可能变化；未知窗口形态会安全失败，不会显示 0%。
- 查询额度不代表 Harness 自动符合供应商套餐的调用条款。
- OpenAI 成本需要组织级 Admin Key；普通推理 Key 无法查询。

## 开发

```sh
npm run check   # 全部模块语法检查
npm test        # 162 项测试：解析器、Host 集成、安全边界
```

## 发布

本包是标准 DSH 插件 bundle：`package.json` 声明 `engines.dsh` 和客户端入口，显示元数据来自 `locale/*.json` 和 `icon.svg`。它可以像其他 bundle 一样从 npm 安装，也可以在你维护或加入 DSH 插件市场索引（format 1，由 `dsh-plugin-market-index` 校验）后被列出。

## 许可证

[MIT](LICENSE)
