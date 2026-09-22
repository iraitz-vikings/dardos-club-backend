// Envío de avisos por Web Push a los socios (navegador/móvil con la web
// instalada o simplemente con "Activar avisos" pulsado desde "Mi perfil").
// No depende de que la pestaña esté abierta: la entrega la hace el
// navegador/sistema operativo a partir del endpoint push suscrito.
import webpush from "web-push";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { enviarTelegramAJugador } from "./telegram.js";

const prisma = new PrismaClient();

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:info@dardosvikings.com";

// Token permanente (sin caducidad, igual que el enlace de check-in de
// Telegram) para volver a vincular una suscripción push SIN sesión activa.
// Hace falta porque el service worker no tiene acceso a localStorage (donde
// vive el socioToken normal) pero sí puede guardar cosas en IndexedDB — ver
// periodicsync en service-worker.js y push-token-db.js. El socio lo pide una
// vez desde "Mi perfil" (GET /push/token-resuscripcion) y a partir de ahí el
// propio navegador puede recuperar sus avisos en segundo plano si se
// desactivan solos, sin que el socio tenga que volver a entrar en la web.
export function generarTokenResuscripcionPush(jugadorId) {
  return jwt.sign({ tipo: "push-resub", jugadorId }, process.env.JWT_SECRET);
}

export function verificarTokenResuscripcionPush(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.tipo !== "push-resub" || !payload.jugadorId) throw new Error("Token de re-suscripción inválido");
  return payload.jugadorId;
}

let configurado = false;
function asegurarConfigurado() {
  if (configurado) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configurado = true;
  return true;
}

// Clave pública VAPID, para que el frontend pueda suscribirse. null si el
// servidor todavía no tiene las claves configuradas (variables de entorno
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
export function vapidPublicKey() {
  return VAPID_PUBLIC_KEY || null;
}

// Manda un aviso a TODOS los dispositivos que este jugador tenga con avisos
// activados. Si algún endpoint ya no es válido (410/404: el usuario
// desinstaló la web o borró los datos del navegador), se borra esa
// suscripción de la base de datos. Nunca lanza: si el servidor no tiene
// VAPID configurado, simplemente no manda nada (se avisa por consola).
export async function enviarPushAJugador(jugadorId, payload) {
  if (!asegurarConfigurado()) {
    console.warn("Web Push no configurado (faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY): se omite el envío.");
    return { enviados: 0, eliminados: 0 };
  }

  const suscripciones = await prisma.suscripcionPush.findMany({ where: { jugadorId } });
  if (suscripciones.length === 0) return { enviados: 0, eliminados: 0 };

  let enviados = 0;
  const idsAEliminar = [];

  await Promise.all(
    suscripciones.map(async (sub) => {
      try {
        // urgency "high": sin esto, Android puede retrasar la entrega
        // mientras el móvil está en reposo (Doze) y despertarlo solo en sus
        // ventanas de mantenimiento o al desbloquear — de ahí que llegaran
        // en momentos random en la prueba del torneo. Con prioridad alta,
        // el sistema despierta el dispositivo al instante para entregarlo.
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { urgency: "high" }
        );
        enviados++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          idsAEliminar.push(sub.id);
        } else {
          console.error(`Error enviando push (suscripción ${sub.id}):`, err.message || err);
        }
      }
    })
  );

  if (idsAEliminar.length > 0) {
    await prisma.suscripcionPush.deleteMany({ where: { id: { in: idsAEliminar } } });
    // Las notificaciones del navegador se pueden desactivar solas con el
    // tiempo sin que el socio se entere (el navegador invalida la
    // suscripción sin avisar a la web ni al servidor). Si tiene Telegram
    // vinculado, al menos se entera de que tiene que reactivarlas — no
    // bloquea el envío original (sin await sobre él, con su propio catch).
    enviarTelegramAJugador(
      jugadorId,
      "🔕 Tus avisos por notificación del navegador se han desactivado solos. Actívalos de nuevo desde \"Mi perfil\" en la web del club."
    ).catch(() => {});
  }

  return { enviados, eliminados: idsAEliminar.length };
}
