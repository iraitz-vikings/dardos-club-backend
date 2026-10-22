# Imagen oficial de Playwright: trae Chromium y todas sus librerías de
# sistema ya instaladas, necesarias para los scrapers de Connection Darts y
# Phoenix Darts (ver src/scrapers). La versión de la imagen tiene que
# coincidir con la versión de "playwright" fijada en package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npx prisma generate

ENV NODE_ENV=production

# `exec` hace que node sustituya al sh y sea el PID 1: así recibe él el
# SIGTERM de Railway al retirar el contenedor (sh como PID 1 no lo reenvía)
# y puede cerrar ordenadamente (ver el final de src/index.js).
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && exec node src/index.js"]
