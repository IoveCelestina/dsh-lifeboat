# Architecture

Lifeboat deliberately has two unequal halves:

```text
Harness process                         Independent Lifeboat process
┌──────────────────────────┐            ┌─────────────────────────────┐
│ tiny last-healthy marker │            │ loopback HTTP + static UI   │
│ no rescue routes         │            │ bounded single-job queue    │
└──────────────────────────┘            │ fresh temporary Home/probe  │
         may fail to boot ───────────X  │ minimizer + report store    │
                                        │ guarded recovery writer     │
                                        └─────────────────────────────┘
```

The recovery service does not depend on the Harness Loader. A broken active bundle can therefore prevent the health marker from running without preventing the rescue console from starting.

## Diagnosis flow

1. Read and hash the selected profile manifest.
2. Keep installation-owned bundles fixed and identify dependency-backed active bundles as candidates.
3. For every logical probe, create a fresh temporary `DSH_HOME`, copy bounded non-sensitive regular assets, and link installed package directories by their resolved absolute targets.
4. Probe the original composition, then clean bundle and patch baselines.
5. If a candidate set is implicated, run delta debugging until removing any one member from the reproduced set makes that tested set pass.
6. In runtime mode, repeat each logical probe in fresh homes. Mixed results produce `unstable-probe` and suppress recovery.
7. Persist the terminal job report under the service state directory.

## Service lifecycle

The default scheduler runs one diagnosis at a time so concurrent probes cannot compete for CPU or produce a misleading incident picture. Queued jobs can be cancelled before they start. In-memory jobs are bounded; completed reports remain on disk.

On `SIGINT` or `SIGTERM`, the server stops accepting work, cancels queued jobs, aborts owned probe processes, closes idle and active HTTP connections, and waits for active task cleanup within a bounded window.

## Write boundary

Diagnosis itself is read-only with respect to the selected profile. Recovery is a separate token-protected action. It checks the original manifest hash, writes an exclusive backup within `.lifeboat-backups`, and atomically replaces only `package.json`. Restore creates another guard copy and refuses stale writes.
