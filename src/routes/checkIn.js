import { Router } from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { verificarTokenSocio } from "./auth.js";

// Check-in con QR de un cuadrante (torneo, o cuadrante final de liga): el
// admin abre el check-in desde el panel de participantes (POST
// /api/torneos-club/cuadrantes/:id/check-in), que crea un CheckInCuadrante
// con un token aleatorio y muestra el QR de /checkin/:token. Cada jugador lo
// lee con su móvil, se identifica (PIN de la página pública o sesión de
// socio) y marca su propia presencia, sin pasar por la mesa. Solo vale para
// participantes ya apuntados al cuadrante; en parejas tienen que hacerlo los
// dos. El QR deja de valer al cerrar el check-in o al hacer el sorteo.

const router = Router();

// El token del QR es aleatorio y largo, pero aun así se limitan los intentos
// fallidos (token inexistente, sin identificar...) para que no se puedan
// probar tokens a lo loco. Solo cuentan los fallos (skipSuccessfulRequests):
// en el wifi del club todos llegan con la misma IP y medio torneo hace el
// check-in a la vez — ver el comentario de src/middleware/loginLimiter.js.
const checkInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Demasiados intentos fallidos. Espera unos minutos." },
});

// jugadorId de quien hace la petición: vale tanto el token de PIN de la
// página pública (invitados y socios, ver partidasHerramienta.js) como la
// sesión de la zona de socios (cuenta aprobada con ficha de jugador).
async function jugadorDeLaPeticion(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.tipo === "partida" && payload.jugadorId) return payload.jugadorId;
  } catch {
    return null;
  }
  try {
    const payload = verificarTokenSocio(token);
    const usuario = await prisma.usuario.findUnique({
      where: { id: payload.sub },
      select: { aprobado: true, jugador: { select: { id: true } } },
    });
    return usuario?.aprobado ? usuario.jugador?.id || null : null;
  } catch {
    return null;
  }
}

async function buscarCheckIn(token) {
  return prisma.checkInCuadrante.findUnique({
    where: { token },
    include: { cuadrante: { include: { torneoClub: true, liga: true } } },
  });
}

function datosCompeticion(cuadrante) {
  const entidad = cuadrante.torneoClub || cuadrante.liga;
  return {
    tipo: cuadrante.torneoClub ? "torneo" : "liga",
    id: entidad?.id,
    nombre: entidad?.nombre || "Torneo del club",
    insigniaUrl: entidad?.insigniaUrl || null,
    cuadrante: cuadrante.nombre,
  };
}

const nombreJugador = (j) => (j ? j.apodo || j.nombre : null);

// Estado del check-in de un participante visto desde uno de sus jugadores:
// si ya ha hecho el suyo y, en parejas, si falta el del compañero.
function estadoParticipante(p, jugadorId) {
  const soyJugador1 = p.jugador1Id === jugadorId;
  const companero = soyJugador1 ? p.jugador2 : p.jugador1;
  const esPareja = !!(p.jugador2Id || p.etiqueta.includes(" / "));
  return {
    etiqueta: p.etiqueta,
    hecho: soyJugador1 ? p.checkInJugador1 : p.checkInJugador2,
    confirmado: p.confirmado !== false,
    esPareja,
    companero: esPareja ? nombreJugador(companero) || p.etiqueta.split(" / ")[soyJugador1 ? 1 : 0] || null : null,
    companeroSinCuenta: esPareja && !(soyJugador1 ? p.jugador2Id : p.jugador1Id),
    companeroHecho: esPareja ? (soyJugador1 ? p.checkInJugador2 : p.checkInJugador1) : null,
  };
}

const includeJugadores = {
  jugador1: { select: { nombre: true, apodo: true } },
  jugador2: { select: { nombre: true, apodo: true } },
};

// GET /api/check-in/:token - datos del check-in abierto (competición y
// cuadrante) para la página del QR. Si la petición viene identificada,
// añade también el estado de los participantes de ese jugador.
router.get("/:token", checkInLimiter, async (req, res) => {
  const checkIn = await buscarCheckIn(req.params.token);
  if (!checkIn) return res.status(404).json({ error: "Este check-in ya está cerrado o el QR no es válido." });

  const respuesta = { competicion: datosCompeticion(checkIn.cuadrante) };
  const jugadorId = await jugadorDeLaPeticion(req);
  if (jugadorId) {
    const mios = await prisma.participanteCuadrante.findMany({
      where: { cuadranteId: checkIn.cuadranteId, OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] },
      include: includeJugadores,
    });
    respuesta.participantes = mios.map((p) => estadoParticipante(p, jugadorId));
  }
  res.json(respuesta);
});

// POST /api/check-in/:token - el jugador identificado marca su presencia en
// todos los participantes suyos de ese cuadrante (normalmente uno). El
// participante queda `confirmado` cuando han hecho check-in todos sus
// jugadores: en individual, él; en parejas, los dos (si el compañero no
// tiene ficha, el admin tiene que marcarlo a mano en la mesa).
router.post("/:token", checkInLimiter, async (req, res) => {
  const jugadorId = await jugadorDeLaPeticion(req);
  if (!jugadorId) return res.status(401).json({ error: "Identifícate para hacer el check-in." });

  const checkIn = await buscarCheckIn(req.params.token);
  if (!checkIn) return res.status(404).json({ error: "Este check-in ya está cerrado o el QR no es válido." });

  const mios = await prisma.participanteCuadrante.findMany({
    where: { cuadranteId: checkIn.cuadranteId, OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] },
  });
  if (mios.length === 0) {
    return res.status(403).json({
      error: "No estás apuntado a este cuadrante. Si deberías estarlo, pasa por la mesa.",
      competicion: datosCompeticion(checkIn.cuadrante),
    });
  }

  const actualizados = [];
  for (const p of mios) {
    const check1 = p.checkInJugador1 || p.jugador1Id === jugadorId;
    const check2 = p.checkInJugador2 || p.jugador2Id === jugadorId;
    const esPareja = !!(p.jugador2Id || p.etiqueta.includes(" / "));
    const completo = esPareja ? check1 && check2 : check1;
    actualizados.push(
      await prisma.participanteCuadrante.update({
        where: { id: p.id },
        data: { checkInJugador1: check1, checkInJugador2: check2, ...(completo ? { confirmado: true } : {}) },
        include: includeJugadores,
      })
    );
  }

  res.json({
    competicion: datosCompeticion(checkIn.cuadrante),
    participantes: actualizados.map((p) => estadoParticipante(p, jugadorId)),
  });
});

export default router;
