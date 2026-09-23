# Self-host Mandate. Build: docker build -t mandate . ; run with DATABASE_URL etc.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/mcp ./mcp
# Amazon RDS certificate bundle, for DATABASE_SSL_CA=/app/certs/rds.pem.
# The build fails if the bundle cannot be fetched, rather than shipping an
# image that will refuse to talk to RDS. Set RDS_BUNDLE=off to skip it.
ARG RDS_BUNDLE=on
RUN mkdir -p certs && if [ "$RDS_BUNDLE" = "on" ]; then wget -qO certs/rds.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem && grep -q "BEGIN CERTIFICATE" certs/rds.pem; else touch certs/rds.pem; fi
EXPOSE 3000
# Apply committed migrations, then serve.
CMD ["sh", "-c", "node scripts/migrate.mjs && npx next start -p ${PORT}"]
