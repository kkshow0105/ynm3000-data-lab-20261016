# Isolated budget ledger

Only sanitized request reservations. No market data, secrets, logs, or personal settings.

This orphan branch is never merged into main and is not connected to Netlify. Entries are append-only. A failed or cancelled run never refunds its reservation. Branch deletion, uncertain writes, failed readback, or invalid integrity must stop all provider requests. Automatic reinitialization is prohibited.

Real collection is locked: provider reset policy and full external usage are not confirmed. simulation reservations are virtual costs and never call FMP/FRED. The rolling 24-hour project cap is an additional conservative safeguard, not a claim about provider reset time.
