// Gestión del club → Patrocinadores: lista interna (solo admin) con lo que
// aporta cada patrocinador y si ya ha pagado, más su logo. Es aparte de los
// patrocinadores que se publican en la web (src/routes/patrocinadores.js).
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();
router.use(requireAdmin);

function leerCantidad(valor) {
  if (valor === null || valor === "" || valor === undefined) return null;
  const n = Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
}

// Body (alta o edición parcial) → datos de Prisma, validando.
function datosDesdeBody(body) {
  const data = {};
  if (body.nombre !== undefined) {
    const nombre = String(body.nombre || "").trim();
    if (!nombre) return { error: "Falta el nombre del patrocinador." };
    data.nombre = nombre;
  }
  if (body.cantidad !== undefined) {
    const cantidad = leerCantidad(body.cantidad);
    if (cantidad === undefined) return { error: "La cantidad tiene que ser un número (p.ej. 150 o 75,50)." };
    data.cantidad = cantidad;
  }
  if (body.pagado !== undefined) data.pagado = !!body.pagado;
  if (body.logoUrl !== undefined) data.logoUrl = body.logoUrl || null;
  return { data };
}

router.get("/", async (_req, res) => {
  const lista = await prisma.patrocinadorClub.findMany({ orderBy: { creadoEn: "asc" } });
  res.json(lista);
});

router.post("/", async (req, res) => {
  const { data, error } = datosDesdeBody({ nombre: "", ...req.body });
  if (error) return res.status(400).json({ error });
  const patrocinador = await prisma.patrocinadorClub.create({ data });
  res.status(201).json(patrocinador);
});

router.put("/:id", async (req, res) => {
  const { data, error } = datosDesdeBody(req.body || {});
  if (error) return res.status(400).json({ error });
  try {
    const patrocinador = await prisma.patrocinadorClub.update({ where: { id: req.params.id }, data });
    res.json(patrocinador);
  } catch {
    res.status(404).json({ error: "Patrocinador no encontrado" });
  }
});

router.delete("/:id", async (req, res) => {
  await prisma.patrocinadorClub.deleteMany({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
