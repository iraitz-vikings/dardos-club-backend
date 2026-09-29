import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import jwt from "jsonwebtoken";
import { verificarTokenSocio } from "./auth.js";
import { requireAdmin, adminRateLimiter } from "../middleware/requireAdmin.js";
import rateLimit from "express-rate-limit";
import { CLOUDINARY_FOLDER } from "../lib/club.js";

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
// Límite de subidas para socios (no admin): cada subida real cuenta (no solo
// las fallidas), para que un socio no pueda llenar el Cloudinary del club
// subiendo sin parar (auditoría 2026-09-26). El admin no está limitado.
const subidaSocioLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Has subido demasiados archivos en poco tiempo. Espera unos minutos." },
});

function requireAdminOAuth(req, res, next) {
  adminRateLimiter(req, res, (err) => {
    if (err) return next(err);
    // Con token de admin no se aplica el límite de socio.
    if (req.headers["x-admin-token"] === process.env.ADMIN_TOKEN) {
      return continuarRequireAdminOAuth(req, res, next);
    }
    subidaSocioLimiter(req, res, (err2) => {
      if (err2) return next(err2);
      continuarRequireAdminOAuth(req, res, next);
    });
  });
}
function continuarRequireAdminOAuth(req, res, next) {
  const adminToken = req.headers["x-admin-token"];
  if (adminToken && adminToken === process.env.ADMIN_TOKEN) return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      req.usuario = verificarTokenSocio(token);
      return next();
    } catch {
      // no es un token de socio; se prueba abajo con el de PIN
    }
    // Token de PIN de la herramienta (amigo/invitado que sube su foto de
    // perfil desde la pestaña "Invitados"): { tipo: "partida", jugadorId }.
    // Igual que un socio, pasa por el límite de subidas de arriba.
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.tipo === "partida" && payload.jugadorId) {
        req.jugadorPartidaId = payload.jugadorId;
        return next();
      }
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
        { folder: CLOUDINARY_FOLDER, resource_type: "auto" },
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
      prefix: `${CLOUDINARY_FOLDER}/`,
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
