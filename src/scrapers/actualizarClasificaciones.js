import { prisma } from "../lib/prisma.js";
import { extraerClasificacionEquiposRadikal } from "./radikalDarts.js";
import { extraerClasificacionEquiposPhoenix } from "./phoenixDarts.js";
import { extraerClasificacionEquiposConnection } from "./connectionDarts.js";


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
// { include: { plataforma: true, equipos: { include: { equipoClub: true } } } }
// — equipoClub hace falta para Connection, que casa por nombre del equipo).
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

  const esConnection = nombrePlataforma.includes("connection");
  if (nombrePlataforma.includes("phoenix") || esConnection) {
    if (torneo.equipos.length === 0) {
      return {
        ok: false,
        error: 'Este torneo/liga todavía no tiene ningún equipo del club inscrito. Inscribe uno primero desde la pestaña "Equipos".',
      };
    }

    // Connection: Torneo.idExterno = ids de liga separados por comas; cada
    // equipo se busca por su nombre en todos los grupos de esas ligas (ver
    // connectionDarts.js). Phoenix: búsqueda por nombre de equipo.
    const resultados = esConnection
      ? await extraerClasificacionEquiposConnection(
          torneo.idExterno,
          torneo.equipos.map((eq) => ({
            id: eq.id,
            nombreExacto: eq.idExternoEquipo || null,
            nombreClub: eq.equipoClub?.nombre || eq.nombreEquipo || null,
          }))
        )
      : await extraerClasificacionEquiposPhoenix(
          torneo.equipos.map((eq) => ({
            id: eq.id,
            idExterno: eq.idExternoEquipo || torneo.idExterno,
            nombre: torneo.nombre,
          }))
        );
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

    // Connection: además de la clasificación, sincroniza calendario y
    // resultados de los partidos de NUESTROS equipos (ver
    // sincronizarPartidosConnection más abajo).
    const avisosPartidos = [];
    if (esConnection) {
      for (const r of exitos) {
        const eq = torneo.equipos.find((e) => e.id === r.equipoTorneoId);
        const nombreEq = eq?.equipoClub?.nombre || eq?.idExternoEquipo || "Un equipo";
        if (r.avisoPartidos) avisosPartidos.push(`${nombreEq}: ${r.avisoPartidos}`);
        if (!r.partidos) continue;
        try {
          await sincronizarPartidosConnection(r.equipoTorneoId, r.partidos);
        } catch (err) {
          avisosPartidos.push(`${nombreEq}: error guardando partidos (${err.message})`);
        }
      }
    }

    const avisos = fallos.map((f) => {
      const eq = torneo.equipos.find((e) => e.id === f.equipoTorneoId);
      const nombreEq = eq?.idExternoEquipo || eq?.equipoClub?.nombre || eq?.nombreEquipo || "Un equipo";
      return `${nombreEq}: ${f.error}`;
    });
    return { ok: true, avisos: [...avisos, ...avisosPartidos] };
  }

  return {
    ok: false,
    omitido: true,
    motivo: `La extracción de clasificación de equipos todavía no está implementada para "${torneo.plataforma?.nombre || "esta plataforma"}" (por ahora solo Radikal, Phoenix y Connection Darts).`,
  };
}

// Crea/actualiza los Partido de una inscripción a partir del calendario de
// Connection (solo los partidos de ese equipo). Reglas:
//  - Partido nuevo → se crea SIN confirmar (fijado=false), para que el
//    capitán solo tenga que revisarlo y pulsar "Confirmar" (ahí elige
//    máquina, y se avisa a la plantilla, como siempre).
//  - Si aún no está confirmado ni lo ha tocado el capitán
//    (origenActualizacion = scraper), se le actualizan fecha y rival por si
//    Connection los cambia. Si el capitán ya lo confirmó o editó, su
//    fecha/rival se respetan.
//  - El resultado oficial de Connection (partido terminado) se guarda
//    siempre, esté confirmado o no.
// Nunca borra partidos.
async function sincronizarPartidosConnection(equipoTorneoId, partidos) {
  for (const p of partidos) {
    const existente = await prisma.partido.findUnique({ where: { idExterno: p.idExterno } });
    if (!existente) {
      await prisma.partido.create({
        data: {
          equipoTorneoId,
          idExterno: p.idExterno,
          jornada: p.jornada ?? null,
          fecha: p.fecha,
          rival: p.rival,
          resultado: p.resultado,
          fijado: false,
          origenActualizacion: "scraper",
        },
      });
      continue;
    }
    const datos = {};
    const editable = !existente.fijado && existente.origenActualizacion === "scraper";
    if (editable && existente.fecha.getTime() !== p.fecha.getTime()) datos.fecha = p.fecha;
    if (editable && existente.rival !== p.rival) datos.rival = p.rival;
    if (p.resultado && existente.resultado !== p.resultado) datos.resultado = p.resultado;
    // La jornada es dato de Connection, no del capitán: se mantiene siempre
    // al día (también rellena los partidos sincronizados antes de existir
    // este campo).
    if (p.jornada != null && existente.jornada !== p.jornada) datos.jornada = p.jornada;
    if (Object.keys(datos).length > 0) {
      // Prisma pondría @updatedAt igual; origenActualizacion no se toca para
      // no "robarle" al capitán un partido que ya editó.
      await prisma.partido.update({ where: { id: existente.id }, data: datos });
    }
  }
}

// Ventana en la que el cron sigue buscando el resultado de un partido ya
// jugado: si Connection tarda en publicarlo, se reintenta cada mañana; pasada
// una semana (partido aplazado o anulado) se deja de insistir.
const VENTANA_RESULTADO_MS = 7 * 24 * 60 * 60 * 1000;

// Equipos de Connection que merece la pena actualizar en el cron: los que
// tienen algún partido ya empezado (fecha pasada, de la última semana) sin
// resultado guardado, es decir, los que jugaron ayer, más los que todavía
// no tienen ningún partido (primera sincronización, para traer su
// calendario). Cada equipo juega un día fijo de la semana, así que cada uno
// se actualiza solo la mañana siguiente a su partido en vez de todas las
// noches, y si ningún equipo de la liga ha jugado ni siquiera se abre el
// navegador (menos consumo en Railway).
async function equiposConPartidoPorActualizar(equipos, ahora = new Date()) {
  if (equipos.length === 0) return [];
  const partidos = await prisma.partido.findMany({
    where: { equipoTorneoId: { in: equipos.map((e) => e.id) } },
    select: { equipoTorneoId: true, fecha: true, resultado: true },
  });
  const desde = ahora.getTime() - VENTANA_RESULTADO_MS;
  return equipos.filter((eq) => {
    const suyos = partidos.filter((p) => p.equipoTorneoId === eq.id);
    if (suyos.length === 0) return true;
    return suyos.some((p) => !p.resultado && p.fecha.getTime() <= ahora.getTime() && p.fecha.getTime() > desde);
  });
}

// Recorre todos los torneos/ligas externos NO terminados y actualiza la
// clasificación de cada uno, uno detrás de otro (no en paralelo: cada
// actualización abre su propio navegador Playwright, y lanzar varios a la
// vez podría agotar la memoria del servidor). Nunca lanza si uno falla
// (login roto, nombre de equipo mal puesto, plataforma sin soportar
// todavía...): lo recoge en el resumen y sigue con el siguiente.
//
// - Botón "Actualizar todas las clasificaciones ahora" (sin opciones):
//   actualiza todo, como siempre.
// - Cron diario (`{ cron: true, otrasPlataformas }`): en Connection solo
//   los equipos que jugaron ayer (ver equiposConPartidoPorActualizar);
//   Radikal y Phoenix, que no tienen calendario automático, solo si
//   `otrasPlataformas` es true (el cron lo pasa de lunes a viernes, como
//   antes).
export async function actualizarTodasLasClasificaciones({ cron = false, otrasPlataformas = true } = {}) {
  // Las competiciones terminadas (histórico) ya no cambian: no se
  // intentan actualizar.
  const torneosTodos = await prisma.torneo.findMany({
    where: { terminado: false },
    include: { plataforma: true, equipos: { include: { equipoClub: true } } },
  });

  const torneos = [];
  const saltados = [];
  for (const torneo of torneosTodos) {
    const esConnection = (torneo.plataforma?.nombre || "").toLowerCase().includes("connection");
    if (!cron) {
      torneos.push(torneo);
    } else if (!esConnection) {
      if (otrasPlataformas) torneos.push(torneo);
      else saltados.push({ torneo: torneo.nombre, motivo: "fin de semana: solo se actualiza de lunes a viernes" });
    } else {
      // Los equipos marcados como inactivos ya terminaron: no se miran.
      const activos = torneo.equipos.filter((eq) => eq.equipoClub?.activo !== false);
      const pendientes = await equiposConPartidoPorActualizar(activos);
      if (pendientes.length > 0) torneos.push({ ...torneo, equipos: pendientes });
      else saltados.push({ torneo: torneo.nombre, motivo: "ningún equipo jugó ayer" });
    }
  }

  const resumen = { actualizados: 0, errores: 0, omitidos: 0, detalle: [] };
  for (const { torneo, motivo } of saltados) {
    resumen.omitidos++;
    resumen.detalle.push({ torneo, estado: "omitido", motivo });
  }

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
