# Contributing

Issues and focused pull requests are welcome.

Before submitting a change:

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

Keep the rescue path dependency-free unless a dependency removes more failure risk than it adds. Tests that launch processes must terminate only processes they created. Files under a real `DSH_HOME` must remain read-only unless a test explicitly exercises recovery against a disposable fixture.

Report security problems through the process in [SECURITY.md](SECURITY.md), not a public issue.
