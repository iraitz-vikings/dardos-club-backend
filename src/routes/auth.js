import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { loginLimiter } from "../middleware/loginLimiter.js";

const prisma = new PrismaClient();
const router = Router();

// Middleware para rutas que requieren socio logueado (se reutilizará en fases futuras)
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autenticado" });
  try {
    req.usuario = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o caducado" });
  }
}

// Middleware para restringir por rol, ej. requireRole("capitan", "admin")
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.usuario || !roles.includes(req.usuario.rol)) {
      return res.status(403).json({ error: "No tienes permiso para esto" });
    }
    next();
  };
}

function firmarToken(usuario) {
  return jwt.sign({ sub: usuario.id, rol: usuario.rol }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
}

// POST /api/auth/registro - alta pública con código de invitación, queda pendiente de aprobación
// loginLimiter también aquí: el código de invitación es otro secreto fijo que
// se podría intentar adivinar a base de intentos, igual que una contraseña.
router.post("/registro", loginLimiter, async (req, res) => {
  const { nombre, email, password, codigoInvitacion } = req.body;
  if (!nombre || !email || !password || !codigoInvitacion) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  if (codigoInvitacion !== process.env.CODIGO_INVITACION) {
    return res.status(403).json({ error: "Código de invitación incorrecto" });
  }
  const emailNormalizado = email.trim().toLowerCase();
  const existente = await prisma.usuario.findUnique({ where: { email: emailNormalizado } });
  if (existente) {
    return res.status(409).json({ error: "Ya existe una cuenta con ese email" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const usuario = await prisma.usuario.create({
    data: { nombre, email: emailNormalizado, passwordHash, aprobado: false },
  });
  res.status(201).json({
    mensaje: "Cuenta creada. Un admin del club debe aprobarla antes de que puedas entrar.",
    id: usuario.id,
  });
});

// POST /api/auth/login
router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  const usuario = await prisma.usuario.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!usuario) {
    return res.status(401).json({ error: "Email o contraseña incorrectos" });
  }
  const passwordOk = await bcrypt.compare(password, usuario.passwordHash);
  if (!passwordOk) {
    return res.status(401).json({ error: "Email o contraseña incorrectos" });
  }
  if (!usuario.aprobado) {
    return res.status(403).json({ error: "Tu cuenta todavía no ha sido aprobada por el club" });
  }
  const token = firmarToken(usuario);
  res.json({
    token,
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: usuario.rol,
      debeCambiarPassword: usuario.debeCambiarPassword,
    },
  });
});

// GET /api/auth/pendientes - lista de cuentas por aprobar (admin)
router.get("/pendientes", requireAdmin, async (_req, res) => {
  const pendientes = await prisma.usuario.findMany({
    where: { aprobado: false },
    orderBy: { creadoEn: "asc" },
    select: { id: true, nombre: true, email: true, creadoEn: true },
  });
  res.json(pendientes);
});

// POST /api/auth/:id/aprobar - aprueba una cuenta y le asigna rol (admin)
router.post("/:id/aprobar", requireAdmin, async (req, res) => {
  const { rol } = req.body; // "jugador" | "capitan" | "admin", opcional (por defecto jugador)
  const usuario = await prisma.usuario.update({
    where: { id: req.params.id },
    data: { aprobado: true, ...(rol ? { rol } : {}) },
  });
  res.json({ id: usuario.id, nombre: usuario.nombre, rol: usuario.rol, aprobado: usuario.aprobado });
});

// POST /api/auth/:id/resetear-password - el admin genera una contraseña
// provisional para un socio (por ejemplo, si la ha olvidado)
router.post("/:id/resetear-password", requireAdmin, async (req, res) => {
  const provisional = Math.random().toString(36).slice(-8);
  const passwordHash = await bcrypt.hash(provisional, 10);
  const usuario = await prisma.usuario.update({
    where: { id: req.params.id },
    data: { passwordHash, debeCambiarPassword: true },
  });
  res.json({ email: usuario.email, passwordProvisional: provisional });
});

// PUT /api/auth/cambiar-password - el propio socio cambia su contraseña
// (obligatorio tras un reset del admin, o voluntario desde su perfil)
router.put("/cambiar-password", requireAuth, async (req, res) => {
  const { passwordActual, passwordNueva } = req.body;
  if (!passwordActual || !passwordNueva) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  if (passwordNueva.length < 6) {
    return res.status(400).json({ error: "La contraseña nueva debe tener al menos 6 caracteres" });
  }
  const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario.sub } });
  if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });
  const passwordOk = await bcrypt.compare(passwordActual, usuario.passwordHash);
  if (!passwordOk) {
    return res.status(401).json({ error: "La contraseña actual no es correcta" });
  }
  const passwordHash = await bcrypt.hash(passwordNueva, 10);
  await prisma.usuario.update({
    where: { id: usuario.id },
    data: { passwordHash, debeCambiarPassword: false },
  });
  res.json({ mensaje: "Contraseña actualizada" });
});

// DELETE /api/auth/:id - rechaza/borra una cuenta pendiente, o elimina un socio (admin).
// Si el socio tenía una ficha de Jugador vinculada, se desvincula en vez de
// borrarla: el Jugador se queda, como si pasara a ser un invitado sin cuenta
// — conserva su historial de torneos/ligas, capitanías de equipo y autoría
// de contenido. Solo se borra el acceso (login/email). Si aun así el borrado
// falla porque la cuenta tiene anuncios/noticias/fotos publicadas (autoría
// obligatoria, sin desvincular posible), se avisa con un error claro en vez
// de reventar con un 500 sin explicación.
router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const jugador = await prisma.jugador.findUnique({ where: { usuarioId: id } });
    if (jugador) {
      await prisma.jugador.update({ where: { id: jugador.id }, data: { usuarioId: null } });
    }
    await prisma.usuario.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(204).end();
    if (err.code === "P2003") {
      return res.status(409).json({
        error: "No se puede borrar: esta cuenta tiene anuncios, noticias o fotos publicadas. Bórralos o reasígnalos primero.",
      });
    }
    console.error("Error borrando usuario:", err);
    res.status(500).json({ error: "No se pudo borrar la cuenta." });
  }
});

// GET /api/auth/socios - lista completa de socios aprobados, para gestionar roles
// (admin). Incluye los IDs de fabricante que cada socio tenga guardados en su
// perfil, visibles solo aquí (nunca en el directorio público de jugadores).
router.get("/socios", requireAdmin, async (_req, res) => {
  const socios = await prisma.usuario.findMany({
    where: { aprobado: true },
    orderBy: { nombre: "asc" },
    select: {
      id: true,
      nombre: true,
      email: true,
      rol: true,
      creadoEn: true,
      jugador: {
        select: {
          idsFabricantes: {
            select: {
              idExterno: true,
              notaBusqueda: true,
              mpr: true,
              ppd: true,
              mprVirtual: true,
              ppdVirtual: true,
              mprPresencial: true,
              ppdPresencial: true,
              statsActualizadoEn: true,
              statsError: true,
              fabricante: { select: { nombre: true, logoUrl: true } },
            },
          },
        },
      },
    },
  });
  const conIdsFabricantes = socios.map(({ jugador, ...s }) => ({
    ...s,
    idsFabricantes: (jugador?.idsFabricantes || []).map((i) => ({
      nombreFabricante: i.fabricante.nombre,
      logoUrl: i.fabricante.logoUrl,
      idExterno: i.idExterno,
      notaBusqueda: i.notaBusqueda,
      mpr: i.mpr,
      ppd: i.ppd,
      mprVirtual: i.mprVirtual,
      ppdVirtual: i.ppdVirtual,
      mprPresencial: i.mprPresencial,
      ppdPresencial: i.ppdPresencial,
      statsActualizadoEn: i.statsActualizadoEn,
      statsError: i.statsError,
    })),
  }));
  res.json(conIdsFabricantes);
});

// PATCH /api/auth/:id/rol - cambia el rol de un socio ya aprobado (admin)
router.patch("/:id/rol", requireAdmin, async (req, res) => {
  const { rol } = req.body;
  if (!["jugador", "capitan", "admin"].includes(rol)) {
    return res.status(400).json({ error: "Rol inválido" });
  }
  const usuario = await prisma.usuario.update({ where: { id: req.params.id }, data: { rol } });
  res.json({ id: usuario.id, nombre: usuario.nombre, rol: usuario.rol });
});

// POST /api/auth/crear-manual - el admin crea una cuenta directamente, ya aprobada (admin)
router.post("/crear-manual", requireAdmin, async (req, res) => {
  const { nombre, email, password, rol } = req.body;
  if (!nombre || !email || !password) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  const emailNormalizado = email.trim().toLowerCase();
  const existente = await prisma.usuario.findUnique({ where: { email: emailNormalizado } });
  if (existente) {
    return res.status(409).json({ error: "Ya existe una cuenta con ese email" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const usuario = await prisma.usuario.create({
    data: {
      nombre,
      email: emailNormalizado,
      passwordHash,
      rol: rol || "jugador",
      aprobado: true,
    },
  });
  res.status(201).json({ id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol });
});

export default router;
