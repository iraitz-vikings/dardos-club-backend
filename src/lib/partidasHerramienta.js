// Lógica de la herramienta de marcador jugada desde la página pública
// (Slice 3+4 del plan "herramienta-marcador-torneos-ligas", guardado en el
// proyecto). Aquí vive todo lo que no es puramente HTTP: encontrar los
// partidos pendientes de un jugador, resolver quién es cada participante de
// un partido (para repartir bien las estadísticas de una pareja), crear o
// reanudar una PartidaHerramienta y registrar los legs que se van jugando
// hasta aplicar el resultado final al partido real — ver
// src/routes/partidasHerramienta.js para las rutas que llaman a esto.
//
// El resultado final se aplica reutilizando exactamente la misma lógica que
// el PUT de administración manual (avance de cuadro, avisos, gran final...):
// ver aplicarResultadoCuadroPartido en torneosClub.js y
// aplicarResultadoPartidoLiga en ligasClub.js.

import { configuracionParaRonda } from "./configuracionHerramienta.js";

// La clave de "ronda/jornada" con la que se busca en `porRonda` — ver el
// comentario de ConfiguracionHerramientaPanel.jsx sobre esta ambigüedad para
// los cuadros de torneo: de momento es String(ronda), con "final" como caso
// especial para la rama final (gran final o cuadrante a partido único).
export function claveRondaCuadroPartido(partido) {
  return partido.rama === "final" ? "final" : String(partido.ronda);
}

export function claveJornadaPartidoLiga(partido) {
  return String(partido.jornada);
}

// Dada una etiqueta de participante (el texto que aparece literalmente en
// jugador1/jugador2 o participante1/participante2 de un partido) busca su
// ParticipanteCuadrante/ParticipanteLiga para sacar los jugadorId reales de
// quien la forma (uno para individual, dos para pareja). Devuelve
// { jugadoresId: string[], nombres: string[] } — arrays vacíos si la
// etiqueta no está vinculada a ningún Jugador del club (partido con nombres
// sueltos, sin sorteo por participantes: no se puede jugar con la
// herramienta hasta que se vincule).
export async function resolverParticipante(prisma, { cuadranteId, ligaId, etiqueta }) {
  if (!etiqueta) return { jugadoresId: [], nombres: [] };
  const participante = cuadranteId
    ? await prisma.participanteCuadrante.findUnique({
        where: { cuadranteId_etiqueta: { cuadranteId, etiqueta } },
        include: { jugador1: true, jugador2: true },
      })
    : await prisma.participanteLiga.findUnique({
        where: { ligaId_etiqueta: { ligaId, etiqueta } },
        include: { jugador1: true, jugador2: true },
      });
  if (!participante) return { jugadoresId: [], nombres: [] };
  const miembros = [participante.jugador1, participante.jugador2].filter(Boolean);
  return { jugadoresId: miembros.map((j) => j.id), nombres: miembros.map((j) => j.apodo || j.nombre) };
}

// Busca todos los partidos de torneos/ligas (con la herramienta activa) en
// los que participa jugadorId y que todavía no tienen ganador ni faltan
// jugadores por decidir (nada de byes ni huecos vacíos). No filtra por
// torneo/liga concretos: eso lo hace la ruta si hace falta (query opcional).
export async function partidosPendientesDeJugador(prisma, jugadorId) {
  const pendientes = [];

  // --- Cuadros de torneos y cuadrantes finales de ligas (misma tabla) -----
  const participacionesCuadrante = await prisma.participanteCuadrante.findMany({
    where: { OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] },
    include: {
      cuadrante: {
        include: {
          torneoClub: true,
          liga: true,
          partidos: true,
        },
      },
    },
  });
  for (const participacion of participacionesCuadrante) {
    const cuadrante = participacion.cuadrante;
    const entidad = cuadrante.torneoClub || cuadrante.liga;
    if (!entidad || entidad.borradoEn || !entidad.configuracionHerramienta?.activa) continue;
    const partidos = cuadrante.partidos.filter(
      (p) =>
        !p.ganador &&
        p.jugador1 &&
        p.jugador2 &&
        (p.jugador1 === participacion.etiqueta || p.jugador2 === participacion.etiqueta)
    );
    for (const partido of partidos) {
      const config = configuracionParaRonda(entidad.configuracionHerramienta, claveRondaCuadroPartido(partido));
      if (!config) continue;
      pendientes.push({
        tipo: "cuadrante",
        partidoId: partido.id,
        cuadranteId: cuadrante.id,
        entidadTipo: cuadrante.torneoClub ? "torneo" : "liga",
        entidadId: entidad.id,
        entidadNombre: entidad.nombre,
        cuadranteNombre: cuadrante.nombre,
        rama: partido.rama,
        ronda: partido.ronda,
        etiquetaPropia: participacion.etiqueta,
        etiquetaRival: partido.jugador1 === participacion.etiqueta ? partido.jugador2 : partido.jugador1,
        juegoConfigurado: config.juego,
        alMejorDe: config.alMejorDe,
      });
    }
  }

  // --- Jornadas de liga (todos contra todos) ------------------------------
  const participacionesLiga = await prisma.participanteLiga.findMany({
    where: { OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] },
    include: { liga: { include: { partidos: true } } },
  });
  for (const participacion of participacionesLiga) {
    const liga = participacion.liga;
    if (liga.borradoEn || !liga.configuracionHerramienta?.activa) continue;
    const partidos = liga.partidos.filter(
      (p) =>
        !p.ganador &&
        p.participante1 &&
        p.participante2 &&
        (p.participante1 === participacion.etiqueta || p.participante2 === participacion.etiqueta)
    );
    for (const partido of partidos) {
      const config = configuracionParaRonda(liga.configuracionHerramienta, claveJornadaPartidoLiga(partido));
      if (!config) continue;
      pendientes.push({
        tipo: "jornada",
        partidoId: partido.id,
        entidadTipo: "liga",
        entidadId: liga.id,
        entidadNombre: liga.nombre,
        jornada: partido.jornada,
        etiquetaPropia: participacion.etiqueta,
        etiquetaRival: partido.participante1 === participacion.etiqueta ? partido.participante2 : partido.participante1,
        juegoConfigurado: config.juego,
        alMejorDe: config.alMejorDe,
      });
    }
  }

  return pendientes;
}

// Localiza un partido pendiente concreto (para /iniciar) y su configuración
// resuelta. `tipo` + `partidoId` identifican el partido tal como los devuelve
// partidosPendientesDeJugador. Devuelve null si no se encuentra, ya tiene
// ganador, o la herramienta no está activa para él.
export async function localizarPartidoConConfig(prisma, { tipo, partidoId }) {
  if (tipo === "cuadrante") {
    const partido = await prisma.cuadroPartido.findUnique({
      where: { id: partidoId },
      include: { cuadrante: { include: { torneoClub: true, liga: true } } },
    });
    if (!partido || partido.ganador || !partido.jugador1 || !partido.jugador2) return null;
    const entidad = partido.cuadrante.torneoClub || partido.cuadrante.liga;
    if (!entidad || entidad.borradoEn) return null;
    const config = configuracionParaRonda(entidad.configuracionHerramienta, claveRondaCuadroPartido(partido));
    if (!config) return null;
    return { partido, cuadranteId: partido.cuadranteId, ligaId: null, config, entidad };
  }
  if (tipo === "jornada") {
    const partido = await prisma.partidoLiga.findUnique({ where: { id: partidoId }, include: { liga: true } });
    if (!partido || partido.ganador || !partido.participante1 || !partido.participante2) return null;
    const liga = partido.liga;
    if (!liga || liga.borradoEn) return null;
    const config = configuracionParaRonda(liga.configuracionHerramienta, claveJornadaPartidoLiga(partido));
    if (!config) return null;
    return { partido, cuadranteId: null, ligaId: liga.id, config, entidad: liga };
  }
  return null;
}
