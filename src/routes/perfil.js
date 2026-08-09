import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";

const prisma = new PrismaClient();
const router = Router();

async function obtenerOCrearJugador(usuarioId) {
  let jugador = await prisma.jugador.findUnique({ where: { usuarioId } });
  if (!jugador) {
    const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
    jugador = await prisma.jugador.create({
      data: { nombre: usuario?.nombre || "Socio", usuarioId },
    });
  }
  return jugador;
}

// GET /api/perfil - el perfil del socio logueado (se crea solo la primera vez)
router.get("/", requireAuth, async (req, res) => {
  const jugador = await obtenerOCrearJugador(req.usuario.sub);
  const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.sub } });
  res.json({
    id: jugador.id,
    nombre: jugador.nombre,
    apodo: jugador.apodo,
    avatarUrl: jugador.avatarUrl,
    bio: jugador.bio,
    email: usuario.email,
    rol: usuario.rol,
  });
});

// PUT /api/perfil - el socio edita su propio perfil
router.put("/", requireAuth, async (req, res) => {
  const { apodo, avatarUrl, bio } = req.body;
  const jugador = await obtenerOCrearJugador(req.usuario.sub);
  const actualizado = await prisma.jugador.update({
    where: { id: jugador.id },
    data: {
      apodo: apodo !== undefined ? apodo || null : undefined,
      avatarUrl: avatarUrl !== undefined ? avatarUrl || null : undefined,
      bio: bio !== undefined ? bio || null : undefined,
    },
  });
  res.json(actualizado);
});

export default router;
