import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// POST /api/upload - sube una imagen o vídeo a Cloudinary y devuelve su URL (protegido)
// resource_type "auto" detecta si es imagen o vídeo; los vídeos se convierten
// automáticamente a un formato reproducible en cualquier navegador.
router.post("/", requireAdmin, upload.single("imagen"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No se ha recibido ningún archivo" });
  }

  try {
    const resultado = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "dardos-club", resource_type: "auto" },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    // Si es un vídeo, pedimos la entrega en MP4 (compatible con todos los
    // navegadores) sin importar el formato original que se haya subido (AVI, MOV...).
    const url =
      resultado.resource_type === "video"
        ? resultado.secure_url.replace(/\.[a-zA-Z0-9]+$/, ".mp4")
        : resultado.secure_url;

    res.status(201).json({ url, tipo: resultado.resource_type });
  } catch (err) {
    if (err?.http_code === 400 && /File size too large/i.test(err.message || "")) {
      return res.status(413).json({ error: "El archivo supera el límite de tamaño (100 MB)." });
    }
    res.status(500).json({ error: "No se pudo subir el archivo" });
  }
});

// GET /api/upload/existentes - lista las imágenes ya subidas a Cloudinary, para poder
// reutilizarlas en vez de subir el mismo archivo otra vez (protegido)
router.get("/existentes", requireAdmin, async (_req, res) => {
  try {
    const resultado = await cloudinary.api.resources({
      type: "upload",
      prefix: "dardos-club/",
      resource_type: "image",
      max_results: 100,
      direction: "desc",
    });
    const imagenes = (resultado.resources || []).map((r) => ({
      url: r.secure_url,
      creadoEn: r.created_at,
    }));
    res.json(imagenes);
  } catch {
    res.status(500).json({ error: "No se pudo obtener el listado de imágenes" });
  }
});

export default router;
