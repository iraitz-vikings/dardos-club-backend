import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

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

// Si la máquina está asignada a algún partido/enfrentamiento (aunque ya esté
// jugado), la base de datos rechaza el borrado — antes se tragaba en
// silencio; ahora se avisa con un error claro en vez de un 204 falso.
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.maquina.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(204).end();
    if (err.code === "P2003") {
      return res.status(409).json({
        error: "No se puede borrar: esta máquina está asignada a algún partido o enfrentamiento (aunque ya esté jugado).",
      });
    }
    console.error("Error borrando máquina:", err);
    res.status(500).json({ error: "No se pudo borrar la máquina." });
  }
});

export default router;
