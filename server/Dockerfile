FROM node:20-slim
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm install
RUN npx tsc
RUN npm prune --omit=dev
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/src/index.js"]
