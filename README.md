# Provider quota

[中文说明](<README.zh.md>) · [npm](https://www.npmjs.com/package/dsh-quota-cordis) · [MIT](<LICENSE>)

Provider quotas, OpenAI spend and company-grouped model management for DeepSeek Harness Desktop. No npm runtime dependencies or install scripts.

## Install

Version **0.7.3** supports DSH `>=0.2.2-rc.1 <0.2.3-0`. Recommended/source-audit baseline: **0.2.2-rc.5**; rc.1–rc.4 have not each been re-tested against all new features.

```sh
dsh plugin --profile desktop add dsh-quota-cordis
# or a local checkout
dsh plugin --profile desktop add /path/to/checkout
```

After updating plugin code, restart DSH and fully refresh the page. The form's **Reload** button refreshes data, not code.

## Features

- **Institution quotas:** provider balances, subscription windows and OpenAI spend details.
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
- Companies follow the actual Host-resolved endpoint. Saved user settings or configured authentication sort first, then localized names; unknown endpoints stay last. Merely enabling a default entry does not count. Edit expands inside its card; discovery uses a dialog and explicit selection. Final **Save** persists changes; editing does not switch the selected/default model.
- **Codex login is built into this plugin using DSH native authorization; no extra OAuth UI plugin is required.** Login starts only on an explicit click and is safely unavailable if the native capability is missing. Existing native-grant quota/Credits queries remain independent of signing in here. The new login integration has source/synthetic coverage, not a new live-account OAuth acceptance.

## Privacy and maintenance

Credentials stay on the local Host and never enter quota results. Quota queries are read-only, use fixed official HTTPS destinations and reject redirects. Native DeepSeek endpoint checks fail closed on invalid, uncertain or relay addresses; no official balance probe or stale official balance is substituted. The quota adapter does not read CLI credentials, cookies or refresh tokens, and does not refresh grants or run inference.

See [security boundaries](<SECURITY.md>) and [company-rule coverage/maintenance](<docs/COMPANY_COVERAGE.md>) for endpoint precedence, private-state handling and rule updates.

## Development

```sh
npm run check
npm test
npm run test:company-coverage
```

Tests do not replace real-browser/provider acceptance. Release notes: [Changelog](<CHANGELOG.md>).
