FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ unixodbc unixodbc-dev ca-certificates \
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
USER node
ENTRYPOINT ["node", "src/sql-cli.mjs"]
