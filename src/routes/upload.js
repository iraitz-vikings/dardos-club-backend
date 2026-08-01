import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

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

// POST /api/upload - sube una imagen a Cloudinary y devuelve su URL (protegido)
router.post("/", requireAdmin, upload.single("imagen"), async (req, res) => {
    if (!req.file) {
          return res.status(400).json({ error: "No se ha recibido ninguna imagen" });
        }

    try {
          const resultado = await new Promise((resolve, reject) => {
                  const stream = cloudinary.uploader.upload_stream(
                            { folder: "dardos-club" },
                            (error, result) => (error ? reject(error) : resolve(result))
                          );
                  stream.end(req.file.buffer);
                });

          res.status(201).json({ url: resultado.secure_url });
        } catch (err) {
          res.status(500).json({ error: "No se pudo subir la imagen" });
        }
  });

export default router;
