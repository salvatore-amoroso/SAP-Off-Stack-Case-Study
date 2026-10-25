FROM sap-polling-node:cds-fix-base-a945b55d
USER root
COPY scripts/patch-odbc.mjs /app/scripts/patch-odbc.mjs
RUN node --input-type=module -e "import {readFile,writeFile} from 'node:fs/promises'; import {patchOdbcCursorSource} from '/app/scripts/patch-odbc.mjs'; const p='/app/node_modules/odbc/src/odbc_cursor.cpp'; await writeFile(p,patchOdbcCursorSource(await readFile(p,'utf8')));" \
    && cd /app && npm_config_jobs=1 MAKEFLAGS=-j1 npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild --offline odbc
COPY src /app/src
USER node
ENTRYPOINT ["node", "/app/src/sql-cli.mjs"]