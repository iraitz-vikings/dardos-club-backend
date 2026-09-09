// Validación del enlace de vídeo en directo (YouTube) que se puede guardar en
// un TorneoClub o una LigaClub — ver `videoDirectoUrl` en schema.prisma. El
// admin pega aquí la URL cuando empieza a retransmitir un torneo/liga (y la
// borra al terminar); se muestra embebido en la página pública de ese
// torneo/liga y, si además es público, también en la portada de la web
// principal (ver dardos-web/src/App.jsx).
//
// De momento solo se admite YouTube (es lo que pidió Iraitz) — la misma
// forma de URL que ya reconoce dardos-web para los vídeos de noticias
// (youtube.com/watch, youtu.be, /live/, /embed/, /shorts/).
const REGEX_YOUTUBE = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|live\/|embed\/|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/;

// undefined/null/"" -> "no se ha tocado nada" -> null (sin vídeo en directo).
// Devuelve { ok: true, valor } o { ok: false, error }.
export function validarVideoDirectoUrl(valor) {
  if (valor === undefined || valor === null || valor === "") return { ok: true, valor: null };
  if (typeof valor !== "string" || !REGEX_YOUTUBE.test(valor.trim())) {
    return { ok: false, error: "El enlace tiene que ser una URL de YouTube válida (youtube.com o youtu.be)." };
  }
  return { ok: true, valor: valor.trim() };
}
