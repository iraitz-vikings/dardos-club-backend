import { Router } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = Router();

// GET /api/torneos - lista de torneos con sus equipos y próximos partidos
router.get("/", async (_req, res) => {
    const torneos = await prisma.torneo.findMany({
          include: {
                  plataforma: true,
                  equipos: {
                            include: {
                                        jugadores: { include: { jugador: true } },
                                        capitan: true,
                                        partidos: { orderBy: { fecha: "asc" } },
                                      },
                          },
                },
        });
    res.json(torneos);
  });

// POST /api/torneos - crear torneo (automático o manual)
router.post("/", async (req, res) => {
    const { nombre, nivel, temporada, origen, plataformaId, idExterno } = req.body;
    const torneo = await prisma.torneo.create({
          data: { nombre, nivel, temporada, origen, plataformaId, idExterno },
        });
    res.status(201).json(torneo);
  });

// PATCH /api/torneos/partidos/:id/fijar - el capitán fija un partido y dispara notificación
router.patch("/partidos/:id/fijar", async (req, res) => {
    const { id } = req.params;
    const { notaCapitan, disparadaPorId } = req.body;

    const partido = await prisma.partido.update({
          where: { id },
          data: { fijado: true, notaCapitan },
        });

    const notificacion = await prisma.notificacion.create({
          data: {
                  partidoId: partido.id,
                  mensaje: notaCapitan || "Partido fijado por el capitán",
                  disparadaPorId,
                },
        });

    res.json({ partido, notificacion });
  });

export default router;
