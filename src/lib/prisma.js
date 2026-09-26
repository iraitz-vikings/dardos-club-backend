import { PrismaClient } from "@prisma/client";

// Cliente de Prisma ÚNICO para todo el servidor. Antes cada archivo hacía su
// propio `new PrismaClient()` (30 en total) y cada uno abre su propio grupo
// de conexiones a Postgres: con carga se podía agotar el máximo de
// conexiones de la base de datos (auditoría 2026-09-26). Importar siempre
// este, nunca crear otro.
export const prisma = new PrismaClient();
