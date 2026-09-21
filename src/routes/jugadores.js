import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { requireAuth } from "./auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

// PIN de partidas: 4 dígitos exactos. Usado por jugadores.js (aquí, para que
// el admin lo ponga a cualquier jugador) y por perfil.js (para que un socio
// se lo cambie él mismo) — ver el comentario de `pinPartidasHash` en
// schema.prisma para qué es y por qué es un secreto aparte de la contraseña.
export function pinValido(pin) {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

// GET /api/jugadores - lista todos los jugadores del club (protegido), incluye
// invitados sin cuenta de socio (usuarioId null)
router.get("/", requireAdmin, async (_req, res) => {
  const jugadores = await prisma.jugador.findMany({
    include: { usuario: { select: { email: true } }, suscripcionTelegram: { select: { id: true } } },
    orderBy: { nombre: "asc" },
  });
  // pinPartidasHash no sale nunca de aquí (es un hash, pero no hace falta
  // mandarlo ni para eso): solo si tiene uno puesto, para que el admin sepa
  // si tiene que "poner" o "cambiar" el PIN.
  res.json(
    jugadores.map(({ pinPartidasHash, suscripcionTelegram, ...j }) => ({
      ...j,
      tienePinPartidas: !!pinPartidasHash,
      telegramVinculado: !!suscripcionTelegram,
    }))
  );
});

// POST /api/jugadores - crea un jugador rápido (invitado, sin cuenta) (protegido)
router.post("/", requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: "Falta el nombre" });
  }
  const jugador = await prisma.jugador.create({ data: { nombre: nombre.trim() } });
  res.status(201).json(jugador);
});

// PUT /api/jugadores/:id - cambia el nombre (y opcionalmente el apodo) de un
// invitado del club (protegido). Solo para invitados sin cuenta: el nombre
// de un socio viene de su cuenta de usuario y se edita desde ahí, no aquí —
// permitirlo desde este endpoint los desincronizaría (el nombre del socio se
// usa también para el login/gestión de socios).
router.put("/:id", requireAdmin, async (req, res) => {
  const { nombre, apodo } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: "Falta el nombre" });
  }
  const jugador = await prisma.jugador.findUnique({ where: { id: req.params.id } });
  if (!jugador) return res.status(404).json({ error: "Jugador no encontrado" });
  if (jugador.usuarioId) {
    return res.status(400).json({ error: "Este jugador es un socio: su nombre se cambia desde su cuenta, no aquí." });
  }
  const actualizado = await prisma.jugador.update({
    where: { id: req.params.id },
    data: { nombre: nombre.trim(), ...(apodo !== undefined ? { apodo: apodo.trim() || null } : {}) },
  });
  res.json(actualizado);
});

// PUT /api/jugadores/:id/pin - el admin pone o cambia el PIN de partidas de
// cualquier jugador (socio o invitado), p.ej. si se le ha olvidado. El socio
// también puede cambiarse el suyo propio desde su perfil (ver PUT /api/perfil/pin).
router.put("/:id/pin", requireAdmin, async (req, res) => {
  const { pin } = req.body;
  if (!pinValido(pin)) {
    return res.status(400).json({ error: "El PIN tiene que ser de 4 dígitos." });
  }
  const jugador = await prisma.jugador.findUnique({ where: { id: req.params.id } });
  if (!jugador) return res.status(404).json({ error: "Jugador no encontrado" });
  const pinPartidasHash = await bcrypt.hash(pin, 10);
  await prisma.jugador.update({ where: { id: jugador.id }, data: { pinPartidasHash } });
  res.json({ ok: true });
});

// GET /api/jugadores/directorio - lista pública para socios logueados (sin datos
// sensibles como el email). Incluye las medias (MPR/PPD) de fabricante de cada
// jugador para poder mostrarlas al hacer clic en su perfil; se omite
// deliberadamente `statsError` (puede llevar un volcado largo del texto de
// diagnóstico de la web del fabricante, pensado para depurar el scraper, no
// para enseñarlo a otros socios).
router.get("/directorio", requireAuth, async (_req, res) => {
  const jugadores = await prisma.jugador.findMany({
    // oculto: fichas de invitados puntuales de torneo creadas solo para
    // activarles avisos de Telegram (ver POST
    // /participantes/:id/invitado-telegram en torneosClub.js) — no son
    // jugadores "del club" de verdad, así que no salen en este listado.
    where: { oculto: false },
    orderBy: { nombre: "asc" },
    select: {
      id: true,
      nombre: true,
      apodo: true,
      avatarUrl: true,
      bio: true,
      usuarioId: true,
      idsFabricantes: {
        select: {
          idExterno: true,
          mpr: true,
          ppd: true,
          mprVirtual: true,
          ppdVirtual: true,
          mprPresencial: true,
          ppdPresencial: true,
          fabricante: { select: { id: true, nombre: true, urlPerfilPlantilla: true, logoUrl: true } },
        },
      },
    },
  });
  const resultado = jugadores.map((j) => ({
    ...j,
    idsFabricantes: j.idsFabricantes.map((i) => ({
      fabricanteId: i.fabricante.id,
      nombreFabricante: i.fabricante.nombre,
      urlPerfilPlantilla: i.fabricante.urlPerfilPlantilla,
      logoUrl: i.fabricante.logoUrl,
      idExterno: i.idExterno,
      mpr: i.mpr,
      ppd: i.ppd,
      mprVirtual: i.mprVirtual,
      ppdVirtual: i.ppdVirtual,
      mprPresencial: i.mprPresencial,
      ppdPresencial: i.ppdPresencial,
    })),
  }));
  res.json(resultado);
});

// Calcula el historial de torneos/ligas del club de un jugador dado su id.
// Es la misma lógica que GET /api/perfil/historial (que solo puede consultar
// el socio logueado sobre sí mismo), extraída aquí para poder parametrizarla
// por jugadorId y así mostrar el palmarés de cualquier jugador del club desde
// el directorio de "Jugadores del club" (ver GET /:id/historial más abajo).
async function historialDeJugador(jugadorId) {
  // borradoEn: null filtra los torneos/ligas en la papelera (ver
  // src/lib/papelera.js): mientras no se purguen de verdad o se restauren,
  // no deben aparecer en el palmarés de ningún jugador.
  const participacionesTorneosRaw = await prisma.participanteCuadrante.findMany({
    where: { OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] },
    include: { cuadrante: { include: { torneoClub: true, liga: true } } },
  });
  const participacionesTorneos = participacionesTorneosRaw.filter(
    (p) => !p.cuadrante.torneoClub?.borradoEn && !p.cuadrante.liga?.borradoEn
  );

  const cuadranteIds = [...new Set(participacionesTorneos.map((p) => p.cuadranteId))];
  const etiquetasTorneos = [...new Set(participacionesTorneos.map((p) => p.etiqueta))];
  const todosPartidosTorneos = cuadranteIds.length
    ? await prisma.cuadroPartido.findMany({
        where: {
          cuadranteId: { in: cuadranteIds },
          OR: [{ jugador1: { in: etiquetasTorneos } }, { jugador2: { in: etiquetasTorneos } }],
        },
        orderBy: [{ rama: "asc" }, { ronda: "asc" }],
      })
    : [];

  const historialTorneos = participacionesTorneos.map((p) => {
    const partidos = todosPartidosTorneos.filter(
      (partido) => partido.cuadranteId === p.cuadranteId && (partido.jugador1 === p.etiqueta || partido.jugador2 === p.etiqueta)
    );
    return {
      nombre: p.cuadrante.torneoClub?.nombre || (p.cuadrante.liga ? `${p.cuadrante.liga.nombre} (cuadrante final)` : "Torneo"),
      cuadrante: p.cuadrante.nombre,
      etiqueta: p.etiqueta,
      partidos: partidos.map((partido) => ({
        rama: partido.rama,
        ronda: partido.ronda,
        rival: partido.jugador1 === p.etiqueta ? partido.jugador2 : partido.jugador1,
        resultado: partido.resultado,
        ganado: partido.ganador ? partido.ganador === p.etiqueta : null,
      })),
    };
  });

  const participacionesLigasRaw = await prisma.participanteLiga.findMany({
    where: { OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] },
    include: { liga: true },
  });
  const participacionesLigas = participacionesLigasRaw.filter((p) => !p.liga?.borradoEn);

  const ligaIds = [...new Set(participacionesLigas.map((p) => p.ligaId))];
  const etiquetasLigas = [...new Set(participacionesLigas.map((p) => p.etiqueta))];
  const todosPartidosLigas = ligaIds.length
    ? await prisma.partidoLiga.findMany({
        where: {
          ligaId: { in: ligaIds },
          OR: [{ participante1: { in: etiquetasLigas } }, { participante2: { in: etiquetasLigas } }],
        },
        orderBy: { jornada: "asc" },
      })
    : [];

  const historialLigas = participacionesLigas.map((p) => {
    const partidos = todosPartidosLigas.filter(
      (partido) => partido.ligaId === p.ligaId && (partido.participante1 === p.etiqueta || partido.participante2 === p.etiqueta)
    );
    return {
      nombre: p.liga.nombre,
      etiqueta: p.etiqueta,
      partidos: partidos.map((partido) => ({
        jornada: partido.jornada,
        rival: partido.participante1 === p.etiqueta ? partido.participante2 : partido.participante1,
        resultado: partido.resultado,
        ganado: partido.ganador ? partido.ganador === p.etiqueta : null,
      })),
    };
  });

  return { torneos: historialTorneos, ligas: historialLigas };
}

// Vacío por defecto de cada bloque de "Acero" (501/cricket), para que el
// frontend siempre reciba números en vez de tener que comprobar null/undefined.
function bloqueAceroVacio501() {
  return {
    partidosJugados: 0, partidosGanados: 0, legsJugados: 0, legsGanados: 0,
    dardos: 0, puntos: 0, ppd: 0, media: 0,
    visitas100: 0, visitas140: 0, visitas180: 0, mejorCheckout: 0,
  };
}
function bloqueAceroVacioCricket() {
  return { partidosJugados: 0, partidosGanados: 0, legsJugados: 0, legsGanados: 0, visitas: 0, marcas: 0, mpr: 0 };
}

// Agrega las estadísticas "Acero" (partidas de torneo/liga jugadas de verdad
// con la herramienta de marcador — ver PartidaHerramienta y el plan
// "herramienta-marcador-torneos-ligas" guardado en el proyecto, Slice 3+4/5)
// de un jugador concreto. Solo cuentan las partidas FINALIZADAS: mientras un
// partido está a medias no hay nada estable que promediar todavía. No se
// filtra por torneo/liga: es la media de "toda la vida" del jugador con la
// herramienta, igual que las medias de fabricante.
//
// Nunca entran aquí partidas del marcador libre (Marcadores.jsx, "jugar
// solo"): esas no crean ninguna PartidaHerramienta, solo existen en la
// pantalla mientras se juega. Por construcción, todo lo que hay en esta
// tabla es de torneo o liga.
async function estadisticasAceroDeJugador(jugadorId) {
  const todas = await prisma.partidaHerramienta.findMany({ where: { finalizada: true } });
  const partidas = todas.filter(
    (p) => p.jugadoresId1.includes(jugadorId) || p.jugadoresId2.includes(jugadorId)
  );

  const stats501 = bloqueAceroVacio501();
  const statsCricket = bloqueAceroVacioCricket();

  for (const partida of partidas) {
    const lado = partida.jugadoresId1.includes(jugadorId) ? 1 : 2;
    const legsPropios = lado === 1 ? partida.legsGanados1 : partida.legsGanados2;
    const legsRivales = lado === 1 ? partida.legsGanados2 : partida.legsGanados1;
    const ganoElPartido = legsPropios > legsRivales;
    const bloque = partida.juego === "cricket" ? statsCricket : stats501;

    bloque.partidosJugados += 1;
    if (ganoElPartido) bloque.partidosGanados += 1;

    for (const leg of partida.legs) {
      const propias = leg.estadisticas?.[jugadorId];
      if (!propias) continue; // por si algún leg viejo no llegó a registrar a este jugador
      bloque.legsJugados += 1;
      if (leg.ladoGanador === lado) bloque.legsGanados += 1;

      if (partida.juego === "cricket") {
        statsCricket.visitas += propias.visitas || 0;
        statsCricket.marcas += propias.marcas || 0;
      } else {
        stats501.dardos += propias.dardos || 0;
        stats501.puntos += propias.puntos || 0;
        stats501.visitas100 += propias.visitas100 || 0;
        stats501.visitas140 += propias.visitas140 || 0;
        stats501.visitas180 += propias.visitas180 || 0;
        if (propias.checkout && propias.checkout > stats501.mejorCheckout) stats501.mejorCheckout = propias.checkout;
      }
    }
  }

  stats501.ppd = stats501.dardos > 0 ? Number((stats501.puntos / stats501.dardos).toFixed(2)) : 0;
  stats501.media = Number((stats501.ppd * 3).toFixed(2));
  statsCricket.mpr = statsCricket.visitas > 0 ? Number((statsCricket.marcas / statsCricket.visitas).toFixed(2)) : 0;

  return { "501": stats501, cricket: statsCricket };
}

// GET /api/jugadores/:id/historial - palmarés (torneos y ligas del club en
// los que ha participado) de un jugador cualquiera del directorio. Protegido
// con requireAuth igual que /directorio: es información visible entre
// socios, no pública en internet. Va antes de DELETE /:id a propósito, sin
// que compartan método así que el orden no importa para el enrutado, pero se
// deja aquí junto a la función que usa.
router.get("/:id/historial", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({ where: { id: req.params.id } });
  if (!jugador) return res.status(404).json({ error: "Jugador no encontrado" });
  const historial = await historialDeJugador(jugador.id);
  res.json(historial);
});

// GET /api/jugadores/:id/estadisticas-acero - medias de "Acero" (partidas de
// torneo/liga jugadas con la herramienta de marcador) de un jugador
// cualquiera del directorio. Mismo nivel de protección que /historial y
// /directorio: visible entre socios, no pública en internet.
router.get("/:id/estadisticas-acero", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({ where: { id: req.params.id } });
  if (!jugador) return res.status(404).json({ error: "Jugador no encontrado" });
  const estadisticas = await estadisticasAceroDeJugador(jugador.id);
  res.json(estadisticas);
});

// DELETE /api/jugadores/:id - borra un jugador (protegido). Si pertenece a un
// equipo del club o a la plantilla de una inscripción externa, la base de
// datos rechaza el borrado (relación obligatoria) — antes eso se tragaba en
// silencio y el admin recibía un "borrado" que no era cierto; ahora se
// responde con un error explicando qué lo bloquea.
// POST /api/jugadores/:id/fusionar - fusiona la ficha :id (origen) EN otra
// (body: { destinoId }, la que se conserva): pasa a la ficha destino todo el
// historial del origen (participaciones en torneos/ligas, puntos de jornada,
// equipos, capitanías, partidas de la herramienta con sus estadísticas, avisos
// push/Telegram, IDs de fabricante) y elimina la ficha origen. Los datos
// propios (nombre, apodo, PIN…) son los del destino; solo se rellenan sus
// huecos vacíos con los del origen. El origen no puede ser un miembro con
// cuenta (la cuenta vive en la ficha que se conserva): para juntar un amigo
// con un miembro se conserva la ficha del miembro. Los textos ya escritos en
// cuadrantes/calendarios (etiquetas) no se reescriben, igual que al editar un
// nombre: lo que cambia es la ficha a la que apuntan.
router.post("/:id/fusionar", requireAdmin, async (req, res) => {
  const origenId = req.params.id;
  const { destinoId } = req.body || {};
  if (!destinoId) return res.status(400).json({ error: "Falta la ficha que se conserva." });
  if (destinoId === origenId) return res.status(400).json({ error: "Elige dos fichas distintas." });

  const [origen, destino] = await Promise.all([
    prisma.jugador.findUnique({ where: { id: origenId } }),
    prisma.jugador.findUnique({ where: { id: destinoId } }),
  ]);
  if (!origen || !destino) return res.status(404).json({ error: "Jugador no encontrado" });
  if (origen.usuarioId) {
    return res.status(400).json({
      error: "La ficha que se elimina no puede ser la de un miembro con cuenta: conserva la del miembro y fusiona la otra en ella.",
    });
  }

  const cambiarId = (valor) => JSON.parse(JSON.stringify(valor).split(origenId).join(destinoId));
  const sinRepetidos = (lista) => (Array.isArray(lista) ? [...new Set(lista)] : lista);

  try {
    const resumen = await prisma.$transaction(
      async (tx) => {
        const cuenta = {};

        // Referencias directas (sin restricción de unicidad).
        const directas = [
          ["participanteCuadrante", "jugador1Id"],
          ["participanteCuadrante", "jugador2Id"],
          ["participanteLiga", "jugador1Id"],
          ["participanteLiga", "jugador2Id"],
          ["puntoJornada", "jugador1Id"],
          ["puntoJornada", "jugador2Id"],
          ["equipoTorneo", "capitanId"],
          ["equipoClub", "capitanId"],
          ["suscripcionPush", "jugadorId"],
        ];
        for (const [modelo, campo] of directas) {
          const r = await tx[modelo].updateMany({ where: { [campo]: origenId }, data: { [campo]: destinoId } });
          cuenta[`${modelo}.${campo}`] = r.count;
        }

        // Referencias con restricción de unicidad: si el destino ya tiene la
        // suya, se descarta la del origen.
        for (const fila of await tx.equipoJugador.findMany({ where: { jugadorId: origenId } })) {
          const ya = await tx.equipoJugador.findFirst({ where: { equipoTorneoId: fila.equipoTorneoId, jugadorId: destinoId } });
          if (ya) await tx.equipoJugador.delete({ where: { id: fila.id } });
          else await tx.equipoJugador.update({ where: { id: fila.id }, data: { jugadorId: destinoId } });
        }
        for (const fila of await tx.miembroEquipoClub.findMany({ where: { jugadorId: origenId } })) {
          const ya = await tx.miembroEquipoClub.findFirst({ where: { equipoId: fila.equipoId, jugadorId: destinoId } });
          if (ya) await tx.miembroEquipoClub.delete({ where: { id: fila.id } });
          else await tx.miembroEquipoClub.update({ where: { id: fila.id }, data: { jugadorId: destinoId } });
        }
        for (const fila of await tx.jugadorFabricanteId.findMany({ where: { jugadorId: origenId } })) {
          const ya = await tx.jugadorFabricanteId.findFirst({ where: { jugadorId: destinoId, fabricanteId: fila.fabricanteId } });
          if (ya) await tx.jugadorFabricanteId.delete({ where: { id: fila.id } });
          else await tx.jugadorFabricanteId.update({ where: { id: fila.id }, data: { jugadorId: destinoId } });
        }

        // Telegram: un solo vínculo por ficha. Se queda el del destino; si no
        // tiene, se pasa el del origen.
        const subDestino = await tx.suscripcionTelegram.findUnique({ where: { jugadorId: destinoId } });
        const subOrigen = await tx.suscripcionTelegram.findUnique({ where: { jugadorId: origenId } });
        if (subOrigen) {
          if (subDestino) await tx.suscripcionTelegram.delete({ where: { id: subOrigen.id } });
          else await tx.suscripcionTelegram.update({ where: { id: subOrigen.id }, data: { jugadorId: destinoId } });
        }
        await tx.telegramCheckIn.deleteMany({ where: { jugadorId: origenId } });

        // Partidas de la herramienta: los ids viven dentro de JSON (lados,
        // estadísticas por leg, señalización…), así que se reescriben ahí.
        const partidas = await tx.partidaHerramienta.findMany();
        let partidasCambiadas = 0;
        for (const p of partidas) {
          const texto = JSON.stringify([p.jugadoresId1, p.jugadoresId2, p.legs, p.visitaEnCurso, p.senalCamara, p.listosInicio]);
          if (!texto.includes(origenId)) continue;
          await tx.partidaHerramienta.update({
            where: { id: p.id },
            data: {
              jugadoresId1: sinRepetidos(cambiarId(p.jugadoresId1)),
              jugadoresId2: sinRepetidos(cambiarId(p.jugadoresId2)),
              legs: cambiarId(p.legs),
              ...(p.visitaEnCurso != null ? { visitaEnCurso: cambiarId(p.visitaEnCurso) } : {}),
              ...(p.senalCamara != null ? { senalCamara: cambiarId(p.senalCamara) } : {}),
              listosInicio: sinRepetidos(cambiarId(p.listosInicio || [])),
            },
          });
          partidasCambiadas += 1;
        }
        cuenta.partidasHerramienta = partidasCambiadas;

        // Datos propios: prevalece el destino; solo se rellenan sus huecos.
        await tx.jugador.update({
          where: { id: destinoId },
          data: {
            apodo: destino.apodo || origen.apodo,
            avatarUrl: destino.avatarUrl || origen.avatarUrl,
            bio: destino.bio || origen.bio,
            pinPartidasHash: destino.pinPartidasHash || origen.pinPartidasHash,
            oculto: destino.oculto && origen.oculto,
          },
        });

        await tx.jugador.delete({ where: { id: origenId } });
        return cuenta;
      },
      { timeout: 60000, maxWait: 10000 }
    );
    res.json({ mensaje: `"${origen.nombre}" fusionado en "${destino.nombre}".`, resumen });
  } catch (err) {
    console.error("Error fusionando jugadores:", err);
    res.status(500).json({ error: "No se pudo fusionar. No se ha cambiado nada." });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.jugador.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(204).end(); // ya no existía
    if (err.code === "P2003") {
      return res.status(409).json({
        error:
          "No se puede borrar: este jugador pertenece a un equipo del club o a la plantilla de una competición externa. Quítalo de ahí primero.",
      });
    }
    console.error("Error borrando jugador:", err);
    res.status(500).json({ error: "No se pudo borrar el jugador." });
  }
});

export default router;
