import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { loginLimiter } from "../middleware/loginLimiter.js";
import {
  partidosPendientesDeJugador,
  localizarPartidoConConfig,
  resolverParticipante,
} from "../lib/partidasHerramienta.js";
import { limpiarConfigJuego } from "../lib/configuracionHerramienta.js";
import { urlPublicaAmistoso } from "../lib/enlacesPublicos.js";
import { aplicarResultadoCuadroPartido } from "./torneosClub.js";
import { aplicarResultadoPartidoLiga } from "./ligasClub.js";
import { pinValido } from "./jugadores.js";
import { requireAuth } from "./auth.js";
import { notificarJugador } from "./notificar.js";

// Flujo público de juego con la herramienta de marcador (Slice 3+4 del plan
// "herramienta-marcador-torneos-ligas", guardado en el proyecto): un jugador
// se identifica con su PIN de partidas (ver Slice 1, src/routes/jugadores.js
// PUT /:id/pin) desde un dispositivo junto a la diana — normalmente
// compartido entre los dos rivales, ver decisión de fases en el plan —,
// elige el partido de torneo/liga que va a jugar de entre los suyos
// pendientes, y juega con el marcador de la app en vez de que el admin meta
// el resultado a mano. Al terminar (alcanzado "al mejor de N"), el resultado
// se aplica solo al partido real reutilizando exactamente la misma lógica
// que el PUT de administración manual.
//
// Token de esta ruta: JWT con { tipo: "partida", jugadorId }, totalmente
// aparte del JWT de socio (auth.js, que lleva { sub, rol }) — un PIN de 4
// dígitos no es una contraseña de socio y no debe poder hacer nada que un
// login de socio pueda hacer. Vida corta pensada para una sesión de juego en
// un dispositivo compartido, no para dejar sesión abierta días.

const prisma = new PrismaClient();
const router = Router();

function firmarTokenPartida(jugador) {
  return jwt.sign({ tipo: "partida", jugadorId: jugador.id }, process.env.JWT_SECRET, { expiresIn: "12h" });
}

function requireJugadorPartida(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No has iniciado sesión con tu PIN." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.tipo !== "partida" || !payload.jugadorId) throw new Error("token no es de partida");
    req.jugadorPartidaId = payload.jugadorId;
    next();
  } catch {
    return res.status(401).json({ error: "Tu sesión ha caducado, vuelve a identificarte con tu PIN." });
  }
}

// GET /api/partidas-herramienta/jugadores - lista pública (sin datos
// sensibles) de TODOS los jugadores del club, para el selector de "¿quién
// eres?" al iniciar sesión — incluye `tienePinPartidas` para que el
// frontend sepa si tiene que pedir el PIN existente o dejarle elegir uno
// nuevo (ver POST /pin más abajo). Antes solo salían los que ya tenían PIN
// puesto, así que la primera vez alguien no aparecía en la lista y no había
// forma de arrancar sin pasar antes por el admin o el perfil — bug
// reportado por Iraitz el 2026-09-09.
router.get("/jugadores", async (_req, res) => {
  const jugadores = await prisma.jugador.findMany({
    select: { id: true, nombre: true, apodo: true, pinPartidasHash: true },
    orderBy: { nombre: "asc" },
  });
  res.json(jugadores.map(({ pinPartidasHash, ...j }) => ({ ...j, tienePinPartidas: !!pinPartidasHash })));
});

// POST /api/partidas-herramienta/pin - un jugador que todavía no tiene PIN
// de partidas se pone uno él mismo, la primera vez que intenta entrar a la
// herramienta (sin esto había que pedirle a un admin que se lo pusiera
// antes desde AdminJugadores.jsx, o que el propio socio fuera a su perfil).
// Si ya tiene uno puesto, no se puede cambiar por aquí (para eso está el
// admin o el perfil, que si requieren sesión de socio) — solo sirve para la
// puesta en marcha inicial. loginLimiter por IP, igual que /login.
router.post("/pin", loginLimiter, async (req, res) => {
  const { jugadorId, pin } = req.body;
  if (!jugadorId || !pinValido(pin)) {
    return res.status(400).json({ error: "Elige quién eres y un PIN de 4 dígitos." });
  }
  const jugador = await prisma.jugador.findUnique({ where: { id: jugadorId } });
  if (!jugador) return res.status(404).json({ error: "Jugador no encontrado" });
  if (jugador.pinPartidasHash) {
    return res.status(409).json({
      error: "Ese jugador ya tiene un PIN puesto. Si no os acordáis, un admin puede cambiarlo, o el propio socio desde su perfil.",
    });
  }
  const pinPartidasHash = await bcrypt.hash(pin, 10);
  const actualizado = await prisma.jugador.update({ where: { id: jugador.id }, data: { pinPartidasHash } });
  res.status(201).json({ token: firmarTokenPartida(actualizado), jugador: { id: actualizado.id, nombre: actualizado.apodo || actualizado.nombre } });
});

// POST /api/partidas-herramienta/login - identificación con PIN (no es un
// login de socio: ver el comentario de arriba). loginLimiter por IP, igual
// que el login de socios, para que probar PINs de 4 dígitos uno detrás de
// otro no sea viable.
router.post("/login", loginLimiter, async (req, res) => {
  const { jugadorId, pin } = req.body;
  if (!jugadorId || !pin) return res.status(400).json({ error: "Faltan datos" });
  const jugador = await prisma.jugador.findUnique({ where: { id: jugadorId } });
  if (!jugador || !jugador.pinPartidasHash) {
    return res.status(401).json({ error: "PIN incorrecto" });
  }
  const ok = await bcrypt.compare(pin, jugador.pinPartidasHash);
  if (!ok) return res.status(401).json({ error: "PIN incorrecto" });
  res.json({ token: firmarTokenPartida(jugador), jugador: { id: jugador.id, nombre: jugador.apodo || jugador.nombre } });
});

// GET /api/partidas-herramienta/pendientes - partidos del jugador logueado
// que tienen la herramienta activa y todavía no tienen ganador. Query
// opcional entidadTipo=torneo|liga & entidadId=... para acotar a una sola
// página pública (si no se pasa, devuelve de todos los torneos/ligas).
router.get("/pendientes", requireJugadorPartida, async (req, res) => {
  const { entidadTipo, entidadId } = req.query;
  let pendientes = await partidosPendientesDeJugador(prisma, req.jugadorPartidaId);
  if (entidadTipo) pendientes = pendientes.filter((p) => p.entidadTipo === entidadTipo);
  if (entidadId) pendientes = pendientes.filter((p) => p.entidadId === entidadId);
  res.json(pendientes);
});

// GET /api/partidas-herramienta/mis-competiciones - torneos y ligas en los
// que participa el jugador identificado con PIN y que el admin ha marcado
// "anclar a inicio" (pestaña pública /torneos). Cada jugador solo ve las
// suyas. Participar = estar en algún cuadrante del torneo (o cuadrante final
// de una liga) o en la lista de participantes de la liga.
router.get("/mis-competiciones", requireJugadorPartida, async (req, res) => {
  const jugadorId = req.jugadorPartidaId;
  const enJugador = { OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] };
  const [enCuadrantes, enLigas] = await Promise.all([
    prisma.participanteCuadrante.findMany({
      where: { ...enJugador, cuadrante: { OR: [{ torneoClub: { anclarInicio: true, borradoEn: null } }, { liga: { anclarInicio: true, borradoEn: null } }] } },
      include: { cuadrante: { include: { torneoClub: true, liga: true } } },
    }),
    prisma.participanteLiga.findMany({
      where: { ...enJugador, liga: { anclarInicio: true, borradoEn: null } },
      include: { liga: true },
    }),
  ]);
  const vistas = new Map();
  const anadir = (tipo, e, etiqueta) => {
    if (!e || !e.anclarInicio || e.borradoEn) return;
    const clave = `${tipo}:${e.id}`;
    if (vistas.has(clave)) return;
    vistas.set(clave, {
      tipo,
      id: e.id,
      nombre: e.nombre,
      insigniaUrl: e.insigniaUrl,
      fechaInicio: e.fechaInicio,
      fechaFin: e.fechaFin,
      finalizado: e.finalizado,
      etiquetaPropia: etiqueta,
    });
  };
  for (const p of enCuadrantes) {
    if (p.cuadrante.torneoClub) anadir("torneo", p.cuadrante.torneoClub, p.etiqueta);
    else anadir("liga", p.cuadrante.liga, p.etiqueta);
  }
  for (const p of enLigas) anadir("liga", p.liga, p.etiqueta);
  res.json([...vistas.values()].sort((a, b) => new Date(b.fechaInicio) - new Date(a.fechaInicio)));
});

function formatearPartida(fila) {
  return {
    id: fila.id,
    juego: fila.juego,
    alMejorDe: fila.alMejorDe,
    apertura: fila.apertura,
    cierre: fila.cierre,
    modoCricket: fila.modoCricket,
    etiqueta1: fila.etiqueta1,
    etiqueta2: fila.etiqueta2,
    jugadoresId1: fila.jugadoresId1,
    jugadoresId2: fila.jugadoresId2,
    nombres1: fila.nombres1,
    nombres2: fila.nombres2,
    legs: fila.legs,
    legsGanados1: fila.legsGanados1,
    legsGanados2: fila.legsGanados2,
    finalizada: fila.finalizada,
    amistosa: fila.amistosa,
    visitaEnCurso: fila.visitaEnCurso,
  };
}

// POST /api/partidas-herramienta/amistosa - un socio logueado (sesión normal,
// no PIN: hace falta para poder elegir rival del listado del club con
// garantías) reta a otro jugador del club a un amistoso fuera de torneo/liga
// (plan "partido-amistoso-remoto", guardado en el proyecto). A diferencia de
// /iniciar, aquí no hay ronda/jornada de la que heredar juego/reglas: las
// elige directamente el creador, así que "ambos" (501 o Cricket a elegir) no
// tiene sentido y se rechaza. body: { rivalJugadorId } o { rivalNombreNuevo }
// (alta de amigo nueva sobre la marcha, igual que ya se hace al apuntar
// invitados a un torneo) + { juego, alMejorDe, apertura?, cierre?, modoCricket? }.
router.post("/amistosa", requireAuth, async (req, res) => {
  const creador = await prisma.jugador.findUnique({ where: { usuarioId: req.usuario.sub } });
  if (!creador) {
    return res.status(400).json({ error: "Tu cuenta de socio no tiene una ficha de jugador vinculada." });
  }

  const { rivalJugadorId, rivalNombreNuevo } = req.body;
  let rival;
  if (rivalNombreNuevo && rivalNombreNuevo.trim()) {
    rival = await prisma.jugador.create({ data: { nombre: rivalNombreNuevo.trim() } });
  } else if (rivalJugadorId) {
    rival = await prisma.jugador.findUnique({ where: { id: rivalJugadorId } });
    if (!rival) return res.status(404).json({ error: "Rival no encontrado." });
  } else {
    return res.status(400).json({ error: "Falta elegir un rival, o el nombre de un amigo nuevo." });
  }
  if (rival.id === creador.id) {
    return res.status(400).json({ error: "No puedes retarte a ti mismo." });
  }

  const config = limpiarConfigJuego(req.body, { requerida: true });
  if (!config.ok) return res.status(400).json({ error: config.error });
  if (config.valor.juego === "ambos") {
    return res.status(400).json({ error: 'Elige 501 o Cricket para el amistoso (no vale "ambos").' });
  }

  const creada = await prisma.partidaHerramienta.create({
    data: {
      amistosa: true,
      juego: config.valor.juego,
      alMejorDe: config.valor.alMejorDe,
      apertura: config.valor.apertura || null,
      cierre: config.valor.cierre || null,
      modoCricket: config.valor.modoCricket || null,
      etiqueta1: creador.apodo || creador.nombre,
      etiqueta2: rival.apodo || rival.nombre,
      jugadoresId1: [creador.id],
      jugadoresId2: [rival.id],
      nombres1: [creador.apodo || creador.nombre],
      nombres2: [rival.apodo || rival.nombre],
    },
  });

  // Aviso al rival (Web Push y/o Telegram, según lo que tenga activado — si
  // no tiene nada, notificarJugador no manda nada y no falla, ver
  // notificar.js). El enlace lleva directo a /partidas con esta partida ya
  // identificada, para que tras meter el PIN se abra sola sin tener que
  // elegirla de la lista de pendientes.
  const juegoEtiqueta = creada.juego === "cricket" ? "Cricket" : "501";
  await notificarJugador(rival.id, {
    titulo: "🎯 Te han retado a un amistoso",
    cuerpo: `${creador.apodo || creador.nombre} te reta a un amistoso (${juegoEtiqueta}, al mejor de ${creada.alMejorDe}).`,
    url: urlPublicaAmistoso(creada.id),
  });

  res.status(201).json(formatearPartida(creada));
});

// GET /api/partidas-herramienta/mis-amistosos - amistosos (pendientes o ya
// jugados) en los que participa el socio logueado, para poder gestionarlos
// desde la Zona de miembros (ver DELETE /:id más abajo). Sesión de socio, no
// PIN: un amigo sin cuenta no tiene esta pantalla, solo puede jugar. Va
// ANTES de GET /:id a propósito (si no, Express lo confundiría con un id).
router.get("/mis-amistosos", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({ where: { usuarioId: req.usuario.sub } });
  if (!jugador) return res.json([]);
  const todas = await prisma.partidaHerramienta.findMany({ where: { amistosa: true }, orderBy: { creadoEn: "desc" } });
  const mias = todas.filter((p) => p.jugadoresId1.includes(jugador.id) || p.jugadoresId2.includes(jugador.id));
  res.json(
    mias.map((p) => ({
      id: p.id,
      juego: p.juego,
      alMejorDe: p.alMejorDe,
      etiqueta1: p.etiqueta1,
      etiqueta2: p.etiqueta2,
      legsGanados1: p.legsGanados1,
      legsGanados2: p.legsGanados2,
      finalizada: p.finalizada,
      creadoEn: p.creadoEn,
    }))
  );
});

// DELETE /api/partidas-herramienta/:id - borra un amistoso (pedido de
// Iraitz, 2026-09-17). Solo amistosos: un partido real de torneo/liga sigue
// el flujo normal del cuadro/jornada, nunca se borra por aquí. Sesión de
// socio y ser uno de los dos participantes. Borrado directo, sin papelera —
// a diferencia de un torneo/liga, un amistoso no tiene nada colgando (ni
// cuadros, ni historial de terceros), así que ese resguardo no hace falta
// aquí. Si estaba finalizado, sus estadísticas dejan de contar en "Acero"
// (se recalcula al vuelo a partir de las `PartidaHerramienta` que queden).
router.delete("/:id", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({ where: { usuarioId: req.usuario.sub } });
  if (!jugador) return res.status(403).json({ error: "Tu cuenta de socio no tiene una ficha de jugador vinculada." });
  const partida = await prisma.partidaHerramienta.findUnique({ where: { id: req.params.id } });
  if (!partida) return res.status(204).end();
  if (!partida.amistosa) {
    return res.status(400).json({ error: "Esto no es un amistoso: los partidos de torneo/liga no se borran desde aquí." });
  }
  const esParticipante = partida.jugadoresId1.includes(jugador.id) || partida.jugadoresId2.includes(jugador.id);
  if (!esParticipante) return res.status(403).json({ error: "No eres parte de este amistoso." });
  await prisma.partidaHerramienta.delete({ where: { id: partida.id } });
  res.status(204).end();
});

// POST /api/partidas-herramienta/iniciar - crea (o recupera, si ya existía)
// la PartidaHerramienta de un partido pendiente concreto. body: { tipo:
// "cuadrante"|"jornada", partidoId, juegoElegido? } — juegoElegido solo hace
// falta si la configuración de esa ronda/jornada es "ambos" (501 y Cricket a
// elegir), ver configuracionHerramienta.js.
router.post("/iniciar", requireJugadorPartida, async (req, res) => {
  const { tipo, partidoId, juegoElegido } = req.body;
  const localizado = await localizarPartidoConConfig(prisma, { tipo, partidoId });
  if (!localizado) {
    return res.status(404).json({ error: "Este partido no está disponible para jugar con la herramienta." });
  }
  const { partido, cuadranteId, ligaId, config } = localizado;

  const yaExiste = await prisma.partidaHerramienta.findUnique({
    where: tipo === "cuadrante" ? { cuadroPartidoId: partidoId } : { partidoLigaId: partidoId },
  });
  if (yaExiste) {
    if (yaExiste.finalizada) {
      return res.status(409).json({ error: "Este partido ya se ha jugado con la herramienta." });
    }
    const esParticipante =
      yaExiste.jugadoresId1.includes(req.jugadorPartidaId) || yaExiste.jugadoresId2.includes(req.jugadorPartidaId);
    if (!esParticipante) return res.status(403).json({ error: "No eres parte de este partido." });
    return res.json(formatearPartida(yaExiste));
  }

  const etiqueta1 = tipo === "cuadrante" ? partido.jugador1 : partido.participante1;
  const etiqueta2 = tipo === "cuadrante" ? partido.jugador2 : partido.participante2;
  const [lado1, lado2] = await Promise.all([
    resolverParticipante(prisma, { cuadranteId, ligaId, etiqueta: etiqueta1 }),
    resolverParticipante(prisma, { cuadranteId, ligaId, etiqueta: etiqueta2 }),
  ]);
  if (lado1.jugadoresId.length === 0 || lado2.jugadoresId.length === 0) {
    return res.status(400).json({
      error: "Este partido tiene jugadores sin vincular a una ficha del club: no se puede jugar con la herramienta.",
    });
  }
  const esParticipante = lado1.jugadoresId.includes(req.jugadorPartidaId) || lado2.jugadoresId.includes(req.jugadorPartidaId);
  if (!esParticipante) return res.status(403).json({ error: "No eres parte de este partido." });

  let juego = config.juego;
  if (juego === "ambos") {
    if (!["501", "cricket"].includes(juegoElegido)) {
      return res.status(400).json({ error: "Elige a qué vais a jugar: 501 o Cricket." });
    }
    juego = juegoElegido;
  }

  const creada = await prisma.partidaHerramienta.create({
    data: {
      cuadroPartidoId: tipo === "cuadrante" ? partidoId : undefined,
      partidoLigaId: tipo === "jornada" ? partidoId : undefined,
      juego,
      alMejorDe: config.alMejorDe,
      apertura: config.apertura || null,
      cierre: config.cierre || null,
      modoCricket: config.modoCricket || null,
      etiqueta1,
      etiqueta2,
      jugadoresId1: lado1.jugadoresId,
      jugadoresId2: lado2.jugadoresId,
      nombres1: lado1.nombres,
      nombres2: lado2.nombres,
    },
  });
  res.status(201).json(formatearPartida(creada));
});

// GET /api/partidas-herramienta/:id - estado actual, para reanudar tras
// recargar la página (o, en el futuro, desde el otro dispositivo).
router.get("/:id", requireJugadorPartida, async (req, res) => {
  const partida = await prisma.partidaHerramienta.findUnique({ where: { id: req.params.id } });
  if (!partida) return res.status(404).json({ error: "Partida no encontrada" });
  const esParticipante =
    partida.jugadoresId1.includes(req.jugadorPartidaId) || partida.jugadoresId2.includes(req.jugadorPartidaId);
  if (!esParticipante) return res.status(403).json({ error: "No eres parte de este partido." });
  res.json(formatearPartida(partida));
});

// POST /api/partidas-herramienta/:id/legs - registra un leg terminado. body:
// { ladoGanador: 1|2, estadisticas: { [jugadorId]: {...} } }. En cuanto se
// alcanza "al mejor de N" (mayoría de legs), se aplica el resultado final al
// partido real (CuadroPartido o PartidoLiga) con la misma lógica que usa el
// PUT de administración manual, y esta partida queda marcada `finalizada`.
router.post("/:id/legs", requireJugadorPartida, async (req, res) => {
  const { ladoGanador, estadisticas } = req.body;
  if (ladoGanador !== 1 && ladoGanador !== 2) {
    return res.status(400).json({ error: "Falta indicar qué lado ha ganado el leg (1 o 2)." });
  }
  const partida = await prisma.partidaHerramienta.findUnique({ where: { id: req.params.id } });
  if (!partida) return res.status(404).json({ error: "Partida no encontrada" });
  if (partida.finalizada) return res.status(409).json({ error: "Esta partida ya ha terminado." });
  const esParticipante =
    partida.jugadoresId1.includes(req.jugadorPartidaId) || partida.jugadoresId2.includes(req.jugadorPartidaId);
  if (!esParticipante) return res.status(403).json({ error: "No eres parte de este partido." });

  const legs = [...partida.legs, { numero: partida.legs.length + 1, ladoGanador, estadisticas: estadisticas || {} }];
  const legsGanados1 = partida.legsGanados1 + (ladoGanador === 1 ? 1 : 0);
  const legsGanados2 = partida.legsGanados2 + (ladoGanador === 2 ? 1 : 0);
  // Mayoría de "al mejor de N" (p.ej. al mejor de 5 -> hacen falta 3).
  const legsParaGanar = Math.floor(partida.alMejorDe / 2) + 1;
  const finalizada = legsGanados1 >= legsParaGanar || legsGanados2 >= legsParaGanar;

  const actualizada = await prisma.partidaHerramienta.update({
    where: { id: partida.id },
    // visitaEnCurso a null: el leg ha terminado, no hay ninguna visita a
    // medias (ni la del siguiente leg, que todavía no ha empezado ningún
    // dardo) — así el otro dispositivo, al hacer polling, no se queda
    // mirando dardos de un leg que ya no existe.
    data: { legs, legsGanados1, legsGanados2, finalizada, visitaEnCurso: null },
  });

  if (finalizada) {
    const ganadorEtiqueta = legsGanados1 >= legsParaGanar ? partida.etiqueta1 : partida.etiqueta2;
    const resultado = `${legsGanados1}-${legsGanados2}`;
    if (partida.cuadroPartidoId) {
      await aplicarResultadoCuadroPartido(partida.cuadroPartidoId, { resultado, ganador: ganadorEtiqueta });
    } else if (partida.partidoLigaId) {
      await aplicarResultadoPartidoLiga(partida.partidoLigaId, { resultado, ganador: ganadorEtiqueta });
    }
  }

  res.json(formatearPartida(actualizada));
});

// PUT /api/partidas-herramienta/:id/visita - guarda el estado de la visita en
// curso (partido remoto entre dos dispositivos, hoy solo amistosos — plan
// "partido-amistoso-remoto" guardado en el proyecto). body libre (forma
// depende del juego, ver comentario de `visitaEnCurso` en schema.prisma) pero
// siempre con `turnoJugadorId`: de quién es el turno DESPUÉS de este envío
// (el mismo jugador que envía, si sigue tirando dardos de su visita; el
// rival, si acaba de terminar su turno de 3 dardos).
//
// Control de turno en el servidor: solo puede escribir aquí quien ya tenía
// el turno asignado (partida.visitaEnCurso.turnoJugadorId) — así el
// dispositivo del rival no puede pisar el marcador del otro mientras no le
// toca. Si todavía no hay ninguna visita guardada (partida recién creada o
// entre leg y leg) se acepta el primer envío de cualquiera de los dos
// participantes para arrancarla: no hay hoy una regla de "quién empieza"
// explícita en el backend para amistosos, la fija el frontend.
router.put("/:id/visita", requireJugadorPartida, async (req, res) => {
  const partida = await prisma.partidaHerramienta.findUnique({ where: { id: req.params.id } });
  if (!partida) return res.status(404).json({ error: "Partida no encontrada" });
  if (partida.finalizada) return res.status(409).json({ error: "Esta partida ya ha terminado." });
  const esParticipante =
    partida.jugadoresId1.includes(req.jugadorPartidaId) || partida.jugadoresId2.includes(req.jugadorPartidaId);
  if (!esParticipante) return res.status(403).json({ error: "No eres parte de este partido." });

  const turnoActual = partida.visitaEnCurso?.turnoJugadorId;
  if (turnoActual && turnoActual !== req.jugadorPartidaId) {
    return res.status(403).json({ error: "No es tu turno." });
  }
  if (!req.body || !req.body.turnoJugadorId) {
    return res.status(400).json({ error: "Falta indicar de quién es el turno." });
  }

  const actualizada = await prisma.partidaHerramienta.update({
    where: { id: partida.id },
    data: { visitaEnCurso: req.body },
  });
  res.json(formatearPartida(actualizada));
});

// --- Cámaras en directo (plan "camaras-partidas", guardado en el proyecto) -
//
// Un dispositivo con dos cámaras (diana + lanzador) se puede activar al
// jugar y retransmitir por WebRTC — sin servidor de medios ni TURN de pago,
// solo STUN público (lo elige el frontend) — a quien esté viendo el
// partido: el rival en un amistoso remoto, o espectadores de la página
// pública de un torneo/liga. La señalización (oferta/respuesta SDP,
// candidatos ICE) va por polling, igual que visitaEnCurso, guardada en
// senalCamara.viewers, una entrada por espectador conectado.
//
// Dos roles con permisos distintos:
// - Emisor: quien tiene las cámaras encendidas, siempre uno de los dos
//   participantes del partido (requireJugadorPartida). Ve el mapa entero de
//   espectadores (para poder mandarles oferta a los nuevos) y solo puede
//   escribir su propia mitad (offer/iceEmisor) de cada entrada.
// - Espectador: público, sin PIN — puede ser el rival remoto o cualquiera
//   viendo la página pública. Solo ve y escribe su PROPIA entrada (por
//   viewerId), nunca el mapa completo, para no filtrar la señalización de
//   otros espectadores ni dejar que nadie la pise.
function esParticipanteDe(partida, jugadorId) {
  return partida.jugadoresId1.includes(jugadorId) || partida.jugadoresId2.includes(jugadorId);
}

// Emisión en los DOS sentidos a la vez (pedido de Iraitz, 2026-09-19: solo se
// veían las cámaras del rival si apagabas las tuyas). Cada participante es un
// emisor independiente: senalCamara = { emisores: { [jugadorId]: { activas,
// viewers: { [viewerId]: {...} } } } }. El rival (o quien sea) que quiere ver
// las cámaras de un emisor se registra como espectador de ESE emisor.
// camarasActivas (columna) queda como "hay algún emisor activo".
function normalizarSenal(senalCamara) {
  return { emisores: (senalCamara && senalCamara.emisores) || {} };
}

function hayEmisorActivo(senal) {
  return Object.values(senal.emisores).some((e) => e.activas);
}

// Ahora escriben en el mismo JSON dos emisores y dos espectadores cada 2.5s,
// así que el leer-modificar-escribir se hace bloqueando la fila (FOR UPDATE)
// dentro de una transacción: sin esto se pisarían candidatos ICE/ofertas.
// `mutador(senal, partida)` modifica `senal` en sitio y devuelve un valor
// (o { fallo: [status, mensaje] } para abortar sin guardar).
async function modificarSenal(partidaId, mutador) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PartidaHerramienta" WHERE id = ${partidaId} FOR UPDATE`;
    const partida = await tx.partidaHerramienta.findUnique({ where: { id: partidaId } });
    if (!partida) return { fallo: [404, "Partida no encontrada"] };
    const senal = normalizarSenal(partida.senalCamara);
    const resultado = (await mutador(senal, partida)) || {};
    if (resultado.fallo) return resultado;
    await tx.partidaHerramienta.update({
      where: { id: partidaId },
      data: { senalCamara: senal, camarasActivas: hayEmisorActivo(senal) },
    });
    return resultado;
  });
}

function responderFallo(res, r) {
  return res.status(r.fallo[0]).json({ error: r.fallo[1] });
}

// Descarta espectadores con más de 10 minutos sin actividad de un emisor,
// para que la señalización no crezca sin límite.
function podarViewers(emisor) {
  const limite = Date.now() - 10 * 60 * 1000;
  const vivos = {};
  for (const [id, v] of Object.entries(emisor.viewers || {})) {
    if (new Date(v.actualizadoEn || 0).getTime() >= limite) vivos[id] = v;
  }
  emisor.viewers = vivos;
}

// Busca en qué emisor está registrado un viewerId (los ids son UUID únicos).
function buscarViewer(senal, viewerId) {
  for (const emisor of Object.values(senal.emisores)) {
    if (emisor.viewers && emisor.viewers[viewerId]) return { emisor, viewerId };
  }
  return null;
}

// GET /api/partidas-herramienta/:id/camara/estado - público: qué emisores
// (jugadorId) tienen las cámaras encendidas ahora mismo.
router.get("/:id/camara/estado", async (req, res) => {
  const partida = await prisma.partidaHerramienta.findUnique({
    where: { id: req.params.id },
    select: { senalCamara: true },
  });
  if (!partida) return res.status(404).json({ error: "Partida no encontrada" });
  const senal = normalizarSenal(partida.senalCamara);
  const emisores = Object.entries(senal.emisores).filter(([, e]) => e.activas).map(([id]) => id);
  res.json({ camarasActivas: emisores.length > 0, emisores });
});

// POST /api/partidas-herramienta/:id/camara/activar - un participante
// enciende SUS cámaras (no afecta a las del rival). Resetea solo sus
// espectadores: tienen que volver a registrarse (ver POST /ver).
router.post("/:id/camara/activar", requireJugadorPartida, async (req, res) => {
  const r = await modificarSenal(req.params.id, (senal, partida) => {
    if (!esParticipanteDe(partida, req.jugadorPartidaId)) return { fallo: [403, "No eres parte de este partido."] };
    senal.emisores[req.jugadorPartidaId] = { activas: true, viewers: {} };
    return {};
  });
  if (r.fallo) return responderFallo(res, r);
  res.json({ camarasActivas: true });
});

// POST /api/partidas-herramienta/:id/camara/desactivar - apaga SUS cámaras y
// limpia su señalización.
router.post("/:id/camara/desactivar", requireJugadorPartida, async (req, res) => {
  const r = await modificarSenal(req.params.id, (senal, partida) => {
    if (!esParticipanteDe(partida, req.jugadorPartidaId)) return { fallo: [403, "No eres parte de este partido."] };
    delete senal.emisores[req.jugadorPartidaId];
    return {};
  });
  if (r.fallo) return responderFallo(res, r);
  res.json({ camarasActivas: false });
});

// POST /api/partidas-herramienta/:id/camara/ver - público: un espectador se
// registra para ver las cámaras de UN emisor (body: { emisorId }) y recibe su
// viewerId (a partir de aquí, solo puede leer/escribir su propia entrada).
router.post("/:id/camara/ver", async (req, res) => {
  const { emisorId } = req.body || {};
  const viewerId = crypto.randomUUID();
  const r = await modificarSenal(req.params.id, (senal) => {
    const emisor = emisorId && senal.emisores[emisorId];
    if (!emisor || !emisor.activas) return { fallo: [409, "Las cámaras no están activas ahora mismo."] };
    podarViewers(emisor);
    emisor.viewers[viewerId] = {
      estado: "esperando",
      offer: null,
      answer: null,
      iceEmisor: [],
      iceReceptor: [],
      actualizadoEn: new Date().toISOString(),
    };
    return {};
  });
  if (r.fallo) return responderFallo(res, r);
  res.status(201).json({ viewerId });
});

// GET /api/partidas-herramienta/:id/camara/senal - el EMISOR (participante)
// consulta el mapa de SUS espectadores, para mandar oferta a los nuevos
// ("esperando") y aplicar la respuesta de los que ya contestaron.
router.get("/:id/camara/senal", requireJugadorPartida, async (req, res) => {
  const partida = await prisma.partidaHerramienta.findUnique({
    where: { id: req.params.id },
    select: { jugadoresId1: true, jugadoresId2: true, senalCamara: true },
  });
  if (!partida) return res.status(404).json({ error: "Partida no encontrada" });
  if (!esParticipanteDe(partida, req.jugadorPartidaId)) {
    return res.status(403).json({ error: "No eres parte de este partido." });
  }
  const emisor = normalizarSenal(partida.senalCamara).emisores[req.jugadorPartidaId];
  res.json({ viewers: (emisor && emisor.viewers) || {} });
});

// PUT /api/partidas-herramienta/:id/camara/senal - el EMISOR manda su oferta
// y/o candidatos ICE nuevos para un espectador suyo (body: { viewerId,
// offer?, iceEmisor?: [...] }). Los candidatos se ACUMULAN.
router.put("/:id/camara/senal", requireJugadorPartida, async (req, res) => {
  const { viewerId, offer, iceEmisor } = req.body || {};
  if (!viewerId) return res.status(400).json({ error: "Falta el id del espectador." });
  const r = await modificarSenal(req.params.id, (senal, partida) => {
    if (!esParticipanteDe(partida, req.jugadorPartidaId)) return { fallo: [403, "No eres parte de este partido."] };
    const emisor = senal.emisores[req.jugadorPartidaId];
    const actual = emisor && emisor.viewers[viewerId];
    if (!actual) return { fallo: [404, "Ese espectador ya no está conectado."] };
    emisor.viewers[viewerId] = {
      ...actual,
      ...(offer ? { offer, estado: "esperando-respuesta" } : {}),
      iceEmisor: [...(actual.iceEmisor || []), ...(iceEmisor || [])],
      actualizadoEn: new Date().toISOString(),
    };
    return {};
  });
  if (r.fallo) return responderFallo(res, r);
  res.status(204).end();
});

// GET /api/partidas-herramienta/:id/camara/senal/:viewerId - público: el
// espectador lee SOLO su propia entrada.
router.get("/:id/camara/senal/:viewerId", async (req, res) => {
  const partida = await prisma.partidaHerramienta.findUnique({
    where: { id: req.params.id },
    select: { senalCamara: true },
  });
  if (!partida) return res.status(404).json({ error: "Partida no encontrada" });
  const encontrado = buscarViewer(normalizarSenal(partida.senalCamara), req.params.viewerId);
  if (!encontrado) {
    return res.status(404).json({ error: "Tu sesión de vídeo ha caducado, vuelve a intentarlo." });
  }
  const entrada = encontrado.emisor.viewers[req.params.viewerId];
  res.json({
    camarasActivas: !!encontrado.emisor.activas,
    offer: entrada.offer,
    iceEmisor: entrada.iceEmisor || [],
  });
});

// PUT /api/partidas-herramienta/:id/camara/senal/:viewerId - público: el
// espectador manda su respuesta y/o candidatos ICE nuevos (body: { answer?,
// iceReceptor?: [...] }).
router.put("/:id/camara/senal/:viewerId", async (req, res) => {
  const { answer, iceReceptor } = req.body || {};
  const r = await modificarSenal(req.params.id, (senal) => {
    const encontrado = buscarViewer(senal, req.params.viewerId);
    if (!encontrado) return { fallo: [404, "Tu sesión de vídeo ha caducado, vuelve a intentarlo."] };
    const actual = encontrado.emisor.viewers[req.params.viewerId];
    encontrado.emisor.viewers[req.params.viewerId] = {
      ...actual,
      ...(answer ? { answer, estado: "conectado" } : {}),
      iceReceptor: [...(actual.iceReceptor || []), ...(iceReceptor || [])],
      actualizadoEn: new Date().toISOString(),
    };
    return {};
  });
  if (r.fallo) return responderFallo(res, r);
  res.status(204).end();
});

export default router;
