import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "./auth.js";
import { validarVideoDirectoUrl } from "../lib/videoDirecto.js";

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
  res.status(201).json(video);
});

router.put("/:id", requireAuth, soloAdmin, async (req, res) => {
  const { datos, error } = datosVideo(req.body || {}, true);
  if (error) return res.status(400).json({ error });
  const existe = await prisma.videoTv.findUnique({ where: { id: req.params.id } });
  if (!existe) return res.status(404).json({ error: "Vídeo no encontrado" });
  const video = await prisma.videoTv.update({ where: { id: req.params.id }, data: datos });
  res.json(video);
});

router.delete("/:id", requireAuth, soloAdmin, async (req, res) => {
  const existe = await prisma.videoTv.findUnique({ where: { id: req.params.id } });
  if (!existe) return res.status(404).json({ error: "Vídeo no encontrado" });
  await prisma.videoTv.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

export default router;
