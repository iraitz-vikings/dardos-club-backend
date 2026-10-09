# Backend – Web Club de Dardos

API (Express + Prisma/PostgreSQL) de la web del club: noticias, galería,
socios, torneos y ligas del club, competiciones externas (con scrapers de
Radikal/Phoenix/Connection Darts), avisos por Web Push y Telegram, y el
marcador online.

## Puesta en marcha

1. Instalar dependencias:
   ```
   npm install
   ```
2. Copiar `.env.example` a `.env` y rellenarlo (como mínimo `DATABASE_URL`,
   `JWT_SECRET` y `ADMIN_TOKEN`).
3. Crear las tablas en la base de datos:
   ```
   npx prisma db push
   ```
4. Arrancar el servidor en modo desarrollo:
   ```
   npm run dev
   ```

En producción (Railway) se despliega con el `Dockerfile`, que al arrancar
aplica el esquema (`prisma db push`) y lanza el servidor.

## Variables de entorno

Todas están explicadas en [`.env.example`](.env.example).

## Montar otro club

El código no lleva nada escrito a mano de un club concreto: lo propio de
cada club sale de variables de entorno (`src/lib/club.js` y las de
`.env.example`). Para otro club:

1. Copiar este repo (o hacer fork) y desplegarlo como servicio nuevo, con
   **su propia base de datos** vacía.
2. Configurar las variables de `.env.example` con valores del club nuevo.
   Hay que generar secretos, claves VAPID y bot de Telegram **nuevos**
   (no reutilizar los de Vikings), y usar otra cuenta de Cloudinary o
   al menos otra `CLOUDINARY_FOLDER`.
3. Arrancar: las tablas se crean solas. Las plataformas, fabricantes,
   máquinas, equipos... se dan de alta desde el panel `/admin` de la web.

La parte de la web está explicada en `NUEVO-CLUB.md` del repo `dardos-web`.

## Estructura

- `prisma/schema.prisma` — modelo de datos completo
- `src/index.js` — arranque, rutas y tareas programadas (cron)
- `src/routes/` — endpoints de la API
- `src/lib/` — lógica compartida (clasificaciones, avisos, config del club...)
- `src/scrapers/` — lectura de medias y clasificaciones de las plataformas
