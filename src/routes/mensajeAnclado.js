import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

// GET /api/mensaje-anclado - público. Solo devuelve el mensaje si está activo.
router.get("/", async (_req, res) => {
  const mensaje = await prisma.mensajeAnclado.findUnique({ where: { id: "actual" } });
  res.json(mensaje && mensaje.activo ? mensaje : null);
});

// GET /api/mensaje-anclado/admin - protegido, para el panel (incluye el texto aunque esté apagado)
router.get("/admin", requireAdmin, async (_req, res) => {
  const mensaje = await prisma.mensajeAnclado.findUnique({ where: { id: "actual" } });
  res.json(mensaje);
});

// PUT /api/mensaje-anclado - crea o actualiza el mensaje anclado (protegido)
router.put("/", requireAdmin, async (req, res) => {
  const { texto, activo } = req.body;
  const datos = { texto: texto || "", activo: activo !== undefined ? !!activo : true };
  const mensaje = await prisma.mensajeAnclado.upsert({
    where: { id: "actual" },
    update: datos,
    create: { id: "actual", ...datos },
  });
  res.json(mensaje);
});

export default router;
