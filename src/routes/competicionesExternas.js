import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
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

// Acepta o bien el admin (panel), o bien la sesión de un socio (para que el
// capitán pueda confirmar sus propios partidos)
function requireAdminOSocio(req, res, next) {
  const adminToken = req.headers["x-admin-token"];
  if (adminToken && adminToken === process.env.ADMIN_TOKEN) {
    req.esAdminPanel = true;
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      req.usuario = jwt.verify(token, process.env.JWT_SECRET);
      return next();
    } catch {
      // sigue abajo
    }
  }
  return res.status(401).json({ error: "No autorizado" });
}

const includeTorneo = {
  plataforma: true,
  equipos: {
    include: {
      capitan: true,
      jugadores: { include: { jugador: true } },
      partidos: { include: { maquina: true }, orderBy: { fecha: "asc" } },
    },
  },
};

// ---------- Plataformas (fabricantes) ----------
router.get("/plataformas", async (_req, res) => {
  const plataformas = await prisma.plataforma.findMany({ orderBy: { nombre: "asc" } });
  res.json(plataformas);
});
router.post("/plataformas", requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "Falta el nombre" });
  try {
    const plataforma = await prisma.plataforma.create({ data: { nombre: nombre.trim() } });
    res.status(201).json(plataforma);
  } catch {
    res.status(409).json({ error: "Ya existe una plataforma con ese nombre" });
  }
});
router.delete("/plataformas/:id", requireAdmin, async (req, res) => {
  await prisma.plataforma.delete({ where: { id: req.params.id } }).catch(() => {});
  res.status(204).end();
});

// ---------- Torneos externos ----------
router.get("/torneos", requireAuth, async (_req, res) => {
  const torneos = await prisma.torneo.findMany({ include: includeTorneo, orderBy: { nombre: "asc" } });
  res.json(torneos);
});
router.get("/torneos/admin", requireAdmin, async (_req, res) => {
  const torneos = await prisma.torneo.findMany({ include: includeTorneo, orderBy: { nombre: "asc" } });
  res.json(torneos);
});
router.post("/torneos", requireAdmin, async (req, res) => {
  const { nombre, nivel, temporada, plataformaId } = req.body;
  if (!nombre || !plataformaId) return res.status(400).json({ error: "Falta el nombre o la plataforma" });
  const torneo = await prisma.torneo.create({
    data: { nombre, nivel: nivel || null, temporada: temporada || null, plataformaId, origen: "manual" },
    include: includeTorneo,
  });
  res.status(201).json(torneo);
});
router.delete("/torneos/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const equipos = await prisma.equipoTorneo.findMany({ where: { torneoId: id }, select: { id: true } });
  const equipoIds = equipos.map((e) => e.id);
  await prisma.partido.deleteMany({ where: { equipoTorneoId: { in: equipoIds } } });
  await prisma.equipoJugador.deleteMany({ where: { equipoTorneoId: { in: equipoIds } } });
  await prisma.equipoTorneo.deleteMany({ where: { torneoId: id } });
  await prisma.torneo.delete({ where: { id } });
  res.status(204).end();
});

// ---------- Equipos del club en un torneo externo ----------
router.post("/torneos/:torneoId/equipos", requireAdmin, async (req, res) => {
  const { torneoId } = req.params;
  const { nombreEquipo, capitanId } = req.body;
  const equipo = await prisma.equipoTorneo.create({
    data: { torneoId, nombreEquipo: nombreEquipo || null, capitanId: capitanId || null },
  });
  res.status(201).json(equipo);
});
router.put("/equipos/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombreEquipo, capitanId } = req.body;
  const equipo = await prisma.equipoTorneo.update({
    where: { id },
    data: {
      nombreEquipo: nombreEquipo !== undefined ? nombreEquipo || null : undefined,
      capitanId: capitanId !== undefined ? capitanId || null : undefined,
    },
  });
  res.json(equipo);
});
router.delete("/equipos/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await prisma.partido.deleteMany({ where: { equipoTorneoId: id } });
  await prisma.equipoJugador.deleteMany({ where: { equipoTorneoId: id } });
  await prisma.equipoTorneo.delete({ where: { id } });
  res.status(204).end();
});
router.post("/equipos/:id/jugadores", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { jugadorId } = req.body;
  try {
    await prisma.equipoJugador.create({ data: { equipoTorneoId: id, jugadorId } });
    res.status(201).json({ ok: true });
  } catch {
    res.status(409).json({ error: "Ese jugador ya está en el equipo" });
  }
});
router.delete("/equipos/:id/jugadores/:jugadorId", requireAdmin, async (req, res) => {
  await prisma.equipoJugador.deleteMany({ where: { equipoTorneoId: req.params.id, jugadorId: req.params.jugadorId } });
  res.status(204).end();
});

// ---------- Partidos ----------
router.post("/equipos/:id/partidos", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { fecha, rival } = req.body;
  if (!fecha) return res.status(400).json({ error: "Falta la fecha" });
  const partido = await prisma.partido.create({
    data: { equipoTorneoId: id, fecha: new Date(fecha), rival: rival || null },
  });
  res.status(201).json(partido);
});

// Confirmar (fijar) un partido: el admin, o el capitán de ese equipo concreto
router.put("/partidos/:id", requireAdminOSocio, async (req, res) => {
  const { id } = req.params;
  const partido = await prisma.partido.findUnique({
    where: { id },
    include: { equipoTorneo: { include: { capitan: true } } },
  });
  if (!partido) return res.status(404).json({ error: "Partido no encontrado" });

  if (!req.esAdminPanel) {
    const esAdmin = req.usuario?.rol === "admin";
    const esCapitan = partido.equipoTorneo.capitan?.usuarioId === req.usuario?.sub;
    if (!esAdmin && !esCapitan) {
      return res.status(403).json({ error: "Solo el capitán de este equipo o un admin pueden confirmar este partido" });
    }
  }

  const { fecha, rival, resultado, maquinaId, notaCapitan, fijado } = req.body;
  const actualizado = await prisma.partido.update({
    where: { id },
    data: {
      fecha: fecha !== undefined ? new Date(fecha) : undefined,
      rival: rival !== undefined ? rival || null : undefined,
      resultado: resultado !== undefined ? resultado || null : undefined,
      maquinaId: maquinaId !== undefined ? maquinaId || null : undefined,
      notaCapitan: notaCapitan !== undefined ? notaCapitan || null : undefined,
      fijado: fijado !== undefined ? !!fijado : undefined,
      origenActualizacion: "manual",
    },
    include: { maquina: true },
  });
  res.json(actualizado);
});

router.delete("/partidos/:id", requireAdmin, async (req, res) => {
  await prisma.partido.delete({ where: { id: req.params.id } }).catch(() => {});
  res.status(204).end();
});

// ---------- Calendario: partidos externos fijados de esta semana +
// enfrentamientos internos Vikings marcados "en curso" ----------
router.get("/calendario", requireAuth, async (_req, res) => {
  const inicioSemana = new Date();
  inicioSemana.setHours(0, 0, 0, 0);
  inicioSemana.setDate(inicioSemana.getDate() - ((inicioSemana.getDay() + 6) % 7));
  const finSemana = new Date(inicioSemana);
  finSemana.setDate(finSemana.getDate() + 7);

  const partidosExternos = await prisma.partido.findMany({
    where: { fijado: true, fecha: { gte: inicioSemana, lt: finSemana } },
    include: { maquina: true, equipoTorneo: { include: { torneo: { include: { plataforma: true } } } } },
  });

  const cuadroPartidosEnCurso = await prisma.cuadroPartido.findMany({
    where: { enCurso: true },
    include: { cuadrante: { include: { torneoClub: true, liga: true } } },
  });
  const partidosLigaEnCurso = await prisma.partidoLiga.findMany({
    where: { enCurso: true },
    include: { liga: true },
  });

  res.json({
    inicioSemana,
    externos: partidosExternos.map((p) => ({
      id: p.id,
      fecha: p.fecha,
      maquina: p.maquina?.nombre || null,
      rival: p.rival,
      equipo: p.equipoTorneo.nombreEquipo || "Vikings",
      torneo: p.equipoTorneo.torneo?.nombre,
      plataforma: p.equipoTorneo.torneo?.plataforma?.nombre,
    })),
    internos: [
      ...cuadroPartidosEnCurso.map((p) => ({
        id: `c-${p.id}`,
        maquina: p.maquina || null,
        jugador1: p.jugador1,
        jugador2: p.jugador2,
        nombre: p.cuadrante.torneoClub?.nombre || p.cuadrante.liga?.nombre || "Torneo",
      })),
      ...partidosLigaEnCurso.map((p) => ({
        id: `l-${p.id}`,
        maquina: p.maquina || null,
        jugador1: p.participante1,
        jugador2: p.participante2,
        nombre: p.liga.nombre,
      })),
    ],
  });
});

export default router;
