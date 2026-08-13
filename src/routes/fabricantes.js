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

// GET /api/fabricantes - lista pública (se usa en el formulario de perfil del
// socio, para pedirle su ID en cada fabricante)
router.get("/", async (_req, res) => {
  const fabricantes = await prisma.fabricante.findMany({ orderBy: { nombre: "asc" } });
  res.json(fabricantes);
});

// POST /api/fabricantes - da de alta un fabricante nuevo (admin)
router.post("/", requireAdmin, async (req, res) => {
  const { nombre, urlPerfilPlantilla } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "Falta el nombre" });
  try {
    const fabricante = await prisma.fabricante.create({
      data: { nombre: nombre.trim(), urlPerfilPlantilla: urlPerfilPlantilla?.trim() || null },
    });
    res.status(201).json(fabricante);
  } catch {
    res.status(409).json({ error: "Ya existe un fabricante con ese nombre" });
  }
});

// DELETE /api/fabricantes/:id - borra un fabricante (admin). Al borrarlo se
// borran también los IDs que los jugadores tuvieran guardados para él.
router.delete("/:id", requireAdmin, async (req, res) => {
  await prisma.fabricante.delete({ where: { id: req.params.id } }).catch(() => {});
  res.status(204).end();
});

export default router;
