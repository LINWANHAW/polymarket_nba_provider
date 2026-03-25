FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN npm run build

EXPOSE 3000
CMD ["sh", "/app/docker-entrypoint.sh"]
