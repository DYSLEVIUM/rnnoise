#!/bin/bash
set -euxo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUTPUT_DIR="$SCRIPT_DIR/dist"
mkdir -p "$OUTPUT_DIR"

IMAGE_NAME="rnnoise-builder"
CACHE_VOLUME="rnnoise-build-cache"

podman volume exists "$CACHE_VOLUME" 2>/dev/null || podman volume create "$CACHE_VOLUME"

podman build -t "$IMAGE_NAME" .

podman run --rm \
    -v "$CACHE_VOLUME:/build/rnnoise:z" \
    -v "$OUTPUT_DIR:/build/dist:z" \
    "$IMAGE_NAME"

echo "Container build completed successfully!"

