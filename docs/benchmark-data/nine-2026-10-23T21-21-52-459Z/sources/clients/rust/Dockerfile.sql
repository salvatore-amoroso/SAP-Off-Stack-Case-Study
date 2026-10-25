FROM rust:bookworm AS build
ARG SQL_FEATURES=native-hana,abap-odbc
RUN case ",${SQL_FEATURES}," in *,abap-odbc,*) \
    apt-get update && apt-get install -y --no-install-recommends unixodbc-dev \
    && rm -rf /var/lib/apt/lists/* ;; esac
WORKDIR /app
ENV CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked --features "$SQL_FEATURES" --bin sql-poller

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates unixodbc libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 poller
COPY --from=build /app/target/release/sql-poller /usr/local/bin/sql-poller
# Mount the licensed SAP ODBC driver and its driver-manager configuration at runtime.
USER 10001
ENTRYPOINT ["sql-poller"]
