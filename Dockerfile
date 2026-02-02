# Base leve com Node.js
FROM node:20-slim

# Diretório de trabalho
WORKDIR /app

# Copia apenas arquivos de dependência e instala
COPY package.json package-lock.json ./
RUN npm ci --silent

# Copia arquivos de configuração do TypeScript
COPY tsconfig*.json ./

# Copia o código-fonte
COPY api ./api

# Build do TypeScript
RUN npm run build:api

# Variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=3005

# Porta exposta
EXPOSE 3005

# CMD com verificação para evitar SIGTERM silencioso
CMD [ "sh", "-c", "if [ -f dist/api/server.js ]; then node dist/api/server.js; else echo '⚠️ Server file not found!'; exit 1; fi" ]
