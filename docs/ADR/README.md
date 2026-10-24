# Architecture Decision Records

This directory records important architecture decisions for FileMaker Data API Tools.

Use a short, numbered ADR whenever a decision changes system behavior, security posture, persistence format, extension lifecycle, CI/release flow, or a public contract future maintainers will need to understand.

## Format

ADRs use the Michael Nygard-style structure:

- **Status**: Proposed, Accepted, Deprecated, or Superseded.
- **Context**: The forces, constraints, and problem that led to the decision.
- **Decision**: The choice made.
- **Consequences**: The tradeoffs, follow-up work, and operational effects.

## Naming

Use zero-padded sequence numbers:

```text
ADR-0001-short-decision-title.md
ADR-0002-short-decision-title.md
```

Do not renumber ADRs after they are merged. If a decision changes, add a new ADR and mark the old one as superseded.
