// Calcula la clasificación final (posición de cada participante) de un
// cuadrante ya terminado, a partir de sus CuadroPartido. Se usa para el
// reparto de puntos de los torneos "por jornadas" (ver TorneoClub.modoJornadas
// en schema.prisma): cada cuadrante del torneo es una jornada independiente,
// y los puntos que da cada jornada (ver PuntoJornada) se suman para la
// clasificación general del torneo (pensado originalmente para elegir a los
// 6 mejores de varias jornadas para la selección de dardos de Euskadi).
//
// Empates: cuando varios participantes quedan eliminados "a la vez" (misma
// ronda), se consideran empatados y a TODOS se les asigna la MEJOR posición
// del tramo (p.ej. los dos semifinalistas perdedores de un cuadro de 8 son
// ambos "3º"), nunca la media ni ningún desempate automático — decisión
// explícita de Iraitz. Si se quiere desempatar a mano, se puede editar la
// tabla de puntos resultante antes de guardarla (ver rutas en torneosClub.js).
//
// Devuelve `null` si el cuadrante todavía no ha terminado (algún partido
// jugable sigue sin ganador) — quien llama a esto debe avisar de que hace
// falta terminar el cuadrante antes de sacar la clasificación.

function log2(n) {
  return Math.round(Math.log2(n));
}

// Un partido con ganador pero solo un jugador real (pase directo / "bye") no
// elimina a nadie: se ignora sin más. Un "__BYE_DOBLE__" (los dos huecos
// vacíos para siempre, ver intentarResolverBye) tampoco es un partido real.
// Cualquier otro partido sin ganador todavía significa que el cuadrante no
// ha terminado.
function perdedorDe(partido) {
  if (partido.resultado === "__BYE_DOBLE__") return { listo: true, perdedor: null };
  if (!partido.ganador) return { listo: false, perdedor: null };
  const perdedor = partido.ganador === partido.jugador1 ? partido.jugador2 : partido.jugador1;
  return { listo: true, perdedor: perdedor || null };
}

// Eliminación directa: el campeón es el ganador de la única ronda final de
// "ganadores"; los perdedores de cada ronda anterior empatan en la posición
// = tamaño/2^ronda + 1 (la ronda final, con un solo perdedor, da la posición
// 2 sin empate posible).
function clasificarDirecta(partidos, tamano) {
  const k = log2(tamano);
  const porRonda = new Map();
  for (const p of partidos.filter((p) => p.rama === "ganadores")) {
    if (!porRonda.has(p.ronda)) porRonda.set(p.ronda, []);
    porRonda.get(p.ronda).push(p);
  }

  const resultado = [];
  for (let r = 1; r <= k; r++) {
    const partidosRonda = porRonda.get(r) || [];
    if (partidosRonda.length === 0) return null;
    for (const p of partidosRonda) {
      const { listo, perdedor } = perdedorDe(p);
      if (!listo) return null;
      if (r === k) {
        if (!p.ganador) return null;
        resultado.push({ etiqueta: p.ganador, posicion: 1 });
        if (perdedor) resultado.push({ etiqueta: perdedor, posicion: 2 });
      } else if (perdedor) {
        resultado.push({ etiqueta: perdedor, posicion: tamano / Math.pow(2, r) + 1 });
      }
    }
  }
  return resultado;
}

// Doble eliminación: el campeón y el subcampeón salen de la rama "final" (con
// posible segunda manga si el cuadro de perdedores fuerza el "reset" — ver el
// disparo de la gran final en torneosClub.js). El resto de posiciones se
// asignan por la ronda del cuadro de PERDEDORES en la que cada participante
// cae eliminado de forma definitiva (su segunda derrota): cuanto más tarde
// cae, mejor posición. Empatan quienes caen en la misma ronda de perdedores.
function clasificarDoble(partidos, tamano) {
  const k = log2(tamano);
  if (k < 2) return clasificarDirecta(partidos, tamano);

  const finales = partidos.filter((p) => p.rama === "final");
  const finalDecisiva = finales.find((f) => f.posicion === 1 && f.ganador) || finales.find((f) => f.posicion === 0);
  if (!finalDecisiva || !finalDecisiva.ganador) return null;

  const campeon = finalDecisiva.ganador;
  const subcampeon = finalDecisiva.ganador === finalDecisiva.jugador1 ? finalDecisiva.jugador2 : finalDecisiva.jugador1;
  if (!subcampeon) return null; // la gran final nunca debería ser un bye

  const resultado = [
    { etiqueta: campeon, posicion: 1 },
    { etiqueta: subcampeon, posicion: 2 },
  ];

  const rondaMaxima = 2 * (k - 1);
  const porRonda = new Map();
  for (const p of partidos.filter((p) => p.rama === "perdedores")) {
    const { listo, perdedor } = perdedorDe(p);
    if (!listo) return null;
    if (!perdedor) continue; // bye dentro del cuadro de perdedores: no elimina a nadie
    if (!porRonda.has(p.ronda)) porRonda.set(p.ronda, []);
    porRonda.get(p.ronda).push(perdedor);
  }

  let acumulado = 2;
  for (let r = rondaMaxima; r >= 1; r--) {
    const perdedores = porRonda.get(r) || [];
    if (perdedores.length === 0) continue;
    const posicion = acumulado + 1;
    for (const etiqueta of perdedores) resultado.push({ etiqueta, posicion });
    acumulado += perdedores.length;
  }
  return resultado;
}

// Calcula la clasificación de un cuadrante ya cargado con sus `partidos` y
// `participantes` (ver includeCompleto en torneosClub.js). Devuelve una
// lista ordenada por posición (con empates) de
// { etiqueta, posicion, jugador1Id, jugador2Id }, o `null` si el cuadrante
// no ha terminado todavía.
export function calcularClasificacionCuadrante(cuadrante) {
  const partidos = cuadrante.partidos || [];
  if (partidos.length === 0) return null;

  const lista =
    cuadrante.tipoEliminacion === "doble"
      ? clasificarDoble(partidos, cuadrante.tamano)
      : clasificarDirecta(partidos, cuadrante.tamano);
  if (!lista) return null;

  const participantesPorEtiqueta = new Map((cuadrante.participantes || []).map((p) => [p.etiqueta, p]));
  return lista
    .map((r) => {
      const participante = participantesPorEtiqueta.get(r.etiqueta);
      return {
        etiqueta: r.etiqueta,
        posicion: r.posicion,
        jugador1Id: participante?.jugador1Id || null,
        jugador2Id: participante?.jugador2Id || null,
      };
    })
    .sort((a, b) => a.posicion - b.posicion || a.etiqueta.localeCompare(b.etiqueta));
}
