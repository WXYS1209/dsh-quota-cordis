<div align="center">

<img src="docs/icon.png" alt="DSH provider quota, spend and model management plugin icon" width="160">

# DSH Provider Quotas, Spend and Model Management

**Provider quotas, OpenAI spend and company-grouped model management for DeepSeek Harness Desktop. No npm runtime dependencies or install scripts.**

[![Stars](https://img.shields.io/github/stars/WXYS1209/dsh-quota-cordis?style=flat&label=stars&color=f59e0b)](https://github.com/WXYS1209/dsh-quota-cordis/stargazers)
[![npm](https://img.shields.io/npm/v/dsh-quota-cordis?label=npm&color=0891b2&logo=npm)](https://www.npmjs.com/package/dsh-quota-cordis)
[![Open Plugin Market](https://img.shields.io/endpoint?url=https%3A%2F%2Fdshopen.org%2Fbadge%2Fdsh-quota-cordis.json%3Flang%3Den)](https://dshopen.org/plugins/dsh-quota-cordis/)

[中文说明](<README.zh.md>) &nbsp;|&nbsp; [npm](https://www.npmjs.com/package/dsh-quota-cordis) &nbsp;|&nbsp; [MIT](<LICENSE>)

</div>

## Install

This documentation covers **0.7.4**. The declared DSH range remains `>=0.2.2-rc.1 <0.2.3-0`; the recommended and source-audited baseline is **0.2.2-rc.5**, not a re-test of every earlier RC.

```sh
dsh plugin --profile desktop add dsh-quota-cordis
# or a local checkout
dsh plugin --profile desktop add /path/to/checkout
```

After updating plugin code, restart DSH and fully refresh the page. The form's **Reload** button refreshes data, not code.

## Features

- **Provider quotas:** provider balances, subscription windows and OpenAI spend details.
- **Model management:** company grouping/search, supported provider and model editing, model discovery and custom API routes; unsupported editors remain read-only.
- **Color settings:** configurable remaining-quota thresholds.
- **Composer summary:** compact current-provider status with an upward popup.
- **Agent tools:** `provider_quota`, `quota_color_settings` and `provider_company_rules`.

## Provider support

**Accepted** means historical live-account acceptance, not a new full rc.5 verification. Current SDK/source and synthetic tests are separate evidence. See [verification history](<CHANGELOG.md#060--2026-11-10>).

| Provider | Display | Status |
|---|---|---|
| DeepSeek API | Available, recharge and granted balance | Accepted |
| DeepSeek account | Separate recharge and bonus wallets | Accepted |
| GLM Coding Plan — China | Subscription windows | Accepted |
| GLM Coding Plan — Global | Subscription windows | Preview |
| GLM Standard API — China | CNY balance and resource packages | Preview |
| Z.AI Standard API — Global | Detection/status only | No balance query |
| OpenAI API | Organization spend: UTC today, yesterday, 7d/30d; API-key breakdown | Accepted |
| OpenAI Codex | Subscription windows and reported Credits | Windows accepted; Credits preview |
| OpenCode Go | Reported 5-hour/weekly/monthly windows | Preview |
| MiniMax China M Plan | Remaining quota | Accepted |
| Other providers/relays | Status and reason | No quota adapter |

Preview features still need live-account validation. Missing data is not shown as zero; Credits are usage units, not an API cash balance.

## Usage notes

- **OpenAI spend needs a separate organization Admin key**, not an inference key. Enter it in OpenAI details; cost data may arrive late or be revised.
- Companies follow the actual Host-resolved endpoint first. If no route endpoint exists, a version-matched built-in catalog with a single model hostname can supply a separately labelled grouping hint; it does not change the request endpoint. Saved user settings or configured authentication sort first, then localized names; unknown endpoints stay last. Merely enabling a default entry does not count. Edit expands inside its card; discovery uses a dialog and explicit selection. Final **Save** persists changes; editing does not switch the selected/default model.
- **Reasoning efforts** can be inherited, disabled, or configured per editable model where the Host schema supports them. Blank platform values use the selected level's name, except a supported blank `off` uses the protocol default. Choose the effort for a conversation in DSH's native model selector.
- **Fetch available models** tries the platform first on supported listing routes (OpenAI-compatible, Anthropic and Gemini). The dialog labels live results and their credential scope. If live listing fails or is unsupported, it uses the existing DSH catalog when that fallback is safe, without retrying a failed custom endpoint. A successful empty list is not replaced. Fixed platform endpoints follow the DSH Host's outbound proxy settings; custom endpoints need direct public HTTPS access. OpenAI live listing uses an API key, not ChatGPT subscription authorization. Codex uses the DSH built-in catalog.
- **Codex login is built into this plugin using DSH native authorization; no extra OAuth UI plugin is required.** Login starts only on an explicit click and is safely unavailable if the native capability is missing. Existing native-grant quota/Credits queries remain independent of signing in here. The new login integration has source/synthetic coverage, not a new live-account OAuth acceptance.

## Privacy and maintenance

Credentials stay on the local Host and never enter quota results. Quota queries are read-only, use fixed official HTTPS destinations and reject redirects. Native DeepSeek endpoint checks fail closed on invalid, uncertain or relay addresses; no official balance probe or stale official balance is substituted. The quota adapter does not read CLI credentials, cookies or refresh tokens, and does not refresh grants or run inference.

See [security boundaries](<SECURITY.md>) and [company-rule coverage/maintenance](<docs/COMPANY_COVERAGE.md>) for endpoint precedence, private-state handling and rule updates.

## Development

- `index.js` / `client.js` — Host and browser entry points.
- `src/` — runtime modules; bundled data lives in `src/data/`.
- `company-rules.json` — published company-rule data, also fetched online at runtime, so it stays at the repository root.
- `locale/`, `icon.png`, `cordis.patch.yml` — package resources.
- `test/`, `scripts/`, `docs/` — tests, maintenance scripts and documentation.

```sh
npm run check
npm test
npm run test:company-coverage
```

Tests do not replace real-browser/provider acceptance. Release notes: [Changelog](<CHANGELOG.md>).
