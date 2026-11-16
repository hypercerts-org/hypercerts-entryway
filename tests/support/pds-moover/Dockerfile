# Test-only build of the PDS MOOver web UI from a pinned upstream commit. The
# source is fetched and verified here and built unmodified; nothing of its tree
# is vendored. The stages mirror upstream Dockerfiles/web-ui.Dockerfile. See
# docs/reuse-assessment.md.
FROM alpine:3.24 AS source
RUN apk add --no-cache git
ARG MOOVER_REPOSITORY=https://tangled.org/kandake.africa/pds-moover
ARG MOOVER_COMMIT=25a54a75c1347728ff0a8b122aeadad1d6902bb4
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 "$MOOVER_REPOSITORY" "$MOOVER_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$MOOVER_COMMIT" \
 && rm -rf .git

FROM node:24-bookworm-slim AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY --from=source /src/package.json /src/pnpm-workspace.yaml /src/pnpm-lock.yaml /src/.npmrc ./
COPY --from=source /src/web-ui/package.json ./web-ui/
COPY --from=source /src/packages/lexicons/package.json ./packages/lexicons/
COPY --from=source /src/packages/moover/package.json ./packages/moover/
COPY --from=source /src/packages/mock-atmosphere/package.json ./packages/mock-atmosphere/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "web-ui..."
COPY --from=source /src/web-ui ./web-ui
COPY --from=source /src/packages/lexicons ./packages/lexicons
COPY --from=source /src/packages/moover ./packages/moover
RUN pnpm --filter web-ui build

FROM node:24-bookworm-slim AS web-ui
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/.npmrc ./
COPY --from=builder /app/web-ui/package.json ./web-ui/
COPY --from=builder /app/packages/lexicons/package.json ./packages/lexicons/
COPY --from=builder /app/packages/moover/package.json ./packages/moover/
COPY --from=builder /app/packages/mock-atmosphere/package.json ./packages/mock-atmosphere/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts --filter web-ui
COPY --from=builder /app/web-ui/build ./web-ui/build
WORKDIR /app/web-ui
USER node
CMD ["node", "build"]
