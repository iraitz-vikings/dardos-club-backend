import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { requireAuth } from "./auth.js";
import { sortearParejasPorGrupos, resolverNombresJugadores } from "../lib/sorteoParejasGrupos.js";
import { notificarJugadores } from "./notificar.js";
import { diasRestantesPapelera } from "../lib/papelera.js";

const prisma = new PrismaClient();
const router = Router();

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

const includeCompleto = {
  cuadrantes: {
    orderBy: { creadoEn: "asc" },
    include: {
      partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] },
      participantes: { include: { jugador1: true, jugador2: true }, orderBy: { creadoEn: "asc" } },
    },
  },
};

// ---------- Generador de cuadros (eliminación directa / doble) ----------

function log2(n) {
  return Math.round(Math.log2(n));
}

export function generarPartidos(tamano, tipoEliminacion) {
  const k = log2(tamano);
  const partidos = [];

  const nuevoPartido = (rama, ronda, posicion) => {
    const p = {
      id: randomUUID(),
      rama,
      ronda,
      posicion,
      jugador1: null,
      jugador2: null,
      siguientePartidoGanadorId: null,
      siguienteSlotGanador: null,
      siguientePartidoPerdedorId: null,
      siguienteSlotPerdedor: null,
    };
    partidos.push(p);
    return p;
  };

  const wbRondas = [];
  for (let r = 0; r < k; r++) {
    const count = tamano / Math.pow(2, r + 1);
    const ronda = [];
    for (let i = 0; i < count; i++) ronda.push(nuevoPartido("ganadores", r + 1, i));
    wbRondas.push(ronda);
  }
  for (let r = 0; r < k - 1; r++) {
    for (let i = 0; i < wbRondas[r].length; i++) {
      const actual = wbRondas[r][i];
      const siguiente = wbRondas[r + 1][Math.floor(i / 2)];
      actual.siguientePartidoGanadorId = siguiente.id;
      actual.siguienteSlotGanador = i % 2 === 0 ? 1 : 2;
    }
  }

  if (tipoEliminacion !== "doble" || k < 2) {
    return partidos;
  }

  const lbRondas = [];
  for (let g = 1; g <= k - 1; g++) {
    const count = tamano / Math.pow(2, g + 1);
    const rondaA = [];
    for (let i = 0; i < count; i++) rondaA.push(nuevoPartido("perdedores", 2 * g - 1, i));
    lbRondas.push(rondaA);
    const rondaB = [];
    for (let i = 0; i < count; i++) rondaB.push(nuevoPartido("perdedores", 2 * g, i));
    lbRondas.push(rondaB);
  }

  {
    const wbR1 = wbRondas[0];
    const lbR1 = lbRondas[0];
    for (let i = 0; i < lbR1.length; i++) {
      wbR1[2 * i].siguientePartidoPerdedorId = lbR1[i].id;
      wbR1[2 * i].siguienteSlotPerdedor = 1;
      wbR1[2 * i + 1].siguientePartidoPerdedorId = lbR1[i].id;
      wbR1[2 * i + 1].siguienteSlotPerdedor = 2;
    }
  }

  for (let g = 1; g <= k - 1; g++) {
    const rondaA = lbRondas[2 * (g - 1)];
    const rondaB = lbRondas[2 * (g - 1) + 1];
    for (let i = 0; i < rondaA.length; i++) {
      rondaA[i].siguientePartidoGanadorId = rondaB[i].id;
      rondaA[i].siguienteSlotGanador = 1;
    }
    if (g < k) {
      const perdedoresWb = [...wbRondas[g]].reverse();
      for (let i = 0; i < rondaB.length; i++) {
        perdedoresWb[i].siguientePartidoPerdedorId = rondaB[i].id;
        perdedoresWb[i].siguienteSlotPerdedor = 2;
      }
    }
  }

  for (let g = 1; g <= k - 2; g++) {
    const rondaB = lbRondas[2 * (g - 1) + 1];
    const siguienteRondaA = lbRondas[2 * g];
    for (let i = 0; i < siguienteRondaA.length; i++) {
      rondaB[2 * i].siguientePartidoGanadorId = siguienteRondaA[i].id;
      rondaB[2 * i].siguienteSlotGanador = 1;
      rondaB[2 * i + 1].siguientePartidoGanadorId = siguienteRondaA[i].id;
      rondaB[2 * i + 1].siguienteSlotGanador = 2;
    }
  }

  const finalPartido = nuevoPartido("final", 2 * (k - 1) + 1, 0);
  const campeonGanadores = wbRondas[k - 1][0];
  campeonGanadores.siguientePartidoGanadorId = finalPartido.id;
  campeonGanadores.siguienteSlotGanador = 1;
  const finalLb = lbRondas[lbRondas.length - 1][0];
  finalLb.siguientePartidoGanadorId = finalPartido.id;
  finalLb.siguienteSlotGanador = 2;

  return partidos;
}

// Si un partido se queda con un único jugador asignado y podemos demostrar que el
// otro hueco nunca se va a rellenar (porque su origen era, a su vez, un "bye" sin
// enfrentamiento real), este partido se resuelve solo como pase directo, y se
// propaga en cascada si hace falta. Si ambos huecos están en ese caso, se marca
// como resuelto sin ganador para no bloquear partidos posteriores. Si algún hueco
// todavía puede recibir a alguien (porque el partido que se lo manda aún no se ha
// jugado), no se toca nada: hay que esperar.
async function intentarResolverBye(partidoId) {
  const partido = await prisma.cuadroPartido.findUnique({ where: { id: partidoId } });
  if (!partido || partido.ganador || partido.resultado === "__BYE_DOBLE__") return;

  const posiblesFuentes = await prisma.cuadroPartido.findMany({
    where: {
      cuadranteId: partido.cuadranteId,
      OR: [
        { siguientePartidoGanadorId: partido.id },
        { siguientePartidoPerdedorId: partido.id },
      ],
    },
  });
  if (posiblesFuentes.length === 0) return;

  const fuentePara = (slot) =>
    posiblesFuentes.find(
      (f) =>
        (f.siguientePartidoGanadorId === partido.id && f.siguienteSlotGanador === slot) ||
        (f.siguientePartidoPerdedorId === partido.id && f.siguienteSlotPerdedor === slot)
    );

  const slotPendiente = (slot, valorActual) => {
    if (valorActual) return false;
    const fuente = fuentePara(slot);
    if (!fuente) return false;
    // Si el partido origen ya quedó resuelto como "bye doble" (sin enfrentamiento
    // real, sin ganador y sin que vaya a haberlo nunca), este hueco no está
    // realmente pendiente: nadie va a llegar por ahí. Esto aplica igual tanto si el
    // hueco se alimenta del GANADOR de ese partido origen como si se alimenta de su
    // PERDEDOR, así que el chequeo tiene que ser el mismo en los dos casos.
    return !fuente.ganador && fuente.resultado !== "__BYE_DOBLE__";
  };

  if (slotPendiente(1, partido.jugador1) || slotPendiente(2, partido.jugador2)) return;

  const jugadoresPresentes = [partido.jugador1, partido.jugador2].filter(Boolean);

  if (jugadoresPresentes.length === 1) {
    const ganador = jugadoresPresentes[0];
    await prisma.cuadroPartido.update({ where: { id: partido.id }, data: { ganador } });
    if (partido.siguientePartidoGanadorId) {
      const campo = partido.siguienteSlotGanador === 2 ? "jugador2" : "jugador1";
      await prisma.cuadroPartido.update({
        where: { id: partido.siguientePartidoGanadorId },
        data: { [campo]: ganador },
      });
      await intentarResolverBye(partido.siguientePartidoGanadorId);
    }
  } else if (jugadoresPresentes.length === 0) {
    await prisma.cuadroPartido.update({
      where: { id: partido.id },
      data: { resultado: "__BYE_DOBLE__" },
    });
    if (partido.siguientePartidoGanadorId) {
      await intentarResolverBye(partido.siguientePartidoGanadorId);
    }
  }
}

// ---------- Rutas de torneos del club ----------

// En todos los listados normales (públicos, admin, socios) se excluyen los
// torneos que están en la papelera (`borradoEn` no nulo) — tienen su propio
// listado en GET /papelera. Ver src/lib/papelera.js.
router.get("/", async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    where: { visibilidad: "publico", borradoEn: null },
    orderBy: { fechaInicio: "desc" },
    include: includeCompleto,
  });
  res.json(torneos);
});

// GET /api/torneos-club/privados - torneos privados ya finalizados, para el
// histórico dentro del portal de socios (requiere sesión de socio, no admin)
router.get("/privados", requireAuth, async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    where: { visibilidad: "privado", finalizado: true, borradoEn: null },
    orderBy: { fechaInicio: "desc" },
    select: { id: true, nombre: true, fechaInicio: true, fechaFin: true },
  });
  res.json(torneos);
});

// GET /api/torneos-club/activos - torneos aún no finalizados, para "Competiciones"
// en el portal de socios (públicos o privados, cualquier socio logueado los ve)
router.get("/activos", requireAuth, async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    where: { finalizado: false, borradoEn: null },
    orderBy: { fechaInicio: "desc" },
    select: { id: true, nombre: true, fechaInicio: true, fechaFin: true, modalidad: true },
  });
  res.json(torneos);
});

router.get("/todos", requireAdmin, async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    where: { borradoEn: null },
    orderBy: { fechaInicio: "desc" },
    include: includeCompleto,
  });
  res.json(torneos);
});

// GET /api/torneos-club/papelera - torneos borrados en los últimos 7 días,
// con los días que quedan antes de que el cron nocturno los purgue de
// verdad (ver src/lib/limpiarPapelera.js). Solo admin.
router.get("/papelera", requireAdmin, async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    where: { borradoEn: { not: null } },
    orderBy: { borradoEn: "desc" },
    include: includeCompleto,
  });
  res.json(torneos.map((t) => ({ ...t, diasRestantes: diasRestantesPapelera(t.borradoEn) })));
});

// GET /api/torneos-club/:id - un torneo público concreto, con todo su detalle (para la página del torneo)
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const torneo = await prisma.torneoClub.findUnique({ where: { id }, include: includeCompleto });
  if (!torneo || torneo.borradoEn) {
    return res.status(404).json({ error: "Torneo no encontrado" });
  }
  res.json(torneo);
});

router.post("/", requireAdmin, async (req, res) => {
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, numeroMaquinas, tipoEliminacion, modalidad, afectaCalendario } = req.body;
  if (!nombre || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  const modalidadesValidas = ["individual", "parejas_hechas", "parejas_ciegas"];
  const torneo = await prisma.torneoClub.create({
    data: {
      nombre,
      descripcion: descripcion || null,
      fechaInicio: new Date(fechaInicio),
      fechaFin: new Date(fechaFin),
      insigniaUrl: insigniaUrl || null,
      visibilidad: visibilidad === "publico" ? "publico" : "privado",
      numeroMaquinas: numeroMaquinas ? Number(numeroMaquinas) : null,
      tipoEliminacion: tipoEliminacion === "doble" ? "doble" : "directa",
      modalidad: modalidadesValidas.includes(modalidad) ? modalidad : "individual",
      afectaCalendario: afectaCalendario !== undefined ? !!afectaCalendario : true,
    },
  });
  res.status(201).json(torneo);
});

router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, numeroMaquinas, tipoEliminacion, finalizado } = req.body;
  try {
    const torneo = await prisma.torneoClub.update({
      where: { id },
      data: {
        nombre,
        descripcion: descripcion || null,
        fechaInicio: fechaInicio ? new Date(fechaInicio) : undefined,
        fechaFin: fechaFin ? new Date(fechaFin) : undefined,
        insigniaUrl: insigniaUrl || null,
        visibilidad: visibilidad === "publico" ? "publico" : "privado",
        numeroMaquinas: numeroMaquinas !== undefined ? (numeroMaquinas ? Number(numeroMaquinas) : null) : undefined,
        tipoEliminacion: tipoEliminacion || undefined,
        finalizado: finalizado !== undefined ? !!finalizado : undefined,
      },
    });
    res.json(torneo);
  } catch {
    res.status(404).json({ error: "Torneo no encontrado" });
  }
});

// Borra definitivamente un torneo del club y todo lo que cuelga de él
// (cuadrantes, cuadro de partidos, participantes). La usan tanto el borrado
// definitivo a mano (DELETE /:id/definitivo) como el cron nocturno que
// purga la papelera pasados los 7 días (ver src/lib/limpiarPapelera.js).
export async function purgarTorneo(id) {
  const cuadrantes = await prisma.cuadrante.findMany({ where: { torneoClubId: id }, select: { id: true } });
  const cuadranteIds = cuadrantes.map((c) => c.id);
  await prisma.cuadroPartido.deleteMany({ where: { cuadranteId: { in: cuadranteIds } } });
  await prisma.participanteCuadrante.deleteMany({ where: { cuadranteId: { in: cuadranteIds } } });
  await prisma.cuadrante.deleteMany({ where: { torneoClubId: id } });
  await prisma.torneoClub.delete({ where: { id } });
}

// DELETE /api/torneos-club/:id - envía el torneo a la papelera (borrado
// suave, marca `borradoEn`): desaparece de todos los listados normales y del
// historial de los jugadores, pero se puede restaurar hasta 7 días desde
// GET /papelera. Si nadie lo restaura, el cron nocturno lo purga de verdad.
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.torneoClub.update({ where: { id: req.params.id }, data: { borradoEn: new Date() } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Torneo no encontrado" });
    console.error("Error moviendo torneo a la papelera:", err);
    res.status(500).json({ error: "No se pudo borrar el torneo." });
  }
});

// POST /api/torneos-club/:id/restaurar - saca un torneo de la papelera
router.post("/:id/restaurar", requireAdmin, async (req, res) => {
  try {
    const torneo = await prisma.torneoClub.update({ where: { id: req.params.id }, data: { borradoEn: null } });
    res.json(torneo);
  } catch {
    res.status(404).json({ error: "Torneo no encontrado" });
  }
});

// DELETE /api/torneos-club/:id/definitivo - borra ya, sin esperar a que
// pasen los 7 días de la papelera (mismo borrado en cascada que antes hacía
// DELETE /:id directamente).
router.delete("/:id/definitivo", requireAdmin, async (req, res) => {
  await purgarTorneo(req.params.id);
  res.status(204).end();
});

router.post("/:id/cuadrantes", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, tamano, tipoEliminacion, metodoSorteoParejas } = req.body;
  const tamanoNum = Number(tamano);
  const tamanosValidos = [4, 8, 16, 32, 64, 128];
  if (!nombre || !tamanosValidos.includes(tamanoNum)) {
    return res.status(400).json({ error: "Falta el nombre o el tamaño no es válido (4, 8, 16, 32, 64 o 128)" });
  }
  const tipo = tipoEliminacion === "doble" ? "doble" : "directa";
  const metodosValidos = ["AB", "ABC", "ABCD"];

  const cuadrante = await prisma.cuadrante.create({
    data: {
      torneoClubId: id,
      nombre,
      tamano: tamanoNum,
      tipoEliminacion: tipo,
      metodoSorteoParejas: metodosValidos.includes(metodoSorteoParejas) ? metodoSorteoParejas : null,
    },
  });

  const partidos = generarPartidos(tamanoNum, tipo);
  await prisma.cuadroPartido.createMany({
    data: partidos.map((p) => ({ ...p, cuadranteId: cuadrante.id })),
  });

  const cuadranteCompleto = await prisma.cuadrante.findUnique({
    where: { id: cuadrante.id },
    include: { partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] } },
  });
  res.status(201).json(cuadranteCompleto);
});

// Calcula, para un cuadro de `tamano` posiciones, en qué posición (0-indexada) debe
// ir cada cabeza de serie (1ª, 2ª, 3ª...) para que no se crucen hasta fases avanzadas.
// Es el reparto clásico de un cuadro de torneo (1 vs último, 2 vs penúltimo, etc.).
function ordenSemillas(tamano) {
  let orden = [1, 2];
  while (orden.length < tamano) {
    const total = orden.length * 2;
    const siguiente = [];
    for (const s of orden) {
      siguiente.push(s);
      siguiente.push(total + 1 - s);
    }
    orden = siguiente;
  }
  return orden; // orden[posicion] = número de cabeza de serie que va en esa posición
}

// POST /api/torneos-club/cuadrantes/:cuadranteId/participantes - añade un
// participante (individual o pareja ya formada) a un cuadrante, antes del
// sorteo (protegido).
router.post("/cuadrantes/:cuadranteId/participantes", requireAdmin, async (req, res) => {
  const { cuadranteId } = req.params;
  const { jugador1Id, nombre1, jugador2Id, nombre2, nombre } = req.body;

  async function resolverLado(id, nombreLibre) {
    if (id) {
      const j = await prisma.jugador.findUnique({ where: { id } });
      if (!j) return { error: true };
      // Si el jugador tiene alias puesto en su perfil, se usa ese en vez del
      // nombre real para la etiqueta del participante.
      return { id: j.id, nombre: j.apodo || j.nombre };
    }
    if (nombreLibre && nombreLibre.trim()) {
      return { id: null, nombre: nombreLibre.trim() };
    }
    return null;
  }

  const lado1 = await resolverLado(jugador1Id, nombre1 || nombre);
  if (!lado1) return res.status(400).json({ error: "Falta el primer participante" });
  if (lado1.error) return res.status(404).json({ error: "Jugador no encontrado" });

  const lado2 = jugador2Id || nombre2 ? await resolverLado(jugador2Id, nombre2) : null;
  if (lado2?.error) return res.status(404).json({ error: "El segundo jugador no existe" });

  const etiqueta = lado2 ? `${lado1.nombre} / ${lado2.nombre}` : lado1.nombre;

  try {
    const participante = await prisma.participanteCuadrante.create({
      data: { cuadranteId, etiqueta, jugador1Id: lado1.id, jugador2Id: lado2?.id || null },
    });
    return res.status(201).json(participante);
  } catch {
    return res.status(409).json({ error: "Ya hay un participante con esa etiqueta en este cuadrante" });
  }
});

// GET /api/torneos-club/cuadrantes/:cuadranteId/participantes - lista los
// participantes apuntados a un cuadrante, antes del sorteo (protegido)
router.get("/cuadrantes/:cuadranteId/participantes", requireAdmin, async (req, res) => {
  const { cuadranteId } = req.params;
  const participantes = await prisma.participanteCuadrante.findMany({
    where: { cuadranteId },
    include: { jugador1: true, jugador2: true },
    orderBy: { creadoEn: "asc" },
  });
  res.json(participantes);
});

// DELETE /api/torneos-club/participantes/:id - quita un participante antes
// del sorteo (protegido)
router.delete("/participantes/:id", requireAdmin, async (req, res) => {
  await prisma.participanteCuadrante.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// POST /api/torneos-club/cuadrantes/:cuadranteId/sortear-parejas - reparte al
// azar una lista de jugadores individuales en parejas ("parejas ciegas"),
// creando un participante por cada pareja resultante (protegido)
router.post("/cuadrantes/:cuadranteId/sortear-parejas", requireAdmin, async (req, res) => {
  const { cuadranteId } = req.params;
  const { jugadorIds } = req.body;
  const ids = Array.isArray(jugadorIds) ? [...new Set(jugadorIds)] : [];

  if (ids.length < 2) {
    return res.status(400).json({ error: "Hacen falta al menos 2 jugadores." });
  }
  if (ids.length % 2 !== 0) {
    return res.status(400).json({ error: "El número de jugadores debe ser par para hacer parejas." });
  }

  const jugadores = await prisma.jugador.findMany({ where: { id: { in: ids } } });
  if (jugadores.length !== ids.length) {
    return res.status(404).json({ error: "Algún jugador indicado no existe." });
  }

  const barajados = [...jugadores];
  for (let i = barajados.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [barajados[i], barajados[j]] = [barajados[j], barajados[i]];
  }

  const creados = [];
  for (let i = 0; i < barajados.length; i += 2) {
    const a = barajados[i];
    const b = barajados[i + 1];
    const etiqueta = `${a.nombre} / ${b.nombre}`;
    const participante = await prisma.participanteCuadrante.create({
      data: { cuadranteId, etiqueta, jugador1Id: a.id, jugador2Id: b.id },
    });
    creados.push(participante);
  }

  res.status(201).json(creados);
});

// POST /api/torneos-club/cuadrantes/:cuadranteId/sortear-parejas-grupos - reparte
// en parejas según el método de nivelación del cuadrante (AB, ABC o ABCD),
// cruzando a los mejores con los peores para igualar el nivel (protegido)
router.post("/cuadrantes/:cuadranteId/sortear-parejas-grupos", requireAdmin, async (req, res) => {
  const { cuadranteId } = req.params;
  const cuadrante = await prisma.cuadrante.findUnique({ where: { id: cuadranteId } });
  if (!cuadrante) return res.status(404).json({ error: "Cuadrante no encontrado" });

  const metodo = cuadrante.metodoSorteoParejas;
  if (!metodo) {
    return res.status(400).json({ error: "Este cuadrante no tiene definido un método de sorteo de parejas." });
  }

  const { entradas } = req.body;
  if (!Array.isArray(entradas) || entradas.length === 0) {
    return res.status(400).json({ error: "No hay participantes para sortear." });
  }

  let parejas;
  try {
    parejas = sortearParejasPorGrupos(entradas, metodo);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const nombresPorId = await resolverNombresJugadores(prisma, entradas);
  const creadas = [];
  for (const [e1, e2] of parejas) {
    const nombre1 = e1.jugadorId ? nombresPorId.get(e1.jugadorId) : e1.nombre;
    const nombre2 = e2.jugadorId ? nombresPorId.get(e2.jugadorId) : e2.nombre;
    const etiqueta = `${nombre1} / ${nombre2}`;
    const participante = await prisma.participanteCuadrante.create({
      data: { cuadranteId, etiqueta, jugador1Id: e1.jugadorId || null, jugador2Id: e2.jugadorId || null },
    });
    creadas.push(participante);
  }

  res.status(201).json(creadas);
});

// Aplica un reparto ya calculado de la ronda 1 (array `posiciones`, longitud
// = tamaño del cuadrante, con el nombre en cada hueco o `null` para un
// "bye") a un cuadrante ya creado: limpia cualquier sorteo anterior, coloca
// nombres, resuelve los "bye" (avance automático a la ronda siguiente,
// incluida la cascada al cuadro de perdedores si es doble eliminación) y
// devuelve el cuadrante completo. Se extrae de lo que antes era el cuerpo
// de /cuadrantes/:cuadranteId/sorteo para poder reutilizarlo tal cual desde
// el cuadrante final por grupos de las ligas del club (ligasClub.js), que
// calcula sus propias `posiciones` (cruce entre grupos) en vez de dejar que
// el sorteo genérico las reparta al azar.
export async function aplicarPosicionesRonda1(cuadranteId, posiciones) {
  await prisma.cuadroPartido.updateMany({
    where: { cuadranteId },
    data: { jugador1: null, jugador2: null, ganador: null, resultado: null, enCurso: false },
  });

  const ronda1 = await prisma.cuadroPartido.findMany({
    where: { cuadranteId, rama: "ganadores", ronda: 1 },
    orderBy: { posicion: "asc" },
  });

  for (let i = 0; i < ronda1.length; i++) {
    const partido = ronda1[i];
    const jugador1 = posiciones[i * 2];
    const jugador2 = posiciones[i * 2 + 1];
    if (jugador1 && !jugador2) {
      await prisma.cuadroPartido.update({
        where: { id: partido.id },
        data: { jugador1, jugador2: null, ganador: jugador1 },
      });
      if (partido.siguientePartidoGanadorId) {
        const campo = partido.siguienteSlotGanador === 2 ? "jugador2" : "jugador1";
        await prisma.cuadroPartido.update({
          where: { id: partido.siguientePartidoGanadorId },
          data: { [campo]: jugador1 },
        });
      }
      if (partido.siguientePartidoPerdedorId) {
        await intentarResolverBye(partido.siguientePartidoPerdedorId);
      }
    } else if (!jugador1 && jugador2) {
      await prisma.cuadroPartido.update({
        where: { id: partido.id },
        data: { jugador1: jugador2, jugador2: null, ganador: jugador2 },
      });
      if (partido.siguientePartidoGanadorId) {
        const campo = partido.siguienteSlotGanador === 2 ? "jugador2" : "jugador1";
        await prisma.cuadroPartido.update({
          where: { id: partido.siguientePartidoGanadorId },
          data: { [campo]: jugador2 },
        });
      }
      if (partido.siguientePartidoPerdedorId) {
        await intentarResolverBye(partido.siguientePartidoPerdedorId);
      }
    } else {
      await prisma.cuadroPartido.update({
        where: { id: partido.id },
        data: {
          jugador1,
          jugador2,
          resultado: !jugador1 && !jugador2 ? "__BYE_DOBLE__" : undefined,
        },
      });
    }
  }

  return prisma.cuadrante.findUnique({
    where: { id: cuadranteId },
    include: { partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] } },
  });
}

// POST /api/torneos-club/cuadrantes/:cuadranteId/sorteo - reparte la lista de
// participantes en los enfrentamientos de la ronda 1 del cuadro de ganadores
// (protegido). Las "cabezasDeSerie" (si se indican, en orden del mejor al peor) se
// colocan en posiciones fijas para no cruzarse pronto; el resto se sortea al azar. Si
// hay menos participantes que el tamaño del cuadrante, el resto de posiciones quedan
// como "bye" (pase directo a la ronda 2), repartidas al azar entre los no sembrados.
router.post("/cuadrantes/:cuadranteId/sorteo", requireAdmin, async (req, res) => {
  const { cuadranteId } = req.params;
  const { participantes, cabezasDeSerie } = req.body;

  let nombres = Array.isArray(participantes) ? participantes.map((n) => String(n).trim()).filter(Boolean) : [];

  // Si no se pasan nombres sueltos, se usan los participantes ya apuntados
  // (individuales o parejas) a este cuadrante.
  if (nombres.length === 0) {
    const apuntados = await prisma.participanteCuadrante.findMany({ where: { cuadranteId } });
    nombres = apuntados.map((p) => p.etiqueta);
  }
  const semillas = Array.isArray(cabezasDeSerie) ? cabezasDeSerie.map((n) => String(n).trim()).filter(Boolean) : [];

  const cuadrante = await prisma.cuadrante.findUnique({ where: { id: cuadranteId } });
  if (!cuadrante) return res.status(404).json({ error: "Cuadrante no encontrado" });

  const numPartidosR1 = cuadrante.tamano / 2;

  if (nombres.length < 2) {
    return res.status(400).json({ error: "Hacen falta al menos 2 participantes." });
  }
  if (nombres.length > cuadrante.tamano) {
    return res.status(400).json({
      error: `Este cuadrante es de ${cuadrante.tamano} participantes como máximo, y se han recibido ${nombres.length}.`,
    });
  }
  const byes = cuadrante.tamano - nombres.length;
  if (byes > numPartidosR1) {
    return res.status(400).json({
      error: `Con ${nombres.length} participantes hacen falta demasiados pases directos para un cuadrante de ${cuadrante.tamano}. Elige un tamaño de cuadrante menor.`,
    });
  }
  const semillasValidas = semillas.filter((s) => nombres.includes(s));
  if (semillasValidas.length > cuadrante.tamano) {
    return res.status(400).json({ error: "Hay más cabezas de serie que huecos en el cuadrante." });
  }

  const noSembrados = nombres.filter((n) => !semillasValidas.includes(n));
  // Barajado (Fisher-Yates) de los no sembrados
  for (let i = noSembrados.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [noSembrados[i], noSembrados[j]] = [noSembrados[j], noSembrados[i]];
  }

  // Posiciones (0-indexadas) del cuadro, tamaño = cuadrante.tamano. Las cabezas de
  // serie ocupan posiciones fijas; el resto (participantes + huecos "bye") se reparte
  // al azar en las posiciones restantes.
  const orden = ordenSemillas(cuadrante.tamano);
  const posiciones = new Array(cuadrante.tamano).fill(null);
  semillasValidas.forEach((nombre, i) => {
    const pos = orden.indexOf(i + 1);
    posiciones[pos] = nombre;
  });

  const pool = [...noSembrados, ...Array(byes).fill(null)];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let cursorPool = 0;
  for (let i = 0; i < posiciones.length; i++) {
    if (posiciones[i] === null) posiciones[i] = pool[cursorPool++];
  }

  // Ningún enfrentamiento puede tener dos "bye" a la vez: si ocurre, se intercambia
  // con un participante real de otro enfrentamiento que no sea cabeza de serie.
  for (let m = 0; m < numPartidosR1; m++) {
    const a = m * 2, b = m * 2 + 1;
    if (posiciones[a] === null && posiciones[b] === null) {
      for (let m2 = 0; m2 < numPartidosR1; m2++) {
        const c = m2 * 2, d = m2 * 2 + 1;
        if (posiciones[c] !== null && posiciones[d] !== null && !semillasValidas.includes(posiciones[c])) {
          [posiciones[a], posiciones[c]] = [posiciones[c], posiciones[a]];
          break;
        } else if (posiciones[c] !== null && posiciones[d] !== null && !semillasValidas.includes(posiciones[d])) {
          [posiciones[a], posiciones[d]] = [posiciones[d], posiciones[a]];
          break;
        }
      }
    }
  }

  // Se limpia todo el cuadrante (nombres, ganadores, resultados) antes de aplicar el
  // sorteo nuevo, para no dejar datos de un sorteo anterior a medias.
  const cuadranteCompleto = await aplicarPosicionesRonda1(cuadranteId, posiciones);
  res.json(cuadranteCompleto);
});

// POST /api/torneos-club/cuadrantes/:cuadranteId/reiniciar - vacía ganadores,
// resultados y "en curso" de todo el cuadrante, sin volver a sortear: la ronda 1
// mantiene el reparto de participantes (y los "bye" que hubiera), pero las rondas
// siguientes quedan vacías otra vez, listas para jugarse desde cero (protegido).
router.post("/cuadrantes/:cuadranteId/reiniciar", requireAdmin, async (req, res) => {
  const { cuadranteId } = req.params;
  const cuadrante = await prisma.cuadrante.findUnique({ where: { id: cuadranteId } });
  if (!cuadrante) return res.status(404).json({ error: "Cuadrante no encontrado" });

  const ronda1 = await prisma.cuadroPartido.findMany({ where: { cuadranteId, rama: "ganadores", ronda: 1 } });
  const bye = ronda1.filter((p) => p.jugador1 && !p.jugador2);

  // Limpia ganador/resultado/en curso en todo, salvo los "bye" de la ronda 1 (su
  // pase automático se mantiene).
  await prisma.cuadroPartido.updateMany({
    where: { cuadranteId, id: { notIn: bye.map((p) => p.id) } },
    data: { ganador: null, resultado: null, enCurso: false },
  });
  // Vacía los nombres en todo lo que no sea la ronda 1 del cuadro de ganadores
  // (esos nombres se rellenaban solos al avanzar, así que hay que borrarlos).
  await prisma.cuadroPartido.updateMany({
    where: { cuadranteId, NOT: { rama: "ganadores", ronda: 1 } },
    data: { jugador1: null, jugador2: null },
  });

  // Los "bye" de la ronda 1 tienen que volver a avanzar hacia la ronda siguiente,
  // porque el paso anterior también ha vaciado ese nombre allí.
  for (const partido of bye) {
    if (partido.siguientePartidoGanadorId) {
      const campo = partido.siguienteSlotGanador === 2 ? "jugador2" : "jugador1";
      await prisma.cuadroPartido.update({
        where: { id: partido.siguientePartidoGanadorId },
        data: { [campo]: partido.jugador1 },
      });
    }
    if (partido.siguientePartidoPerdedorId) {
      await intentarResolverBye(partido.siguientePartidoPerdedorId);
    }
  }

  const cuadranteCompleto = await prisma.cuadrante.findUnique({
    where: { id: cuadranteId },
    include: { partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] } },
  });
  res.json(cuadranteCompleto);
});

router.delete("/cuadrantes/:cuadranteId", requireAdmin, async (req, res) => {
  const { cuadranteId } = req.params;
  await prisma.cuadroPartido.deleteMany({ where: { cuadranteId } });
  await prisma.participanteCuadrante.deleteMany({ where: { cuadranteId } });
  await prisma.cuadrante.delete({ where: { id: cuadranteId } });
  res.status(204).end();
});

// Avisa (Web Push y/o Telegram) a los jugadores del club implicados en un
// enfrentamiento de cuadrante. notificarJugadores() no distingue entre
// socios e invitados: manda Web Push a quien lo tenga activado en "Mi
// perfil" (solo socios, ahí necesitan cuenta) y Telegram a quien haya hecho
// el check-in del bot (socios o invitados, indistintamente — ver
// routes/telegram.js). Lo único que de verdad hace falta es que el
// participante esté enlazado a un jugadorId real: los nombres sueltos
// escritos a mano en el sorteo (sin seleccionar a nadie del desplegable de
// "Jugadores del club") no tienen jugadorId y por tanto no hay a quién
// avisar — no es un error, es que no hay ninguna cuenta ni chat de
// Telegram que relacionar con ese nombre. Mismo patrón que el aviso al
// fijar partido de competiciones externas (ver
// routes/competicionesExternas.js), adaptado aquí porque los participantes
// de un cuadrante se identifican por etiqueta (nombre o "Fulano / Mengano"),
// no por un EquipoJugador con jugadorId directo.
async function notificarPartidoDeCuadrante(partido, motivo = "programado") {
  const etiquetas = [partido.jugador1, partido.jugador2].filter(Boolean);
  if (etiquetas.length === 0) return;

  const [participantes, cuadrante] = await Promise.all([
    prisma.participanteCuadrante.findMany({
      where: { cuadranteId: partido.cuadranteId, etiqueta: { in: etiquetas } },
    }),
    prisma.cuadrante.findUnique({ where: { id: partido.cuadranteId }, include: { torneoClub: true, liga: true } }),
  ]);
  const jugadorIds = participantes.flatMap((p) => [p.jugador1Id, p.jugador2Id]).filter(Boolean);
  if (jugadorIds.length === 0) return;

  const nombreCompeticion = cuadrante?.torneoClub?.nombre || cuadrante?.liga?.nombre || "Torneo del club";
  const enfrentamiento = `${partido.jugador1 || "?"} vs ${partido.jugador2 || "?"}`;

  if (motivo === "en_curso") {
    await notificarJugadores(jugadorIds, {
      titulo: `¡Tu partido empieza ahora! ${nombreCompeticion}`,
      cuerpo: `${enfrentamiento}${partido.maquina ? ` en ${partido.maquina}` : ""}.`,
    });
    return;
  }

  const fechaTexto = partido.fechaCalendario
    ? new Date(partido.fechaCalendario).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" })
    : null;
  await notificarJugadores(jugadorIds, {
    titulo: `Partido programado: ${nombreCompeticion}`,
    cuerpo: `${enfrentamiento}${fechaTexto ? ` el ${fechaTexto}` : ""}${
      partido.maquinaCalendario ? ` en ${partido.maquinaCalendario.nombre}` : ""
    }.`,
  });
}

// PUT /api/torneos-club/partidos/:partidoId/calendario - programa (o desprograma)
// un enfrentamiento del cuadro en el calendario general, con fecha y máquina
router.put("/partidos/:partidoId/calendario", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { fecha, maquinaId, confirmado } = req.body;
  const antes = await prisma.cuadroPartido.findUnique({ where: { id: partidoId } });
  if (!antes) return res.status(404).json({ error: "Enfrentamiento no encontrado" });
  try {
    const partido = await prisma.cuadroPartido.update({
      where: { id: partidoId },
      data: {
        fechaCalendario: fecha !== undefined ? (fecha ? new Date(fecha) : null) : undefined,
        maquinaCalendarioId: maquinaId !== undefined ? (maquinaId || null) : undefined,
        confirmadoCalendario: confirmado !== undefined ? !!confirmado : undefined,
      },
      include: { maquinaCalendario: true },
    });

    // Solo se avisa al pasar de no confirmado a confirmado (no en cada
    // edición posterior de fecha/máquina de un partido ya confirmado). No
    // bloquea la respuesta al admin si el envío falla.
    if (!antes.confirmadoCalendario && partido.confirmadoCalendario) {
      notificarPartidoDeCuadrante(partido).catch((err) =>
        console.error("Error notificando partido de cuadrante:", err.message || err)
      );
    }

    res.json(partido);
  } catch {
    res.status(404).json({ error: "Enfrentamiento no encontrado" });
  }
});

router.put("/partidos/:partidoId", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { maquina, jugador1, jugador2, resultado, ganador, enCurso } = req.body;

  const actual = await prisma.cuadroPartido.findUnique({ where: { id: partidoId } });
  if (!actual) return res.status(404).json({ error: "Enfrentamiento no encontrado" });

  if (enCurso) {
    const maquinaFinal = maquina !== undefined ? maquina : actual.maquina;
    if (maquinaFinal) {
      const cuadrante = await prisma.cuadrante.findUnique({ where: { id: actual.cuadranteId } });
      const hermanos = await prisma.cuadroPartido.findMany({
        where: { cuadrante: { torneoClubId: cuadrante.torneoClubId }, maquina: maquinaFinal },
      });
      await prisma.cuadroPartido.updateMany({
        where: { id: { in: hermanos.map((h) => h.id) } },
        data: { enCurso: false },
      });
    }
  }

  const partido = await prisma.cuadroPartido.update({
    where: { id: partidoId },
    data: {
      maquina: maquina !== undefined ? maquina || null : undefined,
      jugador1: jugador1 !== undefined ? jugador1 || null : undefined,
      jugador2: jugador2 !== undefined ? jugador2 || null : undefined,
      resultado: resultado !== undefined ? resultado || null : undefined,
      ganador: ganador !== undefined ? ganador || null : undefined,
      enCurso: enCurso !== undefined ? !!enCurso : undefined,
    },
  });

  // Aviso a los jugadores del club implicados (si son socios con cuenta) al
  // marcar el partido "en curso" — es el momento en el que de verdad
  // interesa avisar ("tu partido empieza ahora"), no solo al fijarlo en el
  // calendario con antelación. Solo en la transición false -> true, no en
  // cada edición posterior.
  if (!actual.enCurso && partido.enCurso) {
    notificarPartidoDeCuadrante(partido, "en_curso").catch((err) =>
      console.error("Error notificando partido en curso:", err.message || err)
    );
  }

  if (ganador !== undefined && ganador) {
    const jug1 = jugador1 !== undefined ? jugador1 : actual.jugador1;
    const jug2 = jugador2 !== undefined ? jugador2 : actual.jugador2;
    const perdedor = ganador === jug1 ? jug2 : jug1;

    if (partido.siguientePartidoGanadorId) {
      const campo = partido.siguienteSlotGanador === 2 ? "jugador2" : "jugador1";
      await prisma.cuadroPartido.update({
        where: { id: partido.siguientePartidoGanadorId },
        data: { [campo]: ganador },
      });
      // En el cuadro de perdedores es habitual que el otro hueco de este partido
      // nunca vaya a rellenarse (su origen era, a su vez, un "bye" sin enfrentamiento
      // real). Hay que comprobar aquí si con este ganador ya se puede resolver un
      // pase automático (o incluso un "bye doble" en cascada); en el cuadro de
      // ganadores esto normalmente ya estaba resuelto desde el sorteo, pero no cuesta
      // nada comprobarlo también.
      await intentarResolverBye(partido.siguientePartidoGanadorId);
    }
    if (partido.siguientePartidoPerdedorId && perdedor) {
      const campo = partido.siguienteSlotPerdedor === 2 ? "jugador2" : "jugador1";
      await prisma.cuadroPartido.update({
        where: { id: partido.siguientePartidoPerdedorId },
        data: { [campo]: perdedor },
      });
      await intentarResolverBye(partido.siguientePartidoPerdedorId);
    }

    // Gran final (doble eliminación): si gana el jugador que venía del cuadro de
    // perdedores (jugador2), ambos quedan con una derrota y hace falta un segundo
    // partido decisivo. Si en cambio gana el que venía de ganadores, el torneo
    // termina ahí y se quita el partido decisivo si se había creado por error.
    if (partido.rama === "final" && partido.posicion === 0) {
      if (ganador === jug2) {
        const existeDesempate = await prisma.cuadroPartido.findFirst({
          where: { cuadranteId: partido.cuadranteId, rama: "final", posicion: 1 },
        });
        if (!existeDesempate) {
          await prisma.cuadroPartido.create({
            data: {
              cuadranteId: partido.cuadranteId,
              rama: "final",
              ronda: partido.ronda + 1,
              posicion: 1,
              jugador1: jug1,
              jugador2: jug2,
            },
          });
        }
      } else {
        await prisma.cuadroPartido.deleteMany({
          where: { cuadranteId: partido.cuadranteId, rama: "final", posicion: 1 },
        });
      }
    }
  }

  res.json(partido);
});

export default router;
