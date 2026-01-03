FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY api ./api

RUN npm run build:api

ENV NODE_ENV=production
ENV PORT=3005
EXPOSE 3005

CMD ["node","dist/api/server.js"]
