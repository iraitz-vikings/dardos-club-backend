import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

// Eventos sueltos en el calendario del club, puestos a mano por el admin
// (máquina + fecha/hora + texto), para reservar una máquina en algo que no
// es un partido real (mantenimiento, quedada, exhibición...). Se mezclan con
// los partidos de torneo/liga/competición externa en GET /api/calendario
// (ver ese archivo) para que el socio los vea todos juntos en su calendario.
// Aquí solo está la gestión (listar todos, crear, borrar) — protegida, es
// cosa del admin.

router.get("/", requireAdmin, async (_req, res) => {
  const eventos = await prisma.eventoCalendario.findMany({
    include: { maquina: true },
    orderBy: { fecha: "desc" },
  });
  res.json(eventos);
});

router.post("/", requireAdmin, async (req, res) => {
  const { maquinaId, fecha, titulo } = req.body;
  if (!maquinaId || !fecha || !titulo || !titulo.trim()) {
    return res.status(400).json({ error: "Faltan datos: máquina, fecha/hora y texto son obligatorios." });
  }
  const fechaValida = new Date(fecha);
  if (Number.isNaN(fechaValida.getTime())) {
    return res.status(400).json({ error: "La fecha no es válida." });
  }
  try {
    const evento = await prisma.eventoCalendario.create({
      data: { maquinaId, fecha: fechaValida, titulo: titulo.trim() },
      include: { maquina: true },
    });
    res.status(201).json(evento);
  } catch (err) {
    if (err.code === "P2003") return res.status(400).json({ error: "Esa máquina no existe." });
    console.error("Error creando evento de calendario:", err);
    res.status(500).json({ error: "No se pudo crear el evento." });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.eventoCalendario.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(204).end();
    console.error("Error borrando evento de calendario:", err);
    res.status(500).json({ error: "No se pudo borrar el evento." });
  }
});

export default router;
