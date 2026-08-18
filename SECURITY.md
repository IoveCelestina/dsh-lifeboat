# Security policy

## Supported versions

Security fixes are provided for the latest released minor version.

## Reporting a vulnerability

Please use the repository's private GitHub vulnerability-reporting flow when it is available. If it is unavailable, contact the maintainer through the GitHub profile linked in `package.json`. Do not place exploit details, credentials, or an unredacted Lifeboat report in a public issue.

Include the affected version, operating system, probe mode, minimal reproduction, and whether the issue can modify files outside the selected Harness profile.

## Security boundaries

- The service binds to `127.0.0.1`, validates the Host header, rejects cross-origin browser writes, and requires a random per-process token for every write request.
- Configuration probes do not mount plugin rows. Runtime probes execute installed plugin code with the service user's operating-system permissions. A temporary Harness Home is data isolation, not a code sandbox.
- The child environment removes credential-shaped variable names and captured output is redacted for common secret formats. This is best-effort. Reports can still contain local paths, plugin output, and other sensitive data; review them before sharing.
- Recovery can write only the selected profile manifest. It verifies the diagnosis-time hash, creates an exclusive backup, and uses an atomic replacement. A restore refuses to overwrite later manifest changes.
- Package-resolution links in temporary homes point to already-installed code. Lifeboat does not download or install packages during diagnosis.
