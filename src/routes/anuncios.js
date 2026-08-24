import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireRole } from "./auth.js";
import { notificarJugadores } from "./notificar.js";

const prisma = new PrismaClient();
const router = Router();

// GET /api/anuncios - lista de anuncios, visible para cualquier socio logueado
router.get("/", requireAuth, async (_req, res) => {
  const anuncios = await prisma.anuncio.findMany({
    orderBy: [{ fijado: "desc" }, { fechaPublicacion: "desc" }],
    include: { autor: { select: { nombre: true, rol: true } } },
  });
  res.json(anuncios);
});

// POST /api/anuncios - publicar un anuncio (admin o capitán). Si se envía
// notificar: true, se avisa a todos los socios (jugadores con cuenta) por
// su canal de avisos activo — los anuncios del club nunca se mandan a
// invitados, solo a socios.
router.post("/", requireAuth, requireRole("admin", "capitan"), async (req, res) => {
  const { titulo, contenido, fijado, notificar } = req.body;
  if (!titulo || !contenido) {
    return res.status(400).json({ error: "Falta título o contenido" });
  }
  const anuncio = await prisma.anuncio.create({
    data: { titulo, contenido, fijado: !!fijado, autorId: req.usuario.sub },
    include: { autor: { select: { nombre: true, rol: true } } },
  });

  if (notificar) {
    prisma.jugador
      .findMany({ where: { usuarioId: { not: null } }, select: { id: true } })
      .then((socios) =>
        notificarJugadores(
          socios.map((s) => s.id),
          { titulo: `Anuncio: ${titulo}`, cuerpo: contenido }
        )
      )
      .catch((err) => console.error("Error notificando anuncio:", err.message || err));
  }

  res.status(201).json(anuncio);
});

// PUT /api/anuncios/:id - editar un anuncio (autor o admin)
router.put("/:id", requireAuth, requireRole("admin", "capitan"), async (req, res) => {
  const { id } = req.params;
  const anuncio = await prisma.anuncio.findUnique({ where: { id } });
  if (!anuncio) return res.status(404).json({ error: "Anuncio no encontrado" });
  if (anuncio.autorId !== req.usuario.sub && req.usuario.rol !== "admin") {
    return res.status(403).json({ error: "Solo el autor o un admin pueden editar este anuncio" });
  }
  const { titulo, contenido, fijado } = req.body;
  const actualizado = await prisma.anuncio.update({
    where: { id },
    data: {
      titulo: titulo !== undefined ? titulo : undefined,
      contenido: contenido !== undefined ? contenido : undefined,
      fijado: fijado !== undefined ? !!fijado : undefined,
    },
    include: { autor: { select: { nombre: true, rol: true } } },
  });
  res.json(actualizado);
});

// DELETE /api/anuncios/:id - borrar un anuncio (autor o admin)
router.delete("/:id", requireAuth, requireRole("admin", "capitan"), async (req, res) => {
  const { id } = req.params;
  const anuncio = await prisma.anuncio.findUnique({ where: { id } });
  if (!anuncio) return res.status(404).json({ error: "Anuncio no encontrado" });
  if (anuncio.autorId !== req.usuario.sub && req.usuario.rol !== "admin") {
    return res.status(403).json({ error: "Solo el autor o un admin pueden borrar este anuncio" });
  }
  await prisma.anuncio.delete({ where: { id } });
  res.status(204).end();
});

export default router;
