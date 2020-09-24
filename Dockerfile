FROM node:12.16.0-alpine AS builder

WORKDIR /opt/mojaloop-testing-toolkit

RUN npm install -g bunyan
COPY package.json package-lock.json* /opt/mojaloop-testing-toolkit/
RUN npm ci

FROM node:12.16.0-alpine

WORKDIR /opt/mojaloop-testing-toolkit

COPY --from=builder /opt/mojaloop-testing-toolkit .

COPY src /opt/mojaloop-testing-toolkit/src
COPY spec_files /opt/mojaloop-testing-toolkit/spec_files
COPY examples /opt/mojaloop-testing-toolkit/examples
COPY secrets /opt/mojaloop-testing-toolkit/secrets

RUN npm prune --production

EXPOSE 5000
EXPOSE 5050
CMD ["npm", "run", "start", "|bunyan"]
