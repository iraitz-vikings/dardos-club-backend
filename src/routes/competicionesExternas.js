import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { requireAuth } from "./auth.js";
import { extraerClasificacionEquiposRadikal } from "../scrapers/radikalDarts.js";
import { extraerClasificacionEquiposPhoenix } from "../scrapers/phoenixDarts.js";

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
      equipoClub: true,
      capitan: true,
      jugadores: { include: { jugador: true } },
      partidos: { include: { maquina: true }, orderBy: { fecha: "asc" } },
      clasificacion: { orderBy: { posicion: "asc" } },
    },
  },
  // Clasificación a nivel de Torneo: solo tiene filas cuando la plataforma
  // usa una tabla compartida por todo el Torneo/Liga (Radikal). Para
  // plataformas por equipo (Phoenix) la clasificación real está en
  // equipos[].clasificacion, una por cada inscripción.
  clasificacion: { orderBy: { posicion: "asc" } },
};

// Convierte una fila extraída por un scraper (posicion/nombreEquipo/...) en
// los datos que espera Prisma para crear una fila de ClasificacionEquipo.
function filaClasificacion(f) {
  return {
    posicion: f.posicion,
    nombreEquipo: f.nombreEquipo,
    puntos: f.puntos,
    partidosJugados: f.partidosJugados,
    partidosGanados: f.partidosGanados,
    partidosPerdidos: f.partidosPerdidos,
    partidosEmpatados: f.partidosEmpatados,
    juegosGanados: f.juegosGanados,
    juegosPerdidos: f.juegosPerdidos,
    origenActualizacion: "scraper",
  };
}

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
  const { nombre, nivel, temporada, plataformaId, idExterno } = req.body;
  if (!nombre || !plataformaId) return res.status(400).json({ error: "Falta el nombre o la plataforma" });
  const torneo = await prisma.torneo.create({
    data: {
      nombre,
      nivel: nivel || null,
      temporada: temporada || null,
      plataformaId,
      idExterno: idExterno || null,
      origen: "manual",
    },
    include: includeTorneo,
  });
  res.status(201).json(torneo);
});
router.put("/torneos/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, nivel, temporada, idExterno } = req.body;
  try {
    const torneo = await prisma.torneo.update({
      where: { id },
      data: {
        nombre: nombre !== undefined ? nombre : undefined,
        nivel: nivel !== undefined ? nivel || null : undefined,
        temporada: temporada !== undefined ? temporada || null : undefined,
        idExterno: idExterno !== undefined ? idExterno || null : undefined,
      },
      include: includeTorneo,
    });
    res.json(torneo);
  } catch {
    res.status(404).json({ error: "Torneo no encontrado" });
  }
});

// Extrae (scraping) la clasificación de equipos de este torneo desde la
// plataforma externa y la guarda, sustituyendo la anterior. Por ahora solo
// implementado para Radikal Darts y Phoenix Darts — para cualquier otra
// plataforma devuelve un error explicando que aún no está soportado, en vez
// de fallar en silencio.
//
// Radikal: una única búsqueda por Torneo (tabla compartida por toda la
// competición, con Torneo.idExterno = nombre de la competición).
//
// Phoenix: no hay una tabla compartida por Torneo — hay que buscar equipo
// por equipo, porque un mismo Torneo/Liga puede tener varios equipos del
// club inscritos a la vez, cada uno en su propio grupo (caso real: la
// "Summer Cup" tiene 5 equipos del club). Por eso aquí se itera sobre
// TODOS los EquipoTorneo de este Torneo, usando el nombre de cada uno
// (EquipoTorneo.idExternoEquipo — con Torneo.idExterno como último recurso
// si esa inscripción no tiene su propio nombre configurado), y se guarda la
// clasificación de cada uno por separado. Si algún equipo falla pero otros
// no, se actualizan los que sí se pudieron y se informa de los que no.
router.post("/torneos/:id/actualizar-clasificacion", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const torneo = await prisma.torneo.findUnique({
    where: { id },
    include: { plataforma: true, equipos: true },
  });
  if (!torneo) return res.status(404).json({ error: "Torneo no encontrado" });

  const nombrePlataforma = (torneo.plataforma?.nombre || "").toLowerCase();

  if (nombrePlataforma.includes("radikal")) {
    const [resultado] = await extraerClasificacionEquiposRadikal([{ id: torneo.id, idExterno: torneo.idExterno }]);
    if (!resultado.ok) return res.status(422).json({ error: resultado.error });

    await prisma.$transaction([
      prisma.clasificacionEquipo.deleteMany({ where: { torneoId: id, equipoTorneoId: null } }),
      prisma.clasificacionEquipo.createMany({
        data: resultado.filas.map((f) => ({ torneoId: id, ...filaClasificacion(f) })),
      }),
    ]);
  } else if (nombrePlataforma.includes("phoenix")) {
    if (torneo.equipos.length === 0) {
      return res.status(422).json({
        error: 'Este torneo/liga todavía no tiene ningún equipo del club inscrito. Inscribe uno primero desde la pestaña "Equipos".',
      });
    }

    const objetivos = torneo.equipos.map((eq) => ({
      id: eq.id,
      idExterno: eq.idExternoEquipo || torneo.idExterno,
      nombre: torneo.nombre,
    }));
    const resultados = await extraerClasificacionEquiposPhoenix(objetivos);
    const exitos = resultados.filter((r) => r.ok);
    const fallos = resultados.filter((r) => !r.ok);

    if (exitos.length === 0) {
      return res.status(422).json({
        error:
          fallos.length === 1
            ? fallos[0].error
            : `No se pudo actualizar ningún equipo:\n${fallos.map((f) => `- ${f.error}`).join("\n")}`,
      });
    }

    await prisma.$transaction(
      exitos.flatMap((r) => [
        prisma.clasificacionEquipo.deleteMany({ where: { equipoTorneoId: r.equipoTorneoId } }),
        prisma.clasificacionEquipo.createMany({
          data: r.filas.map((f) => ({ torneoId: id, equipoTorneoId: r.equipoTorneoId, ...filaClasificacion(f) })),
        }),
      ])
    );

    if (fallos.length > 0) {
      const actualizado = await prisma.torneo.findUnique({ where: { id }, include: includeTorneo });
      const avisosClasificacion = fallos.map((f) => {
        const eq = torneo.equipos.find((e) => e.id === f.equipoTorneoId);
        const nombreEq = eq?.idExternoEquipo || eq?.nombreEquipo || "Un equipo";
        return `${nombreEq}: ${f.error}`;
      });
      return res.json({ ...actualizado, avisosClasificacion });
    }
  } else {
    return res.status(400).json({
      error: `La extracción de clasificación de equipos todavía no está implementada para "${torneo.plataforma?.nombre || "esta plataforma"}" (por ahora solo Radikal Darts y Phoenix Darts).`,
    });
  }

  const actualizado = await prisma.torneo.findUnique({ where: { id }, include: includeTorneo });
  res.json(actualizado);
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
  const { nombreEquipo, capitanId, idExternoEquipo } = req.body;
  const equipo = await prisma.equipoTorneo.update({
    where: { id },
    data: {
      nombreEquipo: nombreEquipo !== undefined ? nombreEquipo || null : undefined,
      capitanId: capitanId !== undefined ? capitanId || null : undefined,
      idExternoEquipo: idExternoEquipo !== undefined ? idExternoEquipo || null : undefined,
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
