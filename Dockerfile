FROM node:24.18.1-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci

COPY . .
RUN npm run build

FROM node:24.18.1-bookworm-slim AS backend

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev --workspace=anywear-demo-server --include-workspace-root=false

COPY --from=build /app/server/dist ./server/dist

EXPOSE 8787
CMD ["node", "server/dist/index.js"]

FROM nginx:1.29-alpine AS frontend

COPY --from=build /app/client/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
