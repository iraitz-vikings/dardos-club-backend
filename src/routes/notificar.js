// Punto único desde el que el resto de la app manda avisos a un jugador,
// sin tener que saber por qué canal le va a llegar: si es socio con Web
// Push activado, le llega por ahí; si es invitado con Telegram vinculado,
// por ahí. Un jugador puede no tener ningún canal activo todavía (no ha
// pasado por "Mi perfil" o no ha hecho el check-in de Telegram) — en ese
// caso simplemente no se le manda nada, no es un error.
import { enviarPushAJugador } from "./webPush.js";
import { enviarTelegramAJugador } from "./telegram.js";

// opts: { titulo, cuerpo, url, imagen } — url es opcional, a dónde debería
// llevar al pulsar el aviso (se usa en el payload del Web Push). imagen es
// opcional, una URL (Cloudinary) que se muestra dentro del propio aviso: en
// Web Push como imagen grande (si el sistema operativo/navegador la soporta
// — se degrada sin más si no), en Telegram mandando la foto con el texto
// como pie en vez de un mensaje de solo texto.
export async function notificarJugador(jugadorId, opts = {}) {
  const { titulo, cuerpo, url, imagen } = opts;
  const textoTelegram = [titulo, cuerpo].filter(Boolean).join("\n\n");

  const [push, telegram] = await Promise.all([
    enviarPushAJugador(jugadorId, { titulo, cuerpo, url, imagen }),
    enviarTelegramAJugador(jugadorId, textoTelegram, imagen),
  ]);

  return { jugadorId, push, telegram };
}

// Manda el mismo aviso a varios jugadores a la vez (p.ej. toda la plantilla
// de un equipo, o todos los socios). Deduplica IDs repetidos. Nunca lanza
// por un jugador individual que falle: cada uno se resuelve por su cuenta.
export async function notificarJugadores(jugadorIds, opts = {}) {
  const idsUnicos = [...new Set(jugadorIds.filter(Boolean))];
  return Promise.all(idsUnicos.map((id) => notificarJugador(id, opts)));
}
