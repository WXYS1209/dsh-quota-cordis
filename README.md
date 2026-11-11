# Provider quota

[中文说明](README.zh.md)

Balances, subscription quotas and OpenAI API spend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Desktop. Native Host/Client plugin — no npm runtime dependencies, no install scripts.

- npm: [`dsh-quota-cordis`](https://www.npmjs.com/package/dsh-quota-cordis)
- Verified on DSH `0.2.2-rc.1` (declared via `engines.dsh`)
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

Discovery is generic: every provider configured in DeepSeek Harness is listed, and unsupported ones state why instead of showing a fake number. Quota queries are per-provider adapters; **only the providers below are verified end to end. Others may work but are untested — treat their rows as informational.**

| Provider | Shown | Verified |
|---|---|---|
| DeepSeek (official API key) | Available / recharge / granted balance | Yes |
| DeepSeek account (in-app sign-in) | Recharge and bonus wallets, listed separately | Yes |
| GLM Coding Plan — China (`open.bigmodel.cn`) | Subscription windows (legacy token, credit, MCP shapes) | Yes |
| GLM Coding Plan — global (`api.z.ai`) | Same window model | Implemented, not verified with a real account |
| OpenAI API + separate Admin key | UTC month-to-date organization spend, per-currency, with per-API-key breakdown | Yes |
| Built-in `openai-codex` subscription | Main rate-limit windows (5-hour / weekly when reported) | Yes |
| Other providers and relays | Status and reason only | Not applicable |

## Configuration notes

- **OpenAI Admin key** — used only for the official Costs endpoint. It is saved through the Harness credential service and takes precedence over any local file; the plugin never reads `~/.env.local` or your model inference key.
- **Color thresholds** — saved via `configEditor` into the profile; restoring defaults only edits the draft until you save.
- OpenAI spend covers the whole organization for the UTC month to date. Billing data can lag the dashboard and is never presented as a per-model or per-route cost, nor as remaining balance.

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
npm test        # 140 tests: parsers, host integration, security boundaries
```

## Publishing

This package is a standard DSH plugin bundle: `package.json` declares `engines.dsh` and the client entry, and display metadata comes from `locale/*.json` plus `icon.svg`. It installs from npm like any bundle, and it can be listed in a DSH plugin-market index (format 1, validated by `dsh-plugin-market-index`) once you maintain or join an index.

## License

[MIT](LICENSE)
