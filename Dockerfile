FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci
COPY client ./client
COPY server ./server
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production SERVE_CLIENT=true
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/client/dist ./client/dist

EXPOSE 5000
CMD ["npm", "run", "start", "--workspace=server"]