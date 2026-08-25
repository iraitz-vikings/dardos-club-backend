import rateLimit from "express-rate-limit";

// Límite de intentos en el login de socios (POST /api/auth/login): solo
// cuentan los intentos que fallan (skipSuccessfulRequests), así que a nadie
// que introduzca bien su contraseña le afecta esto — pero probar contraseñas
// una detrás de otra sí se bloquea pasados unos pocos intentos por IP.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Demasiados intentos de inicio de sesión. Espera unos minutos." },
});
