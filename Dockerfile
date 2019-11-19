FROM node:10.15.3-alpine AS builder

WORKDIR /opt/mojaloop-testing-toolkit

RUN apk add --no-cache -t build-dependencies git make gcc g++ python libtool autoconf automake \
    && cd $(npm root -g)/npm \
    && npm config set unsafe-perm true \
    && npm install -g node-gyp

COPY package.json package-lock.json* /opt/mojaloop-testing-toolkit/
RUN npm install

COPY config /opt/mojaloop-testing-toolkit/config
COPY src /opt/mojaloop-testing-toolkit/src
COPY spec_files /opt/mojaloop-testing-toolkit/spec_files

FROM node:10.15.3-alpine 

WORKDIR /opt/mojaloop-testing-toolkit

COPY --from=builder /opt/mojaloop-testing-toolkit .
RUN npm prune --production

EXPOSE 3000
CMD ["npm", "run", "start"]
