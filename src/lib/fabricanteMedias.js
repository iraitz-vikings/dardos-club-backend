import { prisma } from "./prisma.js";

// Lectura y guardado de los alias/medias de fabricante de un jugador,
// compartido por el perfil del socio (perfil.js), el perfil del invitado por
// PIN (partidasHerramienta.js) y la edición desde el panel de admin
// (jugadores.js), para no repetir la misma lógica en tres sitios.

// Devuelve los alias de fabricante de un jugador, con los datos que necesita
// el formulario de perfil (mismo shape que devolvía perfil.js).
export async function leerIdsFabricantes(jugadorId) {
  const idsFabricantes = await prisma.jugadorFabricanteId.findMany({
    where: { jugadorId },
    include: { fabricante: true },
  });
  return idsFabricantes.map((i) => ({
    fabricanteId: i.fabricanteId,
    nombreFabricante: i.fabricante.nombre,
    urlPerfilPlantilla: i.fabricante.urlPerfilPlantilla,
    logoUrl: i.fabricante.logoUrl,
    idExterno: i.idExterno,
    notaBusqueda: i.notaBusqueda,
    mpr: i.mpr,
    ppd: i.ppd,
    mprVirtual: i.mprVirtual,
    ppdVirtual: i.ppdVirtual,
    mprPresencial: i.mprPresencial,
    ppdPresencial: i.ppdPresencial,
    statsActualizadoEn: i.statsActualizadoEn,
    statsError: i.statsError,
  }));
}

// Crea/actualiza/borra los alias de fabricante de un jugador a partir del
// array que manda el formulario: { fabricanteId, idExterno, notaBusqueda,
// mpr?, ppd? }. Un idExterno vacío borra el alias de ese fabricante. mpr/ppd
// solo se tocan si el frontend los manda de verdad (hoy solo el formulario de
// Radikal Darts, cuya media se escribe a mano porque su scraper no puede
// iniciar sesión); al guardarlos a mano se marca como actualización correcta
// (statsActualizadoEn a ahora, statsError a null). Cada operación va con su
// propio .catch para que un fabricante borrado a media edición no rompa el
// resto del guardado.
export async function guardarIdsFabricantes(jugadorId, idsFabricantes) {
  if (!Array.isArray(idsFabricantes)) return;
  for (const item of idsFabricantes) {
    if (!item?.fabricanteId) continue;
    const idExterno = (item.idExterno || "").trim();
    if (!idExterno) {
      await prisma.jugadorFabricanteId
        .delete({ where: { jugadorId_fabricanteId: { jugadorId, fabricanteId: item.fabricanteId } } })
        .catch(() => {});
      continue;
    }
    const notaBusqueda = (item.notaBusqueda || "").trim() || null;

    const datosManuales = {};
    if (item.mpr !== undefined) {
      const mpr = item.mpr === null || item.mpr === "" ? null : Number(item.mpr);
      datosManuales.mpr = Number.isFinite(mpr) ? mpr : null;
    }
    if (item.ppd !== undefined) {
      const ppd = item.ppd === null || item.ppd === "" ? null : Number(item.ppd);
      datosManuales.ppd = Number.isFinite(ppd) ? ppd : null;
    }
    if (Object.keys(datosManuales).length > 0) {
      datosManuales.statsActualizadoEn = new Date();
      datosManuales.statsError = null;
    }

    await prisma.jugadorFabricanteId
      .upsert({
        where: { jugadorId_fabricanteId: { jugadorId, fabricanteId: item.fabricanteId } },
        update: { idExterno, notaBusqueda, ...datosManuales },
        create: { jugadorId, fabricanteId: item.fabricanteId, idExterno, notaBusqueda, ...datosManuales },
      })
      .catch(() => {});
  }
}
