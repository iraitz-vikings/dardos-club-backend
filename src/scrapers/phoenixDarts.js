import { chromium } from "playwright";

// Scraper de Phoenix Darts. A diferencia de Connection Darts, aquí no hay un
// "alias" propiamente dicho: el buscador de jugadores (cabecera > "Jugador")
// busca por coincidencia parcial del NOMBRE con el que el jugador está
// registrado en Phoenix Darts. Por eso, para este fabricante, lo que el
// socio debe guardar como "alias" es su nombre (o parte distintiva de él)
// tal como aparece en su cuenta de Phoenix Darts.

// IMPORTANTE: esta página de resultados es PÚBLICA. No hace falta iniciar
// sesión para consultarla (verificado navegando directamente, sin cookies ni
// login, y viendo el Rating/PPD/MPR reales de un jugador). De hecho, iniciar
// sesión es CONTRAPRODUCENTE: si la búsqueda se hace con una sesión ya
// logueada, y el nombre buscado coincide con el del propio usuario logueado,
// Phoenix Darts redirige automáticamente a "MI PÁGINA" (el panel personal del
// usuario logueado) en vez de mostrar la lista de resultados de búsqueda, así
// que el scraping fallaba precisamente para el propio jugador cuya cuenta se
// usaba para loguear. Por eso aquí NO se hace login en ningún momento: se
// navega siempre como visitante anónimo.
//
// Aun así, una sesión de navegador headless completamente sin cookies recibe
// esta web en INGLÉS por defecto (a pesar de fijar locale "es-ES" en el
// contexto, que en teoría debería bastar) — probablemente porque el idioma
// por defecto lo decide el servidor según la IP de origen (los servidores de
// Railway están en EEUU), no la cabecera Accept-Language. Y en ese estado
// "inglés", la URL de resultados de búsqueda ni siquiera muestra una versión
// traducida: directamente sirve la portada genérica de la web en vez de la
// lista de resultados.
//
// La propia web tiene un selector de idioma (bandera/texto "País/Idioma")
// cuyo enlace a español invoca literalmente `changeLocale('es_ES')`, una
// función JS global definida en el dominio play.phoenixdarts.com (la función
// fija el idioma, casi seguro vía cookie, independientemente de la IP de
// origen). Para forzar español de forma fiable sin necesidad de loguearse,
// se visita primero la portada de play.phoenixdarts.com y se invoca esa
// misma función directamente antes de hacer ninguna búsqueda.
const HOME_URL = "https://play.phoenixdarts.com/main.do";
const SEARCH_BASE_URL = "https://play.phoenixdarts.com/selectPlayerList.do";

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
  if (registros.length === 0) return [];

  const browser = await chromium.launch({ headless: true });
  const resultados = [];
  try {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();

    // Fijar idioma español usando el propio mecanismo de la web (ver
    // comentario arriba) antes de hacer ninguna búsqueda.
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => {
      if (typeof changeLocale === "function") changeLocale("es_ES");
    }).catch(() => {});
    // changeLocale normalmente recarga o navega la página tras fijar la
    // cookie de idioma: esperar a que esa navegación termine antes de seguir.
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    for (const { id, idExterno } of registros) {
      try {
        const url = `${SEARCH_BASE_URL}?searchKey=${encodeURIComponent(idExterno)}&unifiedFg=1`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        // La lista de resultados se rellena por JS después de la carga
        // inicial (llamadas de fondo, probablemente AJAX): esperar primero a
        // la cabecera "Lista de jugadores" y LUEGO, por separado, a que el
        // propio nombre buscado aparezca en la página — la cabecera puede
        // salir antes de que la fila del jugador termine de renderizarse.
        await page
          .getByText("Lista de jugadores", { exact: false })
          .waitFor({ state: "visible", timeout: 10000 })
          .catch(() => {});
        await page
          .getByText(idExterno, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: 8000 })
          .catch(() => {});
        const texto = await page.locator("body").innerText();
        const encontrado = parsearResultado(texto, idExterno);
        if (!encontrado) {
          // Diagnóstico: si no encontramos coincidencia, guardar un trozo del
          // texto real recibido (más largo que antes, para llegar a la
          // sección "Lista de jugadores" que sale bastante abajo en la
          // página) para ver, sin mirar logs de Railway, si el nombre
          // aparece con otro formato, si la lista salió vacía, etc.
          const snippet = texto.replace(/\s+/g, " ").trim().slice(0, 1800);
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
