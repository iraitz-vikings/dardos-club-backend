import { chromium } from "playwright";
import { indiceLineaAlias } from "./coincidenciaAlias.js";

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
//
// SEGUNDO FILTRO INDEPENDIENTE (encontrado después de arreglar el idioma):
// la página de resultados tiene además un filtro "Local" (país/región,
// <select id="searchNation">, con un desplegable de provincias que aparece
// debajo al elegir un país) que también se rellena por defecto según la IP
// de origen — en Railway (EEUU) queda en "USA", y como ninguno de nuestros
// socios juega en EEUU la búsqueda siempre devolvía "Lista de jugadores
// (0)" aunque el idioma y el nombre buscado fueran correctos. Verificado
// directamente contra la web: forzando `searchNation=USA` en la URL se
// reproduce el mismo 0 resultados que en Railway; forzando
// `searchNation=ES` la búsqueda SÍ encuentra al jugador. A diferencia del
// idioma, este filtro si se puede fijar como simple parámetro en la URL de
// búsqueda (es un <form method="get">), sin necesidad de invocar ninguna
// función JS ni esperar una navegación adicional.
const HOME_URL = "https://play.phoenixdarts.com/main.do";
const SEARCH_BASE_URL = "https://play.phoenixdarts.com/selectPlayerList.do";
const SEARCH_NATION = "ES";

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
  // Alias exacto o como palabra completa, nunca dentro de otra palabra: con
  // un simple "contiene", buscar "mañu" cogía las medias de "erMAÑUe" si
  // salía antes en la lista (ver coincidenciaAlias.js).
  const idx = indiceLineaAlias(lineas, alias);
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

// Fijar idioma español usando el propio mecanismo de la web (ver comentario
// arriba) antes de hacer ninguna búsqueda — hace falta tanto para la
// búsqueda de jugadores como para la de equipos: confirmado en vivo el
// 2026-08-15 que, sin este paso, selectTeamList.do también devuelve "Team
// List (0)" (0 resultados) para un nombre de equipo real y exacto (se
// reprodujo con "VDC Ragnarok", que SÍ aparece en cuanto se fija el idioma
// a español primero). changeLocale() dispara su propia navegación
// (recarga/redirección) para aplicar el cambio: hay que esperar ESA
// navegación con waitForNavigation en vez de solo waitForLoadState, porque
// si el siguiente page.goto() (la primera búsqueda) se lanza mientras esa
// navegación interna sigue en curso, el navegador la aborta con
// net::ERR_ABORTED.
async function fijarIdiomaEspanol(page) {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  // PAÍS = España (2026-10-20): Phoenix elige el país de la sesión por la
  // IP, y desde Railway (EE. UU.) pinta las fechas como mm/dd y las horas en
  // hora del Pacífico (ej. "12/01 12:30" para el 1 de diciembre a las 21:30
  // en España). Se fija igual que el selector de país de la web
  // (nationForm → changeNation.do, que vuelve a la portada).
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
    page
      .evaluate(() => {
        const f = document.nationForm;
        if (f && f.ntnCd) {
          f.ntnCd.value = "ES";
          f.submit();
        }
      })
      .catch(() => {}),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
    page
      .evaluate(() => {
        if (typeof changeLocale === "function") changeLocale("es_ES");
      })
      .catch(() => {}),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  // Margen extra por si la navegación anterior todavía está asentándose.
  await page.waitForTimeout(1000);
}

// registros: [{ id, idExterno }]. Devuelve [{ id, ok, mpr?, ppd?, error? }].
export async function actualizarMediasPhoenix(registros) {
  if (registros.length === 0) return [];

  const browser = await chromium.launch({ headless: true });
  const resultados = [];
  try {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();

    await fijarIdiomaEspanol(page);

    for (const { id, idExterno } of registros) {
      try {
        const url = `${SEARCH_BASE_URL}?searchKey=${encodeURIComponent(idExterno)}&unifiedFg=1&searchNation=${SEARCH_NATION}`;
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        } catch (navErr) {
          // Reintento único: si la navegación fue abortada (p.ej. por otra
          // navegación aún en curso en la página), esperar un momento y
          // volver a intentarlo antes de darlo por fallido.
          if (!/ERR_ABORTED/i.test(navErr.message || "")) throw navErr;
          await page.waitForTimeout(1500);
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        }
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

// ---------------------------------------------------------------------------
// Clasificación de equipos (Ligas) — también pública, sin login, pero con
// una estructura de búsqueda muy distinta a la de Radikal. Confirmado en
// vivo el 2026-08-15:
//
// - En Phoenix no existe una búsqueda pública directa "por nombre de
//   competición". La búsqueda parte del EQUIPO: selectTeamList.do con
//   ?searchKey=<nombre>&unifiedFg=1&searchNation=ES.
// - IMPORTANTE (fallo real detectado el 2026-08-15 con el equipo "VDC
//   Ragnarok"): esta búsqueda de equipos también necesita el arreglo de
//   idioma español (fijarIdiomaEspanol, ver más arriba) ANTES de buscar.
//   Verificado en vivo: exactamente la misma URL de búsqueda, con el mismo
//   nombre de equipo exacto, devuelve "Team List (0)" en inglés (el idioma
//   por defecto sin cookies) y "Lista de equipos (1)" con el equipo
//   encontrado en cuanto se fija el idioma a español primero. Por eso
//   fijarIdiomaEspanol(page) se llama al principio de
//   extraerClasificacionEquiposPhoenix, igual que ya se hacía en
//   actualizarMediasPhoenix.
// - Un mismo Torneo/Liga de Phoenix puede tener VARIOS equipos del club
//   compitiendo a la vez (caso real detectado el 2026-08-15: la "Summer
//   Cup" tiene 5 equipos del club inscritos), y cada uno puede estar en un
//   grupo distinto — así que la búsqueda no puede hacerse una sola vez por
//   Torneo, tiene que hacerse una vez por cada EQUIPO DEL CLUB inscrito
//   (EquipoTorneo). Por eso esta función recibe una lista de inscripciones,
//   no de torneos: cada `idExterno` es el nombre EXACTO de ESE equipo tal
//   como está registrado en Phoenix Darts (ej. "VDC Gentlemen"), guardado
//   en `EquipoTorneo.idExternoEquipo`, no en `Torneo.idExterno`.
// - Cada equipo encontrado, al expandir su ficha (click en
//   `p.box_list_toggle`, que dispara una carga AJAX), muestra un bloque
//   `div.competition` por cada competición en la que participa, con su
//   título (`div.infos p.c_name`) y la rejilla de Grupos de esa
//   competición (`div.divisions a`) — el Grupo propio del equipo se
//   distingue porque su `<span>` interior tiene la clase
//   `tab_division_on` en vez de `tab_division`. De ese enlace
//   (`goCpttnDvDetail(cpttnId, searchDivision, 'ML', ...)`) se sacan los
//   dos IDs internos que hacen falta para la clasificación.
// - Si el equipo compite en más de una competición a la vez, se desambigua
//   comparando el título de cada `div.competition` con el nombre que
//   nosotros le hemos puesto al Torneo (coincidencia de subcadena, sin
//   mayúsculas ni acentos) — de ahí que esta función necesite también el
//   nombre del Torneo, no solo su idExterno.
// - La clasificación en sí (pública, sin login) está en
//   selectTeamRankingListML.do?cpttnId=<>&searchDivision=<> (no hace falta
//   el tercer parámetro searchStage que añade la web sola: sin él se sigue
//   viendo la etapa/jornada actual). Tabla `div.ranking_form
//   table.tb_style01`, columnas por fila (siempre en este orden, con o sin
//   cabeceras en español según el idioma del navegador, por eso se lee por
//   posición y no por texto de cabecera): Rank, Team Name, Rating, PPD,
//   MPR, Total point, Match W/L/D/WinRate%, Set W/L/D/WinRate%, Penalty
//   point. Encaja con las columnas que ya usa Radikal en
//   ClasificacionEquipo (puntos = Total point, partidosGanados/... = Match
//   W/L/D, juegosGanados/juegosPerdidos = Set W/L) — no hizo falta añadir
//   columnas nuevas al modelo.
// ---------------------------------------------------------------------------

const SEARCH_TEAM_URL = "https://play.phoenixdarts.com/selectTeamList.do";
const RANKING_ML_URL = "https://play.phoenixdarts.com/selectTeamRankingListML.do";

function quitarAcentos(texto) {
  return (texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

// Busca el equipo por nombre exacto (España), expande su ficha para ver
// "Participated Competitions" y devuelve { cpttnId, searchDivision } del
// Grupo en el que compite ese equipo dentro de la competición cuyo título
// mejor coincide con nombreTorneo. Devuelve null si no se encuentra el
// equipo, o si participa en varias competiciones y ninguna coincide.
async function localizarGrupoDelEquipoPhoenix(page, nombreEquipo, nombreTorneo) {
  const url = `${SEARCH_TEAM_URL}?searchKey=${encodeURIComponent(nombreEquipo)}&unifiedFg=1&searchNation=ES`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const filas = page.locator("li.each");
  const totalFilas = await filas.count().catch(() => 0);
  if (totalFilas === 0) return null;

  const nombreTorneoNorm = quitarAcentos(nombreTorneo);
  const candidatos = []; // { cpttnId, searchDivision, titulo }

  for (let i = 0; i < totalFilas; i++) {
    const fila = filas.nth(i);
    const toggle = fila.locator("p.box_list_toggle").first();
    if ((await toggle.count().catch(() => 0)) === 0) continue;
    await toggle.click();
    // El panel de competiciones se rellena por AJAX tras el click.
    const bloques = fila.locator("div.competition");
    await bloques
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => {});
    const totalBloques = await bloques.count().catch(() => 0);
    for (let j = 0; j < totalBloques; j++) {
      const bloque = bloques.nth(j);
      const titulo = ((await bloque.locator("div.infos p.c_name").first().textContent().catch(() => "")) || "").trim();
      const enlaceGrupoPropio = bloque.locator("div.divisions a:has(span.tab_division_on)").first();
      if ((await enlaceGrupoPropio.count().catch(() => 0)) === 0) continue;
      const href = await enlaceGrupoPropio.getAttribute("href").catch(() => null);
      const coincide = href && href.match(/goCpttnDvDetail\(\s*(\d+)\s*,\s*(\d+)/);
      if (!coincide) continue;
      candidatos.push({ cpttnId: coincide[1], searchDivision: coincide[2], titulo });
    }
  }

  if (candidatos.length === 0) return null;
  if (candidatos.length === 1) return candidatos[0];

  const coincidencia = candidatos.find(
    (c) => quitarAcentos(c.titulo).includes(nombreTorneoNorm) || nombreTorneoNorm.includes(quitarAcentos(c.titulo))
  );
  return coincidencia || null;
}

// Lee la tabla `div.ranking_form table.tb_style01` de la página ya
// cargada. A diferencia de Radikal, aquí no se busca por texto de
// cabecera (para no depender del idioma) sino por posición de columna,
// que está fijada por el propio <thead> de la web (ver comentario más
// arriba). Devuelve un array de filas, o null si no encuentra la tabla o
// no tiene filas de equipo reconocibles.
async function leerClasificacionEquiposPhoenixML(page, cpttnId, searchDivision) {
  const url = `${RANKING_ML_URL}?cpttnId=${encodeURIComponent(cpttnId)}&searchDivision=${encodeURIComponent(searchDivision)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const tabla = page.locator("div.ranking_form table.tb_style01").first();
  if ((await tabla.count().catch(() => 0)) === 0) return null;
  const filas = await tabla.locator("tbody tr").all();
  if (filas.length === 0) return null;

  const numero = (texto, entero) => {
    if (texto == null) return null;
    const limpio = texto.trim().replace(",", ".");
    if (limpio === "") return null;
    const n = parseFloat(limpio);
    if (Number.isNaN(n)) return null;
    return entero ? Math.trunc(n) : n;
  };

  const filasEquipo = [];
  for (const fila of filas) {
    const celdas = (await fila.locator("td").allTextContents()).map((c) => c.trim());
    // [rank, teamName, rating, ppd, mpr, totalPoint, matchW, matchL, matchD, matchWinRate, setW, setL, setD, setWinRate, penalty]
    if (celdas.length < 15) continue;
    const nombreEquipo = celdas[1];
    if (!nombreEquipo) continue;
    // El rank puede venir como rango ("5 ~ 8") cuando hay empate: nos
    // quedamos con el primer número.
    const posicionTexto = celdas[0].replace(/[^\d].*$/, "");
    const matchW = numero(celdas[6], true);
    const matchL = numero(celdas[7], true);
    const matchD = numero(celdas[8], true);
    filasEquipo.push({
      posicion: numero(posicionTexto, true) ?? filasEquipo.length + 1,
      nombreEquipo,
      puntos: numero(celdas[5]),
      partidosJugados: matchW != null && matchL != null && matchD != null ? matchW + matchL + matchD : null,
      partidosGanados: matchW,
      partidosPerdidos: matchL,
      partidosEmpatados: matchD,
      juegosGanados: numero(celdas[10], true),
      juegosPerdidos: numero(celdas[11], true),
    });
  }
  return filasEquipo.length > 0 ? filasEquipo : null;
}

// ---------------------------------------------------------------------------
// Calendario y resultados de NUESTRO equipo (Multi League) — añadido el
// 2026-10-20 con la "LIGA EQUIPOS 26-27". Páginas públicas:
//
// - selectMatchListML.do?cpttnId=&searchDivision=&searchTeam=&searchYear=
//   &searchMonth= → tabla `table.tb_style03` con los partidos del grupo
//   (filtrable por equipo y AÑO: sin searchYear solo enseña el año en curso,
//   así que se pide cada año de la temporada, que sale en la cabecera como
//   "19/10/2026 ~ 14/03/2027"). El id de cada equipo está en el <select
//   name="searchTeam"> (texto "VDC EXTREME_LE2627_GRUPO 048").
//   Cada fila: [fecha "20/10 (Tue.)" (con rowspan si hay varios partidos ese
//   día; sin celda de fecha en las filas siguientes), hora "21:30", tipo,
//   local (span.ellipsis = nombre), marcador local, marcador visitante,
//   visitante, estado ("Preparado", "Terminado"…)]. Las celdas llevan
//   onclick="goMatchDetail(<brcktId>)". OJO: el "marcador" de la lista son
//   PUNTOS de liga (victoria = 2), no partidas.
// - selectMatchDetailORLineupML.do?cpttnId=&brcktId= (redirige al detalle):
//   `div.vs_info div.set p` = partidas ganadas local / visitante (ej. 7 y 5).
//   Solo se abre para partidos terminados que aún no tienen resultado
//   guardado.
// Las horas se interpretan como hora de España (Europe/Madrid).
// ---------------------------------------------------------------------------

const MATCH_LIST_ML_URL = "https://play.phoenixdarts.com/selectMatchListML.do";
const MATCH_DETAIL_ML_URL = "https://play.phoenixdarts.com/selectMatchDetailORLineupML.do";

// "BUZZ LIGHYEAR_LE2627_GRUPO 048" → "BUZZ LIGHYEAR"
function sinSufijoPhoenix(nombre) {
  return String(nombre || "").replace(/_[A-Z]{1,6}\d{2,6}(?:_.*)?$/i, "").trim() || String(nombre || "").trim();
}

// Fecha/hora "de pared" en Madrid → Date (UTC) correcto, con horario de
// verano/invierno.
function fechaMadrid(anio, mes, dia, hora, minuto) {
  const guess = Date.UTC(anio, mes - 1, dia, hora, minuto);
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(guess));
  const v = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  const comoMadrid = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute);
  return new Date(guess - (comoMadrid - guess));
}

// Partidos de UN equipo del club en su grupo. Devuelve [{ idExterno,
// jornada, fecha, rival, enCasa, terminado, resultado }] (mismo formato que
// Connection, ver sincronizarPartidosConnection). idsConResultado: Set de
// idExterno que ya tienen resultado guardado (no se vuelve a abrir su
// detalle).
async function leerPartidosEquipoPhoenixML(page, cpttnId, searchDivision, nombreEquipo, idsConResultado = new Set()) {
  const base = `${MATCH_LIST_ML_URL}?cpttnId=${encodeURIComponent(cpttnId)}&searchDivision=${encodeURIComponent(searchDivision)}`;
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const info = await page.evaluate(() => {
    const opciones = [...document.querySelectorAll('select[name="searchTeam"] option')].map((o) => ({
      id: o.value,
      texto: (o.textContent || "").trim(),
    }));
    const periodo = (document.body.innerText || "").match(/(\d{2})\/(\d{2})\/(\d{4})\s*~\s*(\d{2})\/(\d{2})\/(\d{4})/);
    return {
      opciones,
      periodo: periodo ? [+periodo[3], +periodo[6]] : null,
      partesPeriodo: periodo ? [+periodo[1], +periodo[2], +periodo[4], +periodo[5]] : null,
    };
  });
  // Por si el país no se pudo fijar a España: si la cabecera del periodo
  // viene como mm/dd (algún "día" > 12 en segunda posición), se lee así.
  const pp = info.partesPeriodo;
  const mesPrimero = !!pp && (pp[1] > 12 || pp[3] > 12) && pp[0] <= 12 && pp[2] <= 12;

  const buscado = quitarAcentos(nombreEquipo);
  const nuestro = info.opciones.find((o) => {
    const t = quitarAcentos(o.texto);
    return o.id && (t === buscado || t.startsWith(buscado + "_") || quitarAcentos(sinSufijoPhoenix(o.texto)) === buscado);
  });
  if (!nuestro) throw new Error(`no aparece "${nombreEquipo}" en el calendario de su grupo`);

  const anioActual = new Date().getFullYear();
  const [desde, hasta] = info.periodo || [anioActual, anioActual];
  const filas = [];
  for (let anio = desde; anio <= hasta; anio++) {
    await page.goto(`${base}&searchTeam=${encodeURIComponent(nuestro.id)}&searchYear=${anio}&searchMonth=`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const delAnio = await page.evaluate(() => {
      const tabla = document.querySelector("table.tb_style03");
      if (!tabla) return [];
      const res = [];
      let fecha = null;
      for (const tr of [...tabla.querySelectorAll("tbody tr")]) {
        const celdas = [...tr.querySelectorAll("td")];
        const conBrckt = celdas.find((c) => /goMatchDetail\(\s*\d+/.test(c.getAttribute("onclick") || ""));
        if (!conBrckt) continue;
        const brcktId = (conBrckt.getAttribute("onclick") || "").match(/goMatchDetail\(\s*(\d+)/)[1];
        const textoFecha = (celdas[0].textContent || "").match(/(\d{2})\/(\d{2})/);
        if (textoFecha) fecha = [+textoFecha[1], +textoFecha[2]];
        const hora = (tr.textContent || "").match(/\b(\d{1,2}):(\d{2})\b/);
        const local = tr.querySelector("td.l_team span.ellipsis:not(.shop)");
        const visitante = tr.querySelector("td.r_team span.ellipsis:not(.shop)");
        const marcadores = tr.querySelectorAll("span.win, span.lose, span.draw");
        const estado = (celdas[celdas.length - 2]?.textContent || "").trim();
        res.push({
          brcktId,
          fecha,
          hora: hora ? [+hora[1], +hora[2]] : [0, 0],
          local: (local?.textContent || "").trim(),
          visitante: (visitante?.textContent || "").trim(),
          terminado: marcadores.length > 0 || /terminad/i.test(estado),
        });
      }
      return res;
    });
    for (const f of delAnio) {
      if (!f.fecha) continue;
      // f.fecha = [primer número, segundo número] tal cual sale ("20/10")
      const [dia, mes] = mesPrimero ? [f.fecha[1], f.fecha[0]] : f.fecha;
      filas.push({ ...f, fecha: [dia, mes], anio });
    }
  }

  filas.sort((a, b) => fechaMadrid(a.anio, a.fecha[1], a.fecha[0], ...a.hora) - fechaMadrid(b.anio, b.fecha[1], b.fecha[0], ...b.hora));
  const nombreNuestro = quitarAcentos(nuestro.texto);
  const partidos = [];
  let jornada = 0;
  for (const f of filas) {
    jornada++;
    const enCasa = quitarAcentos(f.local) === nombreNuestro;
    const idExterno = `phoenix:${f.brcktId}:${nuestro.id}`;
    let resultado = null;
    if (f.terminado && !idsConResultado.has(idExterno)) {
      try {
        await page.goto(`${MATCH_DETAIL_ML_URL}?cpttnId=${encodeURIComponent(cpttnId)}&brcktId=${encodeURIComponent(f.brcktId)}`, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        const sets = await page.$$eval("div.vs_info div.set p", (ps) => ps.map((p) => (p.textContent || "").trim()));
        if (sets.length >= 2 && /^\d+$/.test(sets[0]) && /^\d+$/.test(sets[1])) {
          resultado = enCasa ? `${sets[0]}-${sets[1]}` : `${sets[1]}-${sets[0]}`;
        }
      } catch {
        resultado = null; // se reintenta en la siguiente actualización
      }
    }
    partidos.push({
      idExterno,
      jornada,
      fecha: fechaMadrid(f.anio, f.fecha[1], f.fecha[0], ...f.hora),
      fechaEsLimite: false,
      rival: sinSufijoPhoenix(enCasa ? f.visitante : f.local),
      enCasa,
      terminado: f.terminado,
      resultado,
    });
  }
  return partidos;
}

// equiposTorneo: [{ id, idExterno, nombre }] — un elemento por cada
// EquipoTorneo (inscripción de un equipo del club en este Torneo/Liga) que
// se quiera actualizar. `id` es el id del EquipoTorneo (no del Torneo).
// `idExterno` es el nombre EXACTO de ESE equipo en Phoenix Darts (ej. "VDC
// Gentlemen" — viene de EquipoTorneo.idExternoEquipo). "nombre" es el
// nombre que le hemos puesto nosotros al Torneo/Liga, y se usa solo para
// desambiguar si ese equipo compite en más de una competición de Phoenix a
// la vez. Se reutiliza un único navegador para toda la lista, así que
// conviene pasar de una vez todos los equipos de un mismo Torneo en lugar
// de llamar a la función una vez por equipo. Opcional por equipo:
// conPartidos (true = leer también su calendario/resultados) e
// idsConResultado (Set). Devuelve [{ equipoTorneoId, ok, filas?, partidos?,
// avisoPartidos?, error? }].
export async function extraerClasificacionEquiposPhoenix(equiposTorneo) {
  const conNombre = equiposTorneo.filter((t) => (t.idExterno || "").trim());
  const resultados = equiposTorneo
    .filter((t) => !(t.idExterno || "").trim())
    .map((t) => ({
      equipoTorneoId: t.id,
      ok: false,
      error: 'Falta indicar el nombre exacto de este equipo en Phoenix Darts (campo "Id del equipo en Phoenix Darts" en su inscripción, pestaña "Equipos").',
    }));
  if (conNombre.length === 0) return resultados;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();

    await fijarIdiomaEspanol(page);

    for (const { id, idExterno, nombre, conPartidos, idsConResultado } of conNombre) {
      try {
        const destino = await localizarGrupoDelEquipoPhoenix(page, idExterno, nombre);
        if (!destino) {
          resultados.push({
            equipoTorneoId: id,
            ok: false,
            error: `No se encontró en Phoenix Darts (España) ningún equipo llamado "${idExterno}", o compite en varias competiciones y ninguna coincide con el nombre del torneo ("${nombre}"). Revisa el nombre exacto del equipo.`,
          });
          continue;
        }
        const filas = await leerClasificacionEquiposPhoenixML(page, destino.cpttnId, destino.searchDivision);
        if (!filas) {
          resultados.push({
            equipoTorneoId: id,
            ok: false,
            error: `Se encontró el equipo "${idExterno}" en Phoenix Darts pero no se pudo leer su tabla de clasificación (puede que Phoenix Darts haya cambiado el formato de la página).`,
          });
          continue;
        }
        // Calendario y resultados de este equipo (solo si se piden): un
        // fallo aquí no tumba la clasificación, se avisa aparte.
        let partidos = null;
        let avisoPartidos = null;
        if (conPartidos) {
          try {
            partidos = await leerPartidosEquipoPhoenixML(page, destino.cpttnId, destino.searchDivision, idExterno, idsConResultado);
          } catch (err) {
            avisoPartidos = `no se pudo leer el calendario (${err.message || err})`;
          }
        }
        resultados.push({ equipoTorneoId: id, ok: true, filas, partidos, avisoPartidos });
      } catch (err) {
        resultados.push({ equipoTorneoId: id, ok: false, error: err.message || "Error consultando Phoenix Darts" });
      }
    }
  } finally {
    await browser.close();
  }
  return resultados;
}
