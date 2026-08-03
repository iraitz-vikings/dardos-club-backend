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

// GET /api/torneo-destacado - público, devuelve el torneo actual (o null si no hay ninguno)
router.get("/", async (_req, res) => {
    const torneo = await prisma.torneoDestacado.findUnique({ where: { id: "actual" } });
    res.json(torneo);
  });

// PUT /api/torneo-destacado - crea o actualiza el torneo destacado (protegido)
router.put("/", requireAdmin, async (req, res) => {
    const { nombre, fechaInicio, fechaFin, insigniaUrl } = req.body;
    if (!nombre || !fechaInicio || !fechaFin) {
          return res.status(400).json({ error: "Faltan campos obligatorios" });
        }

    try {
          const datos = {
                  nombre,
                  fechaInicio: new Date(fechaInicio),
                  fechaFin: new Date(fechaFin),
                  insigniaUrl: insigniaUrl || null,
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
