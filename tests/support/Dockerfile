FROM node:24-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/entryway-core/package.json packages/entryway-core/package.json
COPY packages/entryway-service/package.json packages/entryway-service/package.json
COPY packages/entryway-web/package.json packages/entryway-web/package.json
RUN npm ci
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build && mkdir -p artifacts
ENV NODE_ENV=production
CMD ["npm", "start"]
