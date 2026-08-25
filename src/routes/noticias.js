import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

// GET /api/noticias - lista pública de noticias/eventos, más recientes primero
router.get("/", async (_req, res) => {
  const noticias = await prisma.noticiaEvento.findMany({
    orderBy: { fechaPublicacion: "desc" },
  });
  res.json(noticias);
});

// POST /api/noticias - crear noticia (protegido)
router.post("/", requireAdmin, async (req, res) => {
  const { titulo, contenido, fotos, videos, autorId } = req.body;
  if (!titulo || !contenido) {
    return res.status(400).json({ error: "Falta título o contenido" });
  }
  const noticia = await prisma.noticiaEvento.create({
    data: { titulo, contenido, fotos: fotos || [], videos: videos || [], autorId },
  });
  res.status(201).json(noticia);
});

// DELETE /api/noticias/:id - borrar noticia (protegido)
router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await prisma.noticiaEvento.delete({ where: { id } });
  res.status(204).end();
});

// PUT /api/noticias/:id - editar una noticia existente (protegido)
router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { titulo, contenido, fotos, videos } = req.body;
  if (!titulo || !contenido) {
    return res.status(400).json({ error: "Falta título o contenido" });
  }
  try {
    const noticia = await prisma.noticiaEvento.update({
      where: { id },
      data: { titulo, contenido, fotos: fotos || [], videos: videos || [] },
    });
    res.json(noticia);
  } catch {
    res.status(404).json({ error: "Noticia no encontrada" });
  }
});

export default router;
