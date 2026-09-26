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
// desinstaló la web, borró los datos del navegador, o el navegador/sistema le
// retiró el permiso), esa suscripción se marca como inactiva (no se borra,
// para conservar el historial — ver SuscripcionPush en schema.prisma) y se
// deja en el log cuántos avisos llevaba y cuándo fue el último. Nunca lanza:
// si el servidor no tiene VAPID configurado, simplemente no manda nada (se
// avisa por consola).
//
// payload.tag (opcional): los avisos con el mismo tag se sustituyen en el
// móvil en vez de apilarse (ver service-worker.js del frontend) — uno por
// partido, para que "tu partido empieza", "falta 1 minuto" y el recordatorio
// de ese mismo partido dejen una sola notificación viva.
// opciones.ttl (segundos, opcional): cuánto puede esperar el servicio push
// a entregarlo si el móvil está sin conexión; pasado ese tiempo se descarta.
// Sin él, web-push usa 4 semanas: un "tu partido empieza ahora" que llega
// horas después no sirve de nada y solo suma avisos que nadie pulsa.
export async function enviarPushAJugador(jugadorId, payload, opciones = {}) {
  if (!asegurarConfigurado()) {
    console.warn("Web Push no configurado (faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY): se omite el envío.");
    return { enviados: 0, eliminados: 0 };
  }

  const suscripciones = await prisma.suscripcionPush.findMany({ where: { jugadorId, activa: true } });
  if (suscripciones.length === 0) return { enviados: 0, eliminados: 0 };

  let enviados = 0;
  const idsEnviados = [];
  const fallidas = []; // { id, codigo }

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
          { urgency: "high", ...(opciones.ttl ? { TTL: opciones.ttl } : {}) }
        );
        enviados++;
        idsEnviados.push(sub.id);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          fallidas.push({ id: sub.id, codigo: err.statusCode });
          console.warn(
            `[push] fallo ${err.statusCode} jugador=${jugadorId} sub=${sub.id} enviados=${sub.enviados} ` +
              `ultimoEnvio=${sub.ultimoEnvio ? sub.ultimoEnvio.toISOString() : "-"} creadoEn=${sub.creadoEn.toISOString()} ` +
              `ua=${JSON.stringify(sub.userAgent || "")}`
          );
        } else {
          console.error(`Error enviando push (suscripción ${sub.id}):`, err.message || err);
        }
      }
    })
  );

  if (idsEnviados.length > 0) {
    await prisma.suscripcionPush.updateMany({
      where: { id: { in: idsEnviados } },
      data: { enviados: { increment: 1 }, ultimoEnvio: new Date() },
    });
  }

  if (fallidas.length > 0) {
    const ahora = new Date();
    await Promise.all(
      fallidas.map(({ id, codigo }) =>
        prisma.suscripcionPush.update({ where: { id }, data: { activa: false, fallidaEn: ahora, fallidaCod: codigo } })
      )
    );
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

  return { enviados, eliminados: fallidas.length };
}
