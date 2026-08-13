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
  const idsFabricantes = await prisma.jugadorFabricanteId.findMany({
    where: { jugadorId: jugador.id },
    include: { fabricante: true },
  });
  res.json({
    id: jugador.id,
    nombre: jugador.nombre,
    apodo: jugador.apodo,
    avatarUrl: jugador.avatarUrl,
    bio: jugador.bio,
    email: usuario.email,
    rol: usuario.rol,
    idsFabricantes: idsFabricantes.map((i) => ({
      fabricanteId: i.fabricanteId,
      nombreFabricante: i.fabricante.nombre,
      urlPerfilPlantilla: i.fabricante.urlPerfilPlantilla,
      idExterno: i.idExterno,
    })),
  });
});

// GET /api/perfil/historial - los torneos y ligas del club en los que ha
// participado el socio logueado, con sus enfrentamientos y resultados
router.get("/historial", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({ where: { usuarioId: req.usuario.sub } });
  if (!jugador) return res.json({ torneos: [], ligas: [] });

  const participacionesTorneos = await prisma.participanteCuadrante.findMany({
    where: { OR: [{ jugador1Id: jugador.id }, { jugador2Id: jugador.id }] },
    include: { cuadrante: { include: { torneoClub: true, liga: true } } },
  });

  const historialTorneos = [];
  for (const p of participacionesTorneos) {
    const partidos = await prisma.cuadroPartido.findMany({
      where: { cuadranteId: p.cuadranteId, OR: [{ jugador1: p.etiqueta }, { jugador2: p.etiqueta }] },
      orderBy: [{ rama: "asc" }, { ronda: "asc" }],
    });
    historialTorneos.push({
      nombre: p.cuadrante.torneoClub?.nombre || (p.cuadrante.liga ? `${p.cuadrante.liga.nombre} (cuadrante final)` : "Torneo"),
      cuadrante: p.cuadrante.nombre,
      etiqueta: p.etiqueta,
      partidos: partidos.map((partido) => ({
        rama: partido.rama,
        ronda: partido.ronda,
        rival: partido.jugador1 === p.etiqueta ? partido.jugador2 : partido.jugador1,
        resultado: partido.resultado,
        ganado: partido.ganador ? partido.ganador === p.etiqueta : null,
      })),
    });
  }

  const participacionesLigas = await prisma.participanteLiga.findMany({
    where: { OR: [{ jugador1Id: jugador.id }, { jugador2Id: jugador.id }] },
    include: { liga: true },
  });

  const historialLigas = [];
  for (const p of participacionesLigas) {
    const partidos = await prisma.partidoLiga.findMany({
      where: { ligaId: p.ligaId, OR: [{ participante1: p.etiqueta }, { participante2: p.etiqueta }] },
      orderBy: { jornada: "asc" },
    });
    historialLigas.push({
      nombre: p.liga.nombre,
      etiqueta: p.etiqueta,
      partidos: partidos.map((partido) => ({
        jornada: partido.jornada,
        rival: partido.participante1 === p.etiqueta ? partido.participante2 : partido.participante1,
        resultado: partido.resultado,
        ganado: partido.ganador ? partido.ganador === p.etiqueta : null,
      })),
    });
  }

  res.json({ torneos: historialTorneos, ligas: historialLigas });
});

// PUT /api/perfil - el socio edita su propio perfil
router.put("/", requireAuth, async (req, res) => {
  const { apodo, avatarUrl, bio, idsFabricantes } = req.body;
  const jugador = await obtenerOCrearJugador(req.usuario.sub);
  const actualizado = await prisma.jugador.update({
    where: { id: jugador.id },
    data: {
      apodo: apodo !== undefined ? apodo || null : undefined,
      avatarUrl: avatarUrl !== undefined ? avatarUrl || null : undefined,
      bio: bio !== undefined ? bio || null : undefined,
    },
  });

  // idsFabricantes: array de { fabricanteId, idExterno }. Un idExterno vacío
  // borra el ID guardado para ese fabricante; si no, se crea/actualiza.
  if (Array.isArray(idsFabricantes)) {
    for (const item of idsFabricantes) {
      if (!item?.fabricanteId) continue;
      const idExterno = (item.idExterno || "").trim();
      if (!idExterno) {
        await prisma.jugadorFabricanteId
          .delete({ where: { jugadorId_fabricanteId: { jugadorId: jugador.id, fabricanteId: item.fabricanteId } } })
          .catch(() => {});
        continue;
      }
      // .catch: si el fabricante fue borrado por un admin entre que el
      // frontend cargó la lista y el socio guardó, ignoramos ese ID en vez
      // de romper el resto del guardado por una violación de FK.
      await prisma.jugadorFabricanteId
        .upsert({
          where: { jugadorId_fabricanteId: { jugadorId: jugador.id, fabricanteId: item.fabricanteId } },
          update: { idExterno },
          create: { jugadorId: jugador.id, fabricanteId: item.fabricanteId, idExterno },
        })
        .catch(() => {});
    }
  }

  res.json(actualizado);
});

export default router;
