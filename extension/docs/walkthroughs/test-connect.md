# Step 2 — Connect

Once you've saved a profile, run **FileMaker: Connect** (or right-click the
profile in the FileMaker sidebar and choose **Connect**).

Connect will:

1. **Authenticate** — opens a session against the Data API and stores the
   token in your OS keychain.
2. **Refresh proactively** — the extension renews the token before its
   nominal 15-minute expiry, so long-running queries don't get kicked out.
3. **Retry transient failures** — network blips, 5xx errors, and timeouts
   are retried with exponential backoff so you don't have to.

You'll see a status-bar item showing connection state. The first time the
session token times out due to inactivity, the extension reconnects
automatically.

> **If Connect fails**, the error toast offers **Retry**, **Edit Profile**,
> and **Show Details**. The Details document is redacted but includes the
> retry chain and the failing endpoint — useful for filing bug reports.
