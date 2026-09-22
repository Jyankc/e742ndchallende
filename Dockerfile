FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Prisma config requires a URL during generation; no database is contacted.
RUN DATABASE_URL=postgresql://ingestion:ingestion@postgres:5432/ingestion npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
