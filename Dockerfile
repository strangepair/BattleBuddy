FROM node:20-slim

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --production

COPY server/ ./server/
COPY prompts/ ./prompts/

WORKDIR /app/server

EXPOSE 3333

CMD ["node", "index.js"]
