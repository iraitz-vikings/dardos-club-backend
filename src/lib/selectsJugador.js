// Campos de un Jugador que se pueden devolver dentro de otras respuestas
// (participantes de torneos/ligas, equipos, capitanes...). Antes se hacía
// `include: { jugador1: true }`, que devuelve la ficha ENTERA — incluido
// pinPartidasHash: con un PIN de 4 dígitos, ese hash se descifra probando
// las 10.000 combinaciones en segundos y permite jugar (y meter resultados)
// en la herramienta de marcador como ese jugador. Auditoría 2026-09-26.
// Si una pantalla necesita otro campo, añadirlo aquí a propósito, nunca
// volver a `true`.
//
// Sin avatarUrl: estas respuestas las puede leer cualquiera sin sesión
// (páginas públicas de torneos/ligas/equipos) y la foto de un jugador es un
// dato personal que no ha consentido publicar en abierto — la web solo la
// enseña a socios con sesión (directorio y ficha, GET /api/jugadores/
// directorio y /:id/ficha). Revisión de normativa 2026-09-29.
export const JUGADOR_PUBLICO = { select: { id: true, nombre: true, apodo: true } };

// Igual, más el usuarioId (qué cuenta de socio es) — solo para respuestas
// que ya exigen sesión de socio y lo necesitan (p.ej. saber si el socio
// logueado es el capitán de un equipo, ver Competiciones.jsx).
export const JUGADOR_CON_USUARIO = { select: { ...JUGADOR_PUBLICO.select, usuarioId: true } };
