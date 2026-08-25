// Papelera de torneos/ligas del club: en vez de borrar de golpe, DELETE
// marca `borradoEn` (borrado suave). El elemento desaparece de todos los
// listados normales y del historial de los jugadores, pero se puede
// restaurar durante DIAS_PAPELERA días desde el listado GET /papelera de
// torneosClub.js/ligasClub.js. Pasado ese plazo, el cron nocturno (ver
// limpiarPapelera.js) lo borra de verdad (cascada completa, irreversible).

export const DIAS_PAPELERA = 7;

// Días que quedan antes de la purga automática, redondeados hacia arriba
// (para que "queda menos de 1 día" siga mostrando "1" en vez de "0" hasta
// que de verdad se cumpla el plazo). Devuelve null si no está en la
// papelera.
export function diasRestantesPapelera(borradoEn) {
  if (!borradoEn) return null;
  const transcurridosMs = Date.now() - new Date(borradoEn).getTime();
  const transcurridosDias = transcurridosMs / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(DIAS_PAPELERA - transcurridosDias));
}

// Fecha límite: cualquier `borradoEn` anterior a esto lleva más de
// DIAS_PAPELERA días en la papelera y toca purgarlo.
export function fechaLimitePapelera() {
  return new Date(Date.now() - DIAS_PAPELERA * 24 * 60 * 60 * 1000);
}
