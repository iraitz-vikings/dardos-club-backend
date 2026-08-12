import { Router } from "express";
import { PrismaClient } from "@prisma/client";

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
  participantes: { include: { jugador1: true, jugador2: true }, orderBy: { creadoEn: "asc" } },
  partidos: { orderBy: [{ jornada: "asc" }, { posicion: "asc" }] },
};

router.get("/", async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({
    where: { visibilidad: "publico" },
    orderBy: { fechaInicio: "desc" },
    include: includeCompleto,
  });
  res.json(ligas);
});

router.get("/todos", requireAdmin, async (_req, res) => {
  const ligas = await prisma.ligaClub.findMany({ orderBy: { fechaInicio: "desc" }, include: includeCompleto });
  res.json(ligas);
});

router.get("/:id", async (req, res) => {
  const liga = await prisma.ligaClub.findUnique({ where: { id: req.params.id }, include: includeCompleto });
  if (!liga) return res.status(404).json({ error: "Liga no encontrada" });
  res.json(liga);
});

router.post("/", requireAdmin, async (req, res) => {
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, modalidad, vueltas, numeroParticipantes, metodoSorteoParejas } = req.body;
  if (!nombre || !fechaInicio || !fechaFin || !numeroParticipantes) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }
  const modalidadesValidas = ["individual", "parejas_hechas", "parejas_ciegas"];
  const metodosValidos = ["AB", "ABC", "ABCD"];
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
      metodoSorteoParejas: metodosValidos.includes(metodoSorteoParejas) ? metodoSorteoParejas : null,
    },
  });
  res.status(201).json(liga);
});

router.put("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion, fechaInicio, fechaFin, insigniaUrl, visibilidad, finalizado } = req.body;
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
      },
    });
    res.json(liga);
  } catch {
    res.status(404).json({ error: "Liga no encontrada" });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await prisma.partidoLiga.deleteMany({ where: { ligaId: id } });
  await prisma.participanteLiga.deleteMany({ where: { ligaId: id } });
  await prisma.ligaClub.delete({ where: { id } });
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
      return { id: j.id, nombre: j.nombre };
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

  const gruposValidos = metodo === "AB" ? ["A", "B"] : metodo === "ABC" ? ["A", "B", "C"] : ["A", "B", "C", "D"];
  for (const e of entradas) {
    if (!gruposValidos.includes(e.grupo)) return res.status(400).json({ error: `Grupo inválido: ${e.grupo}` });
    if (!e.jugadorId && !e.nombre) return res.status(400).json({ error: "Falta jugador o nombre en algún participante." });
  }

  const porGrupo = {};
  for (const g of gruposValidos) porGrupo[g] = entradas.filter((e) => e.grupo === g);

  function barajar(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const parejas = [];
  function emparejarCruzado(g1, g2) {
    if (porGrupo[g1].length !== porGrupo[g2].length) {
      throw new Error(`El grupo ${g1} (${porGrupo[g1].length}) y el grupo ${g2} (${porGrupo[g2].length}) deben tener el mismo número de jugadores.`);
    }
    const a = barajar(porGrupo[g1]);
    const b = barajar(porGrupo[g2]);
    for (let i = 0; i < a.length; i++) parejas.push([a[i], b[i]]);
  }
  function emparejarInterno(g) {
    if (porGrupo[g].length % 2 !== 0) {
      throw new Error(`El grupo ${g} (${porGrupo[g].length}) necesita un número par de jugadores para sortearse entre ellos.`);
    }
    const a = barajar(porGrupo[g]);
    for (let i = 0; i < a.length; i += 2) parejas.push([a[i], a[i + 1]]);
  }

  try {
    if (metodo === "AB") emparejarCruzado("A", "B");
    else if (metodo === "ABC") { emparejarCruzado("A", "C"); emparejarInterno("B"); }
    else if (metodo === "ABCD") { emparejarCruzado("A", "D"); emparejarCruzado("B", "C"); }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const creadas = [];
  for (const [e1, e2] of parejas) {
    const nombre1 = e1.jugadorId ? (await prisma.jugador.findUnique({ where: { id: e1.jugadorId } }))?.nombre : e1.nombre;
    const nombre2 = e2.jugadorId ? (await prisma.jugador.findUnique({ where: { id: e2.jugadorId } }))?.nombre : e2.nombre;
    const etiqueta = `${nombre1} / ${nombre2}`;
    const participante = await prisma.participanteLiga.create({
      data: { ligaId, etiqueta, jugador1Id: e1.jugadorId || null, jugador2Id: e2.jugadorId || null },
    });
    creadas.push(participante);
  }

  res.status(201).json(creadas);
});

// ---- Calendario (método del círculo: todos contra todos) ----

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

  await prisma.partidoLiga.deleteMany({ where: { ligaId } });

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

  let todasJornadas = jornadas;
  if (liga.vueltas === 2) {
    const vueltaDos = jornadas.map((j) => j.map(([a, b]) => [b, a]));
    todasJornadas = [...jornadas, ...vueltaDos];
  }

  const datos = [];
  todasJornadas.forEach((partidos, jIdx) => {
    partidos.forEach(([a, b], pIdx) => {
      datos.push({ ligaId, jornada: jIdx + 1, posicion: pIdx, participante1: a, participante2: b });
    });
  });
  await prisma.partidoLiga.createMany({ data: datos });

  const ligaCompleta = await prisma.ligaClub.findUnique({ where: { id: ligaId }, include: includeCompleto });
  res.json(ligaCompleta);
});

router.put("/partidos/:partidoId", requireAdmin, async (req, res) => {
  const { partidoId } = req.params;
  const { resultado, ganador, maquina, enCurso } = req.body;
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
    res.json(partido);
  } catch {
    res.status(404).json({ error: "Enfrentamiento no encontrado" });
  }
});

export default router;
