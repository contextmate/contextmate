FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/src/index.js"]
