import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

// GET /api/torneo-destacado - público, devuelve el torneo actual (o null si no hay ninguno).
// Incluye `activo`: la home oculta la sección si es false, y el admin lo
// necesita igualmente para rellenar el formulario.
router.get("/", async (_req, res) => {
      const torneo = await prisma.torneoDestacado.findUnique({ where: { id: "actual" } });
      res.json(torneo);
});

// PUT /api/torneo-destacado - crea o actualiza el torneo destacado (protegido)
router.put("/", requireAdmin, async (req, res) => {
      const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, cartelUrl, activo } = req.body;
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
                               // Si no llega (clientes antiguos), queda activo.
                               activo: activo !== false,
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
