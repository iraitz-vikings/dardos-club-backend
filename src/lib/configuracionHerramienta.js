// Configuración de la herramienta de marcador (501/Cricket) que se puede
// activar en un TorneoClub o una LigaClub, para que los jugadores jueguen sus
// partidos desde la página pública en vez de que el admin meta el resultado
// a mano. Compartido entre torneosClub.js y ligasClub.js porque el formato
// es idéntico en los dos — ver el plan guardado en el proyecto
// ("herramienta-marcador-torneos-ligas-plan"), Slice 2.
//
// Forma esperada del JSON guardado en `configuracionHerramienta`:
//   {
//     activa: boolean,
//     porDefecto: { juego, alMejorDe, apertura?, cierre?, modoCricket? },
//     porRonda: { "<ronda o jornada>": { ...mismos campos, todos opcionales... } }
//   }
// `porRonda` deja jugar una configuración distinta por ronda de torneo (p.ej.
// "1", "2", "final") o por jornada de liga (p.ej. "3"): la clave es siempre
// texto, tal cual la manda el frontend, y solo hace falta indicar ahí los
// campos que cambian respecto a `porDefecto` — el resto los completa el
// código que arma la partida (Slice 4) con los valores por defecto.

export const JUEGOS_VALIDOS = ["501", "cricket", "ambos"];
export const MODALIDADES_501_VALIDAS = ["simple", "doble", "master"];
export const MODOS_CRICKET_VALIDOS = ["normal", "cutthroat"];

// Limpia y valida una configuración de juego (la de `porDefecto` o la de una
// entrada de `porRonda`). `requerida: true` exige que venga completa (se usa
// para `porDefecto` cuando la herramienta está activa); si no es obligatoria
// y no viene nada, se devuelve `valor: null` sin error (significa "usa la de
// por defecto para esta ronda/jornada").
function limpiarConfigJuego(valor, { requerida }) {
  if (valor === undefined || valor === null) {
    return requerida ? { ok: false, error: "Falta la configuración del juego (501/Cricket, al mejor de cuántas)." } : { ok: true, valor: null };
  }
  if (typeof valor !== "object" || Array.isArray(valor)) {
    return { ok: false, error: "La configuración del juego no es válida." };
  }
  if (!JUEGOS_VALIDOS.includes(valor.juego)) {
    return { ok: false, error: `Juego no válido: "${valor.juego}". Tiene que ser 501, cricket o ambos.` };
  }
  const alMejorDe = Number(valor.alMejorDe);
  if (!Number.isInteger(alMejorDe) || alMejorDe < 1 || alMejorDe > 15) {
    return { ok: false, error: '"Al mejor de" tiene que ser un número entero entre 1 y 15.' };
  }

  const limpio = { juego: valor.juego, alMejorDe };
  if (valor.juego === "501" || valor.juego === "ambos") {
    limpio.apertura = MODALIDADES_501_VALIDAS.includes(valor.apertura) ? valor.apertura : "simple";
    limpio.cierre = MODALIDADES_501_VALIDAS.includes(valor.cierre) ? valor.cierre : "doble";
  }
  if (valor.juego === "cricket" || valor.juego === "ambos") {
    limpio.modoCricket = MODOS_CRICKET_VALIDOS.includes(valor.modoCricket) ? valor.modoCricket : "normal";
  }
  return { ok: true, valor: limpio };
}

// `valor` es el body tal cual lo manda el frontend (req.body.configuracionHerramienta).
// undefined/null/"" se trata como "no se ha tocado nada" -> null (herramienta
// desactivada, sin configurar). Devuelve { ok: true, valor } o { ok: false, error }.
export function validarConfiguracionHerramienta(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return { ok: true, valor: null };
  }
  if (typeof valor !== "object" || Array.isArray(valor)) {
    return { ok: false, error: "La configuración de la herramienta de marcador no es válida." };
  }

  const activa = !!valor.activa;
  const porDefecto = limpiarConfigJuego(valor.porDefecto, { requerida: activa });
  if (!porDefecto.ok) return porDefecto;
  if (activa && !porDefecto.valor) {
    return { ok: false, error: "Hace falta una configuración por defecto (juego y al mejor de cuántas) para activar la herramienta." };
  }

  const porRonda = {};
  if (valor.porRonda && typeof valor.porRonda === "object" && !Array.isArray(valor.porRonda)) {
    for (const [clave, override] of Object.entries(valor.porRonda)) {
      const claveLimpia = String(clave).trim();
      if (!claveLimpia) continue;
      const limpio = limpiarConfigJuego(override, { requerida: false });
      if (!limpio.ok) return { ok: false, error: `Ronda/jornada "${claveLimpia}": ${limpio.error}` };
      if (limpio.valor) porRonda[claveLimpia] = limpio.valor;
    }
  }

  return { ok: true, valor: { activa, porDefecto: porDefecto.valor, porRonda } };
}

// Devuelve la configuración de juego que aplica a una ronda/jornada concreta
// (el override de `porRonda[clave]` si existe, si no `porDefecto`), o null si
// la herramienta no está activa. `clave` se compara como texto. La usará la
// Slice 4 (flujo público de juego) para montar el marcador con las reglas
// correctas de cada partido.
export function configuracionParaRonda(configuracionHerramienta, clave) {
  if (!configuracionHerramienta?.activa) return null;
  const override = configuracionHerramienta.porRonda?.[String(clave)];
  return override || configuracionHerramienta.porDefecto || null;
}
