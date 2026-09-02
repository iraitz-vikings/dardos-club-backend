// Enlaces a las páginas públicas de un torneo/liga del club (ver main.jsx en
// dardos-web: /torneo/:id y /liga/:id), para que los avisos automáticos
// (partido programado/en curso, sorteo, eliminado, campeón, recordatorio del
// día) lleven al jugador directamente ahí en vez de a la portada de la web.
// Antes solo el aviso de "bienvenida al sortear" incluía este enlace; el
// resto se abrían con el valor por defecto "/" del service worker
// (public/service-worker.js: `data: { url: datos.url || "/" }`).
//
// Devuelven undefined si el servidor no tiene FRONTEND_URL configurado (o
// falta el id) — en ese caso el aviso se manda igual, solo que sin enlace
// concreto, igual que ya pasaba con generarEnlaceCheckIn en telegram.js.
function frontendUrl() {
  return (process.env.FRONTEND_URL || "").replace(/\/$/, "");
}

export function urlPublicaTorneo(torneoId) {
  const base = frontendUrl();
  return base && torneoId ? `${base}/torneo/${torneoId}` : undefined;
}

export function urlPublicaLiga(ligaId) {
  const base = frontendUrl();
  return base && ligaId ? `${base}/liga/${ligaId}` : undefined;
}

// Para un Cuadrante con `torneoClub`/`liga` incluidos (ver includes en
// torneosClub.js) — un mismo Cuadrante pertenece o bien a un TorneoClub, o
// bien al cuadrante final de una LigaClub, nunca a los dos.
export function urlPublicaCuadrante(cuadrante) {
  if (cuadrante?.torneoClub) return urlPublicaTorneo(cuadrante.torneoClub.id);
  if (cuadrante?.liga) return urlPublicaLiga(cuadrante.liga.id);
  return undefined;
}
