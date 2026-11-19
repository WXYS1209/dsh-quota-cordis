# 公司规则覆盖与维护

## 当前核对范围

当前覆盖基线使用 **DSH 0.2.2-rc.5 / pi-ai 1.3.0** 的公共供应商与内置模型目录，而不是用户 profile、凭据或实际网络请求。可复现数据见[目录快照](<../test/fixtures/dsh-provider-catalog.json>)，断言见[覆盖测试](<../test/company-catalog-coverage.test.js>)。

- 42 个内置供应商入口（同一公司可有地区、套餐和协议入口）。
- 34 个固定目录默认端点，涉及 33 个不同主机名。
- 50 个不同模型端点模式；结合默认端点，共有 **39 个不同固定主机名，全部命中公司规则**。
- Google Vertex 的 `{location}-aiplatform.googleapis.com` 仅核对固定的 `googleapis.com` 服务后缀，不伪造地区或把模板称为实际请求地址。
- Azure 目录没有固定默认/模型 URL。只有配置或环境明确提供实际地址后才进行主机名分组，不根据 `azure` 这个供应商 ID 猜测地址或公司。
- [模型目录归组数据](<../src/data/model-catalog-hosts.json>)仅在本机 DSH、pi-ai 版本与快照一致，且内置入口缺少路由级地址与部署变量、全部聊天模型端点均可解析且主机名相同时使用。当前 `opencode`、`opencode-go` 均按 `opencode.ai` 展示归组；不会把模型目录视作实际生效 URL。显式覆盖优先；无法校验的自定义模型、协议或请求头覆盖不使用目录归组。

以上数字是本次核对的安装版本，不是未来所有 DSH 版本的永久保证。覆盖测试使用当前供应商目录可确认的**不同主机名**，包含尚未配置的目录入口，不表示已发起了这些网络请求。无 URL 的路由不伪装成已覆盖。模型页仅保留公司搜索与管理入口，不展示规则版本、覆盖统计或管理提示面板。

## 公司映射

[规则源](<../company-rules.json>) 当前维护 29 家公司/运营品牌。每条数据均带有一手参考资料；没有官方中文名称的保留原品牌，不自行音译。公司标签用于识别请求端点的运营方，不根据所托管的模型归属归并，不递归合并所有母公司旗下品牌。

| 公司 / 运营品牌 | 对应目录入口或域名 |
|---|---|
| OpenAI | OpenAI、Codex；openai.com、chatgpt.com |
| DeepSeek | deepseek.com |
| 月之暗面 / Moonshot AI | Moonshot 国内/国际、Kimi Coding；moonshot.cn、moonshot.ai、kimi.com、kimi.ai |
| Anthropic | anthropic.com、claude.ai |
| Google | Gemini、Vertex 的 googleapis.com 服务后缀 |
| MiniMax | minimax.cn、minimax.io、minimaxi.com |
| 智谱 AI / Zhipu AI | bigmodel.cn、z.ai |
| SpaceXSI | Grok / x.ai；沿用原规则名称 |
| 蚂蚁集团 / Ant Group | Ant Ling / ant-ling.com；与阿里云分开 |
| Baseten | baseten.co |
| Cerebras | cerebras.ai；官方条款另证实 cerebras.net |
| Fireworks AI | fireworks.ai |
| GitHub | Copilot / githubcopilot.com、github.com；不因母公司关系与 Azure 合并 |
| Groq | groq.com；与 Grok 分开 |
| Hugging Face | huggingface.co；不按其背后的推理路由商改名 |
| Meta | meta.ai |
| Mistral AI | mistral.ai |
| NVIDIA | nvidia.com；NIM 不按被托管模型厂商分组 |
| 阿里云 / Alibaba Cloud | 仅当前目录的两个 Qwen Token Plan MAAS 精确主机；不认领任意 aliyuncs.com OSS/FC 租户 |
| Earendil Inc. | Radius / pi.dev；公司官网 earendil.com |
| Together AI | together.ai |
| Vercel | 仅 ai-gateway.vercel.sh 精确主机及 vercel.com；不认领其他 vercel.sh 租户 |
| 小米 / Xiaomi | MiMo 及地区 Token Plan / xiaomimimo.com |
| OpenCode | `opencode.ai`，含 OpenCode Models（原 Zen）和 Go；服务条款中的运营方为 Anomaly Innovations, Inc. |
| TypeSafe AI | typesafe.ai；依据官方 SDK 和公司协议 |
| 亚马逊云科技 / Amazon Web Services | 当前目录明确登记的两个 Bedrock 区域主机，精确匹配；不认领任意 amazonaws.com 租户 |
| 微软 / Microsoft | openai.azure.com、services.ai.azure.com 的官方服务子域；不认领任意 azure.com 主机 |
| Cloudflare | AI Gateway / Workers AI 的 cloudflare.com 端点；不认领 workers.dev 租户 |

## 域名选择器

schemaVersion 1 支持以下选择器：

- `domains`：PSL 注册域精确匹配，作用于同一注册域下的主机；必需数组，但可为空。
- `hostSuffixes`：经核实的公共服务后缀，匹配自身及其子域，例如 `openai.azure.com`。不能是 `co.uk`、`github.io` 等公共后缀；`googleapis.com` 是既有明确服务后缀例外。
- `exactHosts`：只匹配完整主机名。`ai-gateway.vercel.sh` 不包含其兄弟主机或子域。

一家公司至少有一个非空选择器；跨公司的重叠归属会被拒绝。新公司 ID 没有代码枚举限制；名称为纯文本，图标只允许本地白名单 ID 或 `null`，因此新增公司不必先有图标代码。当前 29 家已配置本地公司/产品品牌标记；补充资产使用固定版本的 CC0/MIT 来源，详见[品牌来源与许可](<../LICENSES/BRAND-MARKS.md>)。未来尚未内置核实品牌图标的公司仍使用通用图标，不下载远程图像或 SVG。

## 后续新增登记域名

机制支持**数据驱动扩充**，不是无人维护的公司归属查询：

1. DSH 目录或用户配置新增主机名后，未知主机继续按注册域兜底，可在公司搜索中按名称/domain 查找。界面不再展示规则管理提示或待覆盖清单；开发期覆盖测试仍检查官方目录新增端点。搜索内容与域名列表不上传，也不触发 RDAP、DNS 或网站归属查询。
2. 维护者根据官方 API 文档、官网或条款核实运营方，添加相应选择器和证据。比如新增 Bedrock 区域需将新的确切主机写入规则，不通过笼统的云托管根域提前认领。
3. 递增 `revision`、更新 UTC `updatedAt`，运行规则同步、覆盖与安全测试。
4. 发布到既定 GitHub 规则地址。Host 的每日懒检查或通过 `provider_company_rules` 工具显式检查下载验证后即可应用，无需新增公司分组代码；原有本地图标以外的新图标仍需另行更新插件资产。
5. DSH 升级时重新提取安装版公共目录并执行覆盖测试。新端点缺少规则时测试明确失败，不能静默当成已覆盖。该快照工具是开发维护工具，不是后台扫描用户安装或 profile 的任务。

```sh
# 读取安装版公共元数据，不读取 profile / 凭据：
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" scripts/snapshot-dsh-provider-catalog.js
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" scripts/snapshot-dsh-provider-catalog.js --check

npm run sync:company-rules
npm run test:company-coverage
npm test
npm run check
```

`DSH_INSTALL_DIR` 和 `DSH_NODE_EXECUTABLE` 必须指向同一运行中的 DSH 安装；Desktop ASAR 需使用该安装的 Electron Node 模式。普通回归测试读取已提交公共快照，不依赖开发者安装路径。极新的公共后缀/TLD、未来未知 schema 或新增本地图标类别仍可能需要更新插件/PSL 数据；不能承诺所有未来域名在未核实、未发布时自动获得正确公司名。

## 发布与安全边界

本地维护、测试与打包不等于推送仓库或发布线上规则；发布状态须由单独的发布流程确认，本说明不声称当前线上地址可用或仍为 404。如线上规则不可用或返回 404，则保留最近有效缓存；没有有效缓存时使用随包 29 家规则。

规则是展示元数据，不改变推理路由、额度端点白名单、凭据权限或账户/余额隔离。网络失败、404、格式无效、跨公司重叠或版本倒退都会保留最近有效数据。更新依赖固定仓库和 HTTPS，没有独立签名；结构校验本身不证明域名归属。
