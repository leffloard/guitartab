#!/usr/bin/env bash
# Builds the NNLS-Chroma / Chordino Vamp plugin (GPL-2.0-or-later) from pinned source commits.
#
#   scripts/build-vamp-plugins.sh [OUT_DIR]     (default: services/analyzer/.vamp)
#
# Needs git, g++ (C++11), make and the Boost headers (Debian/Ubuntu: libboost-dev; header-only,
# nothing is linked). Idempotent: does nothing when OUT_DIR/nnls-chroma.so already exists.
# The analyzer finds the plugin through VAMP_PATH (see Settings.vamp_path).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:-$HERE/.vamp}" && cd "${1:-$HERE/.vamp}" && pwd)"
[ -f "$OUT/nnls-chroma.so" ] && exit 0

BOOST_ROOT="${BOOST_ROOT:-/usr/include}"
if [ ! -f "$BOOST_ROOT/boost/numeric/ublas/matrix.hpp" ]; then
  echo "Boost headers not found under $BOOST_ROOT (Debian/Ubuntu: apt install libboost-dev)" >&2
  exit 1
fi

SDK_SHA=63e0c3b37b6fb9ce6f074ea8222b4903e4f5568a   # c4dm/vamp-plugin-sdk (SDK 2.10), 2024-02-19
NNLS_SHA=4c5f214a75cb354f8d8c933e161377c5b4d83713  # c4dm/nnls-chroma (1.1+), 2020-04-22
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
fetch() { # repo sha
  git init --quiet "$(basename "$1")"
  git -C "$(basename "$1")" fetch --quiet --depth 1 "https://github.com/c4dm/$1.git" "$2"
  git -C "$(basename "$1")" checkout --quiet FETCH_HEAD
}
fetch vamp-plugin-sdk "$SDK_SHA"
fetch nnls-chroma "$NNLS_SHA"

# Build output goes to a log that is printed only if a step fails.
LOG="$WORK/build.log"
run() { "$@" >>"$LOG" 2>&1 || { cat "$LOG" >&2; echo "build failed: $*" >&2; exit 1; }; }
# Only the plugin-side static library is needed; --disable-programs skips the example host,
# which would need libsndfile.
(cd vamp-plugin-sdk && run ./configure --disable-programs && run make -j"$(nproc)" sdkstatic)
# Makefile.inc adds -I$(BOOST_ROOT); left empty it would swallow the next flag.
(cd nnls-chroma && run make -j"$(nproc)" -f Makefile.linux BOOST_ROOT="$BOOST_ROOT")
cp nnls-chroma/nnls-chroma.so nnls-chroma/nnls-chroma.cat nnls-chroma/nnls-chroma.n3 "$OUT/"
echo "built $OUT/nnls-chroma.so"
