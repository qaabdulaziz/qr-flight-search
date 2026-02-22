# Versioning Guide

This project uses **Semantic Versioning** (`MAJOR.MINOR.PATCH`).

## Rules

| Change type | Version bump | Example |
|---|---|---|
| Bug fix, small improvement | PATCH | 2.0.0 → 2.0.1 |
| New feature, new airport, UI improvement | MINOR | 2.0.0 → 2.1.0 |
| Breaking change, full rewrite, architecture change | MAJOR | 2.0.0 → 3.0.0 |

## Where the version number lives

The version must be kept in sync across **3 places**:

1. **`package.json`** → `"version": "X.Y.Z"` — source of truth
2. **`public/index.html`** → `<title>` tag and footer `<div>` at the bottom of `<body>`
3. **`server.js`** → health check response `{ version: 'X.Y.Z' }`

## How to bump the version (for AI agents continuing this work)

1. Decide the bump type from the table above
2. Update `package.json` version field
3. Update the version string in `public/index.html` (title + footer div) — search for the current version string e.g. `v2.0.0`
4. Update the version string in `server.js` health check — search for `version:`
5. Commit with message: `chore: bump version to vX.Y.Z`
6. Then commit your actual changes separately (or together if it's a single logical change)

## Version history

| Version | Date | Summary |
|---|---|---|
| 1.0.0 | 2026-02 | Initial release — 5 origins, basic search, ITA Matrix automation |
| 2.0.0 | 2026-02 | Security fixes (XSS), reliability (browser leak, DOM polling, retry logic), KWD/OMR currency support, code deduplication, input validation, dynamic default dates |
| 3.0.0 | 2026-02 | Flexible date search — full grid ±1/2/3 days on both depart and return, finds absolute cheapest combination across all origins and all date pairs. Live global best price bar, per-origin flex progress bars, winning dates shown on result cards. v2 search preserved when flexDays=0. |
| 3.1.0 | 2026-02 | Per-origin parallel lanes — each origin runs simultaneously in its own browser lane (date pairs sequential within lane). DOH also gets full flex grid search. Fixed progress counter (was stuck at 0). MAX_PARALLEL now acts as optional safety cap for low-RAM servers, defaults to one lane per origin. |
| 3.2.0 | 2026-02 | Progress bar with % + ETA. Tied price handling — all date combos at same price shown on result card, headline picked as closest to original dates. PAIRS_PARALLEL_PER_LANE=2 (configurable) runs 2 date pairs per origin simultaneously, roughly halving search time. |

## Notes for AI agents

- **Do not** bump the version for internal refactors that don't affect user-facing behaviour
- **Do** bump the version any time a user would notice a difference
- Always verify all 3 locations are updated before pushing
- The footer version in `index.html` is intentionally visible to users so they can report issues with a specific version
