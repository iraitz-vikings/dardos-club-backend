// Mensajes personalizables (opcional) de los avisos automáticos de un
// TorneoClub o una LigaClub — panel "Mensajes de avisos" en el admin, al
// lado de "Imágenes de avisos" (mismo campo Json?, ver schema.prisma). A
// petición de Iraitz, 2026-09-15: antes estos 5 mensajes estaban fijos en el
// código (torneosClub.js), traducidos a mano a ES/EU/FR — ahora el admin
// puede sobreescribir el texto de cualquiera de ellos, en cualquier idioma,
// para un torneo/liga concreto (p.ej. un mensaje especial para el Open).
// Cualquier campo que se deje vacío sigue usando el texto por defecto.
//
// Forma esperada del JSON guardado en `mensajesAvisos`:
//   {
//     bienvenida:  { titulo: { es, eu, fr }, cuerpo: { es, eu, fr } },
//     enCurso:     { titulo: {...}, cuerpo: {...} },
//     programado:  { titulo: {...}, cuerpo: {...} },
//     eliminado:   { titulo: {...}, cuerpo: {...} },
//     campeon:     { titulo: {...}, cuerpo: {...} },
//     unMinuto:    { titulo: {...}, cuerpo: {...} },
//   }
// Todos los campos son opcionales en todos los niveles — un objeto vacío
// {} (o directamente null) es válido y significa "usa todo el texto por
// defecto". Los valores vacíos ("" tras recortar espacios) se guardan como
// si no existieran, para no arrastrar strings vacíos en la base de datos.
//
// Placeholders disponibles en cada tipo (se sustituyen tal cual, ver
// `sustituir` más abajo — el admin los escribe literalmente entre llaves):
//   bienvenida: {competicion}
//   enCurso:    {competicion} {enfrentamiento} {maquina} {minutos}
//   programado: {competicion} {enfrentamiento} {fecha} {maquina}
//   eliminado:  {competicion}
//   campeon:    {competicion}
//   unMinuto:   {competicion} {enfrentamiento}   (aviso "falta 1 minuto" del
//               temporizador, ver src/lib/avisoTemporizadorPartidos.js)

export const TIPOS_MENSAJE = ["bienvenida", "enCurso", "programado", "eliminado", "campeon", "unMinuto"];
export const IDIOMAS_MENSAJE = ["es", "eu", "fr"];

// Limpia un bloque { es, eu, fr } de un campo (titulo o cuerpo): recorta
// espacios y descarta idiomas vacíos. Devuelve null si no queda nada.
function limpiarPorIdioma(valor) {
  if (valor == null || typeof valor !== "object" || Array.isArray(valor)) return null;
  const limpio = {};
  for (const idioma of IDIOMAS_MENSAJE) {
    const texto = typeof valor[idioma] === "string" ? valor[idioma].trim() : "";
    if (texto) limpio[idioma] = texto;
  }
  return Object.keys(limpio).length > 0 ? limpio : null;
}

// `valor` es el body tal cual lo manda el frontend (req.body.mensajesAvisos).
// undefined/null/"" -> "no se ha tocado nada" -> null. Devuelve
// { ok: true, valor } o { ok: false, error }.
export function validarMensajesAvisos(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return { ok: true, valor: null };
  }
  if (typeof valor !== "object" || Array.isArray(valor)) {
    return { ok: false, error: "Los mensajes de avisos no son válidos." };
  }

  const limpio = {};
  for (const [clave, bloque] of Object.entries(valor)) {
    if (!TIPOS_MENSAJE.includes(clave)) continue; // ignora claves desconocidas en vez de fallar
    if (!bloque || typeof bloque !== "object" || Array.isArray(bloque)) continue;
    const titulo = limpiarPorIdioma(bloque.titulo);
    const cuerpo = limpiarPorIdioma(bloque.cuerpo);
    if (titulo || cuerpo) {
      limpio[clave] = { ...(titulo ? { titulo } : {}), ...(cuerpo ? { cuerpo } : {}) };
    }
  }
  return { ok: true, valor: Object.keys(limpio).length > 0 ? limpio : null };
}

// Sustituye placeholders {clave} en una plantilla por los valores dados
// (objeto { clave: texto }) para el idioma `idioma`. Un valor puede ser un
// string plano (mismo texto en los 3 idiomas, p.ej. un nombre) o un objeto
// { es, eu, fr } cuando el texto alrededor del dato cambia según el idioma
// (p.ej. "en {maquina}" / "sur {maquina}"); en ese caso se usa val[idioma].
// Un placeholder sin valor (para ese idioma) se quita entero (con cualquier
// espacio suelto alrededor) en vez de dejar "{clave}" literal o un hueco
// raro — por ejemplo "{enfrentamiento}{maquina}." sin máquina queda "Fulano
// vs Mengano." en vez de "Fulano vs Mengano ."
function sustituir(plantilla, valores, idioma) {
  let texto = plantilla;
  for (const [clave, val] of Object.entries(valores)) {
    const texto_val = val && typeof val === "object" ? val[idioma] : val;
    if (texto_val) {
      texto = texto.split(`{${clave}}`).join(texto_val);
    } else {
      // Quita " {clave}", "{clave} " o "{clave}" sueltos, con el hueco de
      // alrededor, para no dejar frases cojas cuando falta el dato.
      texto = texto.replace(new RegExp(`\\s*\\{${clave}\\}`, "g"), "");
    }
  }
  return texto.trim();
}

// Devuelve { titulo, cuerpo } para un tipo de aviso, con el override del
// admin (si lo hay, en cualquier idioma que tenga relleno) o si no los
// valores por defecto que ya pasa cada llamada — ambos ya resueltos como
// objetos { es, eu, fr } listos para que notificar.js elija el idioma del
// jugador. `valores` son los placeholders de este envío en concreto
// (competicion, enfrentamiento, maquina, fecha) — cada uno un string plano o
// un objeto { es, eu, fr } si el texto de alrededor cambia por idioma (ver
// `sustituir`) —, ya sustituidos aquí mismo tanto en el override como en el
// texto por defecto.
//
// `valoresPersonalizado` (opcional) son los valores a usar en el texto que ha
// escrito el admin, cuando difieren de los del texto por defecto: los textos
// por defecto usan p.ej. {maquina} = " en Máquina 2" (con la palabra de
// enlace incluida, para que desaparezca entera si no hay máquina), pero en el
// panel el admin escribe "... en {maquina}", así que ahí {maquina} tiene que
// ser solo "Máquina 2" — si no, saldría "en en Máquina 2".
export function resolverMensaje(mensajesAvisos, tipo, porDefecto, valores, valoresPersonalizado = valores) {
  const override = mensajesAvisos?.[tipo];
  const resultado = { titulo: {}, cuerpo: {} };
  for (const idioma of IDIOMAS_MENSAJE) {
    const tituloOverride = override?.titulo?.[idioma];
    const cuerpoOverride = override?.cuerpo?.[idioma];
    resultado.titulo[idioma] = tituloOverride
      ? sustituir(tituloOverride, valoresPersonalizado, idioma)
      : sustituir(porDefecto.titulo[idioma], valores, idioma);
    resultado.cuerpo[idioma] = cuerpoOverride
      ? sustituir(cuerpoOverride, valoresPersonalizado, idioma)
      : sustituir(porDefecto.cuerpo[idioma], valores, idioma);
  }
  return resultado;
}
