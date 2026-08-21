FROM node:22.19-alpine

RUN apk add --no-cache postgresql16-client

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run web:build \
  && mkdir -p datavolume server/uploads \
  && chown node:node datavolume server/uploads

USER node
EXPOSE 8787

CMD ["npm", "run", "server"]
