FROM node:20-alpine

ARG SOURCE
ARG COMMIT_HASH
ARG COMMIT_ID
ARG BUILD_TIME
LABEL source=${SOURCE}
LABEL commit_hash=${COMMIT_HASH}
LABEL commit_id=${COMMIT_ID}
LABEL build_time=${BUILD_TIME}
WORKDIR /usr/src/app

ENV SERVER_HOST=0.0.0.0

COPY package.json ./

RUN npm install --only=production && npm cache clean --force

COPY app.js index.html ./

EXPOSE 8080
EXPOSE 8081
EXPOSE 8025

CMD [ "node", "app.js" ]