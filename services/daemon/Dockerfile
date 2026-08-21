# armada-daemon — Node image with a Docker client for sandbox provisioning.
#
# ROADMAP F9 — WHY THE DOCKER CLI IS HERE. DockerSandboxProvider (Runtime R44-R49)
# provisions one SIBLING container per Run, so the daemon needs a Docker client and, at
# runtime, a bind-mount of /var/run/docker.sock. That mount is host-root-equivalent for
# this process and is a DELIBERATE, DOCUMENTED decision — accepted under Armada's
# single-operator, trusted-network posture (a platform-wide non-goal is multi-tenant auth).
#
# It does not weaken invariant 3. The boundary is one-directional: the daemon reaches into
# a sandbox, nothing in a sandbox reaches out. SANDBOX CONTAINERS NEVER RECEIVE THE SOCKET
# (R46), and no profile in config/sandbox-profiles.yaml may ever mount it.

FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so a dependency install is cached independently of source edits.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies in place so the runtime stage copies a production tree rather than
# resolving and installing everything a second time.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim

# docker-cli only — NOT the daemon. This container talks to the host's Docker through the
# mounted socket; it does not run a Docker daemon of its own.
# ca-certificates is needed for the registry TLS handshake the CLI performs when pulling a
# sandbox image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The daemon needs the host Docker socket, which is root-owned, so this process runs as
# root by construction. The SANDBOXES it provisions run as non-root (R46) — that is the
# boundary that matters, and it is enforced per-container at acquire time.
ENV NODE_ENV=production \
    ARMADA_PORT=8080

EXPOSE 8080

# R1 — a single port serving both /api/* and /ws. The WebSocket half lands in Phase 2.
CMD ["node", "dist/index.js"]
