# armada-dashboard — Phase 0 skeleton.
#
# Serves a static placeholder and a healthcheck endpoint. Nothing else.
#
# WHY THERE IS NO BUILD STEP YET. The dashboard's 27 surfaces land in Phase 8 against
# specs/dashboard/design-dashboard.md, which is explicit that "component API design, state
# management, file structure, build tooling, or test strategy" are out of its scope and
# belong to the implementation phase. Phase 0 asks only for a skeleton that boots and
# serves a healthcheck, and shipping an nginx image with a static file does exactly that
# WITHOUT pre-committing Phase 8 to a bundler, a router, or a state library.
#
# Phase 8 replaces this file with a two-stage build: compile the React/TypeScript sources
# under services/dashboard/src/, then copy the built assets into this same nginx stage.

FROM nginx:1.27-alpine

# Health endpoint for the Compose healthcheck, plus SPA history fallback so Phase 8's
# client-side routes survive a page reload without further image changes.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html

EXPOSE 80
