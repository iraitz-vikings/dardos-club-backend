// Recordatorio automático del día del partido: hasta ahora los socios/
// invitados solo recibían un aviso en el momento en que un capitán/admin
// confirmaba fecha y máquina de su partido (ver notificarPartidoDeCuadrante
// en torneosClub.js, notificarPartidoDeLiga en ligasClub.js, y el aviso al
// "fijar" en competicionesExternas.js). Si eso pasaba con semanas de
// antelación, nadie recibía nada más hasta el día en cuestión. Este módulo
// añade un segundo aviso, la mañana del propio día del partido, para los
// tres tipos de enfrentamiento del club (torneos, ligas, competiciones
// externas). Se llama desde el cron matutino de src/index.js.
import { PrismaClient } from "@prisma/client";
import { notificarJugadores } from "../routes/notificar.js";

const prisma = new PrismaClient();

// Límites [inicio, fin) del día de HOY en la España peninsular
// (Europe/Madrid), como instantes UTC reales. El servidor (Railway) corre
// en UTC, así que sin esto "hoy" se calcularía mal según la hora a la que
// dispare el cron — este cálculo tiene en cuenta el cambio de hora de
// verano/invierno automáticamente, usando el Intl ya incorporado en Node
// (sin depender de ninguna librería extra de zonas horarias).
function limitesDeHoyEnMadrid() {
  const ahora = new Date();
  const formateador = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const partes = Object.fromEntries(formateador.formatToParts(ahora).map((p) => [p.type, p.value]));
  // "Ahora", tal y como se ve en el reloj de Madrid, interpretado como si
  // fuera UTC — sirve para calcular el desfase horario real en este instante.
  const comoSiFueraUTC = Date.UTC(partes.year, partes.month - 1, partes.day, partes.hour, partes.minute, partes.second);
  const desfaseMs = comoSiFueraUTC - ahora.getTime();
  const inicio = new Date(Date.UTC(partes.year, partes.month - 1, partes.day, 0, 0, 0) - desfaseMs);
  const fin = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);
  return { inicio, fin };
}

function textoHora(fecha) {
  return new Date(fecha).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
}

// Recordatorio de los partidos externos (equipos del club en competiciones
// de plataformas externas) fijados para hoy.
async function recordatoriosExternos(rangoHoy) {
  const partidos = await prisma.partido.findMany({
    where: { fijado: true, recordatorioEnviado: false, fecha: rangoHoy },
    include: { equipoTorneo: { include: { equipoClub: true, torneo: true } } },
  });

  let enviados = 0;
  for (const p of partidos) {
    const roster = await prisma.equipoJugador.findMany({
      where: { equipoTorneoId: p.equipoTorneoId },
      select: { jugadorId: true },
    });
    const jugadorIds = roster.map((r) => r.jugadorId);
    if (jugadorIds.length > 0) {
      const nombreEquipo = p.equipoTorneo.equipoClub?.nombre || "Tu equipo";
      const nombreTorneo = p.equipoTorneo.torneo?.nombre || "";
      await notificarJugadores(jugadorIds, {
        titulo: `Hoy juegas: ${nombreEquipo}`,
        cuerpo: `${p.rival ? `Contra ${p.rival}` : "Partido"} hoy a las ${textoHora(p.fecha)}${nombreTorneo ? ` (${nombreTorneo})` : ""}.`,
      });
      enviados++;
    }
    await prisma.partido.update({ where: { id: p.id }, data: { recordatorioEnviado: true } });
  }
  return enviados;
}

// Recordatorio de los enfrentamientos de cuadro de torneos del club fijados
// para hoy. Los participantes se identifican por etiqueta (nombre suelto o
// "Fulano / Mengano"), no por jugadorId directo — mismo patrón que
// notificarPartidoDeCuadrante en torneosClub.js. Se ignoran los torneos/
// ligas en la papelera (borradoEn), aunque en la práctica no deberían tener
// nada pendiente de recordar (el borrado suave los saca del calendario).
async function recordatoriosTorneosClub(rangoHoy) {
  const partidos = await prisma.cuadroPartido.findMany({
    where: { confirmadoCalendario: true, recordatorioEnviado: false, fechaCalendario: rangoHoy },
    include: { cuadrante: { include: { torneoClub: true, liga: true } } },
  });

  let enviados = 0;
  for (const p of partidos) {
    if (p.cuadrante.torneoClub?.borradoEn || p.cuadrante.liga?.borradoEn) {
      await prisma.cuadroPartido.update({ where: { id: p.id }, data: { recordatorioEnviado: true } });
      continue;
    }
    // Respeta el interruptor "notificaciones" del torneo/liga (ver
    // schema.prisma) — se marca como enviado igualmente para no reintentar.
    if (p.cuadrante.torneoClub?.notificaciones === false || p.cuadrante.liga?.notificaciones === false) {
      await prisma.cuadroPartido.update({ where: { id: p.id }, data: { recordatorioEnviado: true } });
      continue;
    }
    const etiquetas = [p.jugador1, p.jugador2].filter(Boolean);
    if (etiquetas.length > 0) {
      const participantes = await prisma.participanteCuadrante.findMany({
        where: { cuadranteId: p.cuadranteId, etiqueta: { in: etiquetas } },
      });
      const jugadorIds = participantes.flatMap((pt) => [pt.jugador1Id, pt.jugador2Id]).filter(Boolean);
      if (jugadorIds.length > 0) {
        const nombreCompeticion = p.cuadrante.torneoClub?.nombre || p.cuadrante.liga?.nombre || "Torneo Vikings";
        await notificarJugadores(jugadorIds, {
          titulo: `Hoy juegas: ${nombreCompeticion}`,
          cuerpo: `${p.jugador1 || "?"} vs ${p.jugador2 || "?"} hoy a las ${textoHora(p.fechaCalendario)}.`,
        });
        enviados++;
      }
    }
    await prisma.cuadroPartido.update({ where: { id: p.id }, data: { recordatorioEnviado: true } });
  }
  return enviados;
}

// Igual que la anterior, pero para los partidos de ligas del club
// (PartidoLiga/ParticipanteLiga).
async function recordatoriosLigasClub(rangoHoy) {
  const partidos = await prisma.partidoLiga.findMany({
    where: { confirmadoCalendario: true, recordatorioEnviado: false, fechaCalendario: rangoHoy },
    include: { liga: true },
  });

  let enviados = 0;
  for (const p of partidos) {
    if (p.liga?.borradoEn) {
      await prisma.partidoLiga.update({ where: { id: p.id }, data: { recordatorioEnviado: true } });
      continue;
    }
    // Respeta el interruptor "notificaciones" de la liga (ver
    // schema.prisma) — se marca como enviado igualmente para no reintentar.
    if (p.liga?.notificaciones === false) {
      await prisma.partidoLiga.update({ where: { id: p.id }, data: { recordatorioEnviado: true } });
      continue;
    }
    const etiquetas = [p.participante1, p.participante2].filter(Boolean);
    if (etiquetas.length > 0) {
      const participantes = await prisma.participanteLiga.findMany({
        where: { ligaId: p.ligaId, etiqueta: { in: etiquetas } },
      });
      const jugadorIds = participantes.flatMap((pt) => [pt.jugador1Id, pt.jugador2Id]).filter(Boolean);
      if (jugadorIds.length > 0) {
        const nombreLiga = p.liga?.nombre || "Liga del club";
        await notificarJugadores(jugadorIds, {
          titulo: `Hoy juegas: ${nombreLiga}`,
          cuerpo: `${p.participante1 || "?"} vs ${p.participante2 || "?"} hoy a las ${textoHora(p.fechaCalendario)}.`,
        });
        enviados++;
      }
    }
    await prisma.partidoLiga.update({ where: { id: p.id }, data: { recordatorioEnviado: true } });
  }
  return enviados;
}

// Manda el recordatorio del día a todos los partidos confirmados para hoy
// (torneos, ligas y competiciones externas del club) que todavía no lo
// hayan recibido. Se llama desde el cron matutino de src/index.js; también
// se puede lanzar a mano si hiciera falta.
export async function enviarRecordatoriosDeHoy() {
  const { inicio, fin } = limitesDeHoyEnMadrid();
  const rangoHoy = { gte: inicio, lt: fin };

  const [externos, torneosClub, ligasClub] = await Promise.all([
    recordatoriosExternos(rangoHoy),
    recordatoriosTorneosClub(rangoHoy),
    recordatoriosLigasClub(rangoHoy),
  ]);

  return { externos, torneosClub, ligasClub, total: externos + torneosClub + ligasClub };
}
