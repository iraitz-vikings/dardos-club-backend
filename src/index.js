import express from "express";
import cors from "cors";
import cron from "node-cron";
import "dotenv/config";

import { actualizarTodasLasMedias } from "./scrapers/actualizarMedias.js";
import { actualizarTodasLasClasificaciones } from "./scrapers/actualizarClasificaciones.js";
import { iniciarBotTelegram } from "./routes/telegram.js";
import { limpiarPapelera } from "./lib/limpiarPapelera.js";
import { enviarRecordatoriosDeHoy } from "./lib/recordatoriosPartidos.js";

import noticiasRouter from "./routes/noticias.js";
import buscarRouter from "./routes/buscar.js";
import uploadRouter from "./routes/upload.js";
import torneoDestacadoRouter from "./routes/torneoDestacado.js";
import galeriaRouter from "./routes/galeria.js";
import torneosClubRouter from "./routes/torneosClub.js";
import patrocinadoresRouter from "./routes/patrocinadores.js";
import authRouter from "./routes/auth.js";
import mensajeAncladoRouter from "./routes/mensajeAnclado.js";
import perfilRouter from "./routes/perfil.js";
import jugadoresRouter from "./routes/jugadores.js";
import ligasClubRouter from "./routes/ligasClub.js";
import anunciosRouter from "./routes/anuncios.js";
import galeriaPrivadaRouter from "./routes/galeriaPrivada.js";
import trofeosRouter from "./routes/trofeos.js";
import equiposClubRouter from "./routes/equiposClub.js";
import maquinasRouter from "./routes/maquinas.js";
import fabricantesRouter from "./routes/fabricantes.js";
import competicionesExternasRouter from "./routes/competicionesExternas.js";
import calendarioRouter from "./routes/calendario.js";
import notificacionesRouter from "./routes/notificaciones.js";

const app = express();
app.use(cors());
app.use(express.json());

// Web pública
app.use("/api/noticias", noticiasRouter);

// Galería (fotos/vídeos sueltos, sin noticia asociada)
app.use("/api/galeria", galeriaRouter);

// Torneos del club (con cuadro por maquina)
app.use("/api/torneos-club", torneosClubRouter);

// Torneo destacado (mostrado en la home)
app.use("/api/torneo-destacado", torneoDestacadoRouter);

// Patrocinadores del club
app.use("/api/patrocinadores", patrocinadoresRouter);

// Subida de imágenes (admin)
app.use("/api/upload", uploadRouter);

// Autenticación de socios (registro, login, aprobación)
app.use("/api/auth", authRouter);

app.use("/api/mensaje-anclado", mensajeAncladoRouter);

app.use("/api/perfil", perfilRouter);

app.use("/api/jugadores", jugadoresRouter);

app.use("/api/ligas-club", ligasClubRouter);

app.use("/api/anuncios", anunciosRouter);

app.use("/api/galeria-privada", galeriaPrivadaRouter);

app.use("/api/trofeos", trofeosRouter);

app.use("/api/equipos-club", equiposClubRouter);

app.use("/api/maquinas", maquinasRouter);

app.use("/api/fabricantes", fabricantesRouter);

app.use("/api/competiciones-externas", competicionesExternasRouter);

app.use("/api/calendario", calendarioRouter);

// Avisos por Web Push (socios) y Telegram (invitados)
app.use("/api/notificaciones", notificacionesRouter);

// Buscador global de la web (noticias, torneos, ligas)
app.use("/api/buscar", buscarRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Arranca el bot de Telegram (si TELEGRAM_BOT_TOKEN está configurado), para
// poder recibir el /start de los invitados que hacen check-in.
iniciarBotTelegram();

// Cada noche a las 04:00 se refrescan las medias de Connection Darts y
// Phoenix Darts guardadas en los perfiles de los socios (ver
// src/scrapers/actualizarMedias.js). También se puede lanzar a mano desde
// el admin con el botón "Actualizar medias".
cron.schedule("0 4 * * *", () => {
  console.log("Actualizando medias de fabricantes (cron nocturno)...");
  actualizarTodasLasMedias()
    .then((resumen) => console.log("Medias actualizadas:", resumen))
    .catch((err) => console.error("Error actualizando medias:", err));
});

// Cada noche a las 04:30 (media hora después del cron de medias de arriba,
// para no tener dos navegadores Playwright abiertos a la vez en el mismo
// servidor) se refresca la clasificación de todos los torneos/ligas
// externos dados de alta (ver src/scrapers/actualizarClasificaciones.js).
// Por ahora esto solo actualiza algo en Radikal Darts y Phoenix Darts;
// Connection Darts se omite hasta que tenga scraper. También se puede
// lanzar a mano desde el admin, tanto por torneo ("Actualizar
// clasificación") como para todos a la vez ("Actualizar todas las
// clasificaciones ahora", en "Comp. externas").
cron.schedule("30 4 * * *", () => {
  console.log("Actualizando clasificaciones de equipos (cron nocturno)...");
  actualizarTodasLasClasificaciones()
    .then((resumen) => console.log("Clasificaciones actualizadas:", resumen))
    .catch((err) => console.error("Error actualizando clasificaciones:", err));
});

// Cada noche a las 05:00 (después de los crons de medias/clasificaciones de
// arriba) se purgan de verdad los torneos/ligas del club que llevan más de
// 7 días en la papelera (ver src/lib/limpiarPapelera.js y "Borrar" en
// AdminTorneosClub.jsx/AdminLigasClub.jsx, que ahora es un borrado suave).
cron.schedule("0 5 * * *", () => {
  console.log("Purgando papelera de torneos/ligas (cron nocturno)...");
  limpiarPapelera()
    .then((resumen) => console.log("Papelera purgada:", resumen))
    .catch((err) => console.error("Error purgando papelera:", err));
});

// Cada mañana a las 08:00 UTC (10:00 en Madrid en verano, 09:00 en
// invierno) se manda el recordatorio del día a quien tenga un partido
// confirmado para hoy — torneos, ligas y competiciones externas del club
// (ver src/lib/recordatoriosPartidos.js). Es un segundo aviso, aparte del
// que ya se manda en el momento de fijar/confirmar el partido (que puede
// haber sido días o semanas antes).
cron.schedule("0 8 * * *", () => {
  console.log("Enviando recordatorios de partidos de hoy (cron matutino)...");
  enviarRecordatoriosDeHoy()
    .then((resumen) => console.log("Recordatorios enviados:", resumen))
    .catch((err) => console.error("Error enviando recordatorios:", err));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
