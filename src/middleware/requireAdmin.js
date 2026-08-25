import rateLimit from "express-rate-limit";

// Protege el token fijo de admin (cabecera x-admin-token) contra fuerza
// bruta: solo cuentan los intentos que fallan (skipSuccessfulRequests), así
// que el uso normal del panel de admin nunca se ve afectado, pero probar
// tokens al azar sí se bloquea pasados unos pocos intentos por IP.
export const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Demasiados intentos. Espera unos minutos y vuelve a intentarlo." },
});

// Middleware compartido para las rutas de admin: antes este mismo código
// (comprobar `x-admin-token` contra `ADMIN_TOKEN`) estaba copiado y pegado,
// literal, en 17 archivos de rutas distintos. Ahora vive en un único sitio;
// cada ruta solo importa `requireAdmin` de aquí.
export function requireAdmin(req, res, next) {
  adminRateLimiter(req, res, (err) => {
    if (err) return next(err);
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: "No autorizado" });
    }
    next();
  });
}
