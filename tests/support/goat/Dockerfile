# Test-only build of the public goat CLI, patched to run Entryway's incoming
# migration flow. goat is fetched at a pinned commit, verified, patched and built
# here; nothing of its tree is vendored. See docs/reuse-assessment.md.
# Output stage: `docker build --output type=local,dest=DIR` yields DIR/goat.
FROM golang:1.27.3-alpine AS build
RUN apk add --no-cache git
ARG GOAT_COMMIT=f6a214a184a206241ace7adbb88b43c620e4ff61
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 https://github.com/bluesky-social/goat.git "$GOAT_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$GOAT_COMMIT"
COPY entryway-incoming.patch /tmp/entryway-incoming.patch
RUN git apply --check /tmp/entryway-incoming.patch && git apply /tmp/entryway-incoming.patch
RUN CGO_ENABLED=0 go build -trimpath -o /out/goat .

FROM scratch
COPY --from=build /out/goat /goat
