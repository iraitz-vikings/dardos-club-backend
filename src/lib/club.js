// Datos propios del club que usa el backend. Todo sale de variables de
// entorno para que el mismo código sirva a otro club sin tocarlo (ver
// "Montar otro club" en el README). Los valores por defecto son los de
// Vikings, así que el servidor actual no necesita configurar nada nuevo.

// Nombre corto del club: equipo por defecto cuando no tiene nombre
// ("<club> vs Rival") y competición por defecto ("Torneo <club>").
export const CLUB_NOMBRE = (process.env.CLUB_NOMBRE || "Vikings").trim();

// Carpeta de Cloudinary donde se suben (y desde donde se listan para
// reutilizar) las fotos y vídeos del admin. Si dos clubes comparten cuenta
// de Cloudinary, cada uno necesita su propia carpeta o verían las fotos del
// otro en el selector de imágenes.
export const CLOUDINARY_FOLDER = (process.env.CLOUDINARY_FOLDER || "dardos-club").trim().replace(/\/+$/, "");
