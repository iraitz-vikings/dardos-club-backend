// Historial de Web Push (ver RegistroPush en schema.prisma): deja apuntado
// cada envío, error, caída y alta/reactivación de los avisos de un socio,
// para poder diagnosticar después un aviso que "no llegó" aunque la
// suscripción ya se haya reactivado sola. Nunca lanza: si no se puede
// apuntar algo, el aviso en sí no debe fallar por ello.
import { prisma } from "./prisma.js";

const DIAS_RETENCION = 60;

export async function registrarEventoPush(datos) {
  try {
    await prisma.registroPush.create({
      data: {
        jugadorId: datos.jugadorId,
        suscripcionId: datos.suscripcionId || null,
        userAgent: datos.userAgent || null,
        evento: datos.evento,
        tipoAviso: datos.tipoAviso || null,
        titulo: datos.titulo ? String(datos.titulo).slice(0, 300) : null,
        codigo: Number.isInteger(datos.codigo) ? datos.codigo : null,
        detalle: datos.detalle ? String(datos.detalle).slice(0, 1000) : null,
      },
    });
  } catch (err) {
    console.error("No se pudo guardar el registro de push:", err.message || err);
  }
}

// Borra el historial de más de DIAS_RETENCION días. Desde el cron nocturno.
export async function purgarRegistroPush() {
  const limite = new Date(Date.now() - DIAS_RETENCION * 24 * 60 * 60 * 1000);
  const { count } = await prisma.registroPush.deleteMany({ where: { creadoEn: { lt: limite } } });
  return { eliminados: count };
}
