#!/usr/bin/env bash
# Usage: bash scripts/setup-dana-sprite.sh
# Uses SPRITES_TOKEN and optional SPRITE_ASSISTANT from the root .env. Never prints secrets.
set -euo pipefail
root="$(dirname "$(dirname "$(realpath "$0")")")"
exec "$root/node_modules/.bin/tsx" "$root/scripts/setup-dana-sprite.ts"
