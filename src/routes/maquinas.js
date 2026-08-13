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

// Lista pública (se usa también para el desplegable de socios)
router.get("/", async (_req, res) => {
  const maquinas = await prisma.maquina.findMany({ orderBy: { nombre: "asc" } });
  res.json(maquinas);
});

router.post("/", requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "Falta el nombre" });
  try {
    const maquina = await prisma.maquina.create({ data: { nombre: nombre.trim() } });
    res.status(201).json(maquina);
  } catch {
    res.status(409).json({ error: "Ya existe una máquina con ese nombre" });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  await prisma.maquina.delete({ where: { id: req.params.id } }).catch(() => {});
  res.status(204).end();
});

export default router;
