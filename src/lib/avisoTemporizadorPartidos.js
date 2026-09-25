// Aviso de "queda 1 minuto" del temporizador de partidos de torneos del
// club (ver TorneoClub.temporizadorActivo/temporizadorMinutos y
// CuadroPartido.enCursoDesde/partidoIniciado/avisoUnMinutoEnviado en
// schema.prisma). El temporizador del torneo es un plazo máximo para que
// los jugadores se presenten a jugar desde que la máquina se marca "en
// curso" (ver aplicarResultadoCuadroPartido en torneosClub.js) — este
// módulo manda un aviso extra cuando queda 1 minuto de ese plazo, solo
// para los partidos que todavía no se han empezado a jugar (botón
// "Empezado" del admin, partidoIniciado=false: una vez empezado el
// temporizador deja de importar para ese partido). Solo torneos del club
// — las ligas del club no tienen temporizador (ver schema.prisma). Se
// llama desde el cron de cada minuto en src/index.js.
import { PrismaClient } from "@prisma/client";
import { notificarJugadores } from "../routes/notificar.js";
import { urlPublicaCuadrante } from "./enlacesPublicos.js";
import { resolverMensaje } from "./mensajesAvisos.js";

const prisma = new PrismaClient();

export async function enviarAvisosUnMinutoTemporizador() {
  const candidatos = await prisma.cuadroPartido.findMany({
    where: {
      enCurso: true,
      partidoIniciado: false,
      avisoUnMinutoEnviado: false,
      enCursoDesde: { not: null },
    },
    include: { cuadrante: { include: { torneoClub: true } } },
  });

  let enviados = 0;
  const ahora = Date.now();

  for (const p of candidatos) {
    const torneo = p.cuadrante.torneoClub;
    // Solo torneos del club con temporizador activo y minutos configurados
    // (un cuadrante de liga, o de torneo con temporizador desactivado, no
    // debería aparecer aquí porque enCursoDesde solo se rellena junto con el
    // resto de este flujo, pero se comprueba igualmente por seguridad).
    if (!torneo || !torneo.temporizadorActivo || !torneo.temporizadorMinutos) continue;

    const limite = new Date(p.enCursoDesde).getTime() + torneo.temporizadorMinutos * 60 * 1000;
    const restanteMs = limite - ahora;

    // Todavía no ha llegado al último minuto: se revisa de nuevo en el
    // siguiente minuto del cron.
    if (restanteMs > 60 * 1000) continue;

    // Se marca como enviado sin avisar (para no reintentar cada minuto) si:
    // el torneo tiene los avisos desactivados o está en la papelera, o si ya
    // ha pasado más de 5 minutos del plazo (partido colgado desde hace rato,
    // o el servidor estuvo caído) — un "queda 1 minuto" ahí ya no pintaría nada.
    const marcarSinAvisar =
      restanteMs < -5 * 60 * 1000 || torneo.borradoEn || torneo.notificaciones === false;

    if (!marcarSinAvisar) {
      const etiquetas = [p.jugador1, p.jugador2].filter(Boolean);
      if (etiquetas.length > 0) {
        const participantes = await prisma.participanteCuadrante.findMany({
          where: { cuadranteId: p.cuadranteId, etiqueta: { in: etiquetas } },
        });
        const jugadorIds = participantes.flatMap((pt) => [pt.jugador1Id, pt.jugador2Id]).filter(Boolean);
        if (jugadorIds.length > 0) {
          // Texto personalizable desde el panel "Mensajes de avisos" del
          // torneo (tipo unMinuto, ver src/lib/mensajesAvisos.js).
          const mensaje = resolverMensaje(torneo.mensajesAvisos, "unMinuto", {
            titulo: {
              es: `¡Falta 1 minuto! {competicion}`,
              eu: `Minutu bat falta da! {competicion}`,
              fr: `Plus qu'une minute ! {competicion}`,
            },
            cuerpo: {
              es: `{enfrentamiento}: queda 1 minuto para presentaros a jugar. Si no empezáis antes de que se acabe el tiempo, el partido se dará por perdido.`,
              eu: `{enfrentamiento}: minutu bat geratzen da jokatzera aurkezteko. Denbora amaitu aurretik hasten ez bazarete, partida galdutzat emango da.`,
              fr: `{enfrentamiento} : il reste 1 minute pour vous présenter. Si vous ne commencez pas avant la fin du temps, le match sera déclaré perdu.`,
            },
          }, {
            competicion: torneo.nombre,
            enfrentamiento: `${p.jugador1 || "?"} vs ${p.jugador2 || "?"}`,
          });
          await notificarJugadores(jugadorIds, {
            titulo: mensaje.titulo,
            cuerpo: mensaje.cuerpo,
            url: urlPublicaCuadrante(p.cuadrante),
          });
          enviados++;
        }
      }
    }

    await prisma.cuadroPartido.update({ where: { id: p.id }, data: { avisoUnMinutoEnviado: true } });
  }

  return { enviados };
}
