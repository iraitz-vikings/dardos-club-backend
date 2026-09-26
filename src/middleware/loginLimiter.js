import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Límites de intentos fallidos (solo cuentan los que fallan:
// skipSuccessfulRequests, así que a quien acierta nunca le afecta).
//
// Auditoría 2026-09-26: antes había un único limitador por IP compartido por
// el login de socios, el registro y el PIN de la herramienta, y el servidor
// no confiaba en el proxy de Railway (sin `trust proxy`), así que TODAS las
// peticiones llegaban con la IP del proxy: 10 fallos de cualquiera, en
// cualquiera de esas pantallas, bloqueaban a todo el mundo 15 minutos (p.ej.
// unos cuantos jugadores equivocándose de PIN en un torneo). Ahora cada
// pantalla tiene su propio contador y la clave incluye, además de la IP, la
// cuenta o el jugador al que se intenta entrar: en el wifi del club (misma
// IP pública para todos) quien se equivoca solo se bloquea a sí mismo.
const QUINCE_MIN = 15 * 60 * 1000;

function limitador(max, mensaje, clave) {
  return rateLimit({
    windowMs: QUINCE_MIN,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: mensaje },
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${clave ? clave(req) : ""}`,
  });
}

const textoDe = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

// POST /api/auth/login: por IP + email.
export const loginLimiter = limitador(10, "Demasiados intentos de inicio de sesión. Espera unos minutos.", (req) =>
  textoDe(req.body?.email)
);

// POST /api/auth/registro: por IP (el código de invitación es un secreto
// fijo que se podría intentar adivinar).
export const registroLimiter = limitador(10, "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.");

// POST /api/partidas-herramienta/login y /pin: por IP + jugador. Con 10
// intentos por jugador y 15 minutos, adivinar un PIN de 4 dígitos (10.000
// combinaciones) no es viable.
export const pinLimiter = limitador(10, "Demasiados intentos con este jugador. Espera unos minutos.", (req) =>
  textoDe(req.body?.jugadorId)
);
