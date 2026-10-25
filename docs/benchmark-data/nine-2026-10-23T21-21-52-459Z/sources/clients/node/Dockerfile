FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY src ./src
USER node
ENTRYPOINT ["node", "src/cli.mjs"]
