import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";

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
  capitan: true,
  miembros: { include: { jugador: true }, orderBy: { creadoEn: "asc" } },
};

// Para socios logueados
router.get("/", requireAuth, async (_req, res) => {
  const equipos = await prisma.equipoClub.findMany({ orderBy: { nombre: "asc" }, include: includeCompleto });
  res.json(equipos);
});

// Para el panel de admin
router.get("/admin", requireAdmin, async (_req, res) => {
  const equipos = await prisma.equipoClub.findMany({ orderBy: { nombre: "asc" }, include: includeCompleto });
  res.json(equipos);
});

router.post("/", requireAdmin, async (req, res) => {
  const { nombre, descripcion, escudoUrl } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta el nombre del equipo" });
  const equipo = await prisma.equipoClub.create({
    data: { nombre, descripcion: descripcion || null, escudoUrl: escudoUrl || null },
    include: includeCompleto,
  });
  res.status(201).json(equipo);
});

router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, escudoUrl, capitanId } = req.body;
  try {
    const equipo = await prisma.equipoClub.update({
      where: { id },
      data: {
        nombre: nombre !== undefined ? nombre : undefined,
        descripcion: descripcion !== undefined ? descripcion || null : undefined,
        escudoUrl: escudoUrl !== undefined ? escudoUrl || null : undefined,
        capitanId: capitanId !== undefined ? capitanId || null : undefined,
      },
      include: includeCompleto,
    });
    res.json(equipo);
  } catch {
    res.status(404).json({ error: "Equipo no encontrado" });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await prisma.miembroEquipoClub.deleteMany({ where: { equipoId: id } });
  await prisma.equipoClub.delete({ where: { id } });
  res.status(204).end();
});

router.post("/:id/miembros", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { jugadorId } = req.body;
  if (!jugadorId) return res.status(400).json({ error: "Falta el jugador" });
  try {
    await prisma.miembroEquipoClub.create({ data: { equipoId: id, jugadorId } });
    const equipo = await prisma.equipoClub.findUnique({ where: { id }, include: includeCompleto });
    res.status(201).json(equipo);
  } catch {
    res.status(409).json({ error: "Ese jugador ya está en el equipo" });
  }
});

router.delete("/:id/miembros/:jugadorId", requireAdmin, async (req, res) => {
  const { id, jugadorId } = req.params;
  await prisma.miembroEquipoClub.deleteMany({ where: { equipoId: id, jugadorId } });
  const equipo = await prisma.equipoClub.findUnique({ where: { id }, include: includeCompleto });
  res.json(equipo);
});

export default router;
