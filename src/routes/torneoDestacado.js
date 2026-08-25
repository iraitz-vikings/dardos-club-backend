import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

// GET /api/torneo-destacado - público, devuelve el torneo actual (o null si no hay ninguno)
router.get("/", async (_req, res) => {
      const torneo = await prisma.torneoDestacado.findUnique({ where: { id: "actual" } });
      res.json(torneo);
});

// PUT /api/torneo-destacado - crea o actualiza el torneo destacado (protegido)
router.put("/", requireAdmin, async (req, res) => {
      const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, cartelUrl } = req.body;
      if (!nombre || !fechaInicio || !fechaFin) {
              return res.status(400).json({ error: "Faltan campos obligatorios" });
      }

             try {
                     const datos = {
                               nombre,
                               descripcion: descripcion || null,
                               fechaInicio: new Date(fechaInicio),
                               fechaFin: new Date(fechaFin),
                               insigniaUrl: insigniaUrl || null,
                               cartelUrl: cartelUrl || null,
                     };
                     const torneo = await prisma.torneoDestacado.upsert({
                               where: { id: "actual" },
                               update: datos,
                               create: { id: "actual", ...datos },
                     });
                     res.json(torneo);
             } catch (err) {
                     res.status(500).json({ error: "No se pudo guardar el torneo" });
             }
});

export default router;
