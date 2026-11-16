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

| Provider name | Shown | Verified |
|---|---|---|
| DeepSeek official API (`deepseek`, `deepseek-official`) | Available / recharge / granted balance | Yes |
| DeepSeek account (`deepseek-account`; in-app sign-in) | Recharge and bonus wallets, listed separately | Yes |
| GLM Coding Plan — China (`zai-coding-cn`) | Subscription windows (legacy token, credit, MCP shapes) | Yes |
| GLM Coding Plan — Global (`zai`) | Subscription quota windows from the official Z.AI monitor | Preview — uses the official usage-query endpoint/schema; live account verification pending |
| Z.AI Standard API / custom routes (custom provider IDs) | No documented API for account balance / bundle remaining / spend; official billing-console link | Console only |
| OpenAI API + separate Admin key (`openai`) | Whole-organization spend for selectable 1d / 7d / 30d complete UTC-day windows (excluding today), with matching API-key breakdown | Yes |
| OpenAI Codex subscription (`openai-codex`) | Main rate-limit windows (5-hour / weekly when reported) | Yes |
| OpenCode Go (`opencode-go`) | Go subscription windows (5-hour / weekly / monthly when reported) | Preview — synthetic tests only; live verification pending a Go-enabled account |
| MiniMax M Plan — China (`minimax-cn`) | Remaining quota | Yes — live account verified |
| Other providers and relays | Status and reason only | Not applicable |

## Configuration notes

- **OpenAI Admin key** — used only for the organization Costs endpoint and optional API-key name lookup. It is stored through the Harness credential service and used only for these OpenAI queries; model inference keys are not used.
- **Color thresholds** — saved via `configEditor` into the profile; restoring defaults only edits the draft until you save.
- The OpenAI spend card shows whole-organization spend for selectable 1d / 7d / 30d windows of complete UTC calendar days, ending yesterday and excluding today. Its API-key breakdown follows the selected window and displays the configured key name where the Admin endpoint permits lookup, falling back to the ID if unavailable. Costs data can lag or be backfilled, so completed-day totals may change; this is not a balance.

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
npm test        # 168 tests: parsers, host integration, security boundaries
```

## Publishing

This package is a standard DSH plugin bundle: `package.json` declares `engines.dsh` and the client entry, and display metadata comes from `locale/*.json` plus `icon.svg`. It installs from npm like any bundle, and it can be listed in a DSH plugin-market index (format 1, validated by `dsh-plugin-market-index`) once you maintain or join an index.

## License

[MIT](LICENSE)
