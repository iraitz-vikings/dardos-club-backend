import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

const includeCompleto = {
  capitan: true,
  miembros: { include: { jugador: true }, orderBy: { creadoEn: "asc" } },
  inscripciones: {
    include: {
      // "equipoTorneoId: null" filtra a la tabla compartida por todo el
      // torneo/liga (Radikal). Sin este filtro se mezclarían aquí también
      // las filas de clasificación de CADA equipo del club (Phoenix), que
      // ya se muestran por separado abajo (clasificacion, en esta misma
      // inscripción).
      torneo: { include: { plataforma: true, clasificacion: { where: { equipoTorneoId: null }, orderBy: { posicion: "asc" } } } },
      capitan: true,
      jugadores: { include: { jugador: true } },
      partidos: { include: { maquina: true }, orderBy: { fecha: "asc" } },
      // Clasificación propia de ESTA inscripción (solo tiene filas en
      // plataformas por equipo como Phoenix, donde cada equipo del club
      // puede caer en un grupo distinto dentro del mismo torneo/liga).
      clasificacion: { orderBy: { posicion: "asc" } },
    },
  },
};

// Para socios logueados
router.get("/", requireAuth, async (_req, res) => {
  const equipos = await prisma.equipoClub.findMany({ orderBy: { nombre: "asc" }, include: includeCompleto });
  res.json(equipos);
});

// Para el panel de admin
router.get("/admin", requireAdmin, async (_req, res) => {
  const equipos = await prisma.equipoClub.findMany({ orderBy: { nombre: "asc" }, include: includeCompleto });
  res.json(equipos);
});

router.post("/", requireAdmin, async (req, res) => {
  const { nombre, descripcion, escudoUrl } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta el nombre del equipo" });
  const equipo = await prisma.equipoClub.create({
    data: { nombre, descripcion: descripcion || null, escudoUrl: escudoUrl || null },
    include: includeCompleto,
  });
  res.status(201).json(equipo);
});

router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, escudoUrl, capitanId } = req.body;
  try {
    const equipo = await prisma.equipoClub.update({
      where: { id },
      data: {
        nombre: nombre !== undefined ? nombre : undefined,
        descripcion: descripcion !== undefined ? descripcion || null : undefined,
        escudoUrl: escudoUrl !== undefined ? escudoUrl || null : undefined,
        capitanId: capitanId !== undefined ? capitanId || null : undefined,
      },
      include: includeCompleto,
    });
    res.json(equipo);
  } catch {
    res.status(404).json({ error: "Equipo no encontrado" });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const inscripciones = await prisma.equipoTorneo.findMany({ where: { equipoClubId: id }, select: { id: true } });
  const inscripcionIds = inscripciones.map((i) => i.id);
  await prisma.partido.deleteMany({ where: { equipoTorneoId: { in: inscripcionIds } } });
  await prisma.equipoJugador.deleteMany({ where: { equipoTorneoId: { in: inscripcionIds } } });
  await prisma.equipoTorneo.deleteMany({ where: { equipoClubId: id } });
  await prisma.miembroEquipoClub.deleteMany({ where: { equipoId: id } });
  await prisma.equipoClub.delete({ where: { id } });
  res.status(204).end();
});

router.post("/:id/miembros", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { jugadorId } = req.body;
  if (!jugadorId) return res.status(400).json({ error: "Falta el jugador" });
  try {
    await prisma.miembroEquipoClub.create({ data: { equipoId: id, jugadorId } });
    const equipo = await prisma.equipoClub.findUnique({ where: { id }, include: includeCompleto });
    res.status(201).json(equipo);
  } catch {
    res.status(409).json({ error: "Ese jugador ya está en el equipo" });
  }
});

router.delete("/:id/miembros/:jugadorId", requireAdmin, async (req, res) => {
  const { id, jugadorId } = req.params;
  await prisma.miembroEquipoClub.deleteMany({ where: { equipoId: id, jugadorId } });
  const equipo = await prisma.equipoClub.findUnique({ where: { id }, include: includeCompleto });
  res.json(equipo);
});

// ---------- Inscripciones en competiciones externas ----------
// Inscribe este equipo del club en un Torneo/Liga externo: crea el
// EquipoTorneo (enlazado por equipoClubId, así que su nombre/escudo siempre
// se leen del EquipoClub, nunca duplicados) y copia la plantilla actual del
// club como punto de partida de la plantilla de esa competición (se puede
// ajustar después con los mismos endpoints de siempre en
// /api/competiciones-externas/equipos/:id/jugadores, por si en una
// competición concreta juega gente distinta).
router.post("/:id/inscripciones", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { torneoId } = req.body;
  if (!torneoId) return res.status(400).json({ error: "Falta el torneo/liga" });

  const equipoClub = await prisma.equipoClub.findUnique({ where: { id }, include: { miembros: true } });
  if (!equipoClub) return res.status(404).json({ error: "Equipo no encontrado" });

  try {
    const inscripcion = await prisma.equipoTorneo.create({
      data: {
        torneoId,
        equipoClubId: id,
        capitanId: equipoClub.capitanId || null,
        jugadores: {
          create: equipoClub.miembros.map((m) => ({ jugadorId: m.jugadorId })),
        },
      },
    });
    const equipo = await prisma.equipoClub.findUnique({ where: { id }, include: includeCompleto });
    res.status(201).json(equipo);
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Este equipo ya está inscrito en ese torneo/liga" });
    }
    res.status(400).json({ error: "No se pudo crear la inscripción" });
  }
});

router.delete("/:id/inscripciones/:equipoTorneoId", requireAdmin, async (req, res) => {
  const { id, equipoTorneoId } = req.params;
  // Solo borra si esa inscripción pertenece de verdad a este equipo del club.
  const inscripcion = await prisma.equipoTorneo.findFirst({ where: { id: equipoTorneoId, equipoClubId: id } });
  if (!inscripcion) return res.status(404).json({ error: "Inscripción no encontrada" });

  await prisma.partido.deleteMany({ where: { equipoTorneoId } });
  await prisma.equipoJugador.deleteMany({ where: { equipoTorneoId } });
  await prisma.equipoTorneo.delete({ where: { id: equipoTorneoId } });

  const equipo = await prisma.equipoClub.findUnique({ where: { id }, include: includeCompleto });
  res.json(equipo);
});

export default router;
