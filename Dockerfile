ARG NODE_VERSION
FROM node:${NODE_VERSION}-slim AS dependencies
WORKDIR /app

RUN npm install --global pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY docs/assets/icon.png ./docs/assets/icon.png

RUN install -d -m 0700 -o node -g node /run/relay-keys \
    && printf '{}' > /run/relay-keys/clients.json \
    && chown node:node /run/relay-keys/clients.json \
    && chmod 0600 /run/relay-keys/clients.json

USER node
EXPOSE 7888

CMD ["node", "src/app/server.ts"]
