FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261024T000000Z/ bookworm main' \
       'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261024T000000Z/ bookworm-security main' > /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ unixodbc unixodbc-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV SQL_QUERY_FILE=/run/sql-query.sql
COPY package*.json ./
COPY scripts ./scripts
RUN npm_config_jobs=1 MAKEFLAGS=-j1 npm ci --omit=dev --include=optional \
    && node scripts/patch-odbc.mjs \
    && npm_config_jobs=1 MAKEFLAGS=-j1 npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild odbc \
    && npm cache clean --force \
    && node --input-type=module -e "await import('@sap/hana-client'); await import('odbc')"
COPY src ./src
RUN mkdir -p /usr/share/sap-polling-lab && dpkg-query -W > /usr/share/sap-polling-lab/packages.tsv
USER node
ENTRYPOINT ["node", "src/sql-cli.mjs"]
