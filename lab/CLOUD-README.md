# One-time cloud collector verification

This is an isolated compatibility experiment, not a market data publisher.
- workflow_dispatch only; default mode offline. No schedule and no Netlify integration.
- Cloud mode also requires confirm_live=true and an unused cloud-proof-v1 reservation.
- Hard maximum: FMP 6 requests, FRED CSV 2 requests; no network retry.
- Only code, synthetic tests, and a metadata-only quota ledger are committed.
- Real responses stay in RUNNER_TEMP and are removed at the end; no artifact upload.
- The workflow emits only HTTP status, field checks, counts, dates, and readiness flags.
- FMP_API_KEY belongs in repository Actions Secrets. Never put a key in this repository.
- Existing FRED collectors use public fredgraph.csv and do not require an API key. If a future official API adapter uses FRED_API_KEY, it must also be a Secret.
- A successful complete check does NOT authorize publishing or redistributing the received data.
- Budget reservations survive workflow failure/cancellation and are not refunded. An approved daily baseline is required; account usage outside this repository is not automatically discoverable.
- Repeating this one-time experiment is blocked even for a new workflow run ID. Further live experiments need review and a deliberately revised reservation policy.
