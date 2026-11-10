FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-calc-nogui && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000 DB_PATH=/data/zabka.db
EXPOSE 3000
CMD ["npm", "start"]
