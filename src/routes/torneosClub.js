import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";

const prisma = new PrismaClient();
const router = Router();

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

const includeCompleto = {
  cuadrantes: {
    orderBy: { creadoEn: "asc" },
    include: { partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] } },
  },
};

// ---------- Generador de cuadros (eliminación directa / doble) ----------

function log2(n) {
  return Math.round(Math.log2(n));
}

function generarPartidos(tamano, tipoEliminacion) {
  const k = log2(tamano);
  const partidos = [];

  const nuevoPartido = (rama, ronda, posicion) => {
    const p = {
      id: randomUUID(),
      rama,
      ronda,
      posicion,
      jugador1: null,
      jugador2: null,
      siguientePartidoGanadorId: null,
      siguienteSlotGanador: null,
      siguientePartidoPerdedorId: null,
      siguienteSlotPerdedor: null,
    };
    partidos.push(p);
    return p;
  };

  const wbRondas = [];
  for (let r = 0; r < k; r++) {
    const count = tamano / Math.pow(2, r + 1);
    const ronda = [];
    for (let i = 0; i < count; i++) ronda.push(nuevoPartido("ganadores", r + 1, i));
    wbRondas.push(ronda);
  }
  for (let r = 0; r < k - 1; r++) {
    for (let i = 0; i < wbRondas[r].length; i++) {
      const actual = wbRondas[r][i];
      const siguiente = wbRondas[r + 1][Math.floor(i / 2)];
      actual.siguientePartidoGanadorId = siguiente.id;
      actual.siguienteSlotGanador = i % 2 === 0 ? 1 : 2;
    }
  }

  if (tipoEliminacion !== "doble" || k < 2) {
    return partidos;
  }

  const lbRondas = [];
  for (let g = 1; g <= k - 1; g++) {
    const count = tamano / Math.pow(2, g + 1);
    const rondaA = [];
    for (let i = 0; i < count; i++) rondaA.push(nuevoPartido("perdedores", 2 * g - 1, i));
    lbRondas.push(rondaA);
    const rondaB = [];
    for (let i = 0; i < count; i++) rondaB.push(nuevoPartido("perdedores", 2 * g, i));
    lbRondas.push(rondaB);
  }

  {
    const wbR1 = wbRondas[0];
    const lbR1 = lbRondas[0];
    for (let i = 0; i < lbR1.length; i++) {
      wbR1[2 * i].siguientePartidoPerdedorId = lbR1[i].id;
      wbR1[2 * i].siguienteSlotPerdedor = 1;
      wbR1[2 * i + 1].siguientePartidoPerdedorId = lbR1[i].id;
      wbR1[2 * i + 1].siguienteSlotPerdedor = 2;
    }
  }

  for (let g = 1; g <= k - 1; g++) {
    const rondaA = lbRondas[2 * (g - 1)];
    const rondaB = lbRondas[2 * (g - 1) + 1];
    for (let i = 0; i < rondaA.length; i++) {
      rondaA[i].siguientePartidoGanadorId = rondaB[i].id;
      rondaA[i].siguienteSlotGanador = 1;
    }
    if (g < k) {
      const perdedoresWb = [...wbRondas[g]].reverse();
      for (let i = 0; i < rondaB.length; i++) {
        perdedoresWb[i].siguientePartidoPerdedorId = rondaB[i].id;
        perdedoresWb[i].siguienteSlotPerdedor = 2;
      }
    }
  }

  for (let g = 1; g <= k - 2; g++) {
    const rondaB = lbRondas[2 * (g - 1) + 1];
    const siguienteRondaA = lbRondas[2 * g];
    for (let i = 0; i < siguienteRondaA.length; i++) {
      rondaB[2 * i].siguientePartidoGanadorId = siguienteRondaA[i].id;
      rondaB[2 * i].siguienteSlotGanador = 1;
      rondaB[2 * i + 1].siguientePartidoGanadorId = siguienteRondaA[i].id;
      rondaB[2 * i + 1].siguienteSlotGanador = 2;
    }
  }

  const finalPartido = nuevoPartido("final", 2 * (k - 1) + 1, 0);
  const campeonGanadores = wbRondas[k - 1][0];
  campeonGanadores.siguientePartidoGanadorId = finalPartido.id;
  campeonGanadores.siguienteSlotGanador = 1;
  const finalLb = lbRondas[lbRondas.length - 1][0];
  finalLb.siguientePartidoGanadorId = finalPartido.id;
  finalLb.siguienteSlotGanador = 2;

  return partidos;
}

// ---------- Rutas de torneos del club ----------

router.get("/", async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    where: { visibilidad: "publico" },
    orderBy: { fechaInicio: "desc" },
    include: includeCompleto,
  });
  res.json(torneos);
});

router.get("/todos", requireAdmin, async (_req, res) => {
  const torneos = await prisma.torneoClub.findMany({
    orderBy: { fechaInicio: "desc" },
    include: includeCompleto,
  });
  res.json(torneos);
});

// GET /api/torneos-club/:id - un torneo público concreto, con todo su detalle (para la página del torneo)
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const torneo = await prisma.torneoClub.findUnique({ where: { id }, include: includeCompleto });
  if (!torneo || torneo.visibilidad !== "publico") {
    return res.status(404).json({ error: "Torneo no encontrado" });
  }
  res.json(torneo);
});

router.post("/", requireAdmin, async (req, res) => {
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, numeroMaquinas, tipoEliminacion } = req.body;
  if (!nombre || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  const torneo = await prisma.torneoClub.create({
    data: {
      nombre,
      descripcion: descripcion || null,
      fechaInicio: new Date(fechaInicio),
      fechaFin: new Date(fechaFin),
      insigniaUrl: insigniaUrl || null,
      visibilidad: visibilidad === "publico" ? "publico" : "privado",
      numeroMaquinas: numeroMaquinas ? Number(numeroMaquinas) : null,
      tipoEliminacion: tipoEliminacion === "doble" ? "doble" : "directa",
    },
  });
  res.status(201).json(torneo);
});

router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, numeroMaquinas, tipoEliminacion, finalizado } = req.body;
  try {
    const torneo = await prisma.torneoClub.update({
      where: { id },
      data: {
        nombre,
        descripcion: descripcion || null,
        fechaInicio: fechaInicio ? new Date(fechaInicio) : undefined,
        fechaFin: fechaFin ? new Date(fechaFin) : undefined,
        insigniaUrl: insigniaUrl || null,
        visibilidad: visibilidad === "publico" ? "publico" : "privado",
        numeroMaquinas: numeroMaquinas !== undefined ? (numeroMaquinas ? Number(numeroMaquinas) : null) : undefined,
        tipoEliminacion: tipoEliminacion || undefined,
        finalizado: finalizado !== undefined ? !!finalizado : undefined,
      },
    });
    res.json(torneo);
  } catch {
    res.status(404).json({ error: "Torneo no encontrado" });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const cuadrantes = await prisma.cuadrante.findMany({ where: { torneoClubId: id }, select: { id: true } });
  const cuadranteIds = cuadrantes.map((c) => c.id);
  await prisma.cuadroPartido.deleteMany({ where: { cuadranteId: { in: cuadranteIds } } });
  await prisma.cuadrante.deleteMany({ where: { torneoClubId: id } });
  await prisma.torneoClub.delete({ where: { id } });
  res.status(204).end();
});

router.post("/:id/cuadrantes", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, tamano, tipoEliminacion } = req.body;
  const tamanoNum = Number(tamano);
  const tamanosValidos = [4, 8, 16, 32, 64, 128];
  if (!nombre || !tamanosValidos.includes(tamanoNum)) {
    return res.status(400).json({ error: "Falta el nombre o el tamaño no es válido (4, 8, 16, 32, 64 o 128)" });
  }
  const tipo = tipoEliminacion === "doble" ? "doble" : "directa";

  const cuadrante = await prisma.cuadrante.create({
    data: { torneoClubId: id, nombre, tamano: tamanoNum, tipoEliminacion: tipo },
  });

  const partidos = generarPartidos(tamanoNum, tipo);
  await prisma.cuadroPartido.createMany({
    data: partidos.map((p) => ({ ...p, cuadranteId: cuadrante.id })),
  });

  const cuadranteCompleto = await prisma.cuadrante.findUnique({
    where: { id: cuadrante.id },
    include: { partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] } },
  });
  res.status(201).json(cuadranteCompleto);
});

router.delete("/cuadrantes/:cuadranteId", requireAdmin, async (req, res) => {
  const { cuadranteId } = req.params;
  await prisma.cuadroPartido.deleteMany({ where: { cuadranteId } });
  await prisma.cuadrante.delete({ where: { id: cuadranteId } });
  res.status(204).end();
});

router.put("/partidos/:partidoId", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { maquina, jugador1, jugador2, resultado, ganador, enCurso } = req.body;

  const actual = await prisma.cuadroPartido.findUnique({ where: { id: partidoId } });
  if (!actual) return res.status(404).json({ error: "Enfrentamiento no encontrado" });

  if (enCurso) {
    const maquinaFinal = maquina !== undefined ? maquina : actual.maquina;
    if (maquinaFinal) {
      const cuadrante = await prisma.cuadrante.findUnique({ where: { id: actual.cuadranteId } });
      const hermanos = await prisma.cuadroPartido.findMany({
        where: { cuadrante: { torneoClubId: cuadrante.torneoClubId }, maquina: maquinaFinal },
      });
      await prisma.cuadroPartido.updateMany({
        where: { id: { in: hermanos.map((h) => h.id) } },
        data: { enCurso: false },
      });
    }
  }

  const partido = await prisma.cuadroPartido.update({
    where: { id: partidoId },
    data: {
      maquina: maquina !== undefined ? maquina || null : undefined,
      jugador1: jugador1 !== undefined ? jugador1 || null : undefined,
      jugador2: jugador2 !== undefined ? jugador2 || null : undefined,
      resultado: resultado !== undefined ? resultado || null : undefined,
      ganador: ganador !== undefined ? ganador || null : undefined,
      enCurso: enCurso !== undefined ? !!enCurso : undefined,
    },
  });

  if (ganador !== undefined && ganador) {
    const jug1 = jugador1 !== undefined ? jugador1 : actual.jugador1;
    const jug2 = jugador2 !== undefined ? jugador2 : actual.jugador2;
    const perdedor = ganador === jug1 ? jug2 : jug1;

    if (partido.siguientePartidoGanadorId) {
      const campo = partido.siguienteSlotGanador === 2 ? "jugador2" : "jugador1";
      await prisma.cuadroPartido.update({
        where: { id: partido.siguientePartidoGanadorId },
        data: { [campo]: ganador },
      });
    }
    if (partido.siguientePartidoPerdedorId && perdedor) {
      const campo = partido.siguienteSlotPerdedor === 2 ? "jugador2" : "jugador1";
      await prisma.cuadroPartido.update({
        where: { id: partido.siguientePartidoPerdedorId },
        data: { [campo]: perdedor },
      });
    }

    // Gran final (doble eliminación): si gana el jugador que venía del cuadro de
    // perdedores (jugador2), ambos quedan con una derrota y hace falta un segundo
    // partido decisivo. Si en cambio gana el que venía de ganadores, el torneo
    // termina ahí y se quita el partido decisivo si se había creado por error.
    if (partido.rama === "final" && partido.posicion === 0) {
      if (ganador === jug2) {
        const existeDesempate = await prisma.cuadroPartido.findFirst({
          where: { cuadranteId: partido.cuadranteId, rama: "final", posicion: 1 },
        });
        if (!existeDesempate) {
          await prisma.cuadroPartido.create({
            data: {
              cuadranteId: partido.cuadranteId,
              rama: "final",
              ronda: partido.ronda + 1,
              posicion: 1,
              jugador1: jug1,
              jugador2: jug2,
            },
          });
        }
      } else {
        await prisma.cuadroPartido.deleteMany({
          where: { cuadranteId: partido.cuadranteId, rama: "final", posicion: 1 },
        });
      }
    }
  }

  res.json(partido);
});

export default router;
