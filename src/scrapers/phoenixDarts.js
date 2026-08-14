import { chromium } from "playwright";

// Scraper de Phoenix Darts. A diferencia de Connection Darts, aquí no hay un
// "alias" propiamente dicho: el buscador de jugadores (cabecera > "Jugador")
// busca por coincidencia parcial del NOMBRE con el que el jugador está
// registrado en Phoenix Darts. Por eso, para este fabricante, lo que el
// socio debe guardar como "alias" es su nombre (o parte distintiva de él)
// tal como aparece en su cuenta de Phoenix Darts.

// Página de login directamente en español. Antes navegábamos a la portada
// (play.phoenixdarts.com/main.do) y pulsábamos el enlace "LOG-IN" de la
// cabecera, pero un navegador headless sin cookies recibe la web en INGLÉS
// por defecto (el enlace se llama "Login", no "LOG-IN", y el resto de la
// web también cambia de idioma), aunque se indique locale "es-ES" en el
// contexto. El idioma real depende de un prefijo en la URL, así que vamos
// directos a la versión en español.
const LOGIN_URL = "https://account.phoenixdarts.com/es/login";

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
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const campoCuenta = page.getByPlaceholder("Introducir cuenta (Correo electrónico / Número de tarjeta / ID)");
    try {
      await campoCuenta.waitFor({ state: "visible", timeout: 30000 });
    } catch (err) {
      // Mismo diagnóstico que antes: si el formulario esperado no aparece
      // (idioma distinto, aviso de cookies, redirección a "ya tienes sesión
      // guardada", etc.) lo vemos aquí sin tener que mirar logs de Railway.
      const urlActual = page.url();
      const titulo = await page.title().catch(() => "?");
      const texto = await page
        .locator("body")
        .innerText()
        .then((t) => t.slice(0, 300).replace(/\s+/g, " ").trim())
        .catch(() => "(no se pudo leer el texto)");
      throw new Error(
        `No se encontró el formulario de login tras 30s. url=${urlActual} titulo="${titulo}" texto="${texto}"`
      );
    }
    await campoCuenta.fill(email);
    await page.getByPlaceholder("Introducir contraseña").fill(password);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL(/phoenixdarts\.com\/(main\.do)?$|play\.phoenixdarts\.com/, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    for (const { id, idExterno } of registros) {
      try {
        const url = `https://play.phoenixdarts.com/selectPlayerList.do?searchKey=${encodeURIComponent(idExterno)}&unifiedFg=1`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        // La lista de resultados se rellena por JS después de la carga
        // inicial (llamadas de fondo); esperar a que aparezca su cabecera
        // antes de leer el texto, para no leer la página a medio cargar.
        await page
          .getByText("Lista de jugadores", { exact: false })
          .waitFor({ state: "visible", timeout: 10000 })
          .catch(() => {});
        const texto = await page.locator("body").innerText();
        const encontrado = parsearResultado(texto, idExterno);
        if (!encontrado) {
          // Diagnóstico: si no encontramos coincidencia, guardar un trozo del
          // texto real recibido para poder ver, sin mirar logs de Railway, si
          // el nombre aparece con otro formato, si la lista salió vacía, etc.
          const snippet = texto.replace(/\s+/g, " ").trim().slice(0, 600);
          resultados.push({
            id,
            ok: false,
            error: `Nombre no encontrado en Phoenix Darts. texto="${snippet}"`,
          });
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
