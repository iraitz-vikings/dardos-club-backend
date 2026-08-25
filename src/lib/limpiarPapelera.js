// Purga definitiva de la papelera de torneos/ligas del club: cualquier
// torneo/liga con `borradoEn` de hace más de 7 días (ver
// src/lib/papelera.js) se borra de verdad, en cascada completa. Se llama
// desde el cron nocturno de index.js; también se puede lanzar a mano si
// hiciera falta (por ejemplo desde una consola de Railway).
import { PrismaClient } from "@prisma/client";
import { purgarTorneo } from "../routes/torneosClub.js";
import { purgarLiga } from "../routes/ligasClub.js";
import { fechaLimitePapelera } from "./papelera.js";

const prisma = new PrismaClient();

export async function limpiarPapelera() {
  const limite = fechaLimitePapelera();
  const [torneos, ligas] = await Promise.all([
    prisma.torneoClub.findMany({ where: { borradoEn: { lt: limite } }, select: { id: true, nombre: true } }),
    prisma.ligaClub.findMany({ where: { borradoEn: { lt: limite } }, select: { id: true, nombre: true } }),
  ]);

  for (const t of torneos) await purgarTorneo(t.id);
  for (const l of ligas) await purgarLiga(l.id);

  return {
    torneosPurgados: torneos.map((t) => t.nombre),
    ligasPurgadas: ligas.map((l) => l.nombre),
  };
}
