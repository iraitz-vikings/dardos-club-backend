// Cálculo de la clasificación de una liga del club, con una cascada de
// desempate explícita. Antes esto vivía duplicado (con distintos matices) en
// el frontend (AdminLigasClub.jsx y LigaPage.jsx) y NO tenía ningún
// desempate más allá de la diferencia de partidas — si dos participantes
// quedaban igualados en puntos y en diferencia, el orden final dependía de
// en qué posición del array de participantes había caído cada uno al
// iterar, que no es un criterio real sino un efecto colateral del código.
// Esto importa especialmente ahora que la clasificación decide quién se
// lleva los "bye" del cuadrante final: un desempate no determinista ahí
// significa que dos jugadores empatados podrían recibir un trato distinto
// sin que exista ninguna regla que lo explique.
//
// Cascada de desempate, en este orden:
//   1. Puntos totales.
//   2. Enfrentamiento directo (solo entre los empatados en el punto 1):
//      mini-tabla de puntos usando SOLO los partidos jugados entre ellos.
//   3. Partidas ganadas totales (no la diferencia, el total).
//   4. Si después de todo eso siguen empatados (empate circular: A gana a
//      B, B gana a C, C gana a A — el enfrentamiento directo no lo puede
//      resolver matemáticamente), se marca `empateSinResolver: true` en
//      esas filas y se ordenan alfabéticamente entre sí SOLO para que el
//      resultado sea reproducible (misma entrada → misma salida siempre),
//      no como un criterio deportivo. La UI de admin debe mostrar ese caso
//      con claridad en vez de esconderlo.

function parseResultado(resultado) {
  if (!resultado) return null;
  const m = String(resultado).trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function filaVacia(nombre) {
  return {
    nombre,
    jugados: 0,
    victorias: 0,
    empates: 0,
    derrotas: 0,
    partidasGanadas: 0,
    partidasPerdidas: 0,
    puntos: 0,
    empateSinResolver: false,
  };
}

// Aplica los partidos (ya jugados, con resultado o ganador) sobre un mapa de
// filas por nombre. Se usa tanto para la clasificación general de un grupo
// como para la mini-tabla de enfrentamiento directo entre empatados.
function aplicarPartidos(stats, partidos) {
  for (const p of partidos) {
    const numeros = parseResultado(p.resultado);
    if (numeros) {
      const [a, b] = numeros;
      const f1 = stats[p.participante1];
      const f2 = stats[p.participante2];
      if (!f1 || !f2) continue;
      f1.jugados++; f2.jugados++;
      f1.partidasGanadas += a; f1.partidasPerdidas += b;
      f2.partidasGanadas += b; f2.partidasPerdidas += a;
      if (a > b) { f1.victorias++; f1.puntos += 2; f2.derrotas++; }
      else if (a < b) { f2.victorias++; f2.puntos += 2; f1.derrotas++; }
      else { f1.empates++; f2.empates++; f1.puntos += 1; f2.puntos += 1; }
    } else if (p.ganador) {
      const perdedor = p.ganador === p.participante1 ? p.participante2 : p.participante1;
      const fg = stats[p.ganador];
      const fp = stats[perdedor];
      if (!fg || !fp) continue;
      fg.jugados++; fp.jugados++;
      fg.victorias++; fg.puntos += 2;
      fp.derrotas++;
    }
  }
}

// Calcula la clasificación de una lista de participantes (etiquetas) con sus
// partidos (ya filtrados al grupo/subconjunto que corresponda por quien
// llama). Devuelve las filas ordenadas y con el desempate ya resuelto.
export function calcularClasificacion(etiquetas, partidos) {
  const stats = {};
  for (const nombre of etiquetas) stats[nombre] = filaVacia(nombre);
  aplicarPartidos(stats, partidos);

  const filas = Object.values(stats);

  // 1) Agrupar por puntos.
  const porPuntos = new Map();
  for (const f of filas) {
    if (!porPuntos.has(f.puntos)) porPuntos.set(f.puntos, []);
    porPuntos.get(f.puntos).push(f);
  }

  const ordenadas = [];
  const puntosDesc = [...porPuntos.keys()].sort((a, b) => b - a);

  for (const puntos of puntosDesc) {
    const grupo = porPuntos.get(puntos);
    if (grupo.length === 1) {
      ordenadas.push(grupo[0]);
      continue;
    }
    ordenadas.push(...desempatar(grupo, partidos));
  }

  return ordenadas;
}

function desempatar(empatados, todosLosPartidos) {
  // 2) Enfrentamiento directo: solo partidos jugados entre estos mismos
  // empatados (mini-liga cerrada).
  const nombres = new Set(empatados.map((f) => f.nombre));
  const partidosDirectos = todosLosPartidos.filter(
    (p) => nombres.has(p.participante1) && nombres.has(p.participante2)
  );
  const statsDirecto = {};
  for (const f of empatados) statsDirecto[f.nombre] = filaVacia(f.nombre);
  aplicarPartidos(statsDirecto, partidosDirectos);

  const conDesempate = empatados.map((f) => ({
    original: f,
    puntosDirecto: statsDirecto[f.nombre].puntos,
  }));

  const porPuntosDirecto = new Map();
  for (const c of conDesempate) {
    if (!porPuntosDirecto.has(c.puntosDirecto)) porPuntosDirecto.set(c.puntosDirecto, []);
    porPuntosDirecto.get(c.puntosDirecto).push(c);
  }

  const resultado = [];
  const ordenPuntosDirecto = [...porPuntosDirecto.keys()].sort((a, b) => b - a);
  for (const pd of ordenPuntosDirecto) {
    const sub = porPuntosDirecto.get(pd).map((c) => c.original);
    if (sub.length === 1) {
      resultado.push(sub[0]);
      continue;
    }
    // 3) Partidas ganadas totales (no la diferencia: el total absoluto).
    const porPartidasGanadas = [...sub].sort((a, b) => b.partidasGanadas - a.partidasGanadas);
    let i = 0;
    while (i < porPartidasGanadas.length) {
      let j = i + 1;
      while (j < porPartidasGanadas.length && porPartidasGanadas[j].partidasGanadas === porPartidasGanadas[i].partidasGanadas) j++;
      const bloque = porPartidasGanadas.slice(i, j);
      if (bloque.length > 1) {
        // 4) Empate sin resolver: se marca y se ordena alfabéticamente solo
        // para que el resultado sea reproducible, nunca como criterio real.
        bloque.forEach((f) => { f.empateSinResolver = true; });
        bloque.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
      }
      resultado.push(...bloque);
      i = j;
    }
  }
  return resultado;
}

// Divide participantes y partidos de una liga según su `grupo` (o un único
// grupo "null" si la liga no usa grupos). Devuelve un objeto
// { [grupo]: { etiquetas, partidos } }, con las claves de grupo ordenadas
// alfabéticamente (A, B, C…) y "null" (sin grupo) al final si aparece.
export function agruparPorGrupo(liga) {
  const porGrupo = {};
  for (const p of liga.participantes || []) {
    const g = p.grupo || null;
    if (!porGrupo[g]) porGrupo[g] = { etiquetas: [], partidos: [] };
    porGrupo[g].etiquetas.push(p.etiqueta);
  }
  for (const p of liga.partidos || []) {
    const g = p.grupo || null;
    if (!porGrupo[g]) porGrupo[g] = { etiquetas: [], partidos: [] };
    porGrupo[g].partidos.push(p);
  }
  return porGrupo;
}

// Clasificación completa de una liga, ya dividida por grupo. Devuelve
// { grupos: { A: [filas], B: [filas]... }, sinGrupo: [filas] | null }.
export function clasificacionPorGrupos(liga) {
  const porGrupo = agruparPorGrupo(liga);
  const grupos = {};
  let sinGrupo = null;
  for (const [g, datos] of Object.entries(porGrupo)) {
    const filas = calcularClasificacion(datos.etiquetas, datos.partidos);
    if (g === "null") sinGrupo = filas;
    else grupos[g] = filas;
  }
  return { grupos, sinGrupo };
}
