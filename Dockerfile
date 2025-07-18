# Etapa 1: build da aplicação
FROM node:18-alpine AS builder
WORKDIR /app

# Copia os arquivos de dependência e instala
COPY package*.json ./
RUN npm install

# Copia o restante do código (incluindo nest-cli.json e src/)
COPY . . 
RUN npm run build

# Etapa 2: imagem final para produção
FROM node:18-alpine
WORKDIR /app

# Copia os arquivos de dependência e instala só o necessário
COPY package*.json ./
RUN npm install --only=production

# Copia o resultado do build da etapa anterior
COPY --from=builder /app/dist ./dist

# (Opcional) Se você usa algum arquivo de config em tempo de execução:
COPY --from=builder /app/nest-cli.json ./nest-cli.json

CMD ["node", "dist/main"]
