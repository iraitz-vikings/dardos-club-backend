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

// GET /api/galeria - lista pública de fotos/vídeos sueltos, más recientes primero
router.get("/", async (_req, res) => {
  const items = await prisma.galeriaItem.findMany({
    orderBy: { creadoEn: "desc" },
  });
  res.json(items);
});

// POST /api/galeria - añadir una foto o vídeo directamente a la galería (protegido)
router.post("/", requireAdmin, async (req, res) => {
  const { url, tipo } = req.body;
  if (!url || !tipo) {
    return res.status(400).json({ error: "Falta url o tipo" });
  }
  if (tipo !== "image" && tipo !== "video") {
    return res.status(400).json({ error: "El tipo debe ser 'image' o 'video'" });
  }
  const item = await prisma.galeriaItem.create({ data: { url, tipo } });
  res.status(201).json(item);
});

// DELETE /api/galeria/:id - quitar un elemento de la galería (protegido)
router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await prisma.galeriaItem.delete({ where: { id } });
  res.status(204).end();
});

export default router;
