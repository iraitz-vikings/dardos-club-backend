import { chromium } from "playwright";

// Scraper de Phoenix Darts. A diferencia de Connection Darts, aquí no hay un
// "alias" propiamente dicho: el buscador de jugadores (cabecera > "Jugador")
// busca por coincidencia parcial del NOMBRE con el que el jugador está
// registrado en Phoenix Darts. Por eso, para este fabricante, lo que el
// socio debe guardar como "alias" es su nombre (o parte distintiva de él)
// tal como aparece en su cuenta de Phoenix Darts.

const MAIN_URL = "https://play.phoenixdarts.com/main.do";

// Cabecera de navegador "normal": sin esto, algunos sitios sirven una
// versión distinta de la página (o directamente la bloquean) a un Chromium
// headless por defecto, lo que hacía fallar la búsqueda del enlace de login.
const CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1366, height: 900 },
  locale: "es-ES",
};

function parsearResultado(texto, alias) {
  const lineas = texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const aliasUpper = alias.trim().toUpperCase();
  const idx = lineas.findIndex((l) => l.toUpperCase().includes(aliasUpper));
  if (idx === -1) return null;

  let ppd = null;
  let mpr = null;
  for (let i = idx; i < Math.min(idx + 10, lineas.length); i++) {
    const ppdMatch = lineas[i].match(/PPD\s+([\d.,]+)/i);
    const mprMatch = lineas[i].match(/MPR\s+([\d.,]+)/i);
    if (ppdMatch && ppd === null) ppd = parseFloat(ppdMatch[1].replace(",", "."));
    if (mprMatch && mpr === null) mpr = parseFloat(mprMatch[1].replace(",", "."));
  }
  if (ppd === null && mpr === null) return null;
  return { ppd, mpr };
}

// registros: [{ id, idExterno }]. Devuelve [{ id, ok, mpr?, ppd?, error? }].
export async function actualizarMediasPhoenix(registros) {
  const email = process.env.PHOENIX_DARTS_EMAIL;
  const password = process.env.PHOENIX_DARTS_PASSWORD;
  if (!email || !password) {
    throw new Error("Faltan las variables de entorno PHOENIX_DARTS_EMAIL / PHOENIX_DARTS_PASSWORD");
  }
  if (registros.length === 0) return [];

  const browser = await chromium.launch({ headless: true });
  const resultados = [];
  try {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();
    // "domcontentloaded" en vez de "networkidle": esta web mantiene
    // conexiones de fondo abiertas y "networkidle" nunca llega a cumplirse,
    // lo que antes hacía que la propia carga de la página agotara el tiempo
    // de espera. Se espera la carga de red por separado, sin bloquear.
    await page.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const enlaceLogin = page.getByRole("link", { name: "LOG-IN" }).first();
    try {
      await enlaceLogin.waitFor({ state: "visible", timeout: 30000 });
    } catch (err) {
      // Diagnóstico: si el enlace no aparece, es útil ver qué ha recibido
      // realmente el navegador headless (¿bloqueo/geo-detección? ¿aviso de
      // cookies tapando la página? ¿redirección inesperada?) sin tener que
      // bucear en los logs de Railway.
      const urlActual = page.url();
      const titulo = await page.title().catch(() => "?");
      const texto = await page
        .locator("body")
        .innerText()
        .then((t) => t.slice(0, 300).replace(/\s+/g, " ").trim())
        .catch(() => "(no se pudo leer el texto)");
      throw new Error(
        `No se encontró el enlace LOG-IN tras 30s. url=${urlActual} titulo="${titulo}" texto="${texto}"`
      );
    }
    await enlaceLogin.click();
    await page.waitForURL(/account\.phoenixdarts\.com/, { timeout: 20000 });
    await page.getByPlaceholder("Introducir cuenta (Correo electrónico / Número de tarjeta / ID)").fill(email);
    await page.getByPlaceholder("Introducir contraseña").fill(password);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL(/phoenixdarts\.com\/(main\.do)?$|play\.phoenixdarts\.com/, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    for (const { id, idExterno } of registros) {
      try {
        const url = `https://play.phoenixdarts.com/selectPlayerList.do?searchKey=${encodeURIComponent(idExterno)}&unifiedFg=1`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        const texto = await page.locator("body").innerText();
        const encontrado = parsearResultado(texto, idExterno);
        if (!encontrado) {
          resultados.push({ id, ok: false, error: "Nombre no encontrado en Phoenix Darts" });
          continue;
        }
        resultados.push({ id, ok: true, mpr: encontrado.mpr, ppd: encontrado.ppd });
      } catch (err) {
        resultados.push({ id, ok: false, error: err.message || "Error consultando Phoenix Darts" });
      }
    }
  } finally {
    await browser.close();
  }
  return resultados;
}
