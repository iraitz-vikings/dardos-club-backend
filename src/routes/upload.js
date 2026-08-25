import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import jwt from "jsonwebtoken";
import { requireAdmin, adminRateLimiter } from "../middleware/requireAdmin.js";

const router = Router();

// 20 MB y solo imagen/vídeo: antes no había ningún filtro de tipo y el
// límite era 100 MB, así que cualquier socio logueado podía subir hasta
// 100 MB de cualquier archivo a la cuenta de Cloudinary del club. Los
// carteles/fotos/vídeos reales del club caben de sobra en 20 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("TIPO_NO_PERMITIDO"));
    }
  },
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Acepta o bien el token de admin, o bien la sesión de un socio logueado (para
// que cada uno pueda subir su propia foto de perfil sin usar la contraseña de
// admin). adminRateLimiter protege el token fijo también en esta puerta de
// entrada alternativa (ver src/middleware/requireAdmin.js).
function requireAdminOAuth(req, res, next) {
  adminRateLimiter(req, res, (err) => {
    if (err) return next(err);
    continuarRequireAdminOAuth(req, res, next);
  });
}
function continuarRequireAdminOAuth(req, res, next) {
  const adminToken = req.headers["x-admin-token"];
  if (adminToken && adminToken === process.env.ADMIN_TOKEN) return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      req.usuario = jwt.verify(token, process.env.JWT_SECRET);
      return next();
    } catch {
      // sigue abajo y devuelve 401
    }
  }
  return res.status(401).json({ error: "No autorizado" });
}

// Envuelve upload.single a mano (en vez de pasarlo directo como middleware)
// para poder traducir sus errores (tipo no permitido, archivo demasiado
// grande) a una respuesta JSON normal en vez de que caigan al manejador de
// errores por defecto de Express.
function subirArchivo(req, res, next) {
  upload.single("imagen")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "El archivo supera el límite de tamaño (20 MB)." });
    }
    if (err.message === "TIPO_NO_PERMITIDO") {
      return res.status(400).json({ error: "Solo se permiten imágenes o vídeos." });
    }
    return res.status(400).json({ error: "No se pudo procesar el archivo." });
  });
}

// POST /api/upload - sube una imagen o vídeo a Cloudinary y devuelve su URL (protegido)
// resource_type "auto" detecta si es imagen o vídeo; los vídeos se convierten
// automáticamente a un formato reproducible en cualquier navegador.
router.post("/", requireAdminOAuth, subirArchivo, async (req, res) => {
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
      return res.status(413).json({ error: "El archivo supera el límite de tamaño (20 MB)." });
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
