// Punto único desde el que el resto de la app manda avisos a un jugador,
// sin tener que saber por qué canal le va a llegar: si es socio con Web
// Push activado, le llega por ahí; si es invitado con Telegram vinculado,
// por ahí. Un jugador puede no tener ningún canal activo todavía (no ha
// pasado por "Mi perfil" o no ha hecho el check-in de Telegram) — en ese
// caso simplemente no se le manda nada, no es un error.
import { prisma } from "../lib/prisma.js";
import { enviarPushAJugador } from "./webPush.js";
import { enviarTelegramAJugador } from "./telegram.js";


// titulo/cuerpo pueden ser un string (igual para todo el mundo, como hasta
// ahora) o un objeto { es, eu, fr, ... } con una versión por idioma — en ese
// caso se elige la del idioma de avisos del jugador (Jugador.idiomaAvisos,
// ver "Mi perfil" para socios y la página de check-in para invitados), con
// "es" como reserva si ese idioma no tiene versión propia (igual que el
// resto de la web, ver i18n.jsx del frontend).
function resolverTexto(campo, idioma) {
  if (campo == null || typeof campo === "string") return campo;
  return campo[idioma] || campo.es || Object.values(campo).find(Boolean) || "";
}

// opts: { titulo, cuerpo, url, imagen } — url es opcional, a dónde debería
// llevar al pulsar el aviso: en Web Push se usa en el payload (se abre esa
// página al pulsar la notificación); en Telegram no hay "pulsar para abrir",
// así que se añade tal cual al final del texto para que quede como enlace.
// imagen es opcional, una URL (Cloudinary) que se muestra dentro del propio
// aviso: en Web Push como imagen grande (si el sistema operativo/navegador
// la soporta — se degrada sin más si no), en Telegram mandando la foto con
// el texto como pie en vez de un mensaje de solo texto.
//
// tag y ttl son solo para Web Push (ver enviarPushAJugador en webPush.js):
// tag hace que los avisos del mismo partido se sustituyan en el móvil en vez
// de apilarse; ttl (segundos) descarta el aviso si no se ha podido entregar
// a tiempo.
export async function notificarJugador(jugadorId, opts = {}) {
  const jugador = await prisma.jugador.findUnique({ where: { id: jugadorId }, select: { idiomaAvisos: true } });
  const idioma = jugador?.idiomaAvisos || "es";

  const titulo = resolverTexto(opts.titulo, idioma);
  const cuerpo = resolverTexto(opts.cuerpo, idioma);
  const { url, imagen, tag, ttl } = opts;
  const textoTelegram = [titulo, cuerpo, url].filter(Boolean).join("\n\n");

  const [push, telegram] = await Promise.all([
    enviarPushAJugador(jugadorId, { titulo, cuerpo, url, imagen, tag }, { ttl }),
    enviarTelegramAJugador(jugadorId, textoTelegram, imagen),
  ]);

  return { jugadorId, push, telegram };
}

// Caducidades (TTL, en segundos) de los avisos de partidos — ver `ttl` más
// arriba. "Empieza ahora" y "falta 1 minuto" no sirven de nada si llegan
// tarde; el resto (programado, recordatorio del día, eliminado, campeón...)
// aguanta más.
export const TTL_AVISO_EN_CURSO = 15 * 60;
export const TTL_AVISO_UN_MINUTO = 2 * 60;
export const TTL_AVISO_RECORDATORIO = 12 * 60 * 60;
export const TTL_AVISO_NORMAL = 24 * 60 * 60;

// true si ya se mandó un aviso con esta clave hace menos de `ventanaMs` (y si
// no, la apunta como enviada ahora). Para no repetir el mismo aviso cuando
// algo se desmarca y se vuelve a marcar (p.ej. "en curso" en el admin):
// cada repetición es un aviso más que nadie pulsa, justo lo que hace que
// Chrome/Android acaben quitando el permiso de notificaciones. En memoria:
// si el servidor se reinicia se olvida, que como mucho supone un aviso de
// más.
const avisosRecientes = new Map();
export function avisoRepetido(clave, ventanaMs = 10 * 60 * 1000) {
  const ahora = Date.now();
  for (const [k, t] of avisosRecientes) if (ahora - t > ventanaMs) avisosRecientes.delete(k);
  if (avisosRecientes.has(clave)) return true;
  avisosRecientes.set(clave, ahora);
  return false;
}

// Manda el mismo aviso a varios jugadores a la vez (p.ej. toda la plantilla
// de un equipo, o todos los socios). Deduplica IDs repetidos. Nunca lanza
// por un jugador individual que falle: cada uno se resuelve por su cuenta.
export async function notificarJugadores(jugadorIds, opts = {}) {
  const idsUnicos = [...new Set(jugadorIds.filter(Boolean))];
  return Promise.all(idsUnicos.map((id) => notificarJugador(id, opts)));
}
