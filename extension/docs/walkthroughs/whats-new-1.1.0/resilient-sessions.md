# Resilient Data API sessions

![Schema and batch tooling visible after connecting](../../marketplace/schema-and-batch.png)

Version 1.1.0 tightened the recovery path around FileMaker sessions. Error
toasts now offer direct retry and detail actions, secret persistence has a
documented fallback mode for headless environments, and offline status is
visible without opening a diagnostic panel.

The result is less context switching when a profile, network, or storage
problem interrupts a Data API workflow.
