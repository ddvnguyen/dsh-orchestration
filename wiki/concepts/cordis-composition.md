---
type: concept
title: Cordis Composition
tags: [architecture, cordis, plugins]
related: [fleet-architecture, fleet-web-patch]
created: 2026-08-18
updated: 2026-08-18
---

# Cordis Composition

How fleet plugins compose into the DSH web profile through `cordis.patch.yml` and `--patch` overlays.

## How It Works

1. DSH loads a profile (e.g., `~/.dsh/profiles/web/cordis.yml`) — typically an empty entry list `[]`
2. Bundle layers from `package.json`'s `dsh.profile.bundles` add base plugins
3. `cordis.patch.yml` adds profile-specific overrides
4. `--patch` overlays (like `fleet-web.patch.yml`) add deployment-specific plugins

## Fleet Web Patch

The `fleet-web.patch.yml` file uses the `- insert:` syntax to add fleet plugins:

```yaml
- insert:
    - id: fleet-agent
      name: '@hydra/dsh-fleet-agent'
      inject: ['webServer']
      config:
        home: !!js dshHomePath('')
        autoRegisterAgents: false
        injectTools: true
```

## Plugin Resolution

Bare `@hydra/dsh-fleet-*` names resolve via `$DSH_HOME/profiles/node_modules/@hydra/` — per-package symlinks created by `fleet-supervisor.sh` pointing to the actual plugin directories.

## Config Expressions

`!!js dshHomePath('')` is a JS expression that resolves to the DSH home directory at runtime.
