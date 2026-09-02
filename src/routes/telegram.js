// Envío de avisos por Telegram a los invitados (jugadores sin cuenta de
// socio, usados en torneos). El vínculo jugador <-> chat de Telegram se crea
// una única vez, cuando el invitado abre su enlace personal de avisos
// (/aviso/:token) y pulsa "Iniciar" en el bot — a partir de ahí el vínculo
// es permanente (el Jugador invitado es un registro reutilizable entre
// torneos, así que no hace falta repetir el check-in nunca más).
//
// node-telegram-bot-api v2 (2026-08-25): reescritura completa de la librería
// sin compatibilidad con v1 (0.x/1.x), motivada por cerrar las
// vulnerabilidades de sus dependencias legadas (request/form-data/qs/
// tough-cookie) — v2 no tiene NINGUNA dependencia. Cambios de API relevantes
// para este archivo: la clase se llama `Bot` (no `TelegramBot`), no acepta
// `{ polling: true }` en el constructor — el polling se arranca aparte con
// `bot.startPolling()`, que no resuelve hasta `bot.stop()` (se lanza sin
// await, "fire and forget"); los comandos se registran con `bot.command()`
// en vez de `bot.onText(regex)`, y el argumento tras el comando llega ya
// separado en `ctx.match` (string, "" si no hay nada) en vez de tener que
// sacarlo de un grupo de regex; los mensajes se mandan con `ctx.reply()`
// dentro de un handler o con `bot.api.sendMessage({ chat_id, text })` fuera
// de uno (antes `bot.sendMessage(chatId, texto)`); el evento
// "polling_error" desaparece, ahora es la opción `onError` de
// `startPolling()`.
import { Bot } from "node-telegram-bot-api";
import { randomBytes } from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

let bot = null;

// Arranca el bot (polling) si hay token configurado. Se llama una vez al
// iniciar el servidor (ver index.js). Si TELEGRAM_BOT_TOKEN no está
// configurado, se omite sin error: los avisos a invitados quedan
// desactivados hasta que se configure.
export function iniciarBotTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN no configurado: los avisos por Telegram a invitados quedan desactivados.");
    return null;
  }
  if (bot) return bot;

  bot = new Bot(token);

  bot.command("start", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const tokenCheckIn = (ctx.match || "").trim();

    if (!tokenCheckIn) {
      await ctx.reply(
        "¡Hola! Para activar tus avisos de partidos, abre el enlace personal que te ha dado el club (el que empieza por .../aviso/...)."
      );
      return;
    }

    const checkIn = await prisma.telegramCheckIn.findUnique({ where: { token: tokenCheckIn } });
    if (!checkIn) {
      await ctx.reply("Ese enlace de avisos no es válido. Pide uno nuevo al club.");
      return;
    }

    const jugador = await prisma.jugador.findUnique({ where: { id: checkIn.jugadorId } });
    if (!jugador) {
      await ctx.reply("No se ha encontrado tu ficha de jugador. Contacta con el club.");
      return;
    }

    await prisma.suscripcionTelegram.upsert({
      where: { jugadorId: jugador.id },
      update: { chatId: String(chatId), username: ctx.chat?.username || null },
      create: { jugadorId: jugador.id, chatId: String(chatId), username: ctx.chat?.username || null },
    });

    await ctx.reply(`¡Listo, ${jugador.nombre}! A partir de ahora recibirás por aquí los avisos de tus partidos.`);
  });

  // /parar - el propio invitado se desvincula de los avisos por Telegram,
  // sin depender del admin. Solo borra la SuscripcionTelegram (el Jugador se
  // mantiene intacto); si vuelve a abrir su enlace de avisos y pulsa
  // "Iniciar" de nuevo, se re-vincula sin problema (el enlace no caduca).
  bot.command("parar", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const sub = await prisma.suscripcionTelegram.findUnique({ where: { chatId: String(chatId) } });
    if (!sub) {
      await ctx.reply("No tenías avisos activados por aquí.");
      return;
    }
    await prisma.suscripcionTelegram.delete({ where: { chatId: String(chatId) } });
    await ctx.reply("Avisos desactivados. Si quieres volver a activarlos, abre de nuevo tu enlace personal del club.");
  });

  // Boundary de errores de los handlers de arriba (equivalente al try/catch
  // implícito que traía v1): nunca para el bot, solo lo registra.
  bot.catch((err, ctx) => {
    console.error("Error en un handler del bot de Telegram:", err?.message || err, "update:", ctx?.update?.update_id);
  });

  // startPolling() no resuelve hasta que se llama a bot.stop() — se lanza
  // sin await (fire-and-forget) para no bloquear el arranque del servidor.
  // onError sustituye al antiguo evento "polling_error".
  bot
    .startPolling(undefined, {
      onError: (err) => console.error("Error de polling del bot de Telegram:", err?.message || err),
    })
    .catch((err) => console.error("El polling del bot de Telegram se detuvo con un error:", err?.message || err));

  console.log("Bot de Telegram iniciado (polling).");
  return bot;
}

// Manda un aviso al chat de Telegram vinculado a este jugador, si tiene
// uno. No hace nada (sin error) si el jugador no ha hecho check-in todavía
// o si el bot no está configurado. Si se pasa `imagenUrl` (p.ej. las
// imágenes de eliminación/campeón de un cuadrante, ver
// src/routes/torneosClub.js) se manda como foto con el texto de pie
// (sendPhoto); si el envío de la foto falla por lo que sea (URL no válida,
// demasiado grande, etc.) se cae a mandar el texto solo, para no perder el
// aviso entero por un problema con la imagen.
export async function enviarTelegramAJugador(jugadorId, texto, imagenUrl) {
  if (!bot) return { enviado: false };
  const sub = await prisma.suscripcionTelegram.findUnique({ where: { jugadorId } });
  if (!sub) return { enviado: false };

  if (imagenUrl) {
    try {
      await bot.api.sendPhoto({ chat_id: sub.chatId, photo: imagenUrl, caption: texto });
      return { enviado: true };
    } catch (err) {
      console.error(`Error enviando foto de Telegram a jugador ${jugadorId}, se manda solo el texto:`, err.message || err);
    }
  }

  try {
    await bot.api.sendMessage({ chat_id: sub.chatId, text: texto });
    return { enviado: true };
  } catch (err) {
    console.error(`Error enviando Telegram a jugador ${jugadorId}:`, err.message || err);
    return { enviado: false, error: err.message };
  }
}

// Genera el enlace de check-in permanente de un jugador invitado: un token
// corto y opaco (base64url) que identifica solo a ese jugador, guardado en
// TelegramCheckIn. Antes se usaba un JWT como token, pero el parámetro
// `start` de los deep-links de Telegram solo admite letras, números, "_" y
// "-" (nada de puntos) — un JWT ("cabecera.payload.firma") no es válido ahí
// y el check-in nunca llegaba a completarse (ver comentario en
// schema.prisma). Un jugador solo tiene un token vigente a la vez: si ya
// tenía uno se reutiliza, no se genera uno nuevo en cada llamada (así el
// enlace ya compartido/copiado antes sigue funcionando).
// urlCheckIn es la página propia del club (explica qué es esto); urlTelegram
// es el deep-link directo al bot con el token ya incluido
// (t.me/<bot>?start=<token>), por si se prefiere compartir ese directamente.
export async function generarEnlaceCheckIn(jugadorId) {
  let checkIn = await prisma.telegramCheckIn.findUnique({ where: { jugadorId } });
  if (!checkIn) {
    const token = randomBytes(24).toString("base64url");
    checkIn = await prisma.telegramCheckIn.create({ data: { token, jugadorId } });
  }
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || null;
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  return {
    token: checkIn.token,
    urlCheckIn: frontendUrl ? `${frontendUrl}/aviso/${checkIn.token}` : null,
    urlTelegram: botUsername ? `https://t.me/${botUsername}?start=${checkIn.token}` : null,
  };
}
