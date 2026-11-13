# Provider quota

[中文说明](README.zh.md)

Balances, subscription quotas and OpenAI API spend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Desktop. Native Host/Client plugin — no npm runtime dependencies, no install scripts.

- npm: [`dsh-quota-cordis`](https://www.npmjs.com/package/dsh-quota-cordis)
- MIT licensed

## Install

```sh
dsh plugin --profile desktop add dsh-quota-cordis

# or from a local checkout
dsh plugin --profile desktop add /path/to/checkout
```

## What you get

- **Settings → Provider quota** page with tabs:
  - *Overview* — every configured provider, grouped into subscriptions, accounts and API spend.
  - *Color settings* — remaining-quota thresholds for the fixed green/orange/red palette (defaults 50 / 25), persisted through the profile.
  - *API extras* (shown when an official OpenAI API route is configured) — enter an OpenAI Admin key; it is stored in the DSH credential store, never in the profile, never echoed.
- **Composer summary** — one fixed-height line under the input box for the current provider; click for a popup that opens upward without resizing the composer.
- **Agent tool `provider_quota`** — the same credential-free normalized data the UI shows.

## Provider support

Discovery is generic: every provider configured in DeepSeek Harness is listed, and unsupported ones state why instead of showing a fake number. Quota queries are per-provider adapters; **only rows marked “Yes” are verified end to end. “Preview” rows are not yet verified end to end. Other rows are informational.**

| Provider | Shown | Verified |
|---|---|---|
| DeepSeek (official API key) | Available / recharge / granted balance | Yes |
| DeepSeek account (in-app sign-in) | Recharge and bonus wallets, listed separately | Yes |
| GLM Coding Plan — China (`open.bigmodel.cn`) | Subscription windows (legacy token, credit, MCP shapes) | Yes |
| GLM Coding Plan — global (`api.z.ai`) | Same window model | Preview — synthetic tests only; real-account verification pending |
| OpenAI API + separate Admin key | Authoritative UTC month-to-date/today organization spend and API-key breakdown | Yes |
| Built-in `openai-codex` subscription | Main rate-limit windows (5-hour / weekly when reported) | Yes |
| OpenCode Go (`opencode-go`) | Go subscription windows (5-hour / weekly / monthly when reported) | Preview — synthetic tests only; live verification pending a Go-enabled account |
| MiniMax M Plan — China | Remaining quota | Yes — live account verified |
| Other providers and relays | Status and reason only | Not applicable |

## Configuration notes

- **OpenAI Admin key** — used only for the organization Costs endpoint and optional API-key name lookup. It is saved through the Harness credential service and takes precedence over any local file; the plugin never reads `~/.env.local` or your model inference key.
- **Color thresholds** — saved via `configEditor` into the profile; restoring defaults only edits the draft until you save.
- The OpenAI spend card keeps official Costs API values authoritative for whole-organization UTC month-to-date and daily spend. Its API-key breakdowns display the configured key name where the Admin endpoint permits lookup, falling back to the ID if unavailable. Billing data can lag the dashboard and is never presented as remaining balance.
- OpenCode quota is specific to an OpenCode Go subscription and the `opencode-go` provider route. The general OpenCode Zen route is not queried as if it were a Go subscription.
- MiniMax quota uses the official China M Plan endpoint `https://www.minimax.cn/v1/token_plan/remains` with the configured provider key as a Bearer token ([official FAQ](https://platform.minimax.cn/docs/m-plan/faq.md)). It is intended for a subscription key; the official API key and M Plan key are separate, and no officially documented pay-as-you-go balance endpoint is queried. Only server-reported remaining percentages are normalized; image/video entries use weekly windows only per the FAQ, and ambiguous `*_usage_count` fields are not used to invent a percentage. Live account verification is pending.

## Privacy and security

- Credentials are resolved and used by the local Host only; normalized results never contain them.
- Quota requests go to fixed official HTTPS endpoints with redirects refused; no inference calls, no local file scans, no credential passthrough to relays.
- The Codex adapter reads only the existing native `openai-codex` access grant — never refresh tokens, CLI files or cookies — and prompts for renewal instead of guessing.

## Limitations

- GLM monitor endpoints follow the official usage plugin and may change; unknown window shapes fail safely rather than showing 0%.
- Querying a quota does not certify that Harness qualifies for a provider's plan terms.
- OpenAI Admin-key costs need an organization Admin key; a regular inference key cannot read them.

## Development

```sh
npm run check   # syntax check for every module
npm test        # 162 tests: parsers, host integration, security boundaries
```

## Publishing

This package is a standard DSH plugin bundle: `package.json` declares `engines.dsh` and the client entry, and display metadata comes from `locale/*.json` plus `icon.svg`. It installs from npm like any bundle, and it can be listed in a DSH plugin-market index (format 1, validated by `dsh-plugin-market-index`) once you maintain or join an index.

## License

[MIT](LICENSE)
