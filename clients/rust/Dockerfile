FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8 AS build
WORKDIR /app
ENV CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN rustc --version && cargo --version && cargo build --release --locked

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261024T000000Z/ bookworm main' \
       'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261024T000000Z/ bookworm-security main' > /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 poller
COPY --from=build /app/target/release/poller /usr/local/bin/poller
RUN mkdir -p /usr/share/sap-polling-lab && dpkg-query -W > /usr/share/sap-polling-lab/packages.tsv
USER 10001
ENTRYPOINT ["poller"]
