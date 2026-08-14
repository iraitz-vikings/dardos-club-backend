import { chromium } from "playwright";

// Scraper de Radikal Darts (radikalplayers.com). A diferencia de Connection
// y Phoenix, aquí NO existe ningún buscador general de jugadores por alias:
// confirmado que no hay forma (pública ni logueada) de consultar a un
// jugador cualquiera. Lo que SÍ existe es una página de "Clasificación"
// pública por CADA competición/torneo (liga, campeonato o torneo suelto),
// con una tabla de Alias + PPD o MPR (según la modalidad de la competición)
// de todos sus participantes.
//
// Por eso, para Radikal, el socio guarda además de su alias una
// "notaBusqueda": el nombre de un torneo en el que haya participado (tal
// como aparece en radikalplayers.com, ej. "EL-033 Julio"). El scraper:
//   1. Busca ese nombre en el buscador de competiciones
//      (competiciones.php > "Nombre de Competición" > "Mostrar resultados").
//   2. Entra en el resultado que coincida (preferentemente exacto; si no,
//      el primero de la lista).
//   3. Lee la tabla de Clasificación de esa competición y busca la fila
//      cuyo Alias coincida con el del jugador, recorriendo también las
//      páginas siguientes si la tabla está paginada.
//   4. Según la cabecera de la columna de media (PPD o MPR), guarda el
//      valor en el campo correspondiente (mpr/ppd, reutilizando los mismos
//      campos que usa Phoenix Darts para su media única).
//
// IMPORTANTE — sin confirmar si hace falta login: la exploración de esta
// web se hizo con una sesión ya logueada (la cuenta personal de Iraitz), así
// que no se pudo verificar directamente si la página de Clasificación es
// pública sin sesión. El scraper NO inicia sesión (igual que Phoenix,
// primero se prueba en anónimo); si en producción resulta que hace falta
// estar logueado, los resultados llegarán con error y habrá que añadir
// login con una cuenta de Radikal Darts del club (como se hizo con
// Connection Darts).

const COMPETICIONES_URL = "https://esp.radikalplayers.com/competiciones.php";
const MAX_PAGINAS_CLASIFICACION = 15;

const CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1366, height: 900 },
  locale: "es-ES",
};

// Busca, dentro de la tabla de Clasificación ya cargada en la página, la
// fila cuyo Alias coincide (sin distinguir mayúsculas/minúsculas) con el
// alias buscado. Devuelve { mpr, ppd } (uno de los dos, según la columna que
// tenga la tabla) o null si no está en esta página.
async function buscarEnTablaActual(page, aliasBuscado) {
  const cabeceras = await page.locator("table tr").first().locator("th, td").allTextContents().catch(() => []);
  const idxAlias = cabeceras.findIndex((c) => /alias/i.test(c));
  const idxPpd = cabeceras.findIndex((c) => /^ppd$/i.test(c.trim()));
  const idxMpr = cabeceras.findIndex((c) => /^mpr$/i.test(c.trim()));
  if (idxAlias === -1 || (idxPpd === -1 && idxMpr === -1)) return { encontrado: null, columnas: null };

  const filas = await page.locator("table tr").all();
  for (const fila of filas) {
    const celdas = await fila.locator("td").allTextContents();
    if (celdas.length <= idxAlias) continue;
    if (celdas[idxAlias].trim().toUpperCase() !== aliasBuscado.trim().toUpperCase()) continue;
    const valorTexto = idxPpd !== -1 ? celdas[idxPpd] : celdas[idxMpr];
    const valor = parseFloat((valorTexto || "").replace(",", ".").trim());
    if (Number.isNaN(valor)) continue;
    return {
      encontrado: idxPpd !== -1 ? { ppd: valor, mpr: null } : { ppd: null, mpr: valor },
      columnas: { idxPpd, idxMpr },
    };
  }
  return { encontrado: null, columnas: { idxPpd, idxMpr } };
}

// Recorre las páginas de la clasificación (si las hay) buscando el alias.
async function buscarEnClasificacion(page, aliasBuscado) {
  for (let pagina = 0; pagina < MAX_PAGINAS_CLASIFICACION; pagina++) {
    const { encontrado } = await buscarEnTablaActual(page, aliasBuscado);
    if (encontrado) return encontrado;

    // Paginación: buscar un enlace/botón "Siguiente" o de número de página
    // que todavía no esté deshabilitado. Si no hay más páginas, se acaba la
    // búsqueda aquí.
    const siguiente = page.getByText(/^Siguiente|^»|^>$/i).first();
    const visible = await siguiente.isVisible().catch(() => false);
    if (!visible) break;
    const disabled = await siguiente.evaluate((el) => el.closest("[disabled], .disabled") !== null).catch(() => false);
    if (disabled) break;
    await siguiente.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  return null;
}

// registros: [{ id, idExterno, notaBusqueda }]. Devuelve [{ id, ok, mpr?, ppd?, error? }].
export async function actualizarMediasRadikal(registros) {
  // Sin notaBusqueda (nombre de un torneo) no hay forma de buscar al
  // jugador: se marcan como error directamente, sin gastar tiempo de
  // navegador en ellos.
  const conTorneo = registros.filter((r) => (r.notaBusqueda || "").trim());
  const sinTorneo = registros.filter((r) => !(r.notaBusqueda || "").trim());
  const resultados = sinTorneo.map((r) => ({
    id: r.id,
    ok: false,
    error:
      "Falta indicar un torneo en el que hayas participado (en tu perfil, junto al alias de Radikal Darts) para poder consultar tu media.",
  }));

  if (conTorneo.length === 0) return resultados;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();

    for (const { id, idExterno, notaBusqueda } of conTorneo) {
      try {
        await page.goto(COMPETICIONES_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

        const buscador = page.getByPlaceholder(/Nombre de Competición/i).first();
        await buscador.waitFor({ state: "visible", timeout: 10000 });
        await buscador.fill(notaBusqueda.trim());
        await page.getByText("Mostrar resultados", { exact: true }).first().click();
        await page.waitForTimeout(1500);
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

        // De los resultados de la búsqueda, preferir uno cuyo texto coincida
        // EXACTAMENTE (sin distinguir mayúsculas) con el nombre de torneo
        // guardado; si no hay coincidencia exacta, coger el primer
        // resultado que contenga ese texto.
        const nombreBuscado = notaBusqueda.trim();
        let resultado = page.getByText(nombreBuscado, { exact: true }).first();
        if (!(await resultado.isVisible().catch(() => false))) {
          resultado = page.getByText(nombreBuscado, { exact: false }).first();
        }
        const hayResultado = await resultado.isVisible({ timeout: 8000 }).catch(() => false);
        if (!hayResultado) {
          resultados.push({
            id,
            ok: false,
            error: `No se encontró ninguna competición llamada "${notaBusqueda}" en Radikal Darts. Revisa que el nombre esté escrito igual que en radikalplayers.com.`,
          });
          continue;
        }
        await resultado.click();
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page
          .getByText(/Clasificación/i)
          .first()
          .waitFor({ state: "visible", timeout: 10000 })
          .catch(() => {});

        const encontrado = await buscarEnClasificacion(page, idExterno);
        if (!encontrado) {
          resultados.push({
            id,
            ok: false,
            error: `Se encontró el torneo "${notaBusqueda}" pero tu alias "${idExterno}" no aparece en su clasificación.`,
          });
          continue;
        }
        resultados.push({ id, ok: true, mpr: encontrado.mpr, ppd: encontrado.ppd });
      } catch (err) {
        resultados.push({ id, ok: false, error: err.message || "Error consultando Radikal Darts" });
      }
    }
  } finally {
    await browser.close();
  }
  return resultados;
}
