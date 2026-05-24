# Connection status that persists

![Schema and batch tooling visible after connecting](../../marketplace/schema-and-batch.png)

Version 1.1.0 added a persistent status-bar item for the active FileMaker
profile. It stays visible across reloads so you can tell which profile is
connected before running a Data API command.

Connect also retries transient network failures and refreshes session tokens
before expiry, which reduces manual reconnects during longer work sessions.
