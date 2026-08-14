# Imagen oficial de Playwright: trae Chromium y todas sus librerías de
# sistema ya instaladas, necesarias para los scrapers de Connection Darts y
# Phoenix Darts (ver src/scrapers). La versión de la imagen tiene que
# coincidir con la versión de "playwright" fijada en package.json.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npx prisma generate

ENV NODE_ENV=production

CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node src/index.js"]
