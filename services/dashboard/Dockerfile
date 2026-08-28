# armada-dashboard — the operator console.
#
# Two stages: build the React/TypeScript sources with Vite, then serve the static output
# from nginx. This replaces the Phase 0 placeholder, which existed precisely so that the
# bundler and router could be chosen by the phase that needed them rather than guessed at
# in Phase 0.
#
# nginx is not only a static file server here. It is also the SAME-ORIGIN PROXY that makes
# the dashboard work at all: neither armada-daemon nor armada-forge emits a CORS header or
# answers an OPTIONS preflight, so the browser has to see all three as one origin. See
# nginx.conf.
#
# No network is needed at RUN time and none is reached at build time beyond the npm
# registry, so this does not touch the zero-external-spend property of a default install —
# nothing here contacts a model provider.

FROM node:22-alpine AS build

WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
# `npm ci` rather than `npm install`: it installs exactly the lockfile and fails if
# package.json and the lock have drifted, which is the behaviour an image build wants.
RUN npm ci

# index.html IS THE ENTRY MODULE, not an asset. Vite resolves the whole graph from it,
# so omitting it fails the build with `Could not resolve entry module "index.html"` —
# which is what happened: this COPY list enumerated tsconfig, vite.config and src/ and
# left out the one file the bundler starts from. The build passes on a workstation, where
# the file is simply present, and fails only inside the image.
COPY index.html ./
COPY tsconfig.json tsconfig.test.json vite.config.ts ./
COPY src ./src

# `npm run build` type-checks before bundling (`tsc --noEmit && vite build`), so a type
# error fails the image rather than shipping a bundle Vite happily produced by stripping
# the types it did not check.
RUN npm run build


FROM nginx:1.27-alpine

# The proxy configuration and the SPA history fallback.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
