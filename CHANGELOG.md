# Changelog

All notable changes are documented here. Dates are UTC.

## 0.7.2 — 2026-11-16

- Add Global Z.AI GLM Coding Plan quota lookup for DSH's built-in `zai` provider, using the official `api.z.ai/api/monitor/usage/quota/limit` endpoint and raw-key authorization.
- Keep Standard API and custom Z.AI routes non-querying; Coding Plan monitor data is subscription quota, not cash balance or account spend.
- Link the built-in route to the official subscription usage page; note that live global-account and non-Personal tier behavior remain unverified.
- Add regression coverage for provider identity, endpoint/auth, normalized quota response, and Standard/custom-route isolation.
- Add selectable OpenAI organization spend ranges for the last 1, 7, or 30 complete UTC days (excluding today; 1d is yesterday), with matching API-key breakdowns and a bordered no-record state.
- Preserve month-to-date organization totals for the agent query and document that completed-day Costs data can lag or be backfilled.

## 0.7.1 — 2026-11-13

- Mark MiniMax China M Plan remaining quota as verified after live-account acceptance.
- Refresh the published security policy wording and DSH compatibility note.

## 0.7.0 — 2026-11-13

- Added read-only MiniMax China M Plan quota through the official `/v1/token_plan/remains` endpoint; recognizes DSH's built-in `minimax-cn` default `https://api.minimaxi.com/anthropic` as well as `api.minimax.cn`; only reported remaining percentages are normalized, and ambiguous count fields are ignored.
- Classifies registered-only official provider routes without guessing credentials; MiniMax shows a missing-credential status rather than unsupported when only registry metadata is available.
- Added read-only OpenCode Go subscription usage (rolling / weekly / monthly percentages and reset timestamps), restricted to the built-in `opencode-go` provider or the exact Go API base path; generic OpenCode Zen routes are never sent to this endpoint.
- OpenAI organization Costs now includes UTC daily spend alongside month-to-date totals and marks missing records per currency; API-key breakdowns can show best-effort names from the official project-key endpoint, while retaining ID fallback.
- MiniMax M Plan uses the official CN remains URL and Bearer-key auth. MiniMax CN route recognition was confirmed on the live DSH page; live M Plan subscription-account response validation remains pending. OpenCode Go has synthetic-test coverage only; live subscription-account verification remains pending.

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

Verification notes for 0.6.0 (2026-11-10, Desktop `0.2.2-rc.1`):

- Live queries verified: DeepSeek API-key and in-app account balances, GLM Coding Plan (China) credit windows, OpenAI organization month-to-date spend with per-API-key breakdown, and built-in `openai-codex` subscription windows.
- Provider discovery is generic; only the providers above are verified end to end. Global Z.AI is implemented but unverified with a real account.
- The quota page (Overview / Color settings / API extras tabs), composer summary and upward popup were registered and functional in Desktop; visual polish was reviewed manually on the live page.
- Unauthenticated requests to the plugin's HTTP endpoints return 401/403.

## 0.5.x and earlier

Local development iterations (2026-11-05 → 2026-11-10): initial Host/Client plugin, GLM/DeepSeek/OpenAI adapters, native Codex usage, editable thresholds, popup UX, streaming-GET bridge fix, account grant isolation.
