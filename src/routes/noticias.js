import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// GET /api/noticias - lista pública de noticias/eventos, más recientes primero
router.get("/", async (_req, res) => {
    const noticias = await prisma.noticiaEvento.findMany({
          orderBy: { fechaPublicacion: "desc" },
        });
    res.json(noticias);
  });

// POST /api/noticias - crear noticia (requerirá auth de admin más adelante)
router.post("/", async (req, res) => {
    const { titulo, contenido, fotos, autorId } = req.body;
    const noticia = await prisma.noticiaEvento.create({
          data: { titulo, contenido, fotos: fotos || [], autorId },
        });
    res.status(201).json(noticia);
  });

export default router;
