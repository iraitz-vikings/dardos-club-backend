import { chromium } from "playwright";

// Scraper de Connection Darts (connectionplayer.com). Necesita una cuenta
// personal de Connection Darts ya registrada (CONNECTION_DARTS_EMAIL /
// CONNECTION_DARTS_PASSWORD): una vez logueada, la sección "Comunidad" deja
// buscar a CUALQUIER jugador por su alias exacto y devuelve su MPR/PPD, no
// solo los del propio usuario.

const LOGIN_URL = "https://connectionplayer.com/#/login";
const COMUNIDAD_URL = "https://connectionplayer.com/#/community";
const BUSCADOR_PLACEHOLDER = "Buscar por alias...";

// Cabecera de navegador "normal", igual que en phoenixDarts.js.
const CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1366, height: 900 },
  locale: "es-ES",
};

// Busca, dentro del texto plano de la página de resultados, el bloque que
// corresponde exactamente al alias buscado (nombre en su propia línea) y
// extrae el MPR/PPD que aparecen justo después.
function parsearResultado(texto, alias) {
  const lineas = texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const idx = lineas.findIndex((l) => l.toUpperCase() === alias.trim().toUpperCase());
  if (idx === -1) return null;

  let mpr = null;
  let ppd = null;
  for (let i = idx; i < Math.min(idx + 6, lineas.length); i++) {
    const mprMatch = lineas[i].match(/^MPR:\s*([\d.,]+)/i);
    const ppdMatch = lineas[i].match(/^PPD:\s*([\d.,]+)/i);
    if (mprMatch) mpr = parseFloat(mprMatch[1].replace(",", "."));
    if (ppdMatch) ppd = parseFloat(ppdMatch[1].replace(",", "."));
  }
  if (mpr === null && ppd === null) return null;
  return { mpr, ppd };
}

// registros: [{ id, idExterno }] (id = id de la fila JugadorFabricanteId, no
// del jugador). Devuelve [{ id, ok, mpr?, ppd?, error? }] en el mismo orden.
export async function actualizarMediasConnection(registros) {
  const email = process.env.CONNECTION_DARTS_EMAIL;
  const password = process.env.CONNECTION_DARTS_PASSWORD;
  if (!email || !password) {
    throw new Error("Faltan las variables de entorno CONNECTION_DARTS_EMAIL / CONNECTION_DARTS_PASSWORD");
  }
  if (registros.length === 0) return [];

  const browser = await chromium.launch({ headless: true });
  const resultados = [];
  try {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.getByPlaceholder("Dirección de correo").fill(email);
    await page.getByPlaceholder("Contraseña").fill(password);
    await page.getByRole("button", { name: "Iniciar Sesión" }).click();
    // Tras loguear, la app redirige fuera de /login (a /dashboard u otra
    // sección). Si no lo hace en 20s asumimos que el login ha fallado.
    await page.waitForFunction(() => !location.hash.includes("/login"), null, { timeout: 20000 });
    // Dar un margen extra a la SPA para terminar de asentar la sesión (token,
    // estado de usuario, etc.) antes de navegar a otra sección: navegar
    // demasiado rápido tras el cambio de hash podía interrumpir ese proceso
    // y hacer que la app nos devolviera a /login al pedir "Comunidad".
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    for (const { id, idExterno } of registros) {
      try {
        await page.goto(COMUNIDAD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        // "Comunidad" abre por defecto en la pestaña "Social Feed" (posts,
        // recomendaciones...); el buscador de jugadores por alias está en la
        // pestaña "Buscar" de la barra inferior, hay que pulsarla primero.
        const pestanaBuscar = page
          .getByRole("button", { name: "Buscar", exact: true })
          .or(page.getByRole("link", { name: "Buscar", exact: true }))
          .or(page.getByText("Buscar", { exact: true }));
        await pestanaBuscar
          .first()
          .click({ timeout: 10000 })
          .catch(() => {});
        const buscador = page.getByPlaceholder(BUSCADOR_PLACEHOLDER);
        try {
          await buscador.waitFor({ state: "visible", timeout: 15000 });
        } catch (err) {
          // Diagnóstico: mismo patrón que en Phoenix. Si el buscador no
          // aparece, lo más probable es que la app nos haya devuelto a
          // /login (sesión no reconocida) u otra pantalla inesperada.
          const hashActual = await page.evaluate(() => location.hash).catch(() => "?");
          const titulo = await page.title().catch(() => "?");
          const texto = await page
            .locator("body")
            .innerText()
            .then((t) => t.slice(0, 300).replace(/\s+/g, " ").trim())
            .catch(() => "(no se pudo leer el texto)");
          throw new Error(
            `No se encontró el buscador de Comunidad tras 15s. hash=${hashActual} titulo="${titulo}" texto="${texto}"`
          );
        }
        await buscador.fill(idExterno);
        // Pulsar Enter dispara la búsqueda en la mayoría de estos buscadores
        // y es más robusto que depender de la posición exacta del botón de
        // búsqueda en el DOM (que cambió de sitio al pasar por la pestaña
        // "Buscar" en vez de ir directos por URL). El clic al botón de al
        // lado se mantiene como intento adicional, silencioso si no existe o
        // si Enter ya disparó la búsqueda.
        await buscador.press("Enter").catch(() => {});
        await page
          .locator(`input[placeholder="${BUSCADOR_PLACEHOLDER}"] + button`)
          .click({ timeout: 5000 })
          .catch(() => {});
        await page.waitForTimeout(700);

        const texto = await page.locator("body").innerText();
        const encontrado = parsearResultado(texto, idExterno);
        if (!encontrado) {
          resultados.push({ id, ok: false, error: "Alias no encontrado en Connection Darts" });
          continue;
        }
        resultados.push({ id, ok: true, mpr: encontrado.mpr, ppd: encontrado.ppd });
      } catch (err) {
        resultados.push({ id, ok: false, error: err.message || "Error consultando Connection Darts" });
      }
    }
  } finally {
    await browser.close();
  }
  return resultados;
}
