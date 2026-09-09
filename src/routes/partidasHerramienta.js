import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { loginLimiter } from "../middleware/loginLimiter.js";
import {
  partidosPendientesDeJugador,
  localizarPartidoConConfig,
  resolverParticipante,
} from "../lib/partidasHerramienta.js";
import { aplicarResultadoCuadroPartido } from "./torneosClub.js";
import { aplicarResultadoPartidoLiga } from "./ligasClub.js";
import { pinValido } from "./jugadores.js";

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
  };
}

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
    data: { legs, legsGanados1, legsGanados2, finalizada },
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

export default router;
