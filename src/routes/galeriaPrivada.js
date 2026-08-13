import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";

const prisma = new PrismaClient();
const router = Router();

router.get("/", requireAuth, async (_req, res) => {
  const fotos = await prisma.fotoGaleriaPrivada.findMany({
    orderBy: { fechaSubida: "desc" },
    include: { autor: { select: { nombre: true } } },
  });
  res.json(fotos);
});

router.post("/", requireAuth, async (req, res) => {
  const { url, descripcion } = req.body;
  if (!url) return res.status(400).json({ error: "Falta la URL de la foto" });
  const foto = await prisma.fotoGaleriaPrivada.create({
    data: { url, descripcion: descripcion || null, autorId: req.usuario.sub },
    include: { autor: { select: { nombre: true } } },
  });
  res.status(201).json(foto);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const foto = await prisma.fotoGaleriaPrivada.findUnique({ where: { id: req.params.id } });
  if (!foto) return res.status(404).json({ error: "Foto no encontrada" });
  if (foto.autorId !== req.usuario.sub && req.usuario.rol !== "admin") {
    return res.status(403).json({ error: "Solo quien la subió o un admin puede borrarla" });
  }
  await prisma.fotoGaleriaPrivada.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
