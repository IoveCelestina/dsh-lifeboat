# Changelog

All notable changes to DSH Lifeboat are documented here. The project follows Semantic Versioning.

## 0.1.0 - 2026-08-18

- Add an out-of-process, loopback-only recovery console and CLI.
- Probe each candidate in a fresh temporary `DSH_HOME` and minimize reproducible failing bundle sets.
- Distinguish bundle, user-patch, bundle/patch interaction, and base-environment failures.
- Add opt-in runtime probes with repeated confirmation and an inconclusive result for unstable evidence.
- Add hash-guarded, backed-up, atomic bundle disable and restore operations.
- Add bounded diagnosis scheduling, 30-minute job deadlines, candidate/copy/output limits, graceful shutdown, health checks, persistent reports, and browser-session reconnect.
- Add the in-process last-healthy marker without hosting the rescue service inside Harness.
