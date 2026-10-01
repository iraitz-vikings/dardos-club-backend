// Comparación de alias de jugador con el texto de las webs de los
// fabricantes. Antes Phoenix Darts (y Connection Darts al reconocer la
// cuenta propia) buscaban el alias con un simple "contiene", así que el
// alias "mañu" casaba con "erMAÑUe" — caso real: un socio recibió las
// medias de otro jugador porque su alias aparecía DENTRO del alias ajeno.
//
// Reglas: sin distinguir mayúsculas, ignorando espacios de sobra y
// unificando la forma Unicode (una "ñ" puede venir como un carácter o como
// "n" + tilde combinable), pero SIN quitar acentos ni la ñ: "Mañu" y "Manu"
// son alias distintos.

export function normalizarAlias(texto) {
  return String(texto ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toUpperCase();
}

// El texto es exactamente el alias.
export function esMismoAlias(texto, alias) {
  const a = normalizarAlias(alias);
  return a !== "" && normalizarAlias(texto) === a;
}

function escaparRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// El texto contiene el alias como palabra completa: no puede tener letras,
// números ni "_" pegados delante o detrás. "MAÑU (ES)" o "Jugador: Mañu" sí
// casan con "mañu"; "ERMAÑUE" o "MAÑUEL" no.
export function contieneAliasComoPalabra(texto, alias) {
  const a = normalizarAlias(alias);
  if (a === "") return false;
  const patron = new RegExp(`(?<![\\p{L}\\p{N}_])${escaparRegex(a)}(?![\\p{L}\\p{N}_])`, "u");
  return patron.test(normalizarAlias(texto));
}

// Índice de la línea que corresponde al alias dentro de una lista de líneas:
// primero una línea que sea exactamente el alias; si no hay, una que lo
// contenga como palabra completa. -1 si ninguna — nunca se acepta el alias
// metido dentro de otra palabra.
export function indiceLineaAlias(lineas, alias) {
  const exacta = lineas.findIndex((l) => esMismoAlias(l, alias));
  if (exacta !== -1) return exacta;
  return lineas.findIndex((l) => contieneAliasComoPalabra(l, alias));
}

// Expresión regular para localizar en la página (p.ej. con getByText de
// Playwright) un elemento cuyo texto sea EXACTAMENTE el alias, sin
// distinguir mayúsculas. getByText(alias, { exact: false }) busca por
// fragmento: con "mañu" pulsaba en "erMAÑUe".
export function regexAliasExacto(alias) {
  return new RegExp(`^\\s*${escaparRegex(normalizarAlias(alias))}\\s*$`, "iu");
}
