FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

ARG NEXT_PUBLIC_API_BASE
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

COPY package.json ./
RUN npm install

COPY next.config.js tsconfig.json next-env.d.ts ./
COPY app ./app

RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
