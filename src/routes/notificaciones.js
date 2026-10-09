import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "./auth.js";
import { vapidPublicKey, generarTokenResuscripcionPush, verificarTokenResuscripcionPush } from "./webPush.js";
import { generarEnlaceCheckIn } from "./telegram.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { registrarEventoPush } from "../lib/registroPush.js";

const router = Router();

// Registra (o reactiva) la suscripción push de este endpoint para el jugador
// y, acto seguido, borra las OTRAS suscripciones del MISMO dispositivo (mismo
// userAgent) de ese jugador. Hace falta porque el navegador genera un
// endpoint NUEVO cada vez que se vuelve a suscribir (cuando los avisos "se
// caen y se recuperan solos", o al volver tras un tiempo): el endpoint viejo
// ya está muerto pero quedaba como fila aparte, así que un mismo móvil
// acababa apareciendo varias veces en el panel. Al quedarnos solo con la
// última suscripción de cada dispositivo, la lista deja de acumular
// duplicados. Matiz: si dos aparatos distintos tuvieran EXACTAMENTE la misma
// cadena de navegador, se pisarían, pero cada uno se vuelve a registrar solo
// al entrar en la zona de socios, así que se recupera. Solo se deduplica
// cuando hay userAgent (sin él no se puede saber si es el mismo dispositivo).
// origen: "alta" (desde "Mi perfil", con sesión) o "reactivada" (el service
// worker en segundo plano, ver /push/resuscribir). Queda en el historial
// (RegistroPush) con lo que había antes, porque esto borra o reactiva justo
// las suscripciones caídas que servirían para diagnosticar un fallo.
async function registrarSuscripcion(jugadorId, endpoint, keys, userAgent, origen) {
  const previa = await prisma.suscripcionPush.findUnique({ where: { endpoint } });
  const sub = await prisma.suscripcionPush.upsert({
    where: { endpoint },
    update: { jugadorId, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || null, activa: true, fallidaEn: null, fallidaCod: null },
    create: { jugadorId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || null },
  });
  let reemplazadas = [];
  if (userAgent) {
    reemplazadas = await prisma.suscripcionPush.findMany({
      where: { jugadorId, userAgent, endpoint: { not: endpoint } },
      select: { activa: true, fallidaEn: true, fallidaCod: true },
    });
    await prisma.suscripcionPush.deleteMany({
      where: { jugadorId, userAgent, endpoint: { not: endpoint } },
    });
  }

  // Cada visita a la zona de socios vuelve a registrar la suscripción: si no
  // ha cambiado nada (ya activa, mismo socio, nada sustituido) no se apunta,
  // para no llenar el historial de ruido.
  if (previa?.activa && previa.jugadorId === jugadorId && reemplazadas.length === 0) return;

  const fecha = (d) => (d ? d.toLocaleString("es-ES", { timeZone: "Europe/Madrid" }) : "?");
  const partes = [];
  if (!previa) partes.push("suscripción nueva");
  else if (!previa.activa) {
    partes.push(`reactiva una caída (${previa.fallidaCod ?? "?"} el ${fecha(previa.fallidaEn)})`);
  } else if (previa.jugadorId !== jugadorId) partes.push("pasa de otro socio a este");
  else partes.push("ya estaba activa");
  for (const r of reemplazadas) {
    partes.push(
      r.activa
        ? "sustituye a otra activa del mismo dispositivo"
        : `sustituye a una caída del mismo dispositivo (${r.fallidaCod ?? "?"} el ${fecha(r.fallidaEn)})`
    );
  }
  await registrarEventoPush({
    jugadorId,
    evento: origen,
    suscripcionId: sub.id,
    userAgent,
    detalle: partes.join("; "),
  });
}

// GET /api/notificaciones/vapid-public-key - clave pública para que el
// frontend pueda suscribirse a Web Push. Pública (no hace falta sesión).
router.get("/vapid-public-key", (_req, res) => {
  const clave = vapidPublicKey();
  if (!clave) return res.status(503).json({ error: "Los avisos todavía no están configurados en el servidor." });
  res.json({ publicKey: clave });
});

// POST /api/notificaciones/push/suscribir - un socio activa avisos en este
// dispositivo (llamado desde "Mi perfil" tras conceder permiso en el
// navegador). El jugador se deduce de la sesión, no hace falta enviarlo.
router.post("/push/suscribir", requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Suscripción push incompleta" });
  }
  const jugador = await prisma.jugador.findUnique({ where: { usuarioId: req.usuario.sub } });
  if (!jugador) return res.status(404).json({ error: "Tu cuenta no tiene una ficha de jugador asociada" });

  await registrarSuscripcion(jugador.id, endpoint, keys, req.headers["user-agent"], "alta");
  res.status(201).json({ ok: true });
});

// DELETE /api/notificaciones/push/suscribir - desactiva avisos en este
// dispositivo.
router.delete("/push/suscribir", requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "Falta el endpoint de la suscripción" });
  const jugador = await prisma.jugador.findUnique({ where: { usuarioId: req.usuario.sub } });
  if (!jugador) return res.status(404).json({ error: "Tu cuenta no tiene una ficha de jugador asociada" });
  await prisma.suscripcionPush.deleteMany({ where: { endpoint, jugadorId: jugador.id } });
  res.status(204).end();
});

// GET /api/notificaciones/push/estado - si este socio tiene ya algún
// dispositivo con avisos activados (para pintar el botón de "Mi perfil").
router.get("/push/estado", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({ where: { usuarioId: req.usuario.sub } });
  if (!jugador) return res.json({ activo: false, cantidad: 0 });
  const cantidad = await prisma.suscripcionPush.count({ where: { jugadorId: jugador.id, activa: true } });
  res.json({ activo: cantidad > 0, cantidad });
});

// GET /api/notificaciones/push/token-resuscripcion - un socio logueado pide
// su token permanente de re-suscripción, para guardarlo en IndexedDB desde
// el frontend (el service worker no tiene acceso a localStorage) y poder
// recuperar los avisos en segundo plano si la suscripción se pierde sola
// (ver periodicsync en service-worker.js).
router.get("/push/token-resuscripcion", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({ where: { usuarioId: req.usuario.sub } });
  if (!jugador) return res.status(404).json({ error: "Tu cuenta no tiene una ficha de jugador asociada" });
  res.json({ token: generarTokenResuscripcionPush(jugador.id) });
});

// POST /api/notificaciones/push/resuscribir - re-vincula una suscripción push
// nueva SIN sesión activa (no manda Authorization: Bearer), usando en su
// lugar el token permanente de arriba. Lo usa el service worker en segundo
// plano (periodicsync), que no tiene acceso al socioToken de localStorage.
router.post("/push/resuscribir", async (req, res) => {
  const { token, endpoint, keys } = req.body || {};
  if (!token || !endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Faltan datos de re-suscripción" });
  }
  let jugadorId;
  try {
    jugadorId = verificarTokenResuscripcionPush(token);
  } catch {
    return res.status(401).json({ error: "Token de re-suscripción inválido" });
  }
  await registrarSuscripcion(jugadorId, endpoint, keys, req.headers["user-agent"], "reactivada");
  res.status(201).json({ ok: true });
});

// GET /api/notificaciones/push/admin/dispositivos - el admin ve TODOS los
// dispositivos con avisos push del club y su estado, para diagnosticar los
// avisos que "se desactivan solos" sin tener que mirar la base de datos:
// qué socio, qué dispositivo (userAgent), si está activo o caído, cuántos
// avisos ha recibido, cuándo fue el último y, si el navegador lo dio por
// muerto, cuándo y con qué código (404/410). Se ordenan primero los caídos y,
// dentro de cada grupo, por la fecha más reciente (fallo o último envío).
router.get("/push/admin/dispositivos", requireAdmin, async (_req, res) => {
  const suscripciones = await prisma.suscripcionPush.findMany({
    include: { jugador: { select: { id: true, nombre: true } } },
    orderBy: [{ activa: "asc" }, { fallidaEn: "desc" }, { ultimoEnvio: "desc" }, { creadoEn: "desc" }],
  });
  res.json(
    suscripciones.map((s) => ({
      id: s.id,
      jugadorId: s.jugadorId,
      jugadorNombre: s.jugador?.nombre || "—",
      userAgent: s.userAgent || null,
      activa: s.activa,
      enviados: s.enviados,
      ultimoEnvio: s.ultimoEnvio,
      creadoEn: s.creadoEn,
      fallidaEn: s.fallidaEn,
      fallidaCod: s.fallidaCod,
    }))
  );
});

// GET /api/notificaciones/push/admin/registro - historial de Web Push
// (RegistroPush): envíos, errores, caídas y altas/reactivaciones, del más
// reciente al más antiguo. Filtros opcionales por query: jugadorId, evento,
// desde/hasta (fechas ISO). Como mucho 1000 filas (500 por defecto).
router.get("/push/admin/registro", requireAdmin, async (req, res) => {
  const { jugadorId, evento, desde, hasta } = req.query;
  const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 500, 1), 1000);
  const creadoEn = {};
  if (desde && !isNaN(Date.parse(desde))) creadoEn.gte = new Date(desde);
  if (hasta && !isNaN(Date.parse(hasta))) creadoEn.lte = new Date(hasta);
  const registros = await prisma.registroPush.findMany({
    where: {
      ...(jugadorId ? { jugadorId: String(jugadorId) } : {}),
      ...(evento ? { evento: String(evento) } : {}),
      ...(Object.keys(creadoEn).length ? { creadoEn } : {}),
    },
    include: { jugador: { select: { nombre: true } } },
    orderBy: { creadoEn: "desc" },
    take: limite,
  });
  res.json(
    registros.map((r) => ({
      id: r.id,
      creadoEn: r.creadoEn,
      jugadorId: r.jugadorId,
      jugadorNombre: r.jugador?.nombre || "—",
      suscripcionId: r.suscripcionId,
      userAgent: r.userAgent,
      evento: r.evento,
      tipoAviso: r.tipoAviso,
      titulo: r.titulo,
      codigo: r.codigo,
      detalle: r.detalle,
    }))
  );
});

// DELETE /api/notificaciones/push/admin/dispositivos/caidos - el admin borra
// de golpe todas las suscripciones marcadas como caídas (404/410), para
// limpiar la lista de dispositivos que ya no sirven. Solo toca las inactivas:
// las activas no se tocan nunca desde aquí.
router.delete("/push/admin/dispositivos/caidos", requireAdmin, async (_req, res) => {
  const { count } = await prisma.suscripcionPush.deleteMany({ where: { activa: false } });
  res.json({ eliminados: count });
});

// GET /api/notificaciones/checkin/:token - página pública de check-in de un
// invitado: valida el token y devuelve su nombre y si ya vinculó Telegram,
// para que el frontend pueda mostrar el botón adecuado.
router.get("/checkin/:token", async (req, res) => {
  const checkIn = await prisma.telegramCheckIn.findUnique({ where: { token: req.params.token } });
  if (!checkIn) {
    return res.status(400).json({ error: "Este enlace de avisos no es válido." });
  }
  const jugador = await prisma.jugador.findUnique({
    where: { id: checkIn.jugadorId },
    include: { suscripcionTelegram: true },
  });
  if (!jugador) return res.status(404).json({ error: "No se ha encontrado esta ficha de jugador." });

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || null;
  res.json({
    nombre: jugador.nombre,
    telegramVinculado: !!jugador.suscripcionTelegram,
    idiomaAvisos: jugador.idiomaAvisos,
    urlTelegram: botUsername ? `https://t.me/${botUsername}?start=${req.params.token}` : null,
  });
});

// PUT /api/notificaciones/checkin/:token/idioma - un invitado (sin cuenta,
// identificado solo por el token de su enlace de check-in — no hace falta
// más porque el token en sí ya es el secreto) elige en qué idioma quiere
// recibir sus avisos de Telegram. Pensado sobre todo para invitados
// extranjeros puntuales (p.ej. jugadores de Francia en el Open, ver
// POST /participantes/:id/invitado-telegram en torneosClub.js), que así
// pueden recibir sus avisos en su idioma aunque el club gestione todo en
// castellano — ver Jugador.idiomaAvisos en schema.prisma.
router.put("/checkin/:token/idioma", async (req, res) => {
  const IDIOMAS_VALIDOS = ["es", "eu", "fr"];
  const { idioma } = req.body || {};
  if (!IDIOMAS_VALIDOS.includes(idioma)) {
    return res.status(400).json({ error: "Idioma no válido." });
  }
  const checkIn = await prisma.telegramCheckIn.findUnique({ where: { token: req.params.token } });
  if (!checkIn) return res.status(400).json({ error: "Este enlace de avisos no es válido." });
  await prisma.jugador.update({ where: { id: checkIn.jugadorId }, data: { idiomaAvisos: idioma } });
  res.json({ ok: true });
});

// GET /api/notificaciones/telegram/estado - un socio consulta el estado de
// sus PROPIOS avisos por Telegram (vinculado o no) y su enlace de check-in,
// para poder activarlos él mismo desde "Mi perfil" — hasta ahora el check-in
// de Telegram solo estaba disponible para invitados (el admin les generaba
// el enlace a mano desde "Jugadores del club"); los socios solo tenían Web
// Push. Hace falta sobre todo en iPhone, donde Safari no siempre puede
// mostrar la imagen grande de los avisos (Telegram sí la muestra siempre).
router.get("/telegram/estado", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({
    where: { usuarioId: req.usuario.sub },
    include: { suscripcionTelegram: true },
  });
  if (!jugador) return res.status(404).json({ error: "Tu cuenta no tiene una ficha de jugador asociada" });
  const enlace = await generarEnlaceCheckIn(jugador.id);
  res.json({ telegramVinculado: !!jugador.suscripcionTelegram, urlTelegram: enlace.urlTelegram });
});

// GET /api/notificaciones/invitados/:jugadorId/enlace - el admin obtiene el
// enlace de avisos de un invitado concreto, para copiárselo o enseñárselo
// (panel "Jugadores del club").
router.get("/invitados/:jugadorId/enlace", requireAdmin, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({
    where: { id: req.params.jugadorId },
    include: { suscripcionTelegram: true },
  });
  if (!jugador) return res.status(404).json({ error: "Jugador no encontrado" });
  const enlace = await generarEnlaceCheckIn(jugador.id);
  res.json({ ...enlace, telegramVinculado: !!jugador.suscripcionTelegram });
});

export default router;
