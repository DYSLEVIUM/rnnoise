#!/bin/bash
set -euxo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OPTIMIZE="-O3"
USE_LITE=0 # use lite model for lower latency and less CPU usage

RNN_EXPORTED_FUNCTIONS="['_rnnoise_process_frame', '_rnnoise_destroy', '_rnnoise_create', '_rnnoise_get_frame_size', '_malloc', '_free']"

OUTPUT_DIR="$SCRIPT_DIR/dist"
mkdir -p "$OUTPUT_DIR"

BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT

function compile() {
    local CFLAGS=$1
    local NAME=$2
    local USE_LITE_DATA=${3:-0}

    local variant_build_dir="${BUILD_DIR}/${NAME}"
    mkdir -p "${variant_build_dir}"

    cp -a "$SCRIPT_DIR/." "${variant_build_dir}/"
    rm -rf "${variant_build_dir}/.git" "${variant_build_dir}/dist"

    (
        cd "${variant_build_dir}"

        if [[ $USE_LITE_DATA == 1 ]]; then
            echo "[$NAME] Using lite model data"
            mv ./src/rnnoise_data.c ./src/rnnoise_data_big.c
            mv ./src/rnnoise_data_little.c ./src/rnnoise_data.c
        fi

        # needed for use of same source code which should be built on Linux, macOS, BSD, etc.
        echo "[$NAME] Configuring with CFLAGS: ${CFLAGS} -DNDEBUG"
        emconfigure ./configure \
            CFLAGS="${CFLAGS} -DNDEBUG" \
            --host=wasm32-unknown-emscripten \
            --enable-shared=no \
            --disable-examples \
            --disable-doc

        echo "[$NAME] Building"
        emmake make V=1 -j$(nproc)


        # -s INITIAL_MEMORY=8MB \
        # -s MAXIMUM_MEMORY=32MB \
        # -s STACK_SIZE=256KB \
        emcc \
            ${CFLAGS} \
            -s WASM=1 \
            -s ALLOW_MEMORY_GROWTH=1 \
            -s INITIAL_MEMORY=128MB \
            -s MAXIMUM_MEMORY=1GB \
            -s STACK_SIZE=8MB \
            -s MALLOC=dlmalloc \
            -s MODULARIZE=1 \
            -s EXPORT_ES6=1 \
            -s INCOMING_MODULE_JS_API="['locateFile','wasmBinary','instantiateWasm']" \
            -s ENVIRONMENT='web,worker' \
            -s EXPORT_NAME="createRNNoiseModule" \
            -s EXPORTED_RUNTIME_METHODS='["HEAPF32"]' \
            -s EXPORTED_FUNCTIONS="${RNN_EXPORTED_FUNCTIONS}" \
            -s NO_FILESYSTEM=1 \
            -s ASSERTIONS=0 \
            -s NO_EXIT_RUNTIME=1 \
            -s DISABLE_EXCEPTION_CATCHING=1 \
            -s SUPPORT_LONGJMP=0 \
            -s SINGLE_FILE=0 \
            .libs/librnnoise.a \
            --emit-tsd ${NAME}.d.ts \
            --lembind -o ${NAME}.js

        echo "[$NAME] Compilation complete"
    )

    return 0
}

function build() {
    scalar_name="rnnoise"
    simd_name="rnnoise_simd"
    lite_name="${scalar_name}_lite"
    lite_simd_name="${simd_name}_lite"


    compile "${OPTIMIZE}" "${scalar_name}" 0 &
    compile "${OPTIMIZE} -msimd128 -mrelaxed-simd" "${simd_name}" 0 &

    if [[ $USE_LITE == 1 ]]; then
        compile "${OPTIMIZE}" "${lite_name}" 1 &
        compile "${OPTIMIZE} -msimd128 -mrelaxed-simd" "${lite_simd_name}" 1 &
    fi

    wait

    echo "All builds completed"
}

function copy_variant() {
    local variant_name=$1
    local target_dir=$2
    local variant_build_dir="${BUILD_DIR}/${variant_name}"

    cp -v "${variant_build_dir}/${variant_name}.wasm" "${target_dir}/"
    cp -v "${variant_build_dir}/${variant_name}.js" "${target_dir}/"
    cp -v "${variant_build_dir}/${variant_name}.d.ts" "${target_dir}/"
}

function copy_artifacts() {
    mkdir -p "${OUTPUT_DIR}/scalar/full"
    mkdir -p "${OUTPUT_DIR}/simd/full"

    copy_variant "${scalar_name}" "${OUTPUT_DIR}/scalar/full"
    copy_variant "${simd_name}" "${OUTPUT_DIR}/simd/full"

    if [[ $USE_LITE == 1 ]]; then
        mkdir -p "${OUTPUT_DIR}/scalar/lite"
        mkdir -p "${OUTPUT_DIR}/simd/lite"

        copy_variant "${lite_name}" "${OUTPUT_DIR}/scalar/lite"
        copy_variant "${lite_simd_name}" "${OUTPUT_DIR}/simd/lite"
    fi
}

function main() {
    git clean -f -d -e src/vec_wasm.h || true

    echo "Running autogen.sh"
    "$SCRIPT_DIR/autogen.sh"
    echo "Autogen complete"

    build

    copy_artifacts

    git clean -f -d -e src/vec_wasm.h || true

    return 0
}

main

