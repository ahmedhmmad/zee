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

# Protomaps publishes daily planet builds but serves no directory index, so
# probe backwards from today until one responds. Builds usually lag a day or
# two, and occasionally more.
echo "==> locating latest planet build"
BUILD="${PROTOMAPS_BUILD:-}"
if [ -z "$BUILD" ]; then
  for i in $(seq 0 20); do
    candidate="$(date -u -d "${i} days ago" +%Y%m%d).pmtiles"
    if curl -fsI "https://build.protomaps.com/${candidate}" >/dev/null 2>&1; then
      BUILD="$candidate"
      break
    fi
  done
fi
if [ -z "$BUILD" ]; then
  echo "no planet build found in the last 20 days." >&2
  echo "check https://maps.protomaps.com/builds/ and re-run with:" >&2
  echo "  PROTOMAPS_BUILD=YYYYMMDD.pmtiles bash scripts/fetch-basemap.sh" >&2
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

STACK="Noto Sans Regular"
GLYPH_BASE="https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts"

if [ ! -f "glyphs/${STACK}/1536-1791.pbf" ]; then
  echo "==> fetching glyph ranges (Latin + Arabic)"
  mkdir -p "glyphs/${STACK}"

  # MapLibre asks for one 256-codepoint range at a time. Only the ranges the
  # labels actually use are needed; anything absent upstream is skipped.
  #   0-255       Basic Latin + Latin-1
  #   256-767     Latin Extended A/B
  #   768-1023    Combining marks, Greek
  #   1536-2047   Arabic, Arabic Supplement   <- the ones that matter here
  #   8192-8447   General punctuation
  #   64256-65279 Arabic Presentation Forms A/B
  ranges="0-255 256-511 512-767 768-1023 1024-1279 1280-1535 1536-1791 1792-2047 \
          8192-8447 8448-8703 64256-64511 65024-65279"

  got=0
  for r in $ranges; do
    if curl -fsSL -o "glyphs/${STACK}/${r}.pbf" \
        "${GLYPH_BASE}/$(printf %s "$STACK" | sed 's/ /%20/g')/${r}.pbf" 2>/dev/null; then
      got=$((got + 1))
    else
      rm -f "glyphs/${STACK}/${r}.pbf"
    fi
  done
  echo "    fetched ${got} glyph ranges"
fi

# Arabic is U+0600-06FF, the 1536-1791 range. Without it every Arabic place
# name renders as empty boxes, so this is worth checking explicitly.
if [ -s "glyphs/${STACK}/1536-1791.pbf" ]; then
  echo "    Arabic glyph range present ($(stat -c%s "glyphs/${STACK}/1536-1791.pbf") bytes)"
else
  echo "    WARNING: no Arabic glyphs — labels will render as boxes." >&2
  echo "    The map still works; tell me and I will source them elsewhere." >&2
fi

echo "==> done"
echo "    basemap: $TARGET_DIR/libya.pmtiles"
echo "    glyphs:  $TARGET_DIR/glyphs/"
