import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

// GET /api/patrocinadores - lista pública, ordenada
router.get("/", async (_req, res) => {
  const lista = await prisma.patrocinador.findMany({ orderBy: [{ orden: "asc" }, { creadoEn: "asc" }] });
  res.json(lista);
});

// POST /api/patrocinadores - crear patrocinador (protegido)
router.post("/", requireAdmin, async (req, res) => {
  const { nombre, logoUrl, url, orden } = req.body;
  if (!nombre || !logoUrl) {
    return res.status(400).json({ error: "Faltan el nombre o el logo" });
  }
  const patrocinador = await prisma.patrocinador.create({
    data: { nombre, logoUrl, url: url || null, orden: orden ? Number(orden) : 0 },
  });
  res.status(201).json(patrocinador);
});

// DELETE /api/patrocinadores/:id - borrar patrocinador (protegido)
router.delete("/:id", requireAdmin, async (req, res) => {
  await prisma.patrocinador.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
