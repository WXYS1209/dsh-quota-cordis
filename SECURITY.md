# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** flow for [WXYS1209/dsh-quota-cordis](https://github.com/WXYS1209/dsh-quota-cordis/security/advisories/new), if enabled. If private reporting is unavailable, open an issue asking for a private contact; do not include credentials or tokens in a public issue.

## Credential handling

- Provider credentials are resolved and used by the local DSH Host; normalized quota results do not contain them.
- Only the DSH built-in `zai` route (identified by the provider ID) sends its configured credential to the fixed official Global GLM Coding Plan quota-monitor endpoint. Standard API and custom Z.AI routes remain non-querying; published Z.AI API docs do not provide an account-balance/spend read endpoint. No credentials are sent to guessed console-internal endpoints.
- The optional OpenAI Admin Key is saved through the Harness credential service and sent only to fixed official OpenAI Costs and project API-key metadata endpoints over HTTPS. Key-name lookup is best effort and does not retain key secrets or owner metadata.
- The Codex quota adapter reads only the existing native `openai-codex` access grant; it does not read refresh tokens, CLI files or browser cookies, and does not perform inference or mutate the grant.
- Do not paste API keys, Admin keys, OAuth links/codes or callback URLs into issues, chat transcripts, logs or screenshots.

## Supported version

This 0.7.2 package declares DSH `>=0.2.2-rc.1 <0.2.3` compatibility. The last baseline runtime integration verification was for v0.6.0 on Desktop `0.2.2-rc.1`; MiniMax China M Plan quota reporting has since passed live-account acceptance. Please include the DSH and plugin versions in a report, but never attach credentials or raw authorization data.
