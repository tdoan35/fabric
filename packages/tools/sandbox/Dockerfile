# The sandbox image (ANY-44 D9, T8): debian slim plus the toolchain the
# sandboxed tools rely on, running as the non-root `fabric` user (uid 1000).
# Built by `npm run sandbox:build -w @fabric/tools` as fabric-sandbox:1
# (override the tag with FABRIC_SANDBOX_IMAGE). procps is beyond the card's
# package list solely because D5 inspects processes with `ps` inside.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      python3 \
      python3-pip \
      python3-venv \
      nodejs \
      npm \
      procps \
      ripgrep \
 && rm -rf /var/lib/apt/lists/*

# The egress gateway's script (T18); the gateway container runs it directly.
COPY egress.mjs /opt/fabric/egress.mjs

RUN useradd --create-home --shell /bin/bash --uid 1000 fabric \
 && mkdir -p /workspace \
 && chown fabric:fabric /workspace

USER fabric
WORKDIR /workspace
