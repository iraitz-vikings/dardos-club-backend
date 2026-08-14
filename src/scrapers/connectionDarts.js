import { chromium } from "playwright";

// Scraper de Connection Darts (connectionplayer.com). Necesita una cuenta
// personal de Connection Darts ya registrada (CONNECTION_DARTS_EMAIL /
// CONNECTION_DARTS_PASSWORD): una vez logueada, la sección "Comunidad" deja
// buscar a CUALQUIER jugador por su alias exacto y devuelve su media, no
// solo la del propio usuario.
//
// Connection distingue dos medias por jugador: "Virtual" y "Presencial"
// (cada una con su propio MPR y PPD). La lista de resultados de "Buscar"
// solo enseña la media Virtual; para ver también la Presencial hay que
// entrar en el "Perfil de jugador" de cada uno (se abre al pulsar sobre su
// nombre en la lista), que muestra las cuatro cifras en un bloque de tarjetas
// con las etiquetas "PPD (Virtual)", "MPR (Virtual)", "PPD (Presencial)" y
// "MPR (Presential)" — sic, la propia web tiene esa errata en la etiqueta de
// MPR Presencial, así que el parseo acepta las dos grafías.
//
// IMPORTANTE — autobúsqueda: la cuenta del club usada para loguear ES la
// cuenta personal de un socio (hoy, Iraitz). Buscar el propio alias estando
// logueado con esa misma cuenta no devuelve resultados de búsqueda (mismo
// comportamiento ya confirmado en Phoenix Darts: la web te lleva a tu propio
// dashboard en vez de a la lista). Como aquí SÍ hace falta estar logueado
// para poder buscar a cualquiera (a diferencia de Phoenix, cuya búsqueda es
// pública), no se puede evitar el login. En su lugar: justo después de
// loguear, la propia web te deja ya en tu página principal/dashboard, que
// enseña tus propias medias (Virtual y Presencial) con el mismo formato de
// tarjetas que el "Perfil de jugador" de cualquier otro. Se lee esa página
// una vez al principio y, si el alias de algún socio coincide con el nombre
// mostrado ahí, se usan esas medias directamente para él en vez de
// intentar buscarlo (evitando así el problema de la autobúsqueda).

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

// Extrae el número que aparece después de una etiqueta dentro del texto
// plano de la página, sin asumir si están en la misma línea o en líneas
// distintas (el bloque de tarjetas de Connection pone la etiqueta y el
// valor en líneas separadas).
function extraerNumeroTrasEtiqueta(texto, patronEtiqueta) {
  const regex = new RegExp(`${patronEtiqueta}[^\\d-]{0,40}(-?\\d+(?:[.,]\\d+)?)`, "i");
  const match = texto.match(regex);
  return match ? parseFloat(match[1].replace(",", ".")) : null;
}

// Parsea el bloque de 4 tarjetas (PPD/MPR × Virtual/Presencial) que muestra
// tanto el "Perfil de jugador" de otro socio como el propio dashboard tras
// loguear. Devuelve null si no encuentra ninguna de las 4 cifras (señal de
// que no estamos en una página con ese bloque).
function parsearPerfilDetallado(texto) {
  const ppdVirtual = extraerNumeroTrasEtiqueta(texto, "PPD\\s*\\(Virtual\\)");
  const mprVirtual = extraerNumeroTrasEtiqueta(texto, "MPR\\s*\\(Virtual\\)");
  const ppdPresencial = extraerNumeroTrasEtiqueta(texto, "PPD\\s*\\(Presen(?:cial|tial)\\)");
  const mprPresencial = extraerNumeroTrasEtiqueta(texto, "MPR\\s*\\(Presen(?:cial|tial)\\)");
  if ([ppdVirtual, mprVirtual, ppdPresencial, mprPresencial].every((v) => v === null)) return null;
  return { ppdVirtual, mprVirtual, ppdPresencial, mprPresencial };
}

// Parseo "de reserva": el valor (solo Virtual) tal como aparece en la propia
// lista de resultados de "Buscar", por si no se puede abrir el perfil
// detallado de un jugador concreto.
function parsearMediaListaBusqueda(texto, alias) {
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
// del jugador). Devuelve [{ id, ok, mprVirtual?, ppdVirtual?, mprPresencial?,
// ppdPresencial?, error? }] en el mismo orden.
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

    // La propia web nos deja, justo tras loguear, en la página que enseña
    // nuestras propias medias (ver comentario al principio del archivo). Se
    // lee aquí, una sola vez, sin navegar a ningún sitio (para no arriesgarse
    // a que una URL escrita a mano no resuelva igual que la redirección
    // natural de la SPA).
    const textoInicio = await page.locator("body").innerText().catch(() => "");
    const statsPropios = parsearPerfilDetallado(textoInicio);
    const idPropio = statsPropios
      ? registros.find((r) => textoInicio.toUpperCase().includes(r.idExterno.trim().toUpperCase()))?.id
      : undefined;

    for (const { id, idExterno } of registros) {
      if (id === idPropio) {
        resultados.push({ id, ok: true, ...statsPropios });
        continue;
      }
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
          // Diagnóstico: si el buscador no aparece, lo más probable es que
          // la app nos haya devuelto a /login (sesión no reconocida) u otra
          // pantalla inesperada.
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

        // Entrar en el "Perfil de jugador" del resultado (pulsando su
        // nombre) para leer también la media Presencial, que no sale en la
        // lista. Si por lo que sea no se puede abrir/leer, se cae al
        // parseo de reserva (solo Virtual) más abajo, en vez de fallar del
        // todo.
        let statsDetallados = null;
        try {
          await page.getByText(idExterno, { exact: false }).first().click({ timeout: 5000 });
          await page.getByText(/Perfil de jugador/i).first().waitFor({ state: "visible", timeout: 8000 });
          await page.waitForTimeout(400);
          const textoPerfil = await page.locator("body").innerText();
          statsDetallados = parsearPerfilDetallado(textoPerfil);
        } catch {
          statsDetallados = null;
        }

        if (statsDetallados) {
          resultados.push({ id, ok: true, ...statsDetallados });
          continue;
        }

        const texto = await page.locator("body").innerText();
        const encontrado = parsearMediaListaBusqueda(texto, idExterno);
        if (!encontrado) {
          const snippet = texto.replace(/\s+/g, " ").trim().slice(0, 1800);
          resultados.push({
            id,
            ok: false,
            error: `Alias no encontrado en Connection Darts. texto="${snippet}"`,
          });
          continue;
        }
        // Solo se pudo leer la lista, no el perfil detallado: lo que ahí se
        // ve es la media Virtual (confirmado contra la web real).
        resultados.push({ id, ok: true, mprVirtual: encontrado.mpr, ppdVirtual: encontrado.ppd });
      } catch (err) {
        resultados.push({ id, ok: false, error: err.message || "Error consultando Connection Darts" });
      }
    }
  } finally {
    await browser.close();
  }
  return resultados;
}
