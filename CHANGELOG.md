# Changelog

All notable changes to DSH Lifeboat are documented here. The project follows Semantic Versioning.

## 0.1.1 - 2026-08-18

- Search for Bundle removal sets that make the complete Profile pass instead of minimizing a failure-inducing subset.
- Prove minimum removal cardinality within a bounded exact depth, then use a verified 1-minimal fallback without unbounded powerset enumeration.
- Withhold automatic recovery when the probe budget expires or an independent fresh-Home verification fails.
- Return equally small verified alternatives and let operators choose one in the Web UI; bind writes to the server-owned plan ID.
- Expose candidate, exact-depth, and recovery-probe limits in the advanced UI and CLI/API report options.
- Remove the obsolete failure-subset minimizer so the codebase exposes only the recovery-plan semantics.
- Derive the post-recovery manifest hash from the exact bytes atomically written, keeping restore guards complete without a second file read.

## 0.1.0 - 2026-08-18

- Add an out-of-process, loopback-only recovery console and CLI.
- Probe each candidate in a fresh temporary `DSH_HOME` and minimize reproducible failing bundle sets.
- Distinguish bundle, user-patch, bundle/patch interaction, and base-environment failures.
- Add opt-in runtime probes with repeated confirmation and an inconclusive result for unstable evidence.
- Add hash-guarded, backed-up, atomic bundle disable and restore operations.
- Add bounded diagnosis scheduling, 30-minute job deadlines, candidate/copy/output limits, graceful shutdown, health checks, persistent reports, and browser-session reconnect.
- Add the in-process last-healthy marker without hosting the rescue service inside Harness.
