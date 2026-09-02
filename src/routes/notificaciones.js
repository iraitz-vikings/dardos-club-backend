import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { vapidPublicKey } from "./webPush.js";
import { generarEnlaceCheckIn } from "./telegram.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

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

  await prisma.suscripcionPush.upsert({
    where: { endpoint },
    update: { jugadorId: jugador.id, p256dh: keys.p256dh, auth: keys.auth, userAgent: req.headers["user-agent"] || null },
    create: {
      jugadorId: jugador.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: req.headers["user-agent"] || null,
    },
  });
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
  const cantidad = await prisma.suscripcionPush.count({ where: { jugadorId: jugador.id } });
  res.json({ activo: cantidad > 0, cantidad });
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
    urlTelegram: botUsername ? `https://t.me/${botUsername}?start=${req.params.token}` : null,
  });
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
