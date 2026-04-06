ARG BUILDPLATFORM

FROM --platform=$BUILDPLATFORM emscripten/emsdk:3.1.64

RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf automake libtool && \
    rm -rf /var/lib/apt/lists/* && \
    curl -fsSL https://bun.sh/install | bash && \
    cd /emsdk/upstream/emscripten && \
    ~/.bun/bin/bun install

WORKDIR /build

COPY . .

CMD ["./build.sh"]
