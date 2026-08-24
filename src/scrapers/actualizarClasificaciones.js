import { PrismaClient } from "@prisma/client";
import { extraerClasificacionEquiposRadikal } from "./radikalDarts.js";
import { extraerClasificacionEquiposPhoenix } from "./phoenixDarts.js";

const prisma = new PrismaClient();

// Convierte una fila extraída por un scraper (posicion/nombreEquipo/...) en
// los datos que espera Prisma para crear una fila de ClasificacionEquipo.
function filaClasificacion(f) {
  return {
    posicion: f.posicion,
    nombreEquipo: f.nombreEquipo,
    puntos: f.puntos,
    partidosJugados: f.partidosJugados,
    partidosGanados: f.partidosGanados,
    partidosPerdidos: f.partidosPerdidos,
    partidosEmpatados: f.partidosEmpatados,
    juegosGanados: f.juegosGanados,
    juegosPerdidos: f.juegosPerdidos,
    origenActualizacion: "scraper",
  };
}

// Actualiza la clasificación de UN torneo/liga externo. Esta es la misma
// lógica que antes vivía solo dentro de la ruta POST
// /torneos/:id/actualizar-clasificacion — se movió aquí para poder
// reutilizarla también desde el cron automático y desde el botón "Actualizar
// todas las clasificaciones ahora", sin duplicar código en tres sitios.
//
// `torneo` debe venir con `plataforma` y `equipos` incluidos (findUnique con
// { include: { plataforma: true, equipos: true } }).
//
// Nunca lanza (salvo error real de base de datos): siempre devuelve uno de
// estos resultados, para que quien llame decida qué hacer con él (responder
// al admin, o simplemente anotarlo en un resumen y seguir con el siguiente
// torneo):
//   { ok: true, avisos: [] }                    todo bien
//   { ok: true, avisos: ["equipo X: motivo"] }   bien, pero algún equipo en
//                                                 concreto falló (solo puede
//                                                 pasar en Phoenix, que tiene
//                                                 varios equipos por torneo)
//   { ok: false, error: "..." }                  no se pudo actualizar nada
//   { ok: false, omitido: true, motivo: "..." }  plataforma sin scraper
//                                                 todavía (Connection Darts)
//                                                 — no es un error, se omite
export async function actualizarClasificacionTorneo(torneo) {
  const nombrePlataforma = (torneo.plataforma?.nombre || "").toLowerCase();

  if (nombrePlataforma.includes("radikal")) {
    const [resultado] = await extraerClasificacionEquiposRadikal([{ id: torneo.id, idExterno: torneo.idExterno }]);
    if (!resultado.ok) return { ok: false, error: resultado.error };

    await prisma.$transaction([
      prisma.clasificacionEquipo.deleteMany({ where: { torneoId: torneo.id, equipoTorneoId: null } }),
      prisma.clasificacionEquipo.createMany({
        data: resultado.filas.map((f) => ({ torneoId: torneo.id, ...filaClasificacion(f) })),
      }),
    ]);
    return { ok: true, avisos: [] };
  }

  if (nombrePlataforma.includes("phoenix")) {
    if (torneo.equipos.length === 0) {
      return {
        ok: false,
        error: 'Este torneo/liga todavía no tiene ningún equipo del club inscrito. Inscribe uno primero desde la pestaña "Equipos".',
      };
    }

    const objetivos = torneo.equipos.map((eq) => ({
      id: eq.id,
      idExterno: eq.idExternoEquipo || torneo.idExterno,
      nombre: torneo.nombre,
    }));
    const resultados = await extraerClasificacionEquiposPhoenix(objetivos);
    const exitos = resultados.filter((r) => r.ok);
    const fallos = resultados.filter((r) => !r.ok);

    if (exitos.length === 0) {
      return {
        ok: false,
        error:
          fallos.length === 1
            ? fallos[0].error
            : `No se pudo actualizar ningún equipo:\n${fallos.map((f) => `- ${f.error}`).join("\n")}`,
      };
    }

    await prisma.$transaction(
      exitos.flatMap((r) => [
        prisma.clasificacionEquipo.deleteMany({ where: { equipoTorneoId: r.equipoTorneoId } }),
        prisma.clasificacionEquipo.createMany({
          data: r.filas.map((f) => ({ torneoId: torneo.id, equipoTorneoId: r.equipoTorneoId, ...filaClasificacion(f) })),
        }),
      ])
    );

    const avisos = fallos.map((f) => {
      const eq = torneo.equipos.find((e) => e.id === f.equipoTorneoId);
      const nombreEq = eq?.idExternoEquipo || eq?.nombreEquipo || "Un equipo";
      return `${nombreEq}: ${f.error}`;
    });
    return { ok: true, avisos };
  }

  return {
    ok: false,
    omitido: true,
    motivo: `La extracción de clasificación de equipos todavía no está implementada para "${torneo.plataforma?.nombre || "esta plataforma"}" (por ahora solo Radikal Darts y Phoenix Darts).`,
  };
}

// Recorre TODOS los torneos/ligas externos dados de alta y actualiza la
// clasificación de cada uno, uno detrás de otro (no en paralelo: cada
// actualización abre su propio navegador Playwright, y lanzar varios a la
// vez podría agotar la memoria del servidor). Nunca lanza si uno falla
// (login roto, nombre de equipo mal puesto, plataforma sin soportar
// todavía...): lo recoge en el resumen y sigue con el siguiente. Pensada
// tanto para el cron nocturno como para el botón "Actualizar todas las
// clasificaciones ahora" del panel de admin.
export async function actualizarTodasLasClasificaciones() {
  const torneos = await prisma.torneo.findMany({
    include: { plataforma: true, equipos: true },
  });

  const resumen = { actualizados: 0, errores: 0, omitidos: 0, detalle: [] };

  for (const torneo of torneos) {
    try {
      const resultado = await actualizarClasificacionTorneo(torneo);
      if (resultado.omitido) {
        resumen.omitidos++;
        resumen.detalle.push({ torneo: torneo.nombre, estado: "omitido", motivo: resultado.motivo });
      } else if (resultado.ok) {
        resumen.actualizados++;
        resumen.detalle.push(
          resultado.avisos.length > 0
            ? { torneo: torneo.nombre, estado: "ok", avisos: resultado.avisos }
            : { torneo: torneo.nombre, estado: "ok" }
        );
      } else {
        resumen.errores++;
        resumen.detalle.push({ torneo: torneo.nombre, estado: "error", error: resultado.error });
      }
    } catch (err) {
      resumen.errores++;
      resumen.detalle.push({ torneo: torneo.nombre, estado: "error", error: err.message || "Error desconocido" });
    }
  }

  return resumen;
}
