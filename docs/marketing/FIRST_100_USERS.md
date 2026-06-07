# First 100 Users — Strategy

This is the concrete plan for getting the FileMaker Data API VS Code extension
from zero discovery to ~100 active users. It's targeted at the cold-start
problem — the asymmetric, leverage-tilted moves a solo maintainer can run in
2 weeks of part-time effort, not the maintenance work that matters at 1000+.

## How we got this list

Generated via a structured workflow (`wf_55b6eecd-a0e`):

1. **Discover (5 parallel research angles)** — VS Code extension growth
   playbooks, the FileMaker community map, first-30-minutes friction audit,
   competitor scan, install-conversion drivers.
2. **Synthesize** — combined the 5 briefs into 10 leverage-tilted candidates.
3. **Verify** — one adversarial skeptic per candidate, default-refute,
   demanding falsifiable measurable outcomes.
4. **Decompose** — each surviving candidate broken into 1–3 shippable
   tickets via `ai-pipeline plan`.

**9 of 10 candidates survived adversarial review.** One was refuted
([see "Refuted candidates" below](#refuted-candidates)). The 9 survivors
decomposed into **24 GitHub tickets (#251–#274)**, all in `ai/ready-for-work`.

## The 9 strategies

Ordered by independent skeptic confidence (highest first), then by urgency.

### 1. Publish a launch post on Claris Community + FMSoup ([conf 0.85](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues?q=is%3Aissue+author%3A%40me+251))

| | |
|---|---|
| **Category** | Community |
| **Urgency** | Immediate |
| **Tickets** | #251 (record screencap) · #252 (publish post) · #253 (track referrals) |
| **Measurable outcome** | 300+ Marketplace referrals from `community.claris.com` + `fmsoup.org` in the 14 days following the post |

**Why this one first.** FileMaker devs do not browse the VS Code Marketplace.
They live on Claris Community and FMSoup. A single problem-led post
("watch me diff dev vs prod schema in 3 clicks") in the Integrations subforum
reaches the exact buyer at zero cost. Multiple research angles converged
on this as the single highest-leverage first move because the niche has
one well-defined watering hole.

### 2. Personal feedback-request DMs to 10 FM power users ([conf 0.85](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues/255))

| | |
|---|---|
| **Category** | Community |
| **Urgency** | Immediate |
| **Tickets** | #254 (draft template) · #255 (build recipient list with hooks) · #256 (send + track 30 days) |
| **Measurable outcome** | 2+ replies; 1+ public mention (blog post, podcast, or social share) within 30 days |

**Why.** The FM dev community is small enough that 7–10 named voices
(Decorte, Geist, Senft-Herrera, Petrowsky, Beargie, Wood, Ippolite,
Carlton, Chandler, HOnza Koudelka) drive nearly all tool word-of-mouth.
A personal "I built this, would love honest feedback, no expectation
of promotion" note historically converts 2–3 of 10 into podcast mentions,
blog posts, or in-house adoption inside their consultancies.

### 3. Pitch FileMaker Weekly + ISO FileMaker Magazine ([conf 0.85](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues/257))

| | |
|---|---|
| **Category** | Distribution |
| **Urgency** | Immediate |
| **Tickets** | #257 (Daniel Wood pitch) · #258 (Matt Petrowsky pitch) |
| **Measurable outcome** | 1 confirmed mention in either newsletter within 60 days; 100+ installs in issue week |

**Why.** A single mention from Daniel Wood at FileMaker Weekly or
Matt Petrowsky at ISO FileMaker Magazine carries trust no marketplace
SEO will match. Each newsletter touches a concentrated slice of the
active dev population in one send. Cost: 30 minutes of email drafting
per outlet.

### 4. Publish to Open VSX (Cursor + Windsurf reach) ([conf 0.85](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues/265))

| | |
|---|---|
| **Category** | Distribution |
| **Urgency** | Immediate |
| **Tickets** | #265 (claim deffenda namespace + OVSX_PAT) · #266 (add ovsx publish step + ship first build) |
| **Measurable outcome** | Extension live on `open-vsx.org` within 14 days; 50+ Cursor/Windsurf installs in first 60 days |

**Why.** A non-trivial share of indie FM devs run Cursor for AI assistance
and cannot install from the VS Code Marketplace. The submission was
already tracked as issue #160 — these tickets are the concrete
decomposition. One publish step in CI, zero ongoing maintenance.

### 5. Ship self-signed cert handling ([conf 0.82](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues/259))

| | |
|---|---|
| **Category** | Friction reduction |
| **Urgency** | Immediate |
| **Tickets** | #259 (TLS overrides + agent wiring) · #260 (wizard UI) · #261 (error code mapping + one-click recovery) |
| **Measurable outcome** | Test Connection success rate above 85% within 30 days; zero open issues citing self-signed cert errors |

**Why.** The friction audit identified this as the single largest day-one
churn cause: a large share of FM Server installs use self-signed or
private-CA certs, and the wizard surfaces a raw Node error with no
recovery path. Adding a per-profile "Allow self-signed" toggle, a
CA-bundle picker, and mapped error messages prevents the "I gave up at
Test Connection" outcome that no marketing budget can recover.

### 6. Map FM error codes 212 and 9 to actionable docs ([conf 0.78](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues/262))

| | |
|---|---|
| **Category** | Friction reduction |
| **Urgency** | Immediate |
| **Tickets** | #262 (code mapping in normalizeError) · #263 (troubleshooting doc + 3 screenshots) · #264 (docsUrl as action button) |
| **Measurable outcome** | 50% reduction in repeat-failed-login attempts; zero "wrong password" issues for fmrest-related failures within 60 days |

**Why.** First-time evaluators routinely have an account without the
`fmrest` extended privilege enabled and burn 15 minutes thinking the
password is wrong. Mapping FM error code 212 to a specific message with
a 3-screenshot doc converts confused churners into successful first-query
users — a half-day fix that catches a substantial wedge of evaluators.

### 7. Rework the Marketplace listing ([conf 0.78](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues/267))

| | |
|---|---|
| **Category** | Discoverability |
| **Urgency** | Immediate |
| **Tickets** | #267 (hook description) · #268 (query-builder hero screenshot) · #269 (connection wizard GIF) |
| **Measurable outcome** | Marketplace install conversion rate (installs/views) improves 30% within 30 days |

**Why.** The first 140 chars, the first image, and one tightly scoped GIF
determine click-to-install conversion. Replacing a passive description
with a benefit hook, leading with a Contacts-layout query-builder
screenshot, and adding one sub-2 MB connection-wizard GIF is a half-day
rework that lifts conversion on every existing impression.

### 8. Verified publisher + trust signals ([conf 0.78](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues/272))

| | |
|---|---|
| **Category** | Trust |
| **Urgency** | Immediate |
| **Tickets** | #272 (verify abdenterprises.com) · #273 (last-commit + verified-publisher shields) · #274 (Security & Trust section in README) |
| **Measurable outcome** | Verified publisher badge live within 14 days; reduce listing-view-to-install drop-off by 15% within 30 days |

**Why.** FileMaker devs have been burned by abandoned solo-dev tools;
trust signals matter more than install counts at the cold-start stage.
Verifying the publisher domain (15 min + DNS propagation) adds the
blue checkmark, and a brief SECURITY-summary section in the README
("safe to use against production, read-only by default in untrusted
workspaces, passwords stored in OS keychain") answers the FM admin's
first question before they ask it.

### 9. Postman vs VS Code comparison post + collection importer ([conf 0.72](https://github.com/ABD-Enterprises/filemaker-data-api-for-vs-code/issues/270))

| | |
|---|---|
| **Category** | Content |
| **Urgency** | Soon (90-day horizon) |
| **Tickets** | #270 (comparison post) · #271 (Postman collection importer) |
| **Measurable outcome** | Post ranks page-1 Google for "FileMaker Data API VS Code" within 90 days; 200+ organic visits and 75+ click-throughs in first 90 days |

**Why.** Postman + the myFMbutler community collections is the entrenched
workflow for hitting the Data API. A single comparison post ranks for the
exact long-tail queries FM devs Google, demonstrates the FileMaker-native
advantage over a generic REST client, and converts the largest existing
addressable workflow. Shipping a Postman collection importer eliminates
the switching cost — the post can end with "and here's how to bring your
existing collection over."

## Refuted candidates

The synthesizer also proposed:

> **Open a PR to awesome-filemaker** — listing the extension in a canonical
> curated list.

**Refuted (confidence high).** The cited repo `github.com/jwillinghalpern/awesome-filemaker`
does not exist (404). The only `awesome-filemaker` repos on GitHub are
`filemaker/filemaker-awesome` and `TyrfingMjolnir/AwesomeFilemaker`, each
with 1 star and dormant since 2022 — effectively zero organic traffic.

**Better alternative the skeptic surfaced**: open an issue/PR on
`jwillinghalpern/filemaker-vscode-bundle` (37 stars, actively updated in 2026,
the real canonical FM+VSCode resource) to add this extension to the README,
AND email the maintainer directly proposing he link/recommend this extension
as the successor to his older FileMaker VS Code extension.

(This better alternative is **not** filed as a ticket yet — capture it here
in case Strategy 1 or 2 doesn't perform.)

## Execution order

Roughly the order I'd actually run these (not the same as the confidence ranking):

| Day | Action | Why now |
|---|---|---|
| 1 | #272 verify domain | Async DNS, start it first |
| 1 | #267 rewrite hook + #268 hero screenshot + #269 connection wizard GIF | Listing rework first — lifts conversion on every other channel below |
| 2 | #259 #260 #261 TLS self-signed handling | Day-one churn bug; ship before launch post |
| 2 | #262 #263 #264 fmrest error mapping | Second-biggest day-one churn |
| 3 | #265 #266 Open VSX | One CI step + a publisher claim — async approval, kick off early |
| 3 | #273 #274 trust signals + Security & Trust section | Land while the verified-publisher checkmark is in DNS propagation |
| 4 | #251 record screencap | Asset for the launch post |
| 5 | #252 publish launch post | After listing rework lands so conversion is maxed |
| 5 | #253 set up referral tracking | Same day as launch |
| 6 | #254 #255 #256 power-user DMs | Stagger; not all on day 5 |
| 7 | #257 #258 newsletter pitches | After power-user wave so the pitch can cite early traction |
| Later | #270 #271 Postman comparison + importer | 90-day play — content cooks longer |

This isn't a fixed schedule; it's the dependency-respecting order. A
non-cold-start contributor with more time could parallelize most of it.

## How we'll know it worked

Three checkpoints:

- **Day 14**: 300+ referrals from community.claris.com + fmsoup.org
  (tracked via Marketplace dashboard, per #253).
- **Day 30**: Verified publisher checkmark live (#272), Test Connection
  success rate above 85% (#259–#261 telemetry or support volume),
  zero open issues citing self-signed cert errors.
- **Day 60**: 1+ newsletter mention (#257 or #258); 50+ Cursor/Windsurf
  installs from Open VSX (#266); installs cross 100 cumulative on
  Marketplace.

If any of these miss by more than 50%, the strategy needs rethinking —
not "more posts." See the refuted-candidates section for one
ready-to-deploy alternative.

## Out of scope for this doc

- **Beyond 100 users**: scale-stage plays (telemetry framework #169,
  i18n scaffolding #161, JSDoc API ref site #162, etc.) are tracked
  in Round E / F backlogs but not the cold-start path.
- **Paid acquisition**: there is no ad budget. Every strategy here
  is organic.
- **Open-source contribution channels** (Hacktoberfest, GitHub Stars):
  too noisy for the FM niche; deferred until the product has
  social proof to anchor a contributor pitch.

## Maintaining this doc

If a strategy fails its measurable outcome by more than 50%, document
**why** in a new section below — that's the next quarter's input.
If a strategy succeeds, mark it `[shipped]` in the heading and link
the evidence. Don't delete failed strategies; they're the most valuable
artifacts of the work.
