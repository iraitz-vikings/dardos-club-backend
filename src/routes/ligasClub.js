import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { generarPartidos, aplicarPosicionesRonda1 } from "./torneosClub.js";
import { requireAuth } from "./auth.js";
import { sortearParejasPorGrupos, resolverNombresJugadores } from "../lib/sorteoParejasGrupos.js";
import { notificarJugadores } from "./notificar.js";
import { clasificacionPorGrupos } from "../lib/clasificacionLiga.js";
import { construirRondaUnoConGrupos } from "../lib/cruceGruposFinal.js";
import { diasRestantesPapelera } from "../lib/papelera.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

// "A", "B", "C"... — nombres de grupo para `numeroGrupos` grupos.
function letrasDeGrupos(numeroGrupos) {
  return Array.from({ length: numeroGrupos }, (_, i) => String.fromCharCode(65 + i));
}

const prisma = new PrismaClient();
const router = Router();

const includeCompleto = {
  participantes: { include: { jugador1: true, jugador2: true }, orderBy: { creadoEn: "asc" } },
  partidos: { orderBy: [{ jornada: "asc" }, { posicion: "asc" }] },
  cuadrantes: {
    orderBy: { creadoEn: "asc" },
    include: {
      partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] },
      participantes: { include: { jugador1: true, jugador2: true } },
    },
  },
};

// En todos los listados normales (públicos, admin, socios) se excluyen las
// ligas que están en la papelera (`borradoEn` no nulo) — tienen su propio
// listado en GET /papelera. Ver src/lib/papelera.js.
router.get("/", async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { visibilidad: "publico", borradoEn: null },
    orderBy: { fechaInicio: "desc" },
    include: includeCompleto,
  });
  res.json(ligas);
});

// GET /api/ligas-club/privados - ligas privadas ya finalizadas, para el
// histórico dentro del portal de socios
router.get("/privados", requireAuth, async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { visibilidad: "privado", finalizado: true, borradoEn: null },
    orderBy: { fechaInicio: "desc" },
    select: { id: true, nombre: true, fechaInicio: true, fechaFin: true },
  });
  res.json(ligas);
});

// GET /api/ligas-club/activos - ligas aún no finalizadas, para "Competiciones"
router.get("/activos", requireAuth, async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { finalizado: false, borradoEn: null },
    orderBy: { fechaInicio: "desc" },
    select: { id: true, nombre: true, fechaInicio: true, fechaFin: true, modalidad: true },
  });
  res.json(ligas);
});

router.get("/todos", requireAdmin, async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { borradoEn: null },
    orderBy: { fechaInicio: "desc" },
    include: includeCompleto,
  });
  res.json(ligas);
});

// GET /api/ligas-club/papelera - ligas borradas en los últimos 7 días, con
// los días que quedan antes de que el cron nocturno las purgue de verdad
// (ver src/lib/limpiarPapelera.js). Solo admin.
router.get("/papelera", requireAdmin, async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { borradoEn: { not: null } },
    orderBy: { borradoEn: "desc" },
    include: includeCompleto,
  });
  res.json(ligas.map((l) => ({ ...l, diasRestantes: diasRestantesPapelera(l.borradoEn) })));
});

router.get("/:id", async (req, res) => {
  const liga = await prisma.ligaClub.findUnique({ where: { id: req.params.id }, include: includeCompleto });
  if (!liga || liga.borradoEn) return res.status(404).json({ error: "Liga no encontrada" });
  res.json(liga);
});

// Valida `numeroGrupos`: vacío/null/1 = sin grupos (undefined en el
// resultado); si se indica, tiene que ser un entero par >= 2 para poder
// cruzar los grupos en el cuadrante final (ver lib/cruceGruposFinal.js).
function validarNumeroGrupos(valor) {
  if (valor === undefined || valor === null || valor === "" || Number(valor) === 1) {
    return { ok: true, numeroGrupos: null };
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 2 || n % 2 !== 0) {
    return { ok: false, error: "El número de grupos tiene que ser un número par (2, 4, 6…) para poder cruzarlos en el cuadrante final." };
  }
  return { ok: true, numeroGrupos: n };
}

router.post("/", requireAdmin, async (req, res) => {
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, modalidad, vueltas, numeroParticipantes, numeroGrupos, metodoSorteoParejas, afectaCalendario } = req.body;
  if (!nombre || !fechaInicio || !fechaFin || !numeroParticipantes) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  const modalidadesValidas = ["individual", "parejas_hechas", "parejas_ciegas"];
  const metodosValidos = ["AB", "ABC", "ABCD"];

  const grupos = validarNumeroGrupos(numeroGrupos);
  if (!grupos.ok) return res.status(400).json({ error: grupos.error });
  if (grupos.numeroGrupos && Number(numeroParticipantes) < grupos.numeroGrupos * 2) {
    return res.status(400).json({ error: `Con ${grupos.numeroGrupos} grupos hacen falta al menos ${grupos.numeroGrupos * 2} participantes (2 por grupo como mínimo).` });
  }

  const liga = await prisma.ligaClub.create({
    data: {
      nombre,
      descripcion: descripcion || null,
      fechaInicio: new Date(fechaInicio),
      fechaFin: new Date(fechaFin),
      insigniaUrl: insigniaUrl || null,
      visibilidad: visibilidad === "publico" ? "publico" : "privado",
      modalidad: modalidadesValidas.includes(modalidad) ? modalidad : "individual",
      vueltas: Number(vueltas) === 2 ? 2 : 1,
      numeroParticipantes: Number(numeroParticipantes),
      numeroGrupos: grupos.numeroGrupos,
      metodoSorteoParejas: metodosValidos.includes(metodoSorteoParejas) ? metodoSorteoParejas : null,
      afectaCalendario: afectaCalendario !== undefined ? !!afectaCalendario : true,
    },
  });
  res.status(201).json(liga);
});

router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, finalizado, numeroGrupos } = req.body;

  let numeroGruposData;
  if (numeroGrupos !== undefined) {
    const grupos = validarNumeroGrupos(numeroGrupos);
    if (!grupos.ok) return res.status(400).json({ error: grupos.error });
    numeroGruposData = grupos.numeroGrupos;
  }

  try {
    const liga = await prisma.ligaClub.update({
      where: { id },
      data: {
        nombre,
        descripcion: descripcion || null,
        fechaInicio: fechaInicio ? new Date(fechaInicio) : undefined,
        fechaFin: fechaFin ? new Date(fechaFin) : undefined,
        insigniaUrl: insigniaUrl || null,
        visibilidad: visibilidad === "publico" ? "publico" : "privado",
        finalizado: finalizado !== undefined ? !!finalizado : undefined,
        numeroGrupos: numeroGrupos !== undefined ? numeroGruposData : undefined,
      },
    });
    res.json(liga);
  } catch {
    res.status(404).json({ error: "Liga no encontrada" });
  }
});

// Borra definitivamente una liga del club y todo lo que cuelga de ella
// (cuadrante final si lo tiene, calendario, participantes). La usan tanto
// el borrado definitivo a mano (DELETE /:id/definitivo) como el cron
// nocturno que purga la papelera pasados los 7 días (ver
// src/lib/limpiarPapelera.js). El cuadrante final de la liga (si lo tiene)
// cuelga de Cuadrante.ligaId, con sus propios CuadroPartido/
// ParticipanteCuadrante — sin este borrado, el delete de más abajo falla
// por la relación pendiente.
export async function purgarLiga(id) {
  const cuadrantes = await prisma.cuadrante.findMany({ where: { ligaId: id }, select: { id: true } });
  const cuadranteIds = cuadrantes.map((c) => c.id);
  await prisma.cuadroPartido.deleteMany({ where: { cuadranteId: { in: cuadranteIds } } });
  await prisma.participanteCuadrante.deleteMany({ where: { cuadranteId: { in: cuadranteIds } } });
  await prisma.cuadrante.deleteMany({ where: { ligaId: id } });
  await prisma.partidoLiga.deleteMany({ where: { ligaId: id } });
  await prisma.participanteLiga.deleteMany({ where: { ligaId: id } });
  await prisma.ligaClub.delete({ where: { id } });
}

// DELETE /api/ligas-club/:id - envía la liga a la papelera (borrado suave,
// marca `borradoEn`): desaparece de todos los listados normales y del
// historial de los jugadores, pero se puede restaurar hasta 7 días desde
// GET /papelera. Si nadie la restaura, el cron nocturno la purga de verdad.
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await prisma.ligaClub.update({ where: { id: req.params.id }, data: { borradoEn: new Date() } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Liga no encontrada" });
    console.error("Error moviendo liga a la papelera:", err);
    res.status(500).json({ error: "No se pudo borrar la liga." });
  }
});

// POST /api/ligas-club/:id/restaurar - saca una liga de la papelera
router.post("/:id/restaurar", requireAdmin, async (req, res) => {
  try {
    const liga = await prisma.ligaClub.update({ where: { id: req.params.id }, data: { borradoEn: null } });
    res.json(liga);
  } catch {
    res.status(404).json({ error: "Liga no encontrada" });
  }
});

// DELETE /api/ligas-club/:id/definitivo - borra ya, sin esperar a que pasen
// los 7 días de la papelera (mismo borrado en cascada que antes hacía
// DELETE /:id directamente).
router.delete("/:id/definitivo", requireAdmin, async (req, res) => {
  await purgarLiga(req.params.id);
  res.status(204).end();
});

// ---- Participantes (mismo patrón que en torneos del club) ----

router.post("/:ligaId/participantes", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const { jugador1Id, nombre1, jugador2Id, nombre2, nombre } = req.body;

  async function resolverLado(id, nombreLibre) {
    if (id) {
      const j = await prisma.jugador.findUnique({ where: { id } });
      if (!j) return { error: true };
      // Si el jugador tiene alias puesto en su perfil, se usa ese en vez del
      // nombre real para la etiqueta del participante.
      return { id: j.id, nombre: j.apodo || j.nombre };
    }
    if (nombreLibre && nombreLibre.trim()) {
      return { id: null, nombre: nombreLibre.trim() };
    }
    return null;
  }

  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });

  const lado1 = await resolverLado(jugador1Id, nombre1 || nombre);
  if (!lado1) return res.status(400).json({ error: "Falta el primer participante" });
  if (lado1.error) return res.status(404).json({ error: "Jugador no encontrado" });

  const lado2 = jugador2Id || nombre2 ? await resolverLado(jugador2Id, nombre2) : null;
  if (lado2?.error) return res.status(404).json({ error: "El segundo jugador no existe" });

  const actuales = await prisma.participanteLiga.count({ where: { ligaId } });
  if (actuales >= liga.numeroParticipantes) {
    return res.status(400).json({ error: `Esta liga es de ${liga.numeroParticipantes} participantes como máximo.` });
  }

  const etiqueta = lado2 ? `${lado1.nombre} / ${lado2.nombre}` : lado1.nombre;

  try {
    const participante = await prisma.participanteLiga.create({
      data: { ligaId, etiqueta, jugador1Id: lado1.id, jugador2Id: lado2?.id || null },
    });
    res.status(201).json(participante);
  } catch {
    res.status(409).json({ error: "Ya hay un participante con esa etiqueta en esta liga" });
  }
});

router.delete("/participantes/:id", requireAdmin, async (req, res) => {
  await prisma.participanteLiga.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

router.post("/:ligaId/sortear-parejas-grupos", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });

  const metodo = liga.metodoSorteoParejas;
  if (!metodo) return res.status(400).json({ error: "Esta liga no tiene definido un método de sorteo de parejas." });

  const { entradas } = req.body;
  if (!Array.isArray(entradas) || entradas.length === 0) {
    return res.status(400).json({ error: "No hay participantes para sortear." });
  }

  let parejas;
  try {
    parejas = sortearParejasPorGrupos(entradas, metodo);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const nombresPorId = await resolverNombresJugadores(prisma, entradas);
  const creadas = [];
  for (const [e1, e2] of parejas) {
    const nombre1 = e1.jugadorId ? nombresPorId.get(e1.jugadorId) : e1.nombre;
    const nombre2 = e2.jugadorId ? nombresPorId.get(e2.jugadorId) : e2.nombre;
    const etiqueta = `${nombre1} / ${nombre2}`;
    const participante = await prisma.participanteLiga.create({
      data: { ligaId, etiqueta, jugador1Id: e1.jugadorId || null, jugador2Id: e2.jugadorId || null },
    });
    creadas.push(participante);
  }

  res.status(201).json(creadas);
});

// POST /api/ligas-club/:ligaId/repartir-grupos - asigna el `grupo` (A, B, C…)
// de cada participante ya apuntado a la liga. Solo tiene sentido si la liga
// tiene `numeroGrupos` definido.
//   - modo "auto": baraja a todos los participantes y los reparte "como se
//     dan cartas" en los grupos, de forma que la diferencia de tamaño entre
//     grupos sea como mucho de 1.
//   - modo "manual": aplica las asignaciones indicadas en `asignaciones`
//     ([{ participanteId, grupo }]), que tienen que cubrir a TODOS los
//     participantes de la liga.
router.post("/:ligaId/repartir-grupos", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const { modo, asignaciones } = req.body;

  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId }, include: { participantes: true } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });
  if (!liga.numeroGrupos) return res.status(400).json({ error: "Esta liga no tiene grupos configurados." });

  const gruposValidos = letrasDeGrupos(liga.numeroGrupos);

  if (modo === "auto") {
    const participantes = [...liga.participantes];
    for (let i = participantes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [participantes[i], participantes[j]] = [participantes[j], participantes[i]];
    }
    await prisma.$transaction(
      participantes.map((p, i) =>
        prisma.participanteLiga.update({
          where: { id: p.id },
          data: { grupo: gruposValidos[i % gruposValidos.length] },
        })
      )
    );
  } else if (modo === "manual") {
    if (!Array.isArray(asignaciones)) return res.status(400).json({ error: "Faltan las asignaciones." });
    const idsLiga = new Set(liga.participantes.map((p) => p.id));
    const idsAsignados = new Set(asignaciones.map((a) => a.participanteId));
    for (const a of asignaciones) {
      if (!idsLiga.has(a.participanteId)) return res.status(400).json({ error: "Hay un participante que no pertenece a esta liga." });
      if (!gruposValidos.includes(a.grupo)) return res.status(400).json({ error: `Grupo inválido: ${a.grupo}` });
    }
    if (idsAsignados.size !== idsLiga.size) {
      return res.status(400).json({ error: "Falta asignar grupo a algún participante." });
    }
    await prisma.$transaction(
      asignaciones.map((a) =>
        prisma.participanteLiga.update({ where: { id: a.participanteId }, data: { grupo: a.grupo } })
      )
    );
  } else {
    return res.status(400).json({ error: "Modo de reparto no válido (usa 'auto' o 'manual')." });
  }

  const ligaCompleta = await prisma.ligaClub.findUnique({ where: { id: ligaId }, include: includeCompleto });
  res.json(ligaCompleta);
});

// ---- Calendario (método del círculo: todos contra todos) ----

// Genera las jornadas de una sola "mini-liga" (una lista de etiquetas),
// aplicando el número de vueltas indicado. Misma lógica de siempre (método
// del círculo), extraída para poder aplicarla una vez por grupo cuando la
// liga tiene grupos, y sobre todos los participantes cuando no los tiene.
function generarJornadas(etiquetas, vueltas) {
  let lista = [...etiquetas];
  if (lista.length % 2 !== 0) lista.push(null); // hueco de descanso si son impares
  const n = lista.length;
  const mitad = n / 2;

  let arr = [...lista];
  const jornadas = [];
  for (let j = 0; j < n - 1; j++) {
    const partidos = [];
    for (let i = 0; i < mitad; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== null && b !== null) partidos.push([a, b]);
    }
    jornadas.push(partidos);
    const fijo = arr[0];
    const resto = arr.slice(1);
    resto.unshift(resto.pop());
    arr = [fijo, ...resto];
  }

  if (vueltas === 2) {
    const vueltaDos = jornadas.map((j) => j.map(([a, b]) => [b, a]));
    return [...jornadas, ...vueltaDos];
  }
  return jornadas;
}

router.post("/:ligaId/generar-calendario", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId }, include: { participantes: true } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });

  const etiquetas = liga.participantes.map((p) => p.etiqueta);
  if (etiquetas.length < 2) return res.status(400).json({ error: "Hacen falta al menos 2 participantes." });
  if (etiquetas.length !== liga.numeroParticipantes) {
    return res.status(400).json({
      error: `Esta liga está pensada para ${liga.numeroParticipantes} participantes; ahora mismo hay ${etiquetas.length} apuntados.`,
    });
  }

  // Con grupos: cada grupo juega su propio todos-contra-todos por separado.
  // Sin grupos: como siempre, una única mini-liga con todo el mundo.
  let gruposDeJuego; // [{ grupo: "A"|null, etiquetas: [...] }]
  if (liga.numeroGrupos) {
    const sinGrupo = liga.participantes.filter((p) => !p.grupo);
    if (sinGrupo.length > 0) {
      return res.status(400).json({
        error: `${sinGrupo.length} participante(s) todavía no tienen grupo asignado. Repártelos en grupos antes de generar el calendario.`,
      });
    }
    const letras = letrasDeGrupos(liga.numeroGrupos);
    gruposDeJuego = letras
      .map((g) => ({ grupo: g, etiquetas: liga.participantes.filter((p) => p.grupo === g).map((p) => p.etiqueta) }))
      .filter((g) => g.etiquetas.length > 0);
    const vacios = letras.filter((g) => !gruposDeJuego.some((gg) => gg.grupo === g));
    if (vacios.length > 0) {
      return res.status(400).json({ error: `El/los grupo(s) ${vacios.join(", ")} no tienen ningún participante.` });
    }
  } else {
    gruposDeJuego = [{ grupo: null, etiquetas }];
  }

  await prisma.partidoLiga.deleteMany({ where: { ligaId } });

  const datos = [];
  for (const { grupo, etiquetas: etiquetasGrupo } of gruposDeJuego) {
    const jornadas = generarJornadas(etiquetasGrupo, liga.vueltas);
    jornadas.forEach((partidos, jIdx) => {
      partidos.forEach(([a, b], pIdx) => {
        datos.push({ ligaId, jornada: jIdx + 1, posicion: pIdx, participante1: a, participante2: b, grupo });
      });
    });
  }
  await prisma.partidoLiga.createMany({ data: datos });

  const ligaCompleta = await prisma.ligaClub.findUnique({ where: { id: ligaId }, include: includeCompleto });
  res.json(ligaCompleta);
});

// GET /api/ligas-club/:ligaId/clasificacion - clasificación calculada en el
// servidor (con la cascada de desempate de lib/clasificacionLiga.js), ya
// dividida por grupo si la liga los usa. Se expone como endpoint propio en
// vez de dejar que cada pantalla (admin, página pública) recalcule su
// propia versión simplificada, para que el desempate sea el mismo en todas
// partes y no se pueda ver un orden distinto según desde dónde se mire.
router.get("/:ligaId/clasificacion", async (req, res) => {
  const { ligaId } = req.params;
  const liga = await prisma.ligaClub.findUnique({
    where: { id: ligaId },
    include: { participantes: true, partidos: true },
  });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });
  res.json(clasificacionPorGrupos(liga));
});

// Avisa (Web Push/Telegram) a los jugadores del club implicados en un
// partido de liga, si son socios con cuenta. Mismo patrón que en
// torneosClub.js (ver notificarPartidoDeCuadrante), adaptado a
// ParticipanteLiga/PartidoLiga.
async function notificarPartidoDeLiga(partido, motivo = "programado") {
  const etiquetas = [partido.participante1, partido.participante2].filter(Boolean);
  if (etiquetas.length === 0) return;

  const [participantes, liga] = await Promise.all([
    prisma.participanteLiga.findMany({ where: { ligaId: partido.ligaId, etiqueta: { in: etiquetas } } }),
    prisma.ligaClub.findUnique({ where: { id: partido.ligaId } }),
  ]);
  const jugadorIds = participantes.flatMap((p) => [p.jugador1Id, p.jugador2Id]).filter(Boolean);
  if (jugadorIds.length === 0) return;

  const nombreLiga = liga?.nombre || "Liga del club";
  const enfrentamiento = `${partido.participante1 || "?"} vs ${partido.participante2 || "?"}`;

  if (motivo === "en_curso") {
    await notificarJugadores(jugadorIds, {
      titulo: `¡Tu partido empieza ahora! ${nombreLiga}`,
      cuerpo: `${enfrentamiento}${partido.maquina ? ` en ${partido.maquina}` : ""}.`,
    });
    return;
  }

  const fechaTexto = partido.fechaCalendario
    ? new Date(partido.fechaCalendario).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" })
    : null;
  await notificarJugadores(jugadorIds, {
    titulo: `Partido programado: ${nombreLiga}`,
    cuerpo: `${enfrentamiento}${fechaTexto ? ` el ${fechaTexto}` : ""}${
      partido.maquinaCalendario ? ` en ${partido.maquinaCalendario.nombre}` : ""
    }.`,
  });
}

// PUT /api/ligas-club/partidos/:partidoId/calendario - programa un partido de
// liga en el calendario general, con fecha y máquina
router.put("/partidos/:partidoId/calendario", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { fecha, maquinaId, confirmado } = req.body;
  const antes = await prisma.partidoLiga.findUnique({ where: { id: partidoId } });
  if (!antes) return res.status(404).json({ error: "Enfrentamiento no encontrado" });
  try {
    const partido = await prisma.partidoLiga.update({
      where: { id: partidoId },
      data: {
        fechaCalendario: fecha !== undefined ? (fecha ? new Date(fecha) : null) : undefined,
        maquinaCalendarioId: maquinaId !== undefined ? (maquinaId || null) : undefined,
        confirmadoCalendario: confirmado !== undefined ? !!confirmado : undefined,
      },
      include: { maquinaCalendario: true },
    });

    if (!antes.confirmadoCalendario && partido.confirmadoCalendario) {
      notificarPartidoDeLiga(partido).catch((err) =>
        console.error("Error notificando partido de liga:", err.message || err)
      );
    }

    res.json(partido);
  } catch {
    res.status(404).json({ error: "Enfrentamiento no encontrado" });
  }
});

router.put("/partidos/:partidoId", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { resultado, ganador, maquina, enCurso } = req.body;
  const antes = await prisma.partidoLiga.findUnique({ where: { id: partidoId } });
  if (!antes) return res.status(404).json({ error: "Enfrentamiento no encontrado" });
  try {
    const partido = await prisma.partidoLiga.update({
      where: { id: partidoId },
      data: {
        resultado: resultado !== undefined ? resultado || null : undefined,
        ganador: ganador !== undefined ? ganador || null : undefined,
        maquina: maquina !== undefined ? maquina || null : undefined,
        enCurso: enCurso !== undefined ? !!enCurso : undefined,
      },
    });

    // Mismo aviso "tu partido empieza ahora" que en torneosClub.js, solo en
    // la transición false -> true.
    if (!antes.enCurso && partido.enCurso) {
      notificarPartidoDeLiga(partido, "en_curso").catch((err) =>
        console.error("Error notificando partido de liga en curso:", err.message || err)
      );
    }

    res.json(partido);
  } catch {
    res.status(404).json({ error: "Enfrentamiento no encontrado" });
  }
});

// POST /api/ligas-club/:ligaId/cuadrante-final - crea el cuadrante final de una
// liga (colgado de la liga, no de un torneo). El sorteo en sí se hace después con
// el mismo endpoint que usan los torneos (/api/torneos-club/cuadrantes/:id/sorteo).
router.post("/:ligaId/cuadrante-final", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const { nombre, tamano, tipoEliminacion } = req.body;
  const tamanoNum = Number(tamano);
  const tamanosValidos = [4, 8, 16, 32, 64, 128];
  if (!tamanosValidos.includes(tamanoNum)) {
    return res.status(400).json({ error: "Tamaño de cuadrante no válido." });
  }
  const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId } });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });

  const tipo = tipoEliminacion === "doble" ? "doble" : "directa";
  const cuadrante = await prisma.cuadrante.create({
    data: { ligaId, nombre: nombre || "Cuadrante final", tamano: tamanoNum, tipoEliminacion: tipo },
  });

  const partidos = generarPartidos(tamanoNum, tipo);
  await prisma.cuadroPartido.createMany({ data: partidos.map((p) => ({ ...p, cuadranteId: cuadrante.id })) });

  const cuadranteCompleto = await prisma.cuadrante.findUnique({
    where: { id: cuadrante.id },
    include: { partidos: { orderBy: [{ rama: "asc" }, { ronda: "asc" }, { posicion: "asc" }] } },
  });
  res.status(201).json(cuadranteCompleto);
});

// POST /api/ligas-club/:ligaId/cuadrante-final-grupos - crea el cuadrante
// final de una liga CON grupos, cruzando los grupos "de fuera hacia dentro"
// (A-D, B-C…) y respetando la posición de cada uno dentro de su grupo — ver
// lib/cruceGruposFinal.js. A diferencia de /cuadrante-final (que crea el
// cuadrante vacío para sortearlo después con el endpoint genérico de
// torneos), este además calcula y aplica el reparto de la ronda 1 en el
// mismo paso, porque el tamaño del cuadrante depende del propio cálculo
// (número de grupos × clasificados por grupo, redondeado a la potencia de
// dos superior).
router.post("/:ligaId/cuadrante-final-grupos", requireAdmin, async (req, res) => {
  const { ligaId } = req.params;
  const { nombre, tipoEliminacion, numClasificadosPorGrupo } = req.body;
  const n = Number(numClasificadosPorGrupo);
  if (!Number.isInteger(n) || n < 1) {
    return res.status(400).json({ error: "Indica cuántos clasifican de cada grupo (1 o más)." });
  }

  const liga = await prisma.ligaClub.findUnique({
    where: { id: ligaId },
    include: { participantes: true, partidos: true },
  });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });
  if (!liga.numeroGrupos) return res.status(400).json({ error: "Esta liga no tiene grupos configurados." });

  const { grupos: clasificacionGrupos } = clasificacionPorGrupos(liga);

  let tamano, posiciones;
  try {
    ({ tamano, posiciones } = construirRondaUnoConGrupos(clasificacionGrupos, n));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const tipo = tipoEliminacion === "doble" ? "doble" : "directa";
  const cuadrante = await prisma.cuadrante.create({
    data: { ligaId, nombre: nombre || "Cuadrante final", tamano, tipoEliminacion: tipo },
  });

  const partidos = generarPartidos(tamano, tipo);
  await prisma.cuadroPartido.createMany({ data: partidos.map((p) => ({ ...p, cuadranteId: cuadrante.id })) });

  const cuadranteCompleto = await aplicarPosicionesRonda1(cuadrante.id, posiciones);
  res.status(201).json(cuadranteCompleto);
});

export default router;
