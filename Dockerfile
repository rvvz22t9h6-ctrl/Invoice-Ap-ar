FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_FILE=/data/invoices.db
COPY package.json ./
COPY server.js db.js ./
COPY public ./public
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
