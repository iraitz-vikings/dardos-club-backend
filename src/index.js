import express from "express";
import cors from "cors";
import "dotenv/config";

import noticiasRouter from "./routes/noticias.js";
import torneosRouter from "./routes/torneos.js";
import uploadRouter from "./routes/upload.js";
import torneoDestacadoRouter from "./routes/torneoDestacado.js";
import galeriaRouter from "./routes/galeria.js";
import torneosClubRouter from "./routes/torneosClub.js";
import patrocinadoresRouter from "./routes/patrocinadores.js";
import authRouter from "./routes/auth.js";
import mensajeAncladoRouter from "./routes/mensajeAnclado.js";
import perfilRouter from "./routes/perfil.js";
import jugadoresRouter from "./routes/jugadores.js";
import ligasClubRouter from "./routes/ligasClub.js";
import anunciosRouter from "./routes/anuncios.js";
import galeriaPrivadaRouter from "./routes/galeriaPrivada.js";
import trofeosRouter from "./routes/trofeos.js";
import equiposClubRouter from "./routes/equiposClub.js";
import maquinasRouter from "./routes/maquinas.js";
import competicionesExternasRouter from "./routes/competicionesExternas.js";
import calendarioRouter from "./routes/calendario.js";

const app = express();
app.use(cors());
app.use(express.json());

// Web pública
app.use("/api/noticias", noticiasRouter);

// Galería (fotos/vídeos sueltos, sin noticia asociada)
app.use("/api/galeria", galeriaRouter);

// Torneos del club (con cuadro por maquina)
app.use("/api/torneos-club", torneosClubRouter);

// Torneo destacado (mostrado en la home)
app.use("/api/torneo-destacado", torneoDestacadoRouter);

// Patrocinadores del club
app.use("/api/patrocinadores", patrocinadoresRouter);

// Portal (torneos, partidos, equipos)
app.use("/api/torneos", torneosRouter);

// Subida de imágenes (admin)
app.use("/api/upload", uploadRouter);

// Autenticación de socios (registro, login, aprobación)
app.use("/api/auth", authRouter);

app.use("/api/mensaje-anclado", mensajeAncladoRouter);

app.use("/api/perfil", perfilRouter);

app.use("/api/jugadores", jugadoresRouter);

app.use("/api/ligas-club", ligasClubRouter);

app.use("/api/anuncios", anunciosRouter);

app.use("/api/galeria-privada", galeriaPrivadaRouter);

app.use("/api/trofeos", trofeosRouter);

app.use("/api/equipos-club", equiposClubRouter);

app.use("/api/maquinas", maquinasRouter);

app.use("/api/competiciones-externas", competicionesExternasRouter);

app.use("/api/calendario", calendarioRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
