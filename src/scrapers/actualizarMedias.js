import { PrismaClient } from "@prisma/client";
import { actualizarMediasConnection } from "./connectionDarts.js";
import { actualizarMediasPhoenix } from "./phoenixDarts.js";
import { actualizarMediasRadikal } from "./radikalDarts.js";

const prisma = new PrismaClient();

// Campos de media que puede rellenar un scraper. Phoenix y Radikal solo
// devuelven mpr/ppd (una única media); Connection devuelve las 4 variantes
// Virtual/Presencial. Solo se escriben en la base de datos los campos que el
// resultado del scraper realmente trae (ver más abajo), para no pisar con
// null los campos que ese fabricante en concreto nunca rellena.
const CAMPOS_STATS = ["mpr", "ppd", "mprVirtual", "ppdVirtual", "mprPresencial", "ppdPresencial"];

// Bullshooter es público (se enlaza directamente desde el perfil, sin
// scraping, por respeto a su robots.txt), así que no tiene scraper aquí.
//
// "clave" se busca dentro del nombre del fabricante sin distinguir
// mayúsculas/minúsculas (ej. "Connection", "Connection Darts", "connection"
// encajan todos), para no depender de que el admin haya escrito el nombre
// exacto al darlo de alta.
const SCRAPERS = [
  { etiqueta: "Connection", clave: "connection", scraper: actualizarMediasConnection },
  { etiqueta: "Phoenix", clave: "phoenix", scraper: actualizarMediasPhoenix },
  { etiqueta: "Radikal", clave: "radikal", scraper: actualizarMediasRadikal },
];

// Recorre los fabricantes con scraper, y para cada uno actualiza el
// mpr/ppd de todos los jugadores que tengan un alias guardado para él.
// Nunca lanza si un fabricante falla entero (ej. login roto): lo recoge en
// el resumen para que el admin lo vea, y sigue con el resto.
export async function actualizarTodasLasMedias() {
  const resumen = {};

  for (const { etiqueta, clave, scraper } of SCRAPERS) {
    const fabricante = await prisma.fabricante.findFirst({
      where: { nombre: { contains: clave, mode: "insensitive" } },
    });
    if (!fabricante) {
      resumen[etiqueta] = { omitido: true, motivo: "No hay ningún fabricante dado de alta cuyo nombre contenga esa palabra" };
      continue;
    }

    const registros = await prisma.jugadorFabricanteId.findMany({
      where: { fabricanteId: fabricante.id },
      select: { id: true, idExterno: true, notaBusqueda: true },
    });

    if (registros.length === 0) {
      resumen[etiqueta] = { actualizados: 0, errores: 0 };
      continue;
    }

    try {
      const resultados = await scraper(registros);
      let actualizados = 0;
      let errores = 0;
      for (const r of resultados) {
        // Cada update va envuelto en su propio try/catch: si uno falla (ej.
        // el jugador borró su alias o un admin borró el fabricante justo
        // durante la pasada), no debe tirar por la borda el resto de
        // resultados ya obtenidos de este fabricante.
        if (r.ok) {
          try {
            const datosStats = {};
            for (const campo of CAMPOS_STATS) {
              if (campo in r) datosStats[campo] = r[campo] ?? null;
            }
            await prisma.jugadorFabricanteId.update({
              where: { id: r.id },
              data: { ...datosStats, statsActualizadoEn: new Date(), statsError: null },
            });
            actualizados++;
          } catch {
            errores++;
          }
        } else {
          await prisma.jugadorFabricanteId
            .update({ where: { id: r.id }, data: { statsError: r.error || "No encontrado" } })
            .catch(() => {});
          errores++;
        }
      }
      resumen[etiqueta] = { actualizados, errores };
    } catch (err) {
      // Fallo general (ej. login incorrecto/roto): no se ha podido ni
      // empezar a consultar jugadores de este fabricante.
      resumen[etiqueta] = { error: err.message || "Error desconocido" };
    }
  }

  return resumen;
}
