FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY main.js index.html ./
RUN npm run build && cp index.html dist/index.html

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /build/dist ./dist
COPY server.mjs ./server.mjs
USER 10001:10001
EXPOSE 8080
CMD ["node", "server.mjs"]
