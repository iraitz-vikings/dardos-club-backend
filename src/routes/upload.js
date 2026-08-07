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

    res.status(201).json({ url: resultado.secure_url, tipo: resultado.resource_type });
  } catch (err) {
    if (err?.http_code === 400 && /File size too large/i.test(err.message || "")) {
      return res.status(413).json({ error: "El archivo supera el límite de tamaño (100 MB)." });
    }
    res.status(500).json({ error: "No se pudo subir el archivo" });
  }
});

export default router;
