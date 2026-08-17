# dsh fleet runtime container (issue #30 follow-up — dsh-setup devops plan).
#
# Runs the deepseek-harness (dsh) web UI on :3080 and the standalone
# fleet-board-server on :3090, with the V3 team bootstrap run idempotently at
# start. DSH_HOME lives on a mounted volume so fleet data (bus/tasks/agent)
# persists across container rebuilds and redeploys.
#
# Build recipe (from the approved plan):
#   * submodule: external/deepseek-harness  (NO edits)
#   * pnpm install with the lefthook workaround flag
#   * tsx comes from the harness submodule's node_modules
#
# NOTE on native deps: the harness ships native modules (node-pty, koffi,
# esbuild). They are built for the BUILDER platform at image build time, so a
# host-installed node_modules must NEVER be copied in — always install inside
# the image to avoid glibc mismatches.

FROM node:24-bookworm

ENV CI=true
ENV DSH_HOME=/dsh-home
ENV PNPM_HOME=/opt/pnpm
ENV PATH=/opt/pnpm:/opt/node_modules/.bin:$PATH

WORKDIR /opt/dsh

# 1) pnpm (same major as the host runtime)
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

# 2) copy harness source (submodule) + the fleet plugin family. node_modules is
#    excluded via .dockerignore so the build does a clean, in-image install.
COPY external/deepseek-harness ./external/deepseek-harness
COPY experiments/dsh-fleet ./experiments/dsh-fleet

# 2b) apply the owner-approved build-time dsh patch: allow --host 0.0.0.0 on the
#     web UI (LAN export). The patch file lives in OUR repo (the submodule
#     working tree stays clean), and `git apply --check` fails the build if the
#     patch ever stops matching the pinned submodule HEAD.
COPY dsh-fleet-container/patches/allow-0.0.0.0-web-host.patch /opt/dsh-fleet-seed/allow-0.0.0.0-web-host.patch
RUN cd external/deepseek-harness \
    && git apply --check /opt/dsh-fleet-seed/allow-0.0.0.0-web-host.patch \
    && git apply /opt/dsh-fleet-seed/allow-0.0.0.0-web-host.patch

# 2c) apply the build-time dsh patch that adds fleet request logging to the web
#     server (access-log.dsh-web.patch, request-logging-26): wraps the node:http
#     listener so each request appends one JSONL line to
#     $DSH_HOME/fleet/logs/dsh-web.requests.jsonl. Same check-then-apply guard
#     as 2b so a drift against the pinned submodule HEAD fails the build.
COPY dsh-fleet-container/patches/access-log.dsh-web.patch /opt/dsh-fleet-seed/access-log.dsh-web.patch
RUN cd external/deepseek-harness \
    && git apply --check /opt/dsh-fleet-seed/access-log.dsh-web.patch \
    && git apply /opt/dsh-fleet-seed/access-log.dsh-web.patch

# 2d) apply the build-time dsh patch that lets operator-declared trusted hosts
#     (harness.ddvnguyen.com + LAN IP, via the existing --trusted-host flags)
#     call PRIVILEGED methods (settings.describe, credentials.describe,
#     llm.discoverModels, ...): the privileged check now uses the configured
#     trust list instead of a hardcoded empty one, so the remote SPA's data
#     load stops 403ing while the DNS-rebinding / cross-site / Origin fences
#     and loopback default all still apply. Same check-then-apply guard as 2b.
COPY dsh-fleet-container/patches/allow-remote-privileged-methods.patch /opt/dsh-fleet-seed/allow-remote-privileged-methods.patch
RUN cd external/deepseek-harness \
    && git apply --check /opt/dsh-fleet-seed/allow-remote-privileged-methods.patch \
    && git apply /opt/dsh-fleet-seed/allow-remote-privileged-methods.patch

# 3) in-image install — the lefthook postinstall bails when CI is truthy, and
#    the verify-deps flag is the documented workaround for the hook checks.
#    Fresh install is required: the image glibc differs from the host's.
RUN cd external/deepseek-harness \
    && pnpm --config.verify-deps-before-run=false install --frozen-lockfile

# 4) entrypoint + seeded settings (no secrets — token comes via OPENCODE_ZEN_KEY at runtime)
COPY dsh-fleet-container/entrypoint.sh /usr/local/bin/fleet-entrypoint.sh
COPY dsh-fleet-container/settings.yaml /opt/dsh-fleet-seed/settings.yaml
COPY dsh-fleet-container/fleet-web.patch.yml /opt/dsh-fleet-seed/fleet-web.patch.yml
RUN chmod +x /usr/local/bin/fleet-entrypoint.sh

EXPOSE 3080 3090

ENTRYPOINT ["/usr/local/bin/fleet-entrypoint.sh"]
