import { chromium } from "playwright";

// Scraper de Radikal Darts (radikalplayers.com). A diferencia de Connection
// y Phoenix, aquí NO existe ningún buscador general de jugadores por alias:
// confirmado que no hay forma (pública ni logueada) de consultar a un
// jugador cualquiera. Lo que SÍ existe es una página de "Clasificación"
// pública por CADA competición, con una tabla de Alias + media de todos sus
// participantes — pero el formato de esa tabla depende del TIPO de
// competición, comprobado navegando de verdad la web:
//   - CAMPEONATO / TORNEO: "Clasificación General" ya es individual, con
//     columnas Alias + (PPD o MPR, según el juego) directamente.
//   - LIGA: "Clasificación General" es por EQUIPOS (columnas Equipo/PJ/PG/…,
//     sin Alias). Hay un botón "Clasificación Individual" que sí lista Alias,
//     pero su columna de media es "HCP" (hándicap de liga), NO PPD ni MPR.
//     Es decir: una Liga nunca puede rellenar el PPD/MPR del socio, por
//     mucho que se la busque bien. Si el socio indica una Liga, el scraper
//     lo detecta y devuelve un error explicándolo (ver más abajo), en vez de
//     fallar en silencio o guardar un HCP como si fuera un PPD/MPR.
//
// Por eso, para Radikal, el socio guarda además de su alias una
// "notaBusqueda": el nombre de un torneo/campeonato en el que haya
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
//      getByText.
//   2. Hace click en el resultado del autocompletado que coincida
//      (preferentemente exacto, ignorando el prefijo "LIGA:"/etc.; si no,
//      el primero de la lista), lo que navega directamente a la página de
//      Clasificación de esa competición.
//   3. Busca, entre las tablas de esa página, la que tenga columnas Alias +
//      (PPD o MPR). Si la que se ve por defecto no la tiene (caso Liga, con
//      la tabla de equipos) pero existe un botón "Clasificación Individual",
//      lo pulsa y lo vuelve a intentar. Si aun así no aparece una columna de
//      PPD/MPR (Liga con solo HCP), se informa al socio con un error claro.
//   4. Recorre la tabla (y sus páginas siguientes, si está paginada)
//      buscando la fila cuyo Alias coincide con el del jugador, y guarda el
//      valor en el campo correspondiente (mpr/ppd, reutilizando los mismos
//      campos que usa Phoenix Darts para su media única).
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

// Recorre TODAS las tablas de la página actual buscando la que tenga
// columnas Alias + (PPD o MPR) en su cabecera (primera fila). Devuelve el
// locator de esa tabla y los índices de columna, o null si ninguna tabla de
// esta página es la individual-con-media (típicamente porque es la
// clasificación por Equipos de una Liga).
async function detectarTablaConMedia(page) {
  const tablas = await page.locator("table").all();
  for (const tabla of tablas) {
    const cabeceras = await tabla.locator("tr").first().locator("th, td").allTextContents().catch(() => []);
    const idxAlias = cabeceras.findIndex((c) => /alias/i.test(c));
    const idxPpd = cabeceras.findIndex((c) => /^ppd$/i.test(c.trim()));
    const idxMpr = cabeceras.findIndex((c) => /^mpr$/i.test(c.trim()));
    if (idxAlias !== -1 && (idxPpd !== -1 || idxMpr !== -1)) {
      return { tabla, idxAlias, idxPpd, idxMpr };
    }
  }
  return null;
}

// Busca, dentro de una tabla ya localizada (ver detectarTablaConMedia), la
// fila cuyo Alias coincide (sin distinguir mayúsculas/minúsculas) con el
// alias buscado. Devuelve { mpr, ppd } o null si no está en esta página.
async function buscarEnTabla(tabla, aliasBuscado, idxAlias, idxPpd, idxMpr) {
  const filas = await tabla.locator("tr").all();
  for (const fila of filas) {
    const celdas = await fila.locator("td").allTextContents();
    if (celdas.length <= idxAlias) continue;
    if (celdas[idxAlias].trim().toUpperCase() !== aliasBuscado.trim().toUpperCase()) continue;
    const valorTexto = idxPpd !== -1 ? celdas[idxPpd] : celdas[idxMpr];
    const valor = parseFloat((valorTexto || "").replace(",", ".").trim());
    if (Number.isNaN(valor)) continue;
    return idxPpd !== -1 ? { ppd: valor, mpr: null } : { ppd: null, mpr: valor };
  }
  return null;
}

// Busca el nombre de torneo/campeonato en el autocompletado de
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
  // OJO: el autocompletado (jQuery UI) engancha su búsqueda al evento
  // keydown/keyup de cada tecla, no al valor final del campo. buscador.fill()
  // escribe el valor de golpe sin disparar esos eventos, así que el
  // autocompletado nunca se entera y ".ac_results" se queda vacío (probado
  // en producción: con fill() siempre daba "no se encontró ninguna
  // competición" aunque el nombre fuera correcto). Por eso usamos
  // pressSequentially, que simula pulsaciones de teclado reales una a una.
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

        let encontradaTabla = await detectarTablaConMedia(page);
        if (!encontradaTabla) {
          // Puede ser una Liga: la "Clasificación General" por defecto es de
          // equipos. Si existe el botón "Clasificación Individual", lo
          // pulsamos y lo volvemos a intentar.
          const botonIndividual = page.getByText("Clasificación Individual", { exact: true }).first();
          if (await botonIndividual.isVisible({ timeout: 3000 }).catch(() => false)) {
            await botonIndividual.click();
            await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
            encontradaTabla = await detectarTablaConMedia(page);
          }
        }

        if (!encontradaTabla) {
          resultados.push({
            id,
            ok: false,
            error: `Se encontró "${notaBusqueda}" pero su clasificación no tiene una columna de PPD/MPR (probablemente es una Liga, que solo da un HCP de hándicap, no una media). Prueba a indicar un torneo o campeonato en el que hayas participado en su lugar.`,
          });
          continue;
        }

        let { tabla, idxAlias, idxPpd, idxMpr } = encontradaTabla;
        let encontrado = null;
        for (let pagina = 0; pagina < MAX_PAGINAS_CLASIFICACION; pagina++) {
          encontrado = await buscarEnTabla(tabla, idExterno, idxAlias, idxPpd, idxMpr);
          if (encontrado) break;

          // Paginación: buscar un enlace/botón "Siguiente" o de número de
          // página que todavía no esté deshabilitado. Si no hay más
          // páginas, se acaba la búsqueda aquí.
          const siguiente = page.getByText(/^Siguiente|^»|^>$/i).first();
          const visible = await siguiente.isVisible().catch(() => false);
          if (!visible) break;
          const disabled = await siguiente.evaluate((el) => el.closest("[disabled], .disabled") !== null).catch(() => false);
          if (disabled) break;
          await siguiente.click().catch(() => {});
          await page.waitForTimeout(800);
          // Tras paginar, el DOM de la tabla puede haberse regenerado: la
          // volvemos a localizar para no operar sobre nodos obsoletos.
          const tablaActualizada = await detectarTablaConMedia(page);
          if (tablaActualizada) ({ tabla, idxAlias, idxPpd, idxMpr } = tablaActualizada);
        }

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
