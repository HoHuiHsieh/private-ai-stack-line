FROM node:22-alpine AS base
WORKDIR /app

# Dev target: source is bind-mounted by services/line/docker-compose.dev.yml
FROM base AS dev
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# Prod target: tsx runs the TypeScript directly (it is a runtime dependency).
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --chown=app:app . .
USER app
EXPOSE 3000
CMD ["npm", "start"]
