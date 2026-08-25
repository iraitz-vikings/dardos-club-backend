import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

// Para socios logueados
router.get("/", requireAuth, async (_req, res) => {
  const trofeos = await prisma.trofeo.findMany({ orderBy: [{ anio: "desc" }, { creadoEn: "desc" }] });
  res.json(trofeos);
});

// Para el panel de admin (con la contraseña de admin, no la sesión de un socio)
router.get("/admin", requireAdmin, async (_req, res) => {
  const trofeos = await prisma.trofeo.findMany({ orderBy: [{ anio: "desc" }, { creadoEn: "desc" }] });
  res.json(trofeos);
});

router.post("/", requireAdmin, async (req, res) => {
  const { titulo, anio, ganador, imagenUrl, descripcion } = req.body;
  if (!titulo || !anio || !ganador) return res.status(400).json({ error: "Falta título, año o ganador" });
  const trofeo = await prisma.trofeo.create({
    data: { titulo, anio: Number(anio), ganador, imagenUrl: imagenUrl || null, descripcion: descripcion || null },
  });
  res.status(201).json(trofeo);
});

router.delete("/:id", requireAdmin, async (req, res) => {
  await prisma.trofeo.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
