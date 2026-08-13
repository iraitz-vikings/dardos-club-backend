import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";

const prisma = new PrismaClient();
const router = Router();

function inicioDeSemana(fechaBase) {
  // Si nos llega una fecha ya calculada desde el navegador, la respetamos tal
  // cual (ya viene ajustada al lunes en la hora local del socio) — si no,
  // calculamos el lunes de esta semana en el servidor como último recurso.
  if (fechaBase) return new Date(fechaBase);
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

// GET /api/calendario?inicio=2026-08-10 - partidos confirmados (externos e
// internos) de la semana que empieza en esa fecha (o la semana actual si no se
// indica), todos juntos, sean de torneo, liga o competición externa.
router.get("/", requireAuth, async (req, res) => {
  const inicioSemana = inicioDeSemana(req.query.inicio);
  const finSemana = new Date(inicioSemana);
  finSemana.setDate(finSemana.getDate() + 7);
  const rango = { gte: inicioSemana, lt: finSemana };

  const externos = await prisma.partido.findMany({
    where: { fijado: true, fecha: rango },
    include: { maquina: true, equipoTorneo: { include: { torneo: { include: { plataforma: true } } } } },
  });

  const internosTorneo = await prisma.cuadroPartido.findMany({
    where: { confirmadoCalendario: true, fechaCalendario: rango },
    include: { maquinaCalendario: true, cuadrante: { include: { torneoClub: true, liga: true } } },
  });

  const internosLiga = await prisma.partidoLiga.findMany({
    where: { confirmadoCalendario: true, fechaCalendario: rango },
    include: { maquinaCalendario: true, liga: true },
  });

  const eventos = [
    ...externos.map((p) => ({
      id: `ext-${p.id}`,
      fecha: p.fecha,
      maquina: p.maquina?.nombre || null,
      titulo: `${p.equipoTorneo.nombreEquipo || "Vikings"} vs ${p.rival || "?"}`,
      competicion: `${p.equipoTorneo.torneo?.nombre || ""}${p.equipoTorneo.torneo?.plataforma ? ` (${p.equipoTorneo.torneo.plataforma.nombre})` : ""}`,
    })),
    ...internosTorneo.map((p) => ({
      id: `ct-${p.id}`,
      fecha: p.fechaCalendario,
      maquina: p.maquinaCalendario?.nombre || null,
      titulo: `${p.jugador1 || "?"} vs ${p.jugador2 || "?"}`,
      competicion: p.cuadrante.torneoClub?.nombre || p.cuadrante.liga?.nombre || "Torneo Vikings",
    })),
    ...internosLiga.map((p) => ({
      id: `pl-${p.id}`,
      fecha: p.fechaCalendario,
      maquina: p.maquinaCalendario?.nombre || null,
      titulo: `${p.participante1} vs ${p.participante2}`,
      competicion: p.liga.nombre,
    })),
  ];

  res.json({ inicioSemana, eventos });
});

export default router;
