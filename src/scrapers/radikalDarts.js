import { chromium } from "playwright";

// Scraper de Radikal Darts (radikalplayers.com). A diferencia de Connection
// y Phoenix, aquí NO existe ningún buscador general de jugadores por alias:
// confirmado que no hay forma (pública ni logueada) de consultar a un
// jugador cualquiera directamente. Lo que SÍ existe es una página de
// "Clasificación" pública por CADA competición, con una tabla de Alias de
// todos sus participantes — y esa tabla enlaza el Alias de cada uno a su
// FICHA DE JUGADOR real (competiciones3.php), que es la que tiene su
// PPD/MPR de verdad.
//
// OJO — corregido tras una prueba real de Iraitz con capturas de pantalla:
// el valor de MPR/PPD que aparece EN LA PROPIA TABLA de clasificación (o el
// "HCP" que muestra la Clasificación Individual de una Liga) es una cifra
// concreta de ESA competición, no la media real del jugador. La media real
// (la que también se ve en su ficha, sección "Usuario") solo se obtiene
// entrando en la ficha del jugador hacienda click en su Alias. Por eso el
// scraper NO lee ninguna columna de la tabla de clasificación aparte de
// Alias: la usa solo para encontrar el enlace a la ficha del jugador, y lee
// el PPD/MPR de esa ficha.
//
// Esto además simplifica el caso Liga: antes se pensaba que una Liga nunca
// podía dar PPD/MPR (su Clasificación Individual solo muestra HCP) y se
// rechazaba con un error. Eso era un malentendido — el Alias de esa misma
// tabla SÍ enlaza a la ficha real del jugador con su PPD/MPR, exactamente
// igual que en un Torneo o Campeonato. Así que ya no se distingue por tipo
// de competición.
//
// Por eso, para Radikal, el socio guarda además de su alias una
// "notaBusqueda": el nombre de un torneo/liga/campeonato en el que haya
// participado (tal como aparece en radikalplayers.com, ej. "EL-033 Julio").
// El scraper:
//   1. Escribe ese nombre en el campo de búsqueda de competiciones.php
//      (id="competicion_a_buscar"; OJO, es un <input> sin atributo
//      placeholder — el texto "Nombre de Competición:" que se ve en la
//      página es una etiqueta <label> aparte, no vale con getByPlaceholder).
//      Ese campo dispara un autocompletado (jQuery UI, resultados en
//      ".ac_results li") con las competiciones que coinciden, cada una con
//      un prefijo "LIGA: "/"TORNEO: "/"CAMPEONATO: ". IMPORTANTE: el botón
//      rojo "Mostrar resultados" NO sirve para esto — ese filtra la lista
//      general de todas las competiciones (por país/provincia/tipo/fecha),
//      no busca por nombre; y además es un <input type="button"> cuyo texto
//      vive en el atributo value, así que ni siquiera lo encontraría un
//      getByText. El autocompletado además engancha su búsqueda al evento de
//      teclado de cada pulsación, no al valor final del campo: hay que
//      escribir con pressSequentially (fill() no lo dispara).
//   2. Hace click en el resultado del autocompletado que coincida
//      (preferentemente exacto, ignorando el prefijo "LIGA:"/etc.; si no,
//      el primero de la lista), lo que navega directamente a la página de
//      Clasificación de esa competición.
//   3. Busca, entre las tablas de esa página, la que tenga una columna
//      Alias. Si la que se ve por defecto no la tiene (caso Liga: la
//      "Clasificación General" por defecto es de EQUIPOS, sin Alias) pero
//      existe un botón "Clasificación Individual", lo pulsa y lo vuelve a
//      intentar.
//   4. Recorre esa tabla (y sus páginas siguientes, si está paginada)
//      buscando la fila cuyo Alias coincide con el del jugador, y hace click
//      en el enlace de ese Alias — lo que navega a su ficha de jugador
//      (competiciones3.php).
//   5. En esa ficha, lee su tarjeta "Usuario" (con su PPD y su MPR reales,
//      cada uno con 3 posibles categorías "aa"/"ae"/"bb" según modalidad de
//      juego — se coge la primera con valor distinto de 0, o "aa" si todas
//      son 0). OJO: esa misma tarjeta con clase ".puntajes" aparece DOS
//      veces en la página — una en la barra lateral izquierda (el propio
//      usuario logueado del club, irrelevante) y otra en el cuerpo central
//      (el jugador cuya ficha se está viendo, la que interesa). Se
//      distinguen por el contenedor: la de la barra lateral cuelga de
//      "#left", la del cuerpo no.
//
// Login: NO hace falta. Comprobado con una petición sin cookies de sesión a
// una página de Clasificación real: el HTML devuelto ya incluye la tabla
// completa (Alias, MPR, etc.), así que es pública. El scraper no inicia
// sesión.

const COMPETICIONES_URL = "https://esp.radikalplayers.com/competiciones.php";
const MAX_PAGINAS_CLASIFICACION = 15;

const CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1366, height: 900 },
  locale: "es-ES",
};

// El autocompletado antepone el tipo de competición al nombre (ej. "LIGA: La
// Nucia Level-2"); lo quitamos para poder comparar solo el nombre que
// escribió el socio.
function quitarPrefijoTipo(texto) {
  return texto.replace(/^(LIGA|TORNEO|CAMPEONATO)\s*:\s*/i, "").trim();
}

// Busca, entre TODAS las tablas de la página actual, la que tenga una
// columna "Alias" en su cabecera (primera fila). Devuelve el locator de esa
// tabla y el índice de esa columna, o null si ninguna tabla de esta página
// tiene Alias (típicamente porque es la clasificación por Equipos de una
// Liga, antes de pulsar "Clasificación Individual").
async function localizarTablaConAlias(page) {
  const tablas = await page.locator("table").all();
  for (const tabla of tablas) {
    const cabeceras = await tabla.locator("tr").first().locator("th, td").allTextContents().catch(() => []);
    const idxAlias = cabeceras.findIndex((c) => /alias/i.test(c));
    if (idxAlias !== -1) return { tabla, idxAlias };
  }
  return null;
}

// Busca el nombre de torneo/liga/campeonato en el autocompletado de
// competiciones.php y navega a su página de Clasificación. Lanza si no
// encuentra ningún resultado.
async function irAClasificacionDeCompeticion(page, notaBusqueda) {
  await page.goto(COMPETICIONES_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Banner de cookies: lo aceptamos si aparece, para que no tape ningún
  // elemento con el que necesitemos interactuar.
  await page
    .getByText("Acepto", { exact: true })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});

  const buscador = page.locator("#competicion_a_buscar");
  await buscador.waitFor({ state: "visible", timeout: 10000 });
  await buscador.click();
  // pressSequentially simula pulsaciones de teclado reales una a una, para
  // que el autocompletado (que engancha su búsqueda al evento de teclado,
  // no al valor final del campo) se entere de que hemos escrito algo.
  await buscador.pressSequentially(notaBusqueda.trim(), { delay: 80 });

  // El autocompletado (jQuery UI) tarda un poco en llamar al servidor tras
  // escribir; esperamos a que aparezca al menos un resultado.
  const resultados = page.locator(".ac_results li");
  await resultados.first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const items = await resultados.allTextContents().catch(() => []);
  if (items.length === 0) {
    throw new Error(
      `No se encontró ninguna competición llamada "${notaBusqueda}" en Radikal Darts. Revisa que el nombre esté escrito igual que en radikalplayers.com.`
    );
  }

  const nombreBuscado = quitarPrefijoTipo(notaBusqueda).toUpperCase();
  let indiceElegido = items.findIndex((t) => quitarPrefijoTipo(t).toUpperCase() === nombreBuscado);
  if (indiceElegido === -1) indiceElegido = 0; // sin coincidencia exacta: cogemos el primer resultado

  await resultados.nth(indiceElegido).click();
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

// Busca aliasBuscado en la(s) tabla(s) de Alias de la página actual
// (paginando y probando "Clasificación Individual" si hace falta) y, si lo
// encuentra, hace click en su enlace para entrar en su ficha de jugador.
// Devuelve { encontrado: true } tras navegar a la ficha, o
// { encontrado: false, motivo } si no se pudo.
async function buscarYAbrirFichaJugador(page, aliasBuscado) {
  let localizada = await localizarTablaConAlias(page);
  if (!localizada) {
    // Puede ser una Liga: la "Clasificación General" por defecto es de
    // equipos, sin columna Alias. Si existe el botón "Clasificación
    // Individual", lo pulsamos y lo volvemos a intentar.
    const botonIndividual = page.getByText("Clasificación Individual", { exact: true }).first();
    if (await botonIndividual.isVisible({ timeout: 3000 }).catch(() => false)) {
      await botonIndividual.click();
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      localizada = await localizarTablaConAlias(page);
    }
  }
  if (!localizada) return { encontrado: false, motivo: "sin-tabla-alias" };

  for (let pagina = 0; pagina < MAX_PAGINAS_CLASIFICACION; pagina++) {
    const { tabla, idxAlias } = localizada;
    const filas = await tabla.locator("tr").all();
    for (const fila of filas) {
      const celdas = await fila.locator("td").allTextContents();
      if (celdas.length <= idxAlias) continue;
      if (celdas[idxAlias].trim().toUpperCase() !== aliasBuscado.trim().toUpperCase()) continue;

      const enlace = fila.locator("td").nth(idxAlias).locator("a").first();
      if ((await enlace.count()) === 0) return { encontrado: false, motivo: "alias-sin-enlace" };

      await enlace.click();
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      return { encontrado: true };
    }

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
    const tablaActualizada = await localizarTablaConAlias(page);
    if (tablaActualizada) localizada = tablaActualizada;
  }
  return { encontrado: false, motivo: "alias-no-en-clasificacion" };
}

// Lee, en la ficha de jugador ya cargada (tras buscarYAbrirFichaJugador), su
// PPD y su MPR reales de la tarjeta "Usuario" del cuerpo central (NO la de
// la barra lateral, que es la del usuario logueado del club). Cada media
// puede venir en 3 categorías (aa/ae/bb, según modalidad); se coge la
// primera con valor distinto de 0, o la primera de todas si están a 0.
async function leerMediaDeFichaJugador(page) {
  return page.evaluate(() => {
    const candidatas = Array.from(document.querySelectorAll(".puntajes"));
    const tarjeta = candidatas.find((el) => !el.closest("#left"));
    if (!tarjeta) return null;

    const leerValores = (selectorLista) =>
      Array.from(tarjeta.querySelectorAll(selectorLista))
        .map((li) => li.textContent.trim())
        .filter((texto) => /^[\d.,]+\s*\(/.test(texto)); // descarta el <li> de cabecera ("PPD"/"mpr")

    const primerValorUtil = (textos) => {
      const valores = textos
        .map((t) => {
          const m = t.match(/^([\d.,]+)/);
          return m ? parseFloat(m[1].replace(",", ".")) : null;
        })
        .filter((v) => v !== null && !Number.isNaN(v));
      if (valores.length === 0) return null;
      const noNulo = valores.find((v) => v > 0);
      return noNulo !== undefined ? noNulo : valores[0];
    };

    return {
      ppd: primerValorUtil(leerValores("ul.ppd li")),
      mpr: primerValorUtil(leerValores("ul.mpr li")),
    };
  });
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
        await irAClasificacionDeCompeticion(page, notaBusqueda);

        const resultado = await buscarYAbrirFichaJugador(page, idExterno);
        if (!resultado.encontrado) {
          let error;
          if (resultado.motivo === "sin-tabla-alias") {
            error = `Se encontró "${notaBusqueda}" pero no se pudo localizar ninguna tabla de clasificación con columna de Alias.`;
          } else if (resultado.motivo === "alias-sin-enlace") {
            error = `Se encontró tu alias "${idExterno}" en la clasificación de "${notaBusqueda}" pero no tiene enlace a tu ficha de jugador.`;
          } else {
            error = `Se encontró el torneo "${notaBusqueda}" pero tu alias "${idExterno}" no aparece en su clasificación.`;
          }
          resultados.push({ id, ok: false, error });
          continue;
        }

        const media = await leerMediaDeFichaJugador(page);
        if (!media || (media.ppd == null && media.mpr == null)) {
          resultados.push({
            id,
            ok: false,
            error: `Se encontró tu ficha de jugador en "${notaBusqueda}" pero no se pudo leer tu PPD/MPR (puede que Radikal Darts haya cambiado el formato de la página).`,
          });
          continue;
        }
        resultados.push({ id, ok: true, ppd: media.ppd, mpr: media.mpr });
      } catch (err) {
        resultados.push({ id, ok: false, error: err.message || "Error consultando Radikal Darts" });
      }
    }
  } finally {
    await browser.close();
  }
  return resultados;
}
