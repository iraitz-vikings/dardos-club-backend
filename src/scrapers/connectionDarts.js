import { chromium } from "playwright";

// Scraper de Connection Darts (connectionplayer.com). Necesita una cuenta
// personal de Connection Darts ya registrada (CONNECTION_DARTS_EMAIL /
// CONNECTION_DARTS_PASSWORD): una vez logueada, la sección "Comunidad" deja
// buscar a CUALQUIER jugador por su alias exacto y devuelve su MPR/PPD, no
// solo los del propio usuario.

const LOGIN_URL = "https://connectionplayer.com/#/login";
const COMUNIDAD_URL = "https://connectionplayer.com/#/community";
const BUSCADOR_PLACEHOLDER = "Buscar por alias...";

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
    const page = await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
    await page.getByPlaceholder("Dirección de correo").fill(email);
    await page.getByPlaceholder("Contraseña").fill(password);
    await page.getByRole("button", { name: "Iniciar Sesión" }).click();
    // Tras loguear, la app redirige fuera de /login (a /dashboard u otra
    // sección). Si no lo hace en 20s asumimos que el login ha fallado.
    await page.waitForFunction(() => !location.hash.includes("/login"), null, { timeout: 20000 });

    for (const { id, idExterno } of registros) {
      try {
        await page.goto(COMUNIDAD_URL, { waitUntil: "networkidle" });
        const buscador = page.getByPlaceholder(BUSCADOR_PLACEHOLDER);
        await buscador.fill(idExterno);
        await page.locator(`input[placeholder="${BUSCADOR_PLACEHOLDER}"] + button`).click();
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
