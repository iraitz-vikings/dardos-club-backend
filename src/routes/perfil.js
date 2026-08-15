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
      logoUrl: i.fabricante.logoUrl,
      idExterno: i.idExterno,
      notaBusqueda: i.notaBusqueda,
      mpr: i.mpr,
      ppd: i.ppd,
      mprVirtual: i.mprVirtual,
      ppdVirtual: i.ppdVirtual,
      mprPresencial: i.mprPresencial,
      ppdPresencial: i.ppdPresencial,
      statsActualizadoEn: i.statsActualizadoEn,
      statsError: i.statsError,
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

  // idsFabricantes: array de { fabricanteId, idExterno, notaBusqueda, mpr?,
  // ppd? }. Un idExterno vacío borra el ID guardado para ese fabricante; si
  // no, se crea/actualiza. notaBusqueda es opcional (hoy solo la usa
  // Radikal Darts, ver comentario en schema.prisma) y se guarda tal cual,
  // incluso vacía, para poder borrarla si el socio la quita.
  //
  // mpr/ppd son opcionales y solo se tocan si el frontend los manda de
  // verdad (item.mpr/item.ppd !== undefined): hoy es una entrada manual que
  // solo expone el formulario de Radikal Darts (ver SocioPerfil.jsx),
  // porque su scraper automático no puede iniciar sesión (bloqueado por la
  // propia web de Radikal). Si no se mandan, no se pisan los valores que ya
  // hubiera puesto el scraper automático de otro fabricante (Connection,
  // Phoenix). Al guardar un valor manual se marca como si fuese una
  // actualización automática correcta (statsActualizadoEn a ahora,
  // statsError a null) para que desaparezca cualquier error de scraping
  // anterior en cuanto el socio pone su media a mano.
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
      const notaBusqueda = (item.notaBusqueda || "").trim() || null;

      const datosManuales = {};
      if (item.mpr !== undefined) {
        const mpr = item.mpr === null || item.mpr === "" ? null : Number(item.mpr);
        datosManuales.mpr = Number.isFinite(mpr) ? mpr : null;
      }
      if (item.ppd !== undefined) {
        const ppd = item.ppd === null || item.ppd === "" ? null : Number(item.ppd);
        datosManuales.ppd = Number.isFinite(ppd) ? ppd : null;
      }
      if (Object.keys(datosManuales).length > 0) {
        datosManuales.statsActualizadoEn = new Date();
        datosManuales.statsError = null;
      }

      // .catch: si el fabricante fue borrado por un admin entre que el
      // frontend cargó la lista y el socio guardó, ignoramos ese ID en vez
      // de romper el resto del guardado por una violación de FK.
      await prisma.jugadorFabricanteId
        .upsert({
          where: { jugadorId_fabricanteId: { jugadorId: jugador.id, fabricanteId: item.fabricanteId } },
          update: { idExterno, notaBusqueda, ...datosManuales },
          create: { jugadorId: jugador.id, fabricanteId: item.fabricanteId, idExterno, notaBusqueda, ...datosManuales },
        })
        .catch(() => {});
    }
  }

  res.json(actualizado);
});

export default router;
