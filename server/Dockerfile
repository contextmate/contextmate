FROM node:20-slim
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/
# Compile native modules when a prebuilt binary is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm install \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npx tsc
RUN npm prune --omit=dev
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/src/index.js"]
