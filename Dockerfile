FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Inside the container the listener must accept from the bridge network; the
# container boundary and the compose port binding are what limit exposure.
ENV BIND_HOST=0.0.0.0
ENV DATABASE_PATH=/data/drawdb.sqlite
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/collaboration ./src/collaboration
RUN install -d -o node -g node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
