// Gestión del club → Inscripciones: la "hoja" donde los admins apuntan
// quién se inscribe a cada torneo/liga del club, si ha pagado (cada jugador
// por su lado), cómo y cuánto, y si ha confirmado asistencia. Ver el modelo
// InscripcionClub en schema.prisma. Nadie entra en el torneo/liga hasta que
// se pulsa "Añadir" (POST /:id/anadir o /anadir-listas), y solo si la fila
// está confirmada y pagada por completo. Al terminar el torneo se vacía con
// el reset (DELETE /).
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { JUGADOR_PUBLICO } from "../lib/selectsJugador.js";
import { resolverLadoParticipante } from "./torneosClub.js";

const router = Router();
router.use(requireAdmin);

const MODOS_PAGO = ["efectivo", "bizum", "transferencia", "tarjeta", "otro"];

const includeInscripcion = {
  jugador1: JUGADOR_PUBLICO,
  jugador2: JUGADOR_PUBLICO,
  torneoClub: { select: { id: true, nombre: true, modalidad: true } },
  cuadrante: { select: { id: true, nombre: true } },
  liga: { select: { id: true, nombre: true, modalidad: true, numeroGrupos: true } },
};

// Confirmada, pagada por todos sus jugadores y todavía sin añadir.
export function inscripcionLista(i) {
  return !i.anadidoEn && i.confirmado && i.pagado1 && (!i.nombre2 || i.pagado2);
}

function letrasDeGrupos(numeroGrupos) {
  return Array.from({ length: numeroGrupos || 0 }, (_, i) => String.fromCharCode(65 + i));
}

function leerCantidad(valor) {
  if (valor === null || valor === "" || valor === undefined) return null;
  const n = Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
}

// Un lado (jugador 1 o 2) a partir del body: jugador de la lista
// (jugadorNId), o nombre escrito a mano (nombreN) con la opción de crearle
// ficha en el momento (fichaN: "club" = ficha normal, "invitado" = ficha
// oculta como las de invitado de Telegram). → { jugadorId, nombre } | null
// (vacío) | { error }.
async function resolverLado(body, n) {
  const jugadorId = body[`jugador${n}Id`];
  const nombre = (body[`nombre${n}`] || "").trim();
  const ficha = body[`ficha${n}`];
  if (!jugadorId && nombre && (ficha === "club" || ficha === "invitado")) {
    const j = await prisma.jugador.create({ data: { nombre, oculto: ficha === "invitado" } });
    return { jugadorId: j.id, nombre };
  }
  const lado = await resolverLadoParticipante(jugadorId, nombre);
  if (lado?.error) return { error: `El jugador ${n} no existe` };
  return lado ? { jugadorId: lado.id, nombre: lado.nombre } : null;
}

// Traduce el body (alta o edición parcial) a datos de Prisma, validando.
// `actual` es la fila existente en una edición (null en un alta).
async function datosDesdeBody(body, actual) {
  const data = {};

  // Destino: un torneo (con su cuadrante) o una liga (con su grupo), nunca
  // los dos. Cambiar de uno a otro limpia los campos del otro.
  if (body.torneoClubId !== undefined || body.ligaId !== undefined || body.cuadranteId !== undefined || body.grupo !== undefined) {
    const torneoClubId = body.torneoClubId !== undefined ? body.torneoClubId || null : actual?.torneoClubId || null;
    const ligaId = body.ligaId !== undefined ? body.ligaId || null : actual?.ligaId || null;
    if (torneoClubId && ligaId) return { error: "Una inscripción es para un torneo o para una liga, no para los dos." };

    if (torneoClubId) {
      const cuadranteId = body.cuadranteId !== undefined ? body.cuadranteId || null : actual?.cuadranteId || null;
      if (cuadranteId) {
        const c = await prisma.cuadrante.findUnique({ where: { id: cuadranteId }, select: { torneoClubId: true } });
        if (!c || c.torneoClubId !== torneoClubId) return { error: "Ese cuadrante no es de este torneo." };
      }
      Object.assign(data, { torneoClubId, cuadranteId, ligaId: null, grupo: null });
    } else if (ligaId) {
      const liga = await prisma.ligaClub.findUnique({ where: { id: ligaId }, select: { numeroGrupos: true } });
      if (!liga) return { error: "Liga no encontrada." };
      const grupo = body.grupo !== undefined ? body.grupo || null : actual?.grupo || null;
      if (grupo && !letrasDeGrupos(liga.numeroGrupos).includes(grupo)) return { error: "Esa liga no tiene ese grupo." };
      Object.assign(data, { ligaId, grupo, torneoClubId: null, cuadranteId: null });
    } else {
      Object.assign(data, { torneoClubId: null, cuadranteId: null, ligaId: null, grupo: null });
    }
  }

  for (const n of [1, 2]) {
    if (body[`jugador${n}Id`] !== undefined || body[`nombre${n}`] !== undefined) {
      const lado = await resolverLado(body, n);
      if (lado?.error) return { error: lado.error };
      if (n === 1 && !lado) return { error: "Falta el nombre del jugador." };
      data[`jugador${n}Id`] = lado?.jugadorId || null;
      data[`nombre${n}`] = lado?.nombre || null;
      if (n === 2 && !lado) Object.assign(data, { pagado2: false, modoPago2: null, cantidad2: null });
    }
    if (body[`pagado${n}`] !== undefined) data[`pagado${n}`] = !!body[`pagado${n}`];
    if (body[`modoPago${n}`] !== undefined) {
      const modo = body[`modoPago${n}`] || null;
      if (modo && !MODOS_PAGO.includes(modo)) return { error: "Modo de pago no válido." };
      data[`modoPago${n}`] = modo;
    }
    if (body[`cantidad${n}`] !== undefined) {
      const cantidad = leerCantidad(body[`cantidad${n}`]);
      if (cantidad === undefined) return { error: "La cantidad tiene que ser un número (p.ej. 10 o 7,50)." };
      data[`cantidad${n}`] = cantidad;
    }
  }

  if (body.confirmado !== undefined) data.confirmado = !!body.confirmado;
  if (body.notas !== undefined) data.notas = (body.notas || "").trim() || null;
  // Solo se permite quitar la marca (p.ej. si se ha borrado a mano del
  // torneo y hay que volver a añadirla); ponerla es cosa de /anadir.
  if (body.anadido === false) data.anadidoEn = null;

  // Ya volcada al torneo/liga: no se cambia quién ni dónde, porque el
  // participante creado no se actualizaría y quedarían desincronizados.
  if (actual?.anadidoEn && body.anadido !== false) {
    const tocaDestinoOJugadores = ["torneoClubId", "cuadranteId", "ligaId", "grupo", "jugador1Id", "nombre1", "jugador2Id", "nombre2"].some(
      (k) => k in data && data[k] !== actual[k]
    );
    if (tocaDestinoOJugadores) {
      return { error: "Esta inscripción ya está añadida al torneo/liga. Para cambiar jugadores o destino, quítala de allí y desmarca \"añadida\"." };
    }
  }
  return { data };
}

// GET /api/inscripciones-club - todas las inscripciones + los torneos y
// ligas del club en marcha (con sus cuadrantes/grupos) para los
// desplegables de la hoja.
router.get("/", async (_req, res) => {
  const [inscripciones, torneos, ligas] = await Promise.all([
    prisma.inscripcionClub.findMany({ include: includeInscripcion, orderBy: { creadoEn: "asc" } }),
    prisma.torneoClub.findMany({
      where: { finalizado: false, borradoEn: null },
      select: { id: true, nombre: true, modalidad: true, fechaInicio: true, cuadrantes: { select: { id: true, nombre: true }, orderBy: { creadoEn: "asc" } } },
      orderBy: { fechaInicio: "asc" },
    }),
    prisma.ligaClub.findMany({
      where: { finalizado: false, borradoEn: null },
      select: { id: true, nombre: true, modalidad: true, numeroGrupos: true, numeroParticipantes: true, fechaInicio: true },
      orderBy: { fechaInicio: "asc" },
    }),
  ]);
  res.json({
    inscripciones,
    torneos,
    ligas: ligas.map((l) => ({ ...l, grupos: l.numeroGrupos > 1 ? letrasDeGrupos(l.numeroGrupos) : [] })),
    modosPago: MODOS_PAGO,
  });
});

// GET /api/inscripciones-club/listas?cuadranteId=|ligaId= - las listas
// (confirmadas, pagadas, sin añadir) de un cuadrante o liga, para cargarlas
// en la lista del sorteo de parejas ciegas (allí no hay participantes hasta
// sortear, así que no se pueden añadir de una en una).
router.get("/listas", async (req, res) => {
  const { cuadranteId, ligaId } = req.query;
  if (!cuadranteId && !ligaId) return res.status(400).json({ error: "Falta el cuadrante o la liga." });
  const filas = await prisma.inscripcionClub.findMany({
    where: cuadranteId ? { cuadranteId: String(cuadranteId) } : { ligaId: String(ligaId) },
    include: includeInscripcion,
    orderBy: { creadoEn: "asc" },
  });
  res.json(filas.filter(inscripcionLista));
});

// POST /api/inscripciones-club - nueva fila.
router.post("/", async (req, res) => {
  const { data, error } = await datosDesdeBody(req.body || {}, null);
  if (error) return res.status(400).json({ error });
  if (!data.nombre1) return res.status(400).json({ error: "Falta el nombre del jugador." });
  const inscripcion = await prisma.inscripcionClub.create({ data, include: includeInscripcion });
  res.status(201).json(inscripcion);
});

// PUT /api/inscripciones-club/:id - edición parcial (la hoja guarda celda a
// celda, así que normalmente llega un solo campo).
router.put("/:id", async (req, res) => {
  const actual = await prisma.inscripcionClub.findUnique({ where: { id: req.params.id } });
  if (!actual) return res.status(404).json({ error: "Inscripción no encontrada" });
  const { data, error } = await datosDesdeBody(req.body || {}, actual);
  if (error) return res.status(400).json({ error });
  const inscripcion = await prisma.inscripcionClub.update({ where: { id: actual.id }, data, include: includeInscripcion });
  res.json(inscripcion);
});

// POST /api/inscripciones-club/:id/ficha - crea la ficha de jugador de un
// nombre escrito a mano en una fila ya existente ({ lado: 1|2, tipo:
// "club"|"invitado" }) y la vincula a la fila.
router.post("/:id/ficha", async (req, res) => {
  const lado = Number(req.body?.lado) === 2 ? 2 : 1;
  const tipo = req.body?.tipo === "invitado" ? "invitado" : "club";
  const actual = await prisma.inscripcionClub.findUnique({ where: { id: req.params.id } });
  if (!actual) return res.status(404).json({ error: "Inscripción no encontrada" });
  if (actual[`jugador${lado}Id`]) return res.status(400).json({ error: "Ese jugador ya tiene ficha." });
  const nombre = actual[`nombre${lado}`];
  if (!nombre) return res.status(400).json({ error: "No hay jugador en ese hueco." });
  const jugador = await prisma.jugador.create({ data: { nombre, oculto: tipo === "invitado" } });
  const inscripcion = await prisma.inscripcionClub.update({
    where: { id: actual.id },
    data: { [`jugador${lado}Id`]: jugador.id },
    include: includeInscripcion,
  });
  res.status(201).json(inscripcion);
});

router.delete("/:id", async (req, res) => {
  await prisma.inscripcionClub.deleteMany({ where: { id: req.params.id } });
  res.status(204).end();
});

// DELETE /api/inscripciones-club?torneoClubId=|ligaId=|todo=1 - el reset:
// vacía la hoja de un torneo/liga, o entera con todo=1. Solo borra
// inscripciones: los participantes ya añadidos y las fichas creadas se
// quedan. (La pregunta de confirmación la hace el panel.)
router.delete("/", async (req, res) => {
  const { torneoClubId, ligaId, todo } = req.query;
  let where;
  if (torneoClubId) where = { torneoClubId: String(torneoClubId) };
  else if (ligaId) where = { ligaId: String(ligaId) };
  else if (todo === "1") where = {};
  else return res.status(400).json({ error: "Indica qué vaciar." });
  const { count } = await prisma.inscripcionClub.deleteMany({ where });
  res.json({ borradas: count });
});

// Vuelca una inscripción lista a su torneo (ParticipanteCuadrante) o liga
// (ParticipanteLiga), con las mismas reglas que el alta a mano desde el
// panel del torneo/liga. → { inscripcion } | { status, error }.
async function anadirInscripcion(id) {
  const i = await prisma.inscripcionClub.findUnique({
    where: { id },
    include: { torneoClub: true, liga: true },
  });
  if (!i) return { status: 404, error: "Inscripción no encontrada" };
  if (i.anadidoEn) return { status: 400, error: "Ya está añadida." };
  if (!i.confirmado) return { status: 400, error: "Falta confirmar la asistencia." };
  if (!i.pagado1 || (i.nombre2 && !i.pagado2)) return { status: 400, error: "Falta algún pago." };

  const competicion = i.torneoClub || i.liga;
  if (!competicion) return { status: 400, error: "Falta elegir torneo o liga." };
  if (i.torneoClub && !i.cuadranteId) return { status: 400, error: "Falta elegir el cuadrante." };

  if (competicion.modalidad === "parejas_ciegas") {
    return { status: 400, error: "En parejas ciegas se cargan desde la lista del sorteo del torneo/liga (botón \"Traer inscritos\")." };
  }
  if (competicion.modalidad === "parejas_hechas" && !i.nombre2) return { status: 400, error: "Este torneo es por parejas: falta el segundo jugador (o tráelo a la lista de disponibles con \"Traer inscritos\" para emparejarlo allí)." };
  if (competicion.modalidad === "individual" && i.nombre2) return { status: 400, error: "Este torneo es individual: la inscripción tiene dos jugadores." };

  const ids = [i.jugador1Id, i.jugador2Id].filter(Boolean);
  const etiqueta = i.nombre2 ? `${i.nombre1} / ${i.nombre2}` : i.nombre1;
  const datosParticipante = { etiqueta, jugador1Id: i.jugador1Id, jugador2Id: i.jugador2Id };
  const repetido = ids.length
    ? { OR: [{ jugador1Id: { in: ids } }, { jugador2Id: { in: ids } }, { etiqueta }] }
    : { etiqueta };

  try {
    if (i.torneoClub) {
      const sorteado = await prisma.cuadroPartido.count({
        where: { cuadranteId: i.cuadranteId, OR: [{ jugador1: { not: null } }, { jugador2: { not: null } }] },
      });
      if (sorteado) return { status: 400, error: "Ese cuadrante ya está sorteado." };
      if (await prisma.participanteCuadrante.count({ where: { cuadranteId: i.cuadranteId, ...repetido } })) {
        return { status: 409, error: "Ya está apuntado en ese cuadrante." };
      }
      await prisma.participanteCuadrante.create({ data: { cuadranteId: i.cuadranteId, ...datosParticipante, confirmado: false } });
    } else {
      const actuales = await prisma.participanteLiga.count({ where: { ligaId: i.ligaId } });
      if (actuales >= i.liga.numeroParticipantes) {
        return { status: 400, error: `La liga ya tiene sus ${i.liga.numeroParticipantes} participantes.` };
      }
      if (await prisma.participanteLiga.count({ where: { ligaId: i.ligaId, ...repetido } })) {
        return { status: 409, error: "Ya está apuntado en esa liga." };
      }
      await prisma.participanteLiga.create({ data: { ligaId: i.ligaId, ...datosParticipante, grupo: i.grupo } });
    }
  } catch {
    return { status: 409, error: "No se pudo añadir (¿ya hay un participante con ese nombre?)." };
  }

  const inscripcion = await prisma.inscripcionClub.update({ where: { id }, data: { anadidoEn: new Date() }, include: includeInscripcion });
  return { inscripcion };
}

// POST /api/inscripciones-club/:id/anadir - añade esta inscripción a su
// torneo/liga.
router.post("/:id/anadir", async (req, res) => {
  const r = await anadirInscripcion(req.params.id);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r.inscripcion);
});

// POST /api/inscripciones-club/anadir-listas - añade todas las listas
// ({ torneoClubId } o { ligaId }; sin nada, las de todo). Devuelve cuántas
// entraron y por qué no las que fallaron.
router.post("/anadir-listas", async (req, res) => {
  const { torneoClubId, ligaId } = req.body || {};
  const where = torneoClubId ? { torneoClubId } : ligaId ? { ligaId } : {};
  const candidatas = (await prisma.inscripcionClub.findMany({ where, orderBy: { creadoEn: "asc" } })).filter(inscripcionLista);
  let anadidas = 0;
  const errores = [];
  for (const i of candidatas) {
    const r = await anadirInscripcion(i.id);
    if (r.error) errores.push({ id: i.id, nombre: i.nombre2 ? `${i.nombre1} / ${i.nombre2}` : i.nombre1, error: r.error });
    else anadidas++;
  }
  res.json({ anadidas, errores });
});

// POST /api/inscripciones-club/marcar-anadidas - { ids } marca como
// añadidas las inscripciones que han entrado al torneo/liga por el sorteo
// de parejas ciegas (ver GET /listas).
router.post("/marcar-anadidas", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === "string") : [];
  const { count } = await prisma.inscripcionClub.updateMany({ where: { id: { in: ids }, anadidoEn: null }, data: { anadidoEn: new Date() } });
  res.json({ marcadas: count });
});

export default router;
