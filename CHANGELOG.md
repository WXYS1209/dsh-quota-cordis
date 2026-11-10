# Changelog

All notable changes are documented here. Dates are UTC.

## 0.6.0 — 2026-11-10

First public-ready release.

- Provider discovery from the Harness provider directory, settings and credential service; unsupported relays and auth styles report a reason instead of a fake number.
- DeepSeek API-key balances (available / recharge / granted) and DeepSeek in-app account wallets, kept strictly separate.
- GLM Coding Plan (China open.bigmodel.cn and global api.z.ai) subscription windows: legacy token, credit and MCP shapes, adaptive reset countdown.
- Built-in `openai-codex`: read-only native grant lookup, main rate-limit windows only, explicit renewal guidance; never reads refresh tokens, CLI files, or sends inference probes.
- OpenAI API: Admin key entered in the quota page “API extras” tab and stored in DSH credentials (never in the profile, never echoed). Month-to-date organization spend from the official Costs API with full pagination, per-currency decimal sums, per-API-key breakdown, organization-level unattributed costs listed separately.
- Quota page tabs (Overview / Color settings / API extras), adaptive date formats, in-page popup above the composer, per-key colored subscription summary.
- Editable remaining-quota color thresholds persisted via configEditor; defaults green 50% / orange 25%.
- Hardened Admin-key resolution: only dedicated DSH credential references (`OPENAI_ADMIN_KEY_DSH`, `OPENAI_ADMIN_KEY`, `OPENAI_ADMIN_API_KEY`); no local-file fallback.
- UTC month-start zero-length range returns a known empty result without a request; stream read failures report `network`, malformed payloads report `invalid-response`.
- Agent tools `provider_quota`, `quota_color_settings`; all normalized results are credential-free.

## 0.5.x and earlier

Local development iterations (2026-11-05 → 2026-11-10): initial Host/Client plugin, GLM/DeepSeek/OpenAI adapters, native Codex usage, editable thresholds, popup UX, streaming-GET bridge fix, account grant isolation.
