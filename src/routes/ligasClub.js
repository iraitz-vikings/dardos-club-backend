import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { generarPartidos } from "./torneosClub.js";
import { requireAuth } from "./auth.js";
import { sortearParejasPorGrupos, resolverNombresJugadores } from "../lib/sorteoParejasGrupos.js";

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
  participantes: { include: { jugador1: true, jugador2: true }, orderBy: { creadoEn: "asc" } },
  partidos: { orderBy: [{ jornada: "asc" }, { posicion: "asc" }] },
  cuadrantes: {
    orderBy: { creadoEn: "asc" },
    include: {
      partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] },
      participantes: { include: { jugador1: true, jugador2: true } },
    },
  },
};

router.get("/", async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { visibilidad: "publico" },
    orderBy: { fechaInicio: "desc" },
    include: includeCompleto,
  });
  res.json(ligas);
});

// GET /api/ligas-club/privados - ligas privadas ya finalizadas, para el
// histórico dentro del portal de socios
router.get("/privados", requireAuth, async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { visibilidad: "privado", finalizado: true },
    orderBy: { fechaInicio: "desc" },
    select: { id: true, nombre: true, fechaInicio: true, fechaFin: true },
  });
  res.json(ligas);
});

// GET /api/ligas-club/activos - ligas aún no finalizadas, para "Competiciones"
router.get("/activos", requireAuth, async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { finalizado: false },
    orderBy: { fechaInicio: "desc" },
    select: { id: true, nombre: true, fechaInicio: true, fechaFin: true, modalidad: true },
  });
  res.json(ligas);
});

router.get("/todos", requireAdmin, async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({ orderBy: { fechaInicio: "desc" }, include: includeCompleto });
  res.json(ligas);
});

router.get("/:id", async (req, res) => {
  const liga = await prisma.ligaClub.findUnique({ where: { id: req.params.id }, include: includeCompleto });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });
  res.json(liga);
});

router.post("/", requireAdmin, async (req, res) => {
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, modalidad, vueltas, numeroParticipantes, metodoSorteoParejas, afectaCalendario } = req.body;
  if (!nombre || !fechaInicio || !fechaFin || !numeroParticipantes) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  const modalidadesValidas = ["individual", "parejas_hechas", "parejas_ciegas"];
  const metodosValidos = ["AB", "ABC", "ABCD"];
  const liga = await prisma.ligaClub.create({
    data: {
      nombre,
      descripcion: descripcion || null,
      fechaInicio: new Date(fechaInicio),
      fechaFin: new Date(fechaFin),
      insigniaUrl: insigniaUrl || null,
      visibilidad: visibilidad === "publico" ? "publico" : "privado",
      modalidad: modalidadesValidas.includes(modalidad) ? modalidad : "individual",
      vueltas: Number(vueltas) === 2 ? 2 : 1,
      numeroParticipantes: Number(numeroParticipantes),
      metodoSorteoParejas: metodosValidos.includes(metodoSorteoParejas) ? metodoSorteoParejas : null,
      afectaCalendario: afectaCalendario !== undefined ? !!afectaCalendario : true,
    },
  });
  res.status(201).json(liga);
});

router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, finalizado } = req.body;
  try {
    const liga = await prisma.ligaClub.update({
      where: { id },
      data: {
        nombre,
        descripcion: descripcion || null,
        fechaInicio: fechaInicio ? new Date(fechaInicio) : undefined,
        fechaFin: fechaFin ? new Date(fechaFin) : undefined,
        insigniaUrl: insigniaUrl || null,
        visibilidad: visibilidad === "publico" ? "publico" : "privado",
        finalizado: finalizado !== undefined ? !!finalizado : undefined,
      },
    });
    res.json(liga);
  } catch {
    res.status(404).json({ error: "Liga no encontrada" });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await prisma.partidoLiga.deleteMany({ where: { ligaId: id } });
  await prisma.participanteLiga.deleteMany({ where: { ligaId: id } });
  await prisma.ligaClub.delete({ where: { id } });
  res.status(204).end();
});

// ---- Participantes (mismo patrón que en torneos del club) ----

router.post("/:ligaId/participantes", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const { jugador1Id, nombre1, jugador2Id, nombre2, nombre } = req.body;

  async function resolverLado(id, nombreLibre) {
    if (id) {
      const j = await prisma.jugador.findUnique({ where: { id } });
      if (!j) return { error: true };
      return { id: j.id, nombre: j.nombre };
    }
    if (nombreLibre && nombreLibre.trim()) {
      return { id: null, nombre: nombreLibre.trim() };
    }
    return null;
  }

  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });

  const lado1 = await resolverLado(jugador1Id, nombre1 || nombre);
  if (!lado1) return res.status(400).json({ error: "Falta el primer participante" });
  if (lado1.error) return res.status(404).json({ error: "Jugador no encontrado" });

  const lado2 = jugador2Id || nombre2 ? await resolverLado(jugador2Id, nombre2) : null;
  if (lado2?.error) return res.status(404).json({ error: "El segundo jugador no existe" });

  const actuales = await prisma.participanteLiga.count({ where: { ligaId } });
  if (actuales >= liga.numeroParticipantes) {
    return res.status(400).json({ error: `Esta liga es de ${liga.numeroParticipantes} participantes como máximo.` });
  }

  const etiqueta = lado2 ? `${lado1.nombre} / ${lado2.nombre}` : lado1.nombre;

  try {
    const participante = await prisma.participanteLiga.create({
      data: { ligaId, etiqueta, jugador1Id: lado1.id, jugador2Id: lado2?.id || null },
    });
    res.status(201).json(participante);
  } catch {
    res.status(409).json({ error: "Ya hay un participante con esa etiqueta en esta liga" });
  }
});

router.delete("/participantes/:id", requireAdmin, async (req, res) => {
  await prisma.participanteLiga.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

router.post("/:ligaId/sortear-parejas-grupos", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });

  const metodo = liga.metodoSorteoParejas;
  if (!metodo) return res.status(400).json({ error: "Esta liga no tiene definido un método de sorteo de parejas." });

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
    const participante = await prisma.participanteLiga.create({
      data: { ligaId, etiqueta, jugador1Id: e1.jugadorId || null, jugador2Id: e2.jugadorId || null },
    });
    creadas.push(participante);
  }

  res.status(201).json(creadas);
});

// ---- Calendario (método del círculo: todos contra todos) ----

router.post("/:ligaId/generar-calendario", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId }, include: { participantes: true } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });

  const etiquetas = liga.participantes.map((p) => p.etiqueta);
  if (etiquetas.length < 2) return res.status(400).json({ error: "Hacen falta al menos 2 participantes." });
  if (etiquetas.length !== liga.numeroParticipantes) {
    return res.status(400).json({
      error: `Esta liga está pensada para ${liga.numeroParticipantes} participantes; ahora mismo hay ${etiquetas.length} apuntados.`,
    });
  }

  await prisma.partidoLiga.deleteMany({ where: { ligaId } });

  let lista = [...etiquetas];
  if (lista.length % 2 !== 0) lista.push(null); // hueco de descanso si son impares
  const n = lista.length;
  const mitad = n / 2;

  let arr = [...lista];
  const jornadas = [];
  for (let j = 0; j < n - 1; j++) {
    const partidos = [];
    for (let i = 0; i < mitad; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== null && b !== null) partidos.push([a, b]);
    }
    jornadas.push(partidos);
    const fijo = arr[0];
    const resto = arr.slice(1);
    resto.unshift(resto.pop());
    arr = [fijo, ...resto];
  }

  let todasJornadas = jornadas;
  if (liga.vueltas === 2) {
    const vueltaDos = jornadas.map((j) => j.map(([a, b]) => [b, a]));
    todasJornadas = [...jornadas, ...vueltaDos];
  }

  const datos = [];
  todasJornadas.forEach((partidos, jIdx) => {
    partidos.forEach(([a, b], pIdx) => {
      datos.push({ ligaId, jornada: jIdx + 1, posicion: pIdx, participante1: a, participante2: b });
    });
  });
  await prisma.partidoLiga.createMany({ data: datos });

  const ligaCompleta = await prisma.ligaClub.findUnique({ where: { id: ligaId }, include: includeCompleto });
  res.json(ligaCompleta);
});

// PUT /api/ligas-club/partidos/:partidoId/calendario - programa un partido de
// liga en el calendario general, con fecha y máquina
router.put("/partidos/:partidoId/calendario", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { fecha, maquinaId, confirmado } = req.body;
  try {
    const partido = await prisma.partidoLiga.update({
      where: { id: partidoId },
      data: {
        fechaCalendario: fecha !== undefined ? (fecha ? new Date(fecha) : null) : undefined,
        maquinaCalendarioId: maquinaId !== undefined ? (maquinaId || null) : undefined,
        confirmadoCalendario: confirmado !== undefined ? !!confirmado : undefined,
      },
      include: { maquinaCalendario: true },
    });
    res.json(partido);
  } catch {
    res.status(404).json({ error: "Enfrentamiento no encontrado" });
  }
});

router.put("/partidos/:partidoId", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { resultado, ganador, maquina, enCurso } = req.body;
  try {
    const partido = await prisma.partidoLiga.update({
      where: { id: partidoId },
      data: {
        resultado: resultado !== undefined ? resultado || null : undefined,
        ganador: ganador !== undefined ? ganador || null : undefined,
        maquina: maquina !== undefined ? maquina || null : undefined,
        enCurso: enCurso !== undefined ? !!enCurso : undefined,
      },
    });
    res.json(partido);
  } catch {
    res.status(404).json({ error: "Enfrentamiento no encontrado" });
  }
});

// POST /api/ligas-club/:ligaId/cuadrante-final - crea el cuadrante final de una
// liga (colgado de la liga, no de un torneo). El sorteo en sí se hace después con
// el mismo endpoint que usan los torneos (/api/torneos-club/cuadrantes/:id/sorteo).
router.post("/:ligaId/cuadrante-final", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const { nombre, tamano, tipoEliminacion } = req.body;
  const tamanoNum = Number(tamano);
  const tamanosValidos = [4, 8, 16, 32, 64, 128];
  if (!tamanosValidos.includes(tamanoNum)) {
    return res.status(400).json({ error: "Tamaño de cuadrante no válido." });
  }
  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });

  const tipo = tipoEliminacion === "doble" ? "doble" : "directa";
  const cuadrante = await prisma.cuadrante.create({
    data: { ligaId, nombre: nombre || "Cuadrante final", tamano: tamanoNum, tipoEliminacion: tipo },
  });

  const partidos = generarPartidos(tamanoNum, tipo);
  await prisma.cuadroPartido.createMany({ data: partidos.map((p) => ({ ...p, cuadranteId: cuadrante.id })) });

  const cuadranteCompleto = await prisma.cuadrante.findUnique({
    where: { id: cuadrante.id },
    include: { partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] } },
  });
  res.status(201).json(cuadranteCompleto);
});

export default router;
