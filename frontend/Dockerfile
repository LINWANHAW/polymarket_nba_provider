FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install

COPY next.config.js tsconfig.json next-env.d.ts ./
COPY app ./app

RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
