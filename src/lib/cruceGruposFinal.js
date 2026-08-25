// Construcción del cuadrante final de una liga con grupos.
//
// Regla de cruce entre grupos (decidida con Iraitz el 2026-08-25): NO se
// cruzan grupos consecutivos (A-B, C-D), sino el primero con el último y el
// segundo con el penúltimo — "grupo i" con "grupo N+1-i". Con 4 grupos:
// A-D, B-C. Con 6 grupos: A-F, B-E, C-D. Es, de hecho, el mismo patrón que
// ya usa `sortearParejasPorGrupos` (lib/sorteoParejasGrupos.js) para el
// método ABCD del sorteo de parejas ciegas — aquí se generaliza a cualquier
// número par de grupos.
//
// Dentro de cada pareja de grupos [g1, g2], se cruzan posiciones: el 1º de
// g1 contra el último clasificado de g2, el 2º de g1 contra el penúltimo de
// g2, etc. Así ningún cruce enfrenta a dos primeros (ni a dos segundos)
// entre sí en la ronda 1, y las parejas más fuertes caen en cruces más
// desnivelados (más fáciles) — que es precisamente lo que se aprovecha para
// repartir los "bye" cuando el total de clasificados no llena el cuadrante:
// se quitan primero del cruce más desnivelado, no al azar.
//
// Solo se admite un número PAR de grupos: con un número impar no hay forma
// de emparejar "grupo contra grupo" sin dejar uno suelto o sin enfrentar a
// dos del mismo grupo en la ronda 1.

const TAMANOS_CUADRANTE = [4, 8, 16, 32, 64, 128];

export function siguienteTamanoCuadrante(n) {
  return TAMANOS_CUADRANTE.find((t) => t >= n) || 128;
}

// letras: array de nombres de grupo en el orden en que se crearon (p.ej.
// ["A","B","C","D"]). Devuelve pares [g1, g2] "de fuera hacia dentro".
export function emparejarGruposCruzados(letras) {
  if (letras.length % 2 !== 0) {
    throw new Error("El número de grupos tiene que ser par para poder cruzarlos en el cuadrante final.");
  }
  const pares = [];
  const mitad = letras.length / 2;
  for (let i = 0; i < mitad; i++) {
    pares.push([letras[i], letras[letras.length - 1 - i]]);
  }
  return pares;
}

// clasificacionPorGrupo: { A: [filas ordenadas...], B: [...], ... } — ya con
// el desempate resuelto (ver lib/clasificacionLiga.js).
// numClasificadosPorGrupo: cuántos clasifican de cada grupo (mismo número
// para todos, para que el cruce sea simétrico).
//
// Devuelve { tamano, posiciones } donde `posiciones` es un array de longitud
// `tamano` con el nombre de cada participante en su hueco de la ronda 1 (o
// `null` para un "bye" — hueco vacío, pase directo a la ronda 2). Las
// posiciones [0,1] son el partido 1, [2,3] el partido 2, etc. — mismo
// convenio que ya usa el sorteo de cuadrantes de torneos
// (routes/torneosClub.js).
export function construirRondaUnoConGrupos(clasificacionPorGrupo, numClasificadosPorGrupo) {
  const letras = Object.keys(clasificacionPorGrupo).sort();
  if (letras.length < 2) {
    throw new Error("Hacen falta al menos 2 grupos con clasificación.");
  }
  for (const g of letras) {
    if ((clasificacionPorGrupo[g] || []).length < numClasificadosPorGrupo) {
      throw new Error(`El grupo ${g} no tiene ${numClasificadosPorGrupo} participantes con clasificación.`);
    }
  }

  const cruces = emparejarGruposCruzados(letras);
  const n = numClasificadosPorGrupo;

  // Cada "cruce de grupos" produce n enfrentamientos, en tiers de 0 (más
  // desnivelado: 1º contra el último clasificado del grupo rival) a n-1 (el
  // más parejo). tier = índice dentro del cruce.
  const enfrentamientos = [];
  for (const [g1, g2] of cruces) {
    for (let r = 0; r < n; r++) {
      const ladoA = clasificacionPorGrupo[g1][r];
      const ladoB = clasificacionPorGrupo[g2][n - 1 - r];
      enfrentamientos.push({
        tier: r,
        // posición dentro de su propio grupo (1 = mejor), para saber cuál
        // de los dos lados es el "más débil" si hay que sacar un bye.
        a: { nombre: ladoA.nombre, posicion: r + 1 },
        b: { nombre: ladoB.nombre, posicion: n - r },
      });
    }
  }

  const totalClasificados = letras.length * n;
  const tamano = siguienteTamanoCuadrante(totalClasificados);
  const numPartidosR1 = tamano / 2;
  const byesNecesarios = tamano - totalClasificados; // siempre par: tamano y totalClasificados lo son

  // Cuántos de los enfrentamientos generados hay que "romper" del todo (los
  // dos lados pasan directos, sin jugar entre ellos) para que el número de
  // partidos con gente real cuadre exactamente con los huecos del
  // cuadrante. No basta con vaciar un lado de algunos enfrentamientos: si
  // totalClasificados no llena el cuadrante, además de huecos vacíos faltan
  // partidos enteros (numPartidosR1 > totalClasificados/2), y esos partidos
  // de más solo pueden salir de romper enfrentamientos ya formados.
  const partidosARomper = byesNecesarios / 2;
  if (partidosARomper > enfrentamientos.length) {
    throw new Error(
      `Con ${totalClasificados} clasificados hacen falta demasiados pases directos para un cuadrante de ${tamano}.`
    );
  }

  // Se rompen primero los enfrentamientos más desnivelados (mayor
  // diferencia entre las posiciones de cada lado dentro de su grupo — no
  // necesariamente el tier más bajo: con 3 clasificados por grupo, por
  // ejemplo, el cruce "3º contra 1º" (tier 2) está tan desnivelado como
  // "1º contra 3º" (tier 0); el del medio, "2º contra 2º" (tier 1), es el
  // más parejo y se intenta conservar como partido real el último).
  // Limitación conocida: en un enfrentamiento roto, el lado más débil de
  // ese cruce concreto también pasa directo (no hay forma de dar solo la
  // mitad de un partido roto) — con números de grupo que no sean potencia
  // de dos esto es matemáticamente inevitable si se quiere mantener el
  // cruce A-D/B-C sin desordenarlo.
  const ordenParaRomper = [...enfrentamientos].sort(
    (x, y) => Math.abs(y.a.posicion - y.b.posicion) - Math.abs(x.a.posicion - x.b.posicion)
  );
  const rotos = new Set(ordenParaRomper.slice(0, partidosARomper));
  const normales = enfrentamientos.filter((e) => !rotos.has(e));

  const posiciones = new Array(tamano).fill(null);
  let cursor = 0;
  for (const e of normales) {
    posiciones[cursor++] = e.a.nombre;
    posiciones[cursor++] = e.b.nombre;
  }
  for (const e of rotos) {
    posiciones[cursor++] = e.a.nombre;
    posiciones[cursor++] = null;
    posiciones[cursor++] = e.b.nombre;
    posiciones[cursor++] = null;
  }

  void numPartidosR1;
  return { tamano, posiciones };
}
