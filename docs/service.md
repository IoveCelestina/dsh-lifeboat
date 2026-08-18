# Running Lifeboat as a service

The HTTP service is loopback-only. Keep it under the same user account that owns the intended `DSH_HOME`; do not run it as Administrator or root.

## Health and state

- Liveness: `GET http://127.0.0.1:4317/api/health`
- Reports: `$DSH_HOME/lifeboat/reports/*.json`
- Override state: `dsh-lifeboat serve --state-dir /private/path`
- Default concurrency: one diagnosis; raise only when the machine can absorb multiple Harness starts.
- Default job deadline: 30 minutes; override with `--job-timeout MS` (maximum: 6 hours).
- Automatic isolation stops at 128 candidate bundles by default; raise `--max-candidates` only after reviewing the profile.

The health endpoint returns `503` while the service is stopping. Reports are written atomically and contain local paths and captured plugin output, so the state directory should remain private to the service user. Lifeboat does not automatically delete persisted reports; rotate that directory with an explicit user-owned retention policy.

## systemd user unit

After installing the package, create `~/.config/systemd/user/dsh-lifeboat.service`:

```ini
[Unit]
Description=DSH Lifeboat recovery service
After=default.target

[Service]
Type=simple
ExecStart=%h/.local/bin/dsh-lifeboat serve --home %h/.dsh --port 4317
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

Adjust `ExecStart` to the absolute binary path returned by your package manager, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-lifeboat.service
```

Do not add a broad `0.0.0.0` listener or reverse proxy. The service intentionally has no remote-access mode.

## Windows Task Scheduler

Use Task Scheduler's **Create Task** dialog:

1. Run only for the normal Windows account that owns `.dsh`; do not select highest privileges.
2. Trigger **At log on** for that account.
3. Start the absolute `dsh-lifeboat.cmd` path with `serve --home C:\Users\<you>\.dsh --port 4317`.
4. Set **Restart the task if it fails** to a short bounded retry policy.
5. Set **If the task is already running** to **Do not start a new instance**.

Stop the task before upgrading the package. Start it again and verify `/api/health` and the UI before relying on it for recovery.
