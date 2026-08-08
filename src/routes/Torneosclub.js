import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

const includePartidos = {
  partidos: { orderBy: [{ nivel: "asc" }, { maquina: "asc" }, { orden: "asc" }] },
};

// GET /api/torneos-club - lista pública: solo torneos con visibilidad "publico"
router.get("/", async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    where: { visibilidad: "publico" },
    orderBy: { fechaInicio: "desc" },
    include: includePartidos,
  });
  res.json(torneos);
});

// GET /api/torneos-club/todos - lista completa (públicos y privados), para el admin (protegido)
router.get("/todos", requireAdmin, async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    orderBy: { fechaInicio: "desc" },
    include: includePartidos,
  });
  res.json(torneos);
});

// POST /api/torneos-club - crear torneo del club (protegido)
router.post("/", requireAdmin, async (req, res) => {
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad } = req.body;
  if (!nombre || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  const torneo = await prisma.torneoClub.create({
    data: {
      nombre,
      descripcion: descripcion || null,
      fechaInicio: new Date(fechaInicio),
      fechaFin: new Date(fechaFin),
      insigniaUrl: insigniaUrl || null,
      visibilidad: visibilidad === "publico" ? "publico" : "privado",
    },
  });
  res.status(201).json(torneo);
});

// PUT /api/torneos-club/:id - actualizar torneo del club, incluida la visibilidad (protegido)
router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad } = req.body;
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
      },
    });
    res.json(torneo);
  } catch {
    res.status(404).json({ error: "Torneo no encontrado" });
  }
});

// DELETE /api/torneos-club/:id - borrar torneo del club y su cuadro (protegido)
router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await prisma.cuadroPartido.deleteMany({ where: { torneoClubId: id } });
  await prisma.torneoClub.delete({ where: { id } });
  res.status(204).end();
});

// POST /api/torneos-club/:id/partidos - añadir un enfrentamiento al cuadro (protegido)
router.post("/:id/partidos", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nivel, maquina, ronda, orden, jugador1, jugador2, resultado, ganador, enCurso } = req.body;
  if (!nivel || !maquina || !ronda) {
    return res.status(400).json({ error: "Falta el nivel, la máquina o la ronda" });
  }
  if (enCurso) {
    await prisma.cuadroPartido.updateMany({
      where: { torneoClubId: id, maquina },
      data: { enCurso: false },
    });
  }
  const partido = await prisma.cuadroPartido.create({
    data: {
      torneoClubId: id,
      nivel,
      maquina,
      ronda,
      orden: orden ?? 0,
      jugador1: jugador1 || null,
      jugador2: jugador2 || null,
      resultado: resultado || null,
      ganador: ganador || null,
      enCurso: !!enCurso,
    },
  });
  res.status(201).json(partido);
});

// PUT /api/torneos-club/partidos/:partidoId - actualizar un enfrentamiento del cuadro (protegido)
router.put("/partidos/:partidoId", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { nivel, maquina, ronda, orden, jugador1, jugador2, resultado, ganador, enCurso } = req.body;
  try {
    if (enCurso) {
      const actual = await prisma.cuadroPartido.findUnique({ where: { id: partidoId } });
      if (actual) {
        await prisma.cuadroPartido.updateMany({
          where: { torneoClubId: actual.torneoClubId, maquina: maquina || actual.maquina },
          data: { enCurso: false },
        });
      }
    }
    const partido = await prisma.cuadroPartido.update({
      where: { id: partidoId },
      data: {
        nivel,
        maquina,
        ronda,
        orden,
        jugador1: jugador1 || null,
        jugador2: jugador2 || null,
        resultado: resultado || null,
        ganador: ganador || null,
        enCurso: !!enCurso,
      },
    });
    res.json(partido);
  } catch {
    res.status(404).json({ error: "Enfrentamiento no encontrado" });
  }
});

// DELETE /api/torneos-club/partidos/:partidoId - borrar un enfrentamiento del cuadro (protegido)
router.delete("/partidos/:partidoId", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  await prisma.cuadroPartido.delete({ where: { id: partidoId } });
  res.status(204).end();
});

export default router;
