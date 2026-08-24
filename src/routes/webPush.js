// Envío de avisos por Web Push a los socios (navegador/móvil con la web
// instalada o simplemente con "Activar avisos" pulsado desde "Mi perfil").
// No depende de que la pestaña esté abierta: la entrega la hace el
// navegador/sistema operativo a partir del endpoint push suscrito.
import webpush from "web-push";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:info@dardosvikings.com";

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
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload)
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
  }

  return { enviados, eliminados: idsAEliminar.length };
}
