#!/bin/sh
# Renders every prototype page to screenshots/*.png using headless Edge. Usage: sh shoot.sh
EDGE="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
DIR="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
mkdir -p "$DIR/screenshots"
for f in "$DIR"/[0-9]*.html; do
  n=$(basename "$f" .html)
  case "$n" in 10-*) S=915,412;; *) S=412,915;; esac
  "$EDGE" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --screenshot="$DIR/screenshots/$n.png" --window-size=$S "file:///$DIR/$n.html" >/dev/null 2>&1
done
S=1280,1400
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot="$DIR/screenshots/index.png" --window-size=$S "file:///$DIR/index.html" >/dev/null 2>&1
ls "$DIR/screenshots"
