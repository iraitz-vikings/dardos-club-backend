// Buscador global de la web pública (ver Buscador.jsx en el frontend, en la
// barra de navegación). Busca a la vez en noticias, torneos del club y
// ligas del club. Alcance deliberado v1: solo se incluye contenido con una
// página de destino real a la que enlazar (torneo, liga, noticia en la
// crónica) — se dejó fuera "jugadores del club" porque hoy no existe una
// ficha pública/de socio por jugador a la que llevar el resultado.
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const router = Router();

const LIMITE_POR_CATEGORIA = 6;

// No exige sesión: la búsqueda funciona para cualquier visitante. Pero si
// llega un token de socio válido en el header Authorization, se tiene en
// cuenta para poder buscar también entre torneos/ligas privados (visibles
// solo para socios), además de los públicos. Un token ausente, caducado o
// inválido no es un error — simplemente se busca como visitante anónimo.
function socioOpcional(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      req.usuario = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // sigue como anónimo
    }
  }
  next();
}

// GET /api/buscar?q=texto
router.get("/", socioOpcional, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) {
    return res.json({ noticias: [], torneos: [], ligas: [] });
  }

  const esSocio = !!req.usuario;
  const contiene = { contains: q, mode: "insensitive" };
  // Los torneos/ligas privados (visibilidad "privado") solo se buscan si
  // hay sesión de socio; para un visitante anónimo se filtra a "publico".
  const filtroVisibilidad = esSocio ? {} : { visibilidad: "publico" };

  const [noticias, torneos, ligas] = await Promise.all([
    prisma.noticiaEvento.findMany({
      where: { OR: [{ titulo: contiene }, { contenido: contiene }] },
      orderBy: { fechaPublicacion: "desc" },
      take: LIMITE_POR_CATEGORIA,
      select: { id: true, titulo: true, fechaPublicacion: true },
    }),
    prisma.torneoClub.findMany({
      where: { nombre: contiene, borradoEn: null, ...filtroVisibilidad },
      orderBy: { fechaInicio: "desc" },
      take: LIMITE_POR_CATEGORIA,
      select: { id: true, nombre: true, finalizado: true },
    }),
    prisma.ligaClub.findMany({
      where: { nombre: contiene, borradoEn: null, ...filtroVisibilidad },
      orderBy: { fechaInicio: "desc" },
      take: LIMITE_POR_CATEGORIA,
      select: { id: true, nombre: true, finalizado: true },
    }),
  ]);

  res.json({ noticias, torneos, ligas });
});

export default router;
