import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";

const prisma = new PrismaClient();
const router = Router();

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// GET /api/jugadores - lista todos los jugadores del club (protegido), incluye
// invitados sin cuenta de socio (usuarioId null)
router.get("/", requireAdmin, async (_req, res) => {
  const jugadores = await prisma.jugador.findMany({
    include: { usuario: { select: { email: true } } },
    orderBy: { nombre: "asc" },
  });
  res.json(jugadores);
});

// POST /api/jugadores - crea un jugador rápido (invitado, sin cuenta) (protegido)
router.post("/", requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: "Falta el nombre" });
  }
  const jugador = await prisma.jugador.create({ data: { nombre: nombre.trim() } });
  res.status(201).json(jugador);
});

// GET /api/jugadores/directorio - lista pública para socios logueados (sin datos
// sensibles como el email). Incluye las medias (MPR/PPD) de fabricante de cada
// jugador para poder mostrarlas al hacer clic en su perfil; se omite
// deliberadamente `statsError` (puede llevar un volcado largo del texto de
// diagnóstico de la web del fabricante, pensado para depurar el scraper, no
// para enseñarlo a otros socios).
router.get("/directorio", requireAuth, async (_req, res) => {
  const jugadores = await prisma.jugador.findMany({
    orderBy: { nombre: "asc" },
    select: {
      id: true,
      nombre: true,
      apodo: true,
      avatarUrl: true,
      bio: true,
      usuarioId: true,
      idsFabricantes: {
        select: {
          idExterno: true,
          mpr: true,
          ppd: true,
          fabricante: { select: { id: true, nombre: true, urlPerfilPlantilla: true } },
        },
      },
    },
  });
  const resultado = jugadores.map((j) => ({
    ...j,
    idsFabricantes: j.idsFabricantes.map((i) => ({
      fabricanteId: i.fabricante.id,
      nombreFabricante: i.fabricante.nombre,
      urlPerfilPlantilla: i.fabricante.urlPerfilPlantilla,
      idExterno: i.idExterno,
      mpr: i.mpr,
      ppd: i.ppd,
    })),
  }));
  res.json(resultado);
});

// DELETE /api/jugadores/:id - borra un jugador (protegido)
router.delete("/:id", requireAdmin, async (req, res) => {
  await prisma.jugador.delete({ where: { id: req.params.id } }).catch(() => {});
  res.status(204).end();
});

export default router;
