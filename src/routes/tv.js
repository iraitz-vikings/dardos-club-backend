import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "./auth.js";
import { validarVideoDirectoUrl } from "../lib/videoDirecto.js";
import { urlZonaSocioTv } from "../lib/enlacesPublicos.js";
import { notificarJugadores, avisoRepetido } from "./notificar.js";

// Sección "VikingsTV" de la zona de socios: lista de emisiones/vídeos de
// YouTube. La ven todos los socios con sesión; solo los socios con rol
// admin pueden publicar, editar (p. ej. marcar/desmarcar "en directo") y
// borrar.
const router = Router();

function soloAdmin(req, res, next) {
  if (req.usuario?.rol !== "admin") {
    return res.status(403).json({ error: "Solo un admin puede gestionar los vídeos" });
  }
  next();
}

// Valida y normaliza los campos del cuerpo. `parcial` = PUT (solo lo que venga).
function datosVideo(body, parcial) {
  const datos = {};
  if (!parcial || body.titulo !== undefined) {
    const titulo = typeof body.titulo === "string" ? body.titulo.trim() : "";
    if (!titulo) return { error: "Falta el título" };
    datos.titulo = titulo.slice(0, 200);
  }
  if (!parcial || body.url !== undefined) {
    const v = validarVideoDirectoUrl(body.url);
    if (!v.ok) return { error: v.error };
    if (!v.valor) return { error: "Falta el enlace de YouTube" };
    datos.url = v.valor;
  }
  if (body.descripcion !== undefined) {
    const d = typeof body.descripcion === "string" ? body.descripcion.trim() : "";
    datos.descripcion = d ? d.slice(0, 1000) : null;
  }
  if (body.enDirecto !== undefined) datos.enDirecto = !!body.enDirecto;
  return { datos };
}

// Aviso (Web Push / Telegram) a todos los socios cuando una emisión pasa a
// "en directo" — al publicarla ya marcada o al marcarla después. Se puede
// evitar mandando `notificar: false`. No se repite si se desmarca y se
// vuelve a marcar en poco rato (avisoRepetido), para no saturar a avisos.
// En segundo plano: la respuesta al admin no espera a los envíos.
const TTL_AVISO_DIRECTO = 3 * 60 * 60; // un directo dura horas; pasado eso ya no sirve
function avisarDirecto(video) {
  if (avisoRepetido(`tv-directo:${video.id}`, 60 * 60 * 1000)) return;
  prisma.jugador
    .findMany({ where: { usuarioId: { not: null } }, select: { id: true } })
    .then((socios) =>
      notificarJugadores(
        socios.map((s) => s.id),
        {
          titulo: { es: `🔴 En directo: ${video.titulo}`, eu: `🔴 Zuzenean: ${video.titulo}` },
          cuerpo: video.descripcion || {
            es: "Empieza la emisión. Entra a verla en la zona de socios.",
            eu: "Emanaldia hasi da. Sartu bazkideen gunean ikusteko.",
          },
          url: urlZonaSocioTv(),
          tag: `tv-directo-${video.id}`,
          ttl: TTL_AVISO_DIRECTO,
          tipo: "tvDirecto",
        }
      )
    )
    .catch((err) => console.error("Error avisando del directo:", err.message || err));
}

// En directo primero; después, lo más reciente.
router.get("/", requireAuth, async (_req, res) => {
  const videos = await prisma.videoTv.findMany({
    orderBy: [{ enDirecto: "desc" }, { fechaPublicacion: "desc" }],
  });
  res.json(videos);
});

router.post("/", requireAuth, soloAdmin, async (req, res) => {
  const { datos, error } = datosVideo(req.body || {}, false);
  if (error) return res.status(400).json({ error });
  const video = await prisma.videoTv.create({ data: datos });
  if (video.enDirecto && req.body.notificar !== false) avisarDirecto(video);
  res.status(201).json(video);
});

router.put("/:id", requireAuth, soloAdmin, async (req, res) => {
  const { datos, error } = datosVideo(req.body || {}, true);
  if (error) return res.status(400).json({ error });
  const existe = await prisma.videoTv.findUnique({ where: { id: req.params.id } });
  if (!existe) return res.status(404).json({ error: "Vídeo no encontrado" });
  const video = await prisma.videoTv.update({ where: { id: req.params.id }, data: datos });
  if (!existe.enDirecto && video.enDirecto && req.body.notificar !== false) avisarDirecto(video);
  res.json(video);
});

router.delete("/:id", requireAuth, soloAdmin, async (req, res) => {
  const existe = await prisma.videoTv.findUnique({ where: { id: req.params.id } });
  if (!existe) return res.status(404).json({ error: "Vídeo no encontrado" });
  await prisma.videoTv.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
