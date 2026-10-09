import { chromium } from "playwright";
import {
  contieneAliasComoPalabra,
  contieneLocalidad,
  esMismoAlias,
  regexAliasExacto,
} from "./coincidenciaAlias.js";

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
  const idx = lineas.findIndex((l) => esMismoAlias(l, alias));
  if (idx === -1) return null;

  let mpr = null;
  let ppd = null;
  for (let i = idx; i < Math.min(idx + 6, lineas.length); i++) {
    const mprMatch = lineas[i].match(/MPR:\s*([\d.,]+)/i);
    const ppdMatch = lineas[i].match(/PPD:\s*([\d.,]+)/i);
    if (mprMatch) mpr = parseFloat(mprMatch[1].replace(",", "."));
    if (ppdMatch) ppd = parseFloat(ppdMatch[1].replace(",", "."));
  }
  if (mpr === null && ppd === null) return null;
  return { mpr, ppd };
}

// Resultados de "Buscar" cuyo nombre es EXACTAMENTE el alias, cada uno con
// el texto de su tarjeta (nombre, localidad y "MPR: x" / "PPD: y").
// Connection permite que varios jugadores tengan el mismo alias, así que
// puede haber más de uno. La tarjeta se localiza subiendo desde el nombre
// hasta el primer contenedor que ya incluye las cifras de MPR y PPD.
async function tarjetasConAlias(page, alias) {
  const coincidencias = page.getByText(regexAliasExacto(alias));
  await coincidencias.first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const nombres = await coincidencias.all();
  const tarjetas = [];
  for (const nombre of nombres) {
    if (!(await nombre.isVisible().catch(() => false))) continue;
    const texto = await nombre
      .evaluate((el) => {
        let n = el;
        while (n && !(/MPR/i.test(n.innerText || "") && /PPD/i.test(n.innerText || ""))) n = n.parentElement;
        return (n || el).innerText || "";
      })
      .catch(() => "");
    tarjetas.push({ nombre, texto });
  }
  return tarjetas;
}

// Localidad que enseña una tarjeta de resultado (la línea que sigue al
// alias), para dar pistas en los mensajes de error.
function localidadDeTarjeta(texto, alias) {
  const lineas = texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const idx = lineas.findIndex((l) => esMismoAlias(l, alias));
  const siguiente = idx === -1 ? null : lineas[idx + 1];
  return siguiente && !/^(MPR|PPD):/i.test(siguiente) ? siguiente : "sin localidad";
}

// registros: [{ id, idExterno, notaBusqueda }] (id = id de la fila
// JugadorFabricanteId, no del jugador; notaBusqueda = localidad opcional del
// jugador, para distinguirlo de otros con el mismo alias). Devuelve [{ id, ok, mprVirtual?, ppdVirtual?, mprPresencial?,
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
      ? // Alias como palabra completa: con un "contiene", un socio cuyo alias
        // va dentro del de la cuenta del club (p.ej. "mañu" en "erMAÑUe")
        // se quedaba con las medias de esa cuenta.
        // Y si el socio ha puesto localidad, también tiene que coincidir:
        // otro jugador puede tener el mismo alias que la cuenta del club.
        registros.find(
          (r) =>
            contieneAliasComoPalabra(textoInicio, r.idExterno) &&
            (!(r.notaBusqueda || "").trim() || contieneLocalidad(textoInicio, r.notaBusqueda))
        )?.id
      : undefined;

    for (const { id, idExterno, notaBusqueda } of registros) {
      const localidad = (notaBusqueda || "").trim();
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

        // Connection deja que varios jugadores tengan el mismo alias, así que
        // solo se aceptan resultados cuyo nombre sea EXACTAMENTE el alias
        // (antes, al buscar "mañu" se abría "erMAÑUe") y, si hay más de uno,
        // se elige por la localidad que el socio ha guardado en notaBusqueda
        // (la que la tarjeta enseña bajo el nombre, p.ej. "BERAUN, GIPUZKOA,
        // ES"). Sin localidad y con varios candidatos no se adivina: mejor un
        // error que guardar las medias de otro jugador.
        const todas = await tarjetasConAlias(page, idExterno);
        const candidatas = localidad ? todas.filter((t) => contieneLocalidad(t.texto, localidad)) : todas;
        const localidades = todas.map((t) => localidadDeTarjeta(t.texto, idExterno)).join(" | ");
        if (localidad && todas.length > 0 && candidatas.length === 0) {
          resultados.push({
            id,
            ok: false,
            error: `Ningún jugador "${idExterno}" de Connection Darts es de "${localidad}". Localidades encontradas: ${localidades}`,
          });
          continue;
        }
        if (candidatas.length > 1) {
          resultados.push({
            id,
            ok: false,
            error: localidad
              ? `Hay ${candidatas.length} jugadores "${idExterno}" de "${localidad}" en Connection Darts; afina la localidad. Localidades: ${localidades}`
              : `Hay ${candidatas.length} jugadores "${idExterno}" en Connection Darts; indica tu localidad para saber cuál eres. Localidades: ${localidades}`,
          });
          continue;
        }
        const tarjeta = candidatas[0];

        // Entrar en el "Perfil de jugador" del resultado (pulsando su
        // nombre) para leer también la media Presencial, que no sale en la
        // lista. Si por lo que sea no se puede abrir/leer, se cae al
        // parseo de reserva (solo Virtual) más abajo, en vez de fallar del
        // todo. El perfil se abre en una ventana encima de la lista, así que
        // se lee solo el texto de esa ventana (si no, el alias o la localidad
        // de otras tarjetas de debajo darían el perfil por bueno), y se
        // comprueba que muestra el alias buscado y, si hay, la localidad.
        let statsDetallados = null;
        if (tarjeta) {
          try {
            await tarjeta.nombre.click({ timeout: 5000 });
            const cabecera = page.getByText(/Perfil de jugador/i).first();
            await cabecera.waitFor({ state: "visible", timeout: 8000 });
            await page.waitForTimeout(400);
            const textoPerfil = await cabecera.evaluate((el) => {
              let n = el;
              while (n && !/PPD\s*\(Virtual\)/i.test(n.innerText || "")) n = n.parentElement;
              return (n || document.body).innerText || "";
            });
            if (
              contieneAliasComoPalabra(textoPerfil, idExterno) &&
              (!localidad || contieneLocalidad(textoPerfil, localidad))
            ) {
              statsDetallados = parsearPerfilDetallado(textoPerfil);
            }
          } catch {
            statsDetallados = null;
          }
        }

        if (statsDetallados) {
          resultados.push({ id, ok: true, ...statsDetallados });
          continue;
        }

        const encontrado = tarjeta ? parsearMediaListaBusqueda(tarjeta.texto, idExterno) : null;
        if (!encontrado) {
          const texto = await page.locator("body").innerText();
          const snippet = texto.replace(/\s+/g, " ").trim().slice(0, 1800);
          resultados.push({
            id,
            ok: false,
            error: `Alias no encontrado en Connection Darts. texto="${snippet}"`,
          });
          continue;
        }
        // Solo se pudo leer la tarjeta de la lista, no el perfil detallado:
        // lo que ahí se ve es la media Virtual (confirmado contra la web real).
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

// ---------------------------------------------------------------------------
// Clasificación de equipos (Ligas de Connection Darts)
//
// Investigado el 2026-10-06 con la primera liga real (LIGA COMBO 26/27): la
// web pinta la clasificación desde una API REST propia
// (api.connectionplayer.com) que exige las cabeceras de sesión del usuario
// logueado (authorization, accesstoken, refreshtoken, playerid,
// clienttype). Con ellas se puede leer CUALQUIER liga por su id numérico,
// no solo las de "Mis Ligas" de la cuenta logueada:
//   GET /v1/league/{ligaId}/groups                       → { groups: [{ id, name }] }
//   GET /v1/league/{ligaId}/group/{grupoId}/ranking      → { rankings: [{ team_id,
//        team_name, position, points, played, won, drawn, lost,
//        score_for, score_against, ... }] }
//
// En Connection cada día de la semana es una liga distinta (ej. Liga Combo:
// 25201 viernes, 25202 jueves, 25203 miércoles, 25204 martes), y cada equipo
// del club cae en un grupo de una de ellas. Por eso Torneo.idExterno guarda
// la LISTA de ids de liga separados por comas, y para cada equipo del club
// se recorren todos los grupos de esas ligas hasta encontrarlo. Se guarda
// la tabla completa de SU grupo (igual que Phoenix: una tabla por
// EquipoTorneo).
//
// Para localizar el equipo: EquipoTorneo.idExternoEquipo (nombre exacto en
// Connection, ej. "CB26V-VDC VALHALLA") si está puesto; si no, se compara
// el nombre del equipo del club ignorando el prefijo de liga ("CB26V-") y
// las palabras VDC/VIKINGS/THE (ej. "VIKINGS VALHALLA" ↔ "CB26V-VDC
// VALHALLA" → los dos quedan en "VALHALLA").

const API_CONNECTION = "https://api.connectionplayer.com/v1";
const CABECERAS_SESION = ["accept", "authorization", "accesstoken", "refreshtoken", "playerid", "clienttype"];

function nombreClave(nombre) {
  return (nombre || "")
    .toUpperCase()
    .replace(/^[A-Z0-9]+-/, "") // prefijo de liga tipo "CB26V-"
    .replace(/\b(VDC|VIKINGS|THE)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function coincideEquipo(nombreConnection, { nombreExacto, nombreClub }) {
  if (nombreExacto) return nombreConnection.trim().toUpperCase() === nombreExacto.trim().toUpperCase();
  const clave = nombreClave(nombreClub);
  return !!clave && nombreClave(nombreConnection) === clave;
}

// Login con la cuenta de CONNECTION_DARTS_EMAIL/PASSWORD y captura de las
// cabeceras de sesión que la propia SPA manda a su API.
async function abrirSesionApiConnection(page) {
  const email = process.env.CONNECTION_DARTS_EMAIL;
  const password = process.env.CONNECTION_DARTS_PASSWORD;
  if (!email || !password) {
    throw new Error("Faltan las variables de entorno CONNECTION_DARTS_EMAIL / CONNECTION_DARTS_PASSWORD");
  }

  let cabeceras = null;
  page.on("request", (req) => {
    if (!req.url().startsWith("https://api.connectionplayer.com/")) return;
    const h = req.headers();
    if (!h.accesstoken && !h.authorization) return;
    cabeceras = Object.fromEntries(CABECERAS_SESION.filter((k) => h[k]).map((k) => [k, h[k]]));
  });

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.getByPlaceholder("Dirección de correo").fill(email);
  await page.getByPlaceholder("Contraseña").fill(password);
  await page.getByRole("button", { name: "Iniciar Sesión" }).click();
  await page.waitForFunction(() => !location.href.includes("login"), null, { timeout: 20000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Si el dashboard no ha hecho ninguna llamada autenticada todavía, forzar
  // una entrando en "Ligas".
  if (!cabeceras) {
    await page.goto("https://connectionplayer.com/leagues", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  if (!cabeceras) {
    throw new Error("Login en Connection Darts hecho, pero no se pudieron capturar las cabeceras de sesión de su API.");
  }
  return () => cabeceras;
}

// GET a la API desde dentro de la página (mismo origen/CORS que la propia web).
async function apiGet(page, getCabeceras, ruta) {
  const r = await page.evaluate(
    async ({ url, headers }) => {
      const res = await fetch(url, { headers });
      return { status: res.status, texto: await res.text() };
    },
    { url: `${API_CONNECTION}${ruta}`, headers: getCabeceras() }
  );
  if (r.status !== 200) throw new Error(`API Connection ${ruta} → HTTP ${r.status}: ${r.texto.slice(0, 120)}`);
  return JSON.parse(r.texto);
}

// Quita el prefijo de liga que Connection pone a todos los nombres
// ("CB26V-LOS PITOCHAS" → "LOS PITOCHAS", "SU262-Walter" → "Walter").
function sinPrefijo(nombre) {
  return String(nombre || "").replace(/^[A-Z0-9]{3,8}-/i, "").trim() || String(nombre || "");
}

// En los grupos impares Connection mete un "equipo" ficticio de descanso
// (ej. "SU262-PLATA4", ciudad "ATSEDENA", provincia "DESCANSO").
function esDescanso(nombre, ciudad, provincia) {
  return /descanso|atsedena/i.test(`${ciudad || ""} ${provincia || ""}`);
}

function filasRanking(rankings) {
  return [...(rankings || [])]
    .filter((t) => !esDescanso(t.team_name, t.team_city, t.team_region))
    .sort((a, b) => a.position - b.position)
    .map((t) => ({
      posicion: t.position,
      nombreEquipo: sinPrefijo(t.team_name),
      puntos: t.points ?? null,
      partidosJugados: t.played ?? null,
      partidosGanados: t.won ?? null,
      partidosPerdidos: t.lost ?? null,
      partidosEmpatados: t.drawn ?? null,
      juegosGanados: t.score_for ?? null,
      juegosPerdidos: t.score_against ?? null,
    }));
}

// Calendario de un grupo (GET /league/{l}/group/{g}/calendar):
//   { calendar: { days: [{ day_number, matches: [{ match_id, match_start,
//     match_end, match_state (0 pendiente, 1 en juego, 2 terminado),
//     local_team_id, local_name, local_region, visitor_team_id,
//     visitor_name, visitor_region, local_score, visitor_score }] }] } }
//
// Dos tipos de jornada:
//  - Ligas de equipos (Combo): match_start es el día y hora fijos de la
//    jornada (ej. viernes 18:00) → esa es la fecha.
//  - Ligas individuales (Super One): la jornada es una VENTANA de varias
//    semanas (match_start = apertura, match_end = fecha límite) y cada
//    jugador queda con su rival → se usa la FECHA LÍMITE; el jugador pone la
//    fecha real al confirmar.
// Se descartan los "partidos" contra el equipo de descanso.
// idExterno incluye nuestro team_id porque en una liga individual dos
// jugadores del club pueden enfrentarse entre sí (mismo match_id).
function partidosDeEquipo(cal, teamId) {
  const dias = cal?.calendar?.days || [];
  const lista = [];
  for (const d of dias) {
    for (const m of d.matches || []) {
      const enCasa = String(m.local_team_id) === teamId;
      if (!enCasa && String(m.visitor_team_id) !== teamId) continue;
      const rivalNombre = enCasa ? m.visitor_name : m.local_name;
      const rivalCiudad = enCasa ? m.visitor_city : m.local_city;
      const rivalProvincia = enCasa ? m.visitor_region : m.local_region;
      if (esDescanso(rivalNombre, rivalCiudad, rivalProvincia)) continue;
      const inicio = Number(m.match_start);
      const fin = Number(m.match_end);
      const esVentana = fin && fin - inicio > 2 * 24 * 3600 * 1000;
      const terminado = Number(m.match_state) === 2;
      const nuestros = enCasa ? m.local_score : m.visitor_score;
      const suyos = enCasa ? m.visitor_score : m.local_score;
      lista.push({
        idExterno: `connection:${m.match_id}:${teamId}`,
        idExternoAntiguo: `connection:${m.match_id}`,
        jornada: Number(m.day_number) + 1,
        fecha: new Date(esVentana ? fin : inicio),
        fechaEsLimite: !!esVentana,
        rival: sinPrefijo(rivalNombre),
        enCasa,
        terminado,
        resultado: terminado ? `${nuestros}-${suyos}` : null,
      });
    }
  }
  return lista;
}

// ligaIdsTexto: Torneo.idExterno, ej. "25201,25202,25203,25204".
// equipos: [{ id (EquipoTorneo), nombreExacto?, nombreClub? }].
// Devuelve [{ equipoTorneoId, ok, filas?, grupo?, partidos?, avisoPartidos?,
// error? }] — mismo formato que extraerClasificacionEquiposPhoenix, más los
// partidos de ESE equipo (ver partidosDeEquipo) para sincronizar calendario
// y resultados.
export async function extraerClasificacionEquiposConnection(ligaIdsTexto, equipos) {
  const ligaIds = String(ligaIdsTexto || "")
    .split(/[^0-9]+/)
    .filter(Boolean);
  if (ligaIds.length === 0) {
    return equipos.map((e) => ({
      equipoTorneoId: e.id,
      ok: false,
      error:
        'Falta el "Id externo" del torneo: los ids de liga de Connection Darts separados por comas (ej. 25201,25202,25203,25204).',
    }));
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();
    const getCabeceras = await abrirSesionApiConnection(page);

    // Descargar una vez todos los grupos de todas las ligas indicadas. Al
    // acabar la temporada Connection "archiva" la liga: entonces los grupos
    // solo salen con archived=1.
    const grupos = []; // [{ ligaId, grupoId, nombreGrupo, archivada, rankings }]
    const erroresLiga = [];
    for (const ligaId of ligaIds) {
      try {
        let archivada = 0;
        let { groups = [] } = await apiGet(page, getCabeceras, `/league/${ligaId}/groups`);
        if (groups.length === 0) {
          archivada = 1;
          ({ groups = [] } = await apiGet(page, getCabeceras, `/league/${ligaId}/groups?archived=1`));
        }
        for (const g of groups) {
          const r = await apiGet(
            page,
            getCabeceras,
            `/league/${ligaId}/group/${g.id}/ranking?teamName=&archived=${archivada}`
          );
          grupos.push({ ligaId, grupoId: g.id, nombreGrupo: g.name, archivada, rankings: r.rankings || [] });
        }
      } catch (err) {
        erroresLiga.push(`liga ${ligaId}: ${err.message}`);
      }
    }

    const resultados = [];
    for (const eq of equipos) {
      const encontrados = grupos.filter((g) => g.rankings.some((t) => coincideEquipo(t.team_name, eq)));
      if (encontrados.length === 1) {
        const g = encontrados[0];
        const equipoConnection = g.rankings.find((t) => coincideEquipo(t.team_name, eq));
        // Calendario y resultados SOLO de los partidos de este equipo.
        let partidos = null;
        let avisoPartidos = null;
        try {
          const cal = await apiGet(
            page,
            getCabeceras,
            `/league/${g.ligaId}/group/${g.grupoId}/calendar?archived=${g.archivada}`
          );
          partidos = partidosDeEquipo(cal, String(equipoConnection.team_id));
        } catch (err) {
          avisoPartidos = `no se pudo leer el calendario (${err.message})`;
        }
        resultados.push({
          equipoTorneoId: eq.id,
          ok: true,
          grupo: `${g.ligaId} · ${g.nombreGrupo}`,
          filas: filasRanking(g.rankings),
          partidos,
          avisoPartidos,
        });
        continue;
      }
      const quien = eq.nombreExacto || eq.nombreClub || "equipo";
      const extra = erroresLiga.length ? ` (errores: ${erroresLiga.join("; ")})` : "";
      resultados.push({
        equipoTorneoId: eq.id,
        ok: false,
        error:
          encontrados.length === 0
            ? `"${quien}" no aparece en ningún grupo de las ligas ${ligaIds.join(", ")}. Pon su nombre exacto de Connection en la inscripción del equipo.${extra}`
            : `"${quien}" coincide con varios equipos de Connection. Pon su nombre exacto en la inscripción del equipo.`,
      });
    }
    return resultados;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Ligas INDIVIDUALES (ej. SUPER ONE 2026 ORO/PLATA/BRONCE, ids 25233-25235)
//
// No se casa por equipos: se parte de los jugadores del club que tienen
// alias de Connection guardado en su perfil. Para cada uno:
//   1. GET /community/{miPlayerId}?filter={alias}&pageNumber=1 → su player id
//      (coincidencia exacta de alias). La cuenta logueada no se encuentra a
//      sí misma en ese buscador: se reconoce comparando con su propio alias
//      (GET /player/{miPlayerId}/data).
//   2. GET /player/{id}/leagues → ligas en las que juega, con teamId,
//      groupId y groupName. En una liga individual cada jugador es un
//      "equipo" de una persona (ej. "SU262-Fabyts").
//   3. Si juega en alguna de las ligas indicadas: tabla de su grupo y sus
//      partidos (mismo formato que en las ligas de equipos).
//
// jugadores: [{ jugadorId, alias, localidad? }]. Devuelve [{ jugadorId, alias,
// encontrado, juega, nombreConnection?, grupo?, filas?, partidos?,
// avisoPartidos?, error? }].
// Mayúsculas y sin tildes, para comparar localidades ("Beraun" ≈ "BERAUN").
function normalizarTexto(t) {
  return String(t || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9Ñ]+/g, " ")
    .trim();
}

export async function extraerLigaIndividualConnection(ligaIdsTexto, jugadores) {
  const ligaIds = String(ligaIdsTexto || "")
    .split(/[^0-9]+/)
    .filter(Boolean);
  if (ligaIds.length === 0) {
    throw new Error(
      'Falta el "Id externo" del torneo: los ids de liga de Connection Darts separados por comas (ej. 25233,25234,25235).'
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();
    const getCabeceras = await abrirSesionApiConnection(page);
    const api = (ruta) => apiGet(page, getCabeceras, ruta);
    const miId = getCabeceras().playerid;

    let miAlias = "";
    try {
      const yo = await api(`/player/${miId}/data`);
      miAlias = (yo.players?.[0]?.alias || "").trim().toUpperCase();
    } catch {
      /* sin alias propio: solo afecta a la autobúsqueda */
    }

    const cacheGrupos = new Map(); // `${ligaId}:${grupoId}` → { rankings, calendario }
    const resultados = [];

    for (const { jugadorId, alias, localidad } of jugadores) {
      const aliasNorm = (alias || "").trim().toUpperCase();
      try {
        let playerId = null;
        const busqueda = await api(`/community/${miId}?filter=${encodeURIComponent(alias.trim())}&pageNumber=1`);
        // Connection permite alias repetidos: si hay varios exactos, se
        // elige por la localidad guardada en el perfil del socio
        // (notaBusqueda, la misma que usan las medias).
        const exactos = (busqueda.community?.data || []).filter((p) => (p.alias || "").trim().toUpperCase() === aliasNorm);
        const loc = normalizarTexto(localidad);
        const candidatos = loc
          ? exactos.filter((p) => normalizarTexto(`${p.city || ""} ${p.region || ""}`).includes(loc))
          : exactos;
        if (candidatos.length > 1) {
          resultados.push({
            jugadorId,
            alias,
            encontrado: false,
            error: `hay ${candidatos.length} jugadores "${alias}" en Connection; indica tu localidad en el perfil para saber cuál eres`,
          });
          continue;
        }
        if (candidatos.length === 1) playerId = candidatos[0].id;
        else if (exactos.length === 0 && miAlias && (miAlias === aliasNorm || miAlias.startsWith(aliasNorm + " "))) playerId = miId;
        if (!playerId) {
          resultados.push({ jugadorId, alias, encontrado: false });
          continue;
        }

        const { leagues = [] } = await api(`/player/${playerId}/leagues`);
        const liga = leagues.find((l) => ligaIds.includes(String(l.id)));
        if (!liga) {
          resultados.push({ jugadorId, alias, encontrado: true, juega: false });
          continue;
        }

        const clave = `${liga.id}:${liga.groupId}`;
        if (!cacheGrupos.has(clave)) {
          const archivada = liga.archived ? 1 : 0;
          const r = await api(`/league/${liga.id}/group/${liga.groupId}/ranking?teamName=&archived=${archivada}`);
          let calendario = null;
          let errorCal = null;
          try {
            calendario = await api(`/league/${liga.id}/group/${liga.groupId}/calendar?archived=${archivada}`);
          } catch (err) {
            errorCal = err.message;
          }
          cacheGrupos.set(clave, { rankings: r.rankings || [], calendario, errorCal });
        }
        const g = cacheGrupos.get(clave);
        resultados.push({
          jugadorId,
          alias,
          encontrado: true,
          juega: true,
          nombreConnection: liga.teamName,
          grupo: `${liga.name} · ${liga.groupName}`,
          filas: filasRanking(g.rankings),
          partidos: g.calendario ? partidosDeEquipo(g.calendario, String(liga.teamId)) : null,
          avisoPartidos: g.errorCal ? `no se pudo leer el calendario (${g.errorCal})` : null,
        });
      } catch (err) {
        resultados.push({ jugadorId, alias, encontrado: false, error: err.message || "Error consultando Connection Darts" });
      }
    }
    return resultados;
  } finally {
    await browser.close();
  }
}
