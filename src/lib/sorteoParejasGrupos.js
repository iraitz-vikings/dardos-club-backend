// Sorteo de parejas por grupos de nivel (AB, ABC, ABCD), cruzando a los
// mejores con los peores para igualar el nivel entre parejas. Esta lógica
// vivía duplicada, casi carácter a carácter, en el sorteo de cuadrantes de
// TorneoClub (routes/torneosClub.js) y en el de LigaClub (routes/ligasClub.js)
// — se copió al añadir las ligas del club después de los torneos y nunca se
// unificó. Se extrae aquí porque es exactamente el mismo reparto en los dos
// sitios; lo único que cambia entre uno y otro es el modelo de Prisma donde
// se guarda cada participante creado (participanteCuadrante / participanteLiga).

export const GRUPOS_POR_METODO = {
  AB: ["A", "B"],
  ABC: ["A", "B", "C"],
  ABCD: ["A", "B", "C", "D"],
};

function barajar(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Valida que cada entrada tenga un grupo reconocido por el método y algún
// identificador (jugador del club o nombre suelto). Lanza Error con un
// mensaje apto para devolver tal cual al frontend si algo no cuadra.
function validarEntradas(entradas, gruposValidos) {
  for (const e of entradas) {
    if (!gruposValidos.includes(e.grupo)) {
      throw new Error(`Grupo inválido: ${e.grupo}`);
    }
    if (!e.jugadorId && !e.nombre) {
      throw new Error("Falta jugador o nombre en algún participante.");
    }
  }
}

// Reparte "entradas" (cada una con { grupo, jugadorId?, nombre? }) en parejas
// según el método de sorteo:
//   - AB:   grupo A contra grupo B (cruzado, mismo tamaño en ambos)
//   - ABC:  grupo A contra grupo C (cruzado), grupo B sorteado entre sí (par)
//   - ABCD: A contra D y B contra C (dos cruces)
// Devuelve un array de parejas [entrada1, entrada2]. Lanza Error (con
// mensaje listo para el usuario) si el método es desconocido o si algún
// grupo no tiene el tamaño necesario para el cruce/sorteo interno.
export function sortearParejasPorGrupos(entradas, metodo) {
  const gruposValidos = GRUPOS_POR_METODO[metodo];
  if (!gruposValidos) throw new Error(`Método de sorteo desconocido: ${metodo}`);
  validarEntradas(entradas, gruposValidos);

  const porGrupo = {};
  for (const g of gruposValidos) porGrupo[g] = entradas.filter((e) => e.grupo === g);

  const parejas = [];

  function emparejarCruzado(g1, g2) {
    if (porGrupo[g1].length !== porGrupo[g2].length) {
      throw new Error(
        `El grupo ${g1} (${porGrupo[g1].length}) y el grupo ${g2} (${porGrupo[g2].length}) deben tener el mismo número de jugadores.`
      );
    }
    const a = barajar(porGrupo[g1]);
    const b = barajar(porGrupo[g2]);
    for (let i = 0; i < a.length; i++) parejas.push([a[i], b[i]]);
  }

  function emparejarInterno(g) {
    if (porGrupo[g].length % 2 !== 0) {
      throw new Error(`El grupo ${g} (${porGrupo[g].length}) necesita un número par de jugadores para sortearse entre ellos.`);
    }
    const a = barajar(porGrupo[g]);
    for (let i = 0; i < a.length; i += 2) parejas.push([a[i], a[i + 1]]);
  }

  if (metodo === "AB") {
    emparejarCruzado("A", "B");
  } else if (metodo === "ABC") {
    emparejarCruzado("A", "C");
    emparejarInterno("B");
  } else if (metodo === "ABCD") {
    emparejarCruzado("A", "D");
    emparejarCruzado("B", "C");
  }

  return parejas;
}

// Resuelve los nombres de una lista de entradas { jugadorId?, nombre? } en
// una sola consulta (en vez de una por entrada, que era el patrón N+1 que
// tenían ambas copias originales). Devuelve un Map jugadorId -> nombre para
// mostrar: el alias del jugador si lo tiene puesto en su perfil, si no su
// nombre real.
export async function resolverNombresJugadores(prisma, entradas) {
  const ids = [...new Set(entradas.filter((e) => e.jugadorId).map((e) => e.jugadorId))];
  if (ids.length === 0) return new Map();
  const jugadores = await prisma.jugador.findMany({
    where: { id: { in: ids } },
    select: { id: true, nombre: true, apodo: true },
  });
  return new Map(jugadores.map((j) => [j.id, j.apodo || j.nombre]));
}
