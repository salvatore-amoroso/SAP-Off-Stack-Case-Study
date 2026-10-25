FROM rust:bookworm AS build
WORKDIR /app
ENV CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 poller
COPY --from=build /app/target/release/poller /usr/local/bin/poller
USER 10001
ENTRYPOINT ["poller"]
