FROM node:26.7.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
CMD ["node", "src/main.ts"]
