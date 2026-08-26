import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const prisma = new PrismaClient();
const router = Router();

// GET /api/jugadores - lista todos los jugadores del club (protegido), incluye
// invitados sin cuenta de socio (usuarioId null)
router.get("/", requireAdmin, async (_req, res) => {
  const jugadores = await prisma.jugador.findMany({
    include: { usuario: { select: { email: true } } },
    orderBy: { nombre: "asc" },
  });
  res.json(jugadores);
});

// POST /api/jugadores - crea un jugador rápido (invitado, sin cuenta) (protegido)
router.post("/", requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: "Falta el nombre" });
  }
  const jugador = await prisma.jugador.create({ data: { nombre: nombre.trim() } });
  res.status(201).json(jugador);
});

// GET /api/jugadores/directorio - lista pública para socios logueados (sin datos
// sensibles como el email). Incluye las medias (MPR/PPD) de fabricante de cada
// jugador para poder mostrarlas al hacer clic en su perfil; se omite
// deliberadamente `statsError` (puede llevar un volcado largo del texto de
// diagnóstico de la web del fabricante, pensado para depurar el scraper, no
// para enseñarlo a otros socios).
router.get("/directorio", requireAuth, async (_req, res) => {
  const jugadores = await prisma.jugador.findMany({
    orderBy: { nombre: "asc" },
    select: {
      id: true,
      nombre: true,
      apodo: true,
      avatarUrl: true,
      bio: true,
      usuarioId: true,
      idsFabricantes: {
        select: {
          idExterno: true,
          mpr: true,
          ppd: true,
          mprVirtual: true,
          ppdVirtual: true,
          mprPresencial: true,
          ppdPresencial: true,
          fabricante: { select: { id: true, nombre: true, urlPerfilPlantilla: true, logoUrl: true } },
        },
      },
    },
  });
  const resultado = jugadores.map((j) => ({
    ...j,
    idsFabricantes: j.idsFabricantes.map((i) => ({
      fabricanteId: i.fabricante.id,
      nombreFabricante: i.fabricante.nombre,
      urlPerfilPlantilla: i.fabricante.urlPerfilPlantilla,
      logoUrl: i.fabricante.logoUrl,
      idExterno: i.idExterno,
      mpr: i.mpr,
      ppd: i.ppd,
      mprVirtual: i.mprVirtual,
      ppdVirtual: i.ppdVirtual,
      mprPresencial: i.mprPresencial,
      ppdPresencial: i.ppdPresencial,
    })),
  }));
  res.json(resultado);
});

// Calcula el historial de torneos/ligas del club de un jugador dado su id.
// Es la misma lógica que GET /api/perfil/historial (que solo puede consultar
// el socio logueado sobre sí mismo), extraída aquí para poder parametrizarla
// por jugadorId y así mostrar el palmarés de cualquier jugador del club desde
// el directorio de "Jugadores del club" (ver GET /:id/historial más abajo).
async function historialDeJugador(jugadorId) {
  // borradoEn: null filtra los torneos/ligas en la papelera (ver
  // src/lib/papelera.js): mientras no se purguen de verdad o se restauren,
  // no deben aparecer en el palmarés de ningún jugador.
  const participacionesTorneosRaw = await prisma.participanteCuadrante.findMany({
    where: { OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] },
    include: { cuadrante: { include: { torneoClub: true, liga: true } } },
  });
  const participacionesTorneos = participacionesTorneosRaw.filter(
    (p) => !p.cuadrante.torneoClub?.borradoEn && !p.cuadrante.liga?.borradoEn
  );

  const cuadranteIds = [...new Set(participacionesTorneos.map((p) => p.cuadranteId))];
  const etiquetasTorneos = [...new Set(participacionesTorneos.map((p) => p.etiqueta))];
  const todosPartidosTorneos = cuadranteIds.length
    ? await prisma.cuadroPartido.findMany({
        where: {
          cuadranteId: { in: cuadranteIds },
          OR: [{ jugador1: { in: etiquetasTorneos } }, { jugador2: { in: etiquetasTorneos } }],
        },
        orderBy: [{ rama: "asc" }, { ronda: "asc" }],
      })
    : [];

  const historialTorneos = participacionesTorneos.map((p) => {
    const partidos = todosPartidosTorneos.filter(
      (partido) => partido.cuadranteId === p.cuadranteId && (partido.jugador1 === p.etiqueta || partido.jugador2 === p.etiqueta)
    );
    return {
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
    };
  });

  const participacionesLigasRaw = await prisma.participanteLiga.findMany({
    where: { OR: [{ jugador1Id: jugadorId }, { jugador2Id: jugadorId }] },
    include: { liga: true },
  });
  const participacionesLigas = participacionesLigasRaw.filter((p) => !p.liga?.borradoEn);

  const ligaIds = [...new Set(participacionesLigas.map((p) => p.ligaId))];
  const etiquetasLigas = [...new Set(participacionesLigas.map((p) => p.etiqueta))];
  const todosPartidosLigas = ligaIds.length
    ? await prisma.partidoLiga.findMany({
        where: {
          ligaId: { in: ligaIds },
          OR: [{ participante1: { in: etiquetasLigas } }, { participante2: { in: etiquetasLigas } }],
        },
        orderBy: { jornada: "asc" },
      })
    : [];

  const historialLigas = participacionesLigas.map((p) => {
    const partidos = todosPartidosLigas.filter(
      (partido) => partido.ligaId === p.ligaId && (partido.participante1 === p.etiqueta || partido.participante2 === p.etiqueta)
    );
    return {
      nombre: p.liga.nombre,
      etiqueta: p.etiqueta,
      partidos: partidos.map((partido) => ({
        jornada: partido.jornada,
        rival: partido.participante1 === p.etiqueta ? partido.participante2 : partido.participante1,
        resultado: partido.resultado,
        ganado: partido.ganador ? partido.ganador === p.etiqueta : null,
      })),
    };
  });

  return { torneos: historialTorneos, ligas: historialLigas };
}

// GET /api/jugadores/:id/historial - palmarés (torneos y ligas del club en
// los que ha participado) de un jugador cualquiera del directorio. Protegido
// con requireAuth igual que /directorio: es información visible entre
// socios, no pública en internet. Va antes de DELETE /:id a propósito, sin
// que compartan método así que el orden no importa para el enrutado, pero se
// deja aquí junto a la función que usa.
router.get("/:id/historial", requireAuth, async (req, res) => {
  const jugador = await prisma.jugador.findUnique({ where: { id: req.params.id } });
  if (!jugador) return res.status(404).json({ error: "Jugador no encontrado" });
  const historial = await historialDeJugador(jugador.id);
  res.json(historial);
});

// DELETE /api/jugadores/:id - borra un jugador (protegido). Si pertenece a un
// equipo del club o a la plantilla de una inscripción externa, la base de
// datos rechaza el borrado (relación obligatoria) — antes eso se tragaba en
// silencio y el admin recibía un "borrado" que no era cierto; ahora se
// responde con un error explicando qué lo bloquea.
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.jugador.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(204).end(); // ya no existía
    if (err.code === "P2003") {
      return res.status(409).json({
        error:
          "No se puede borrar: este jugador pertenece a un equipo del club o a la plantilla de una competición externa. Quítalo de ahí primero.",
      });
    }
    console.error("Error borrando jugador:", err);
    res.status(500).json({ error: "No se pudo borrar el jugador." });
  }
});

export default router;
