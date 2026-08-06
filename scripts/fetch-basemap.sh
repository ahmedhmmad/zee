#!/usr/bin/env bash
#
# Download a Libya-only vector basemap as a single PMTiles file.
#
# Self-hosted for two reasons: label language is controllable (raster tiles
# have the text baked in, in each country's own language), and it removes the
# last external dependency the map has - which matters when OpenStreetMap is
# not reliably reachable from Libya.
#
# Usage:  bash scripts/fetch-basemap.sh [target-dir]

set -euo pipefail

TARGET_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/.cache/basemap}"
PMTILES_VERSION="1.22.1"
# Generous bounds: Libya plus border regions, so cross-border trips still work.
BBOX="7.0,17.0,28.0,35.0"

mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

arch=$(uname -m)
case "$arch" in
  x86_64)  asset="Linux_x86_64" ;;
  aarch64) asset="Linux_arm64"  ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

if [ ! -x ./pmtiles ]; then
  echo "==> downloading pmtiles CLI ${PMTILES_VERSION} (${asset})"
  curl -fsSL -o pmtiles.tar.gz \
    "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_${asset}.tar.gz"
  tar xzf pmtiles.tar.gz pmtiles
  rm pmtiles.tar.gz
  chmod +x pmtiles
fi

# Protomaps publishes a daily planet build; find the most recent one.
echo "==> locating latest planet build"
BUILD=$(curl -fsSL https://build.protomaps.com/ \
  | grep -oE '[0-9]{8}\.pmtiles' | sort -u | tail -1)
if [ -z "$BUILD" ]; then
  echo "could not determine latest build from build.protomaps.com" >&2
  exit 1
fi
echo "    using $BUILD"

# Extract only Libya. This reads ranges over HTTP rather than downloading the
# whole planet, so it pulls a few hundred MB instead of ~120 GB.
echo "==> extracting Libya (bbox $BBOX) — this takes a few minutes"
./pmtiles extract "https://build.protomaps.com/${BUILD}" libya.pmtiles --bbox="${BBOX}"

ls -lh libya.pmtiles

# --- Glyphs -----------------------------------------------------------------
#
# MapLibre renders vector labels itself, which means it needs the font as PBF
# glyph ranges. Base Noto Sans has no Arabic coverage, so Noto Sans Arabic is
# merged in - without it, every Arabic place name renders as blank boxes.

if [ ! -d glyphs/"Noto Sans Regular" ]; then
  echo "==> building glyphs (Latin + Arabic)"
  mkdir -p fonts
  curl -fsSL -o fonts/NotoSans-Regular.ttf \
    "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf"
  curl -fsSL -o fonts/NotoSansArabic-Regular.ttf \
    "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansArabic/NotoSansArabic-Regular.ttf"

  # font-maker writes one PBF per 256-codepoint range; later fonts fill gaps
  # left by earlier ones, so Latin comes from Noto Sans and Arabic from
  # Noto Sans Arabic.
  npx --yes @maplibre/font-maker@latest \
    --name "Noto Sans Regular" \
    --output glyphs \
    fonts/NotoSans-Regular.ttf fonts/NotoSansArabic-Regular.ttf

  # Arabic lives at U+0600-06FF, which is the 1536-1791 range.
  if [ -f "glyphs/Noto Sans Regular/1536-1791.pbf" ]; then
    echo "    Arabic glyph range present"
  else
    echo "    WARNING: Arabic glyph range missing — labels will render as boxes" >&2
  fi
fi

echo "==> done"
echo "    basemap: $TARGET_DIR/libya.pmtiles"
echo "    glyphs:  $TARGET_DIR/glyphs/"
