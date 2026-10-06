import express from "express";
import cors from "cors";
import helmet from "helmet";
import cron from "node-cron";
import "dotenv/config";
// Hace que un error lanzado (o una promesa rechazada) dentro de CUALQUIER
// ruta async se pase al manejador de errores de Express en vez de quedar
// como "unhandledRejection", que en Node por defecto MATA el proceso. Sin
// esto, una sola petición malformada (p.ej. POST /auth/login con el email
// como lista: email.trim() peta) tumbaba el servidor entero para todo el
// mundo, sin necesidad de estar identificado (auditoría 2026-09-26).
import "express-async-errors";

import { actualizarTodasLasMedias } from "./scrapers/actualizarMedias.js";
import { actualizarTodasLasClasificaciones } from "./scrapers/actualizarClasificaciones.js";
import { iniciarBotTelegram } from "./routes/telegram.js";
import { limpiarPapelera } from "./lib/limpiarPapelera.js";
import { purgarRegistroPush } from "./lib/registroPush.js";
import { enviarRecordatoriosDeHoy } from "./lib/recordatoriosPartidos.js";
import { enviarAvisosUnMinutoTemporizador } from "./lib/avisoTemporizadorPartidos.js";

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
import eventosCalendarioRouter from "./routes/eventosCalendario.js";
import notificacionesRouter from "./routes/notificaciones.js";
import partidasHerramientaRouter from "./routes/partidasHerramienta.js";

const app = express();
// Railway pone un proxy delante: sin esto, req.ip es siempre la IP del proxy
// y los límites de intentos (loginLimiter.js, requireAdmin.js) contaban a
// todo el mundo como si fuera una sola persona. 1 = confiar solo en el
// primer salto (el de Railway), no en lo que mande el cliente.
app.set("trust proxy", 1);
// Cabeceras de seguridad (X-Content-Type-Options, Referrer-Policy, oculta
// X-Powered-By, etc.). La API solo devuelve JSON, no HTML, así que se
// desactiva la CSP de helmet (no aplica y podría estorbar). CORS abierto a
// propósito: la web del club está en otro dominio y la sesión va por token
// Bearer (no por cookie), así que abrir CORS no expone la sesión de nadie.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors());
// Límite subido de 100kb (por defecto de Express) a 5mb: algunas rutas de
// admin (torneos/ligas del club) construían su PUT mandando el objeto
// completo ya cargado en el frontend (incluidos cuadrantes/partidos
// anidados) para no pisar campos no tocados — en un torneo grande eso podía
// superar el límite por defecto y el guardado fallaba con un error genérico
// sin explicación (2026-09-16). Esas rutas ahora mandan solo lo que cambia,
// pero este límite se sube igualmente como red de seguridad.
app.use(express.json({ limit: "5mb" }));

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
app.use("/api/eventos-calendario", eventosCalendarioRouter);

// Avisos por Web Push (socios) y Telegram (invitados)
app.use("/api/notificaciones", notificacionesRouter);

// Buscador global de la web (noticias, torneos, ligas)
app.use("/api/buscar", buscarRouter);

// Herramienta de marcador jugada desde la página pública (login con PIN,
// partidos pendientes, jugar y aplicar el resultado) — ver src/routes/partidasHerramienta.js
app.use("/api/partidas-herramienta", partidasHerramientaRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Arranca el bot de Telegram (si TELEGRAM_BOT_TOKEN está configurado), para
// poder recibir el /start de los invitados que hacen check-in.
iniciarBotTelegram();

// Cada 3 meses (día 1 de enero, abril, julio y octubre) a las 04:00 se
// refrescan las medias de Connection Darts y Phoenix Darts guardadas en los
// perfiles de los socios (ver src/scrapers/actualizarMedias.js) — las medias
// cambian muy poco, así que no compensa hacerlo más a menudo. También se
// puede lanzar a mano en cualquier momento desde el admin con el botón
// "Actualizar medias".
cron.schedule("0 4 1 1,4,7,10 *", () => {
  console.log("Actualizando medias de fabricantes (cron nocturno)...");
  actualizarTodasLasMedias()
    .then((resumen) => console.log("Medias actualizadas:", resumen))
    .catch((err) => console.error("Error actualizando medias:", err));
});

// De lunes a viernes a las 04:30 (media hora después del cron de medias de
// arriba, para no tener dos navegadores Playwright abiertos a la vez en el
// mismo servidor) se refresca la clasificación de todos los torneos/ligas
// externos dados de alta (ver src/scrapers/actualizarClasificaciones.js).
// Los fines de semana no se suele jugar liga, así que no hace falta
// actualizar sábados ni domingos. Por ahora esto solo actualiza algo en
// Radikal Darts y Phoenix Darts; Connection Darts se omite hasta que tenga
// scraper. También se puede lanzar a mano desde el admin, tanto por torneo
// ("Actualizar clasificación") como para todos a la vez ("Actualizar todas
// las clasificaciones ahora", en "Comp. externas").
cron.schedule("30 4 * * 1-5", () => {
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

// Y a la misma hora se borra el historial de Web Push de más de 60 días
// (ver RegistroPush en schema.prisma y src/lib/registroPush.js).
cron.schedule("10 5 * * *", () => {
  purgarRegistroPush()
    .then((resumen) => console.log("Historial de push purgado:", resumen))
    .catch((err) => console.error("Error purgando historial de push:", err.message || err));
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

// Cada minuto se revisa si algún partido de torneo del club "en curso" con
// temporizador activo ha llegado a su último minuto de plazo, para mandar
// el aviso de "falta 1 minuto" (ver src/lib/avisoTemporizadorPartidos.js).
// Solo torneos del club (las ligas no tienen temporizador).
cron.schedule("* * * * *", () => {
  enviarAvisosUnMinutoTemporizador().catch((err) =>
    console.error("Error enviando avisos de temporizador:", err.message || err)
  );
});

// Manejador de errores final: cualquier error no controlado en una ruta
// acaba aquí y se responde 500 sin filtrar la traza al cliente (queda en el
// log del servidor). Tiene que ir DESPUÉS de montar todas las rutas.
app.use((err, req, res, _next) => {
  console.error(`Error no controlado en ${req.method} ${req.originalUrl}:`, err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Ha ocurrido un error inesperado." });
});

// Última red de seguridad: si algo se escapa fuera de una ruta (un cron, el
// bot de Telegram...), se registra pero NO se mata el proceso.
process.on("unhandledRejection", (motivo) => {
  console.error("unhandledRejection (no se cierra el proceso):", motivo?.message || motivo);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
