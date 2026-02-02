FROM node:20-slim
WORKDIR /app

# Copia e instala dependências
COPY package.json package-lock.json ./
RUN npm ci --silent

# Copia configs e código
COPY tsconfig*.json ./
COPY api ./api

# Build do TypeScript
RUN npm run build:api

# Variáveis e porta
ENV NODE_ENV=production
ENV PORT=3005
EXPOSE 3005

# Verificação se arquivo compilado existe antes de rodar
CMD [ "sh", "-c", "if [ -f dist/api/server.js ]; then node dist/api/server.js; else echo 'Server file not found'; exit 1; fi" ]
