#!/usr/bin/env bash
# Turn an idle-animation mp4 into a single-row WebP sprite strip + a still poster.
# usage: scripts/build-sprite.sh <input.mp4> <still.png> <out-name> [fps=12] [px=192] [quality=70]
set -euo pipefail
in=$1; still=$2; name=$3; fps=${4:-12}; px=${5:-192}; q=${6:-70}
out=apps/web/public/dana
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
frames=$(python3 -c "print(round($dur*$fps))")
tmp=$(mktemp --suffix=.png)
ffmpeg -v error -y -i "$in" -an -vf "fps=$fps,scale=$px:$px:flags=lanczos,tile=${frames}x1" -frames:v 1 "$tmp"
ffmpeg -v error -y -i "$tmp" -c:v libwebp -quality "$q" "$out/$name-strip.webp"
ffmpeg -v error -y -i "$still" -vf "scale=$((px*2)):$((px*2)):flags=lanczos" -c:v libwebp -quality 85 "$out/$name-still.webp"
rm -f "$tmp"
echo "frames=$frames fps=$fps px=$px  strip=$(stat -c%s "$out/$name-strip.webp")B still=$(stat -c%s "$out/$name-still.webp")B"
