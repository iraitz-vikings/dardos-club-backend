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
          mprVirtual: true,
          ppdVirtual: true,
          mprPresencial: true,
          ppdPresencial: true,
          fabricante: { select: { id: true, nombre: true, urlPerfilPlantilla: true, logoUrl: true } },
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
      logoUrl: i.fabricante.logoUrl,
      idExterno: i.idExterno,
      mpr: i.mpr,
      ppd: i.ppd,
      mprVirtual: i.mprVirtual,
      ppdVirtual: i.ppdVirtual,
      mprPresencial: i.mprPresencial,
      ppdPresencial: i.ppdPresencial,
    })),
  }));
  res.json(resultado);
});

// DELETE /api/jugadores/:id - borra un jugador (protegido). Si pertenece a un
// equipo del club o a la plantilla de una inscripción externa, la base de
// datos rechaza el borrado (relación obligatoria) — antes eso se tragaba en
// silencio y el admin recibía un "borrado" que no era cierto; ahora se
// responde con un error explicando qué lo bloquea.
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.jugador.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(204).end(); // ya no existía
    if (err.code === "P2003") {
      return res.status(409).json({
        error:
          "No se puede borrar: este jugador pertenece a un equipo del club o a la plantilla de una competición externa. Quítalo de ahí primero.",
      });
    }
    console.error("Error borrando jugador:", err);
    res.status(500).json({ error: "No se pudo borrar el jugador." });
  }
});

export default router;
