import express from "express";
import cors from "cors";
import "dotenv/config";

import noticiasRouter from "./routes/noticias.js";
import torneosRouter from "./routes/torneos.js";
import uploadRouter from "./routes/upload.js";
import torneoDestacadoRouter from "./routes/torneoDestacado.js";
import galeriaRouter from "./routes/galeria.js";
import torneosClubRouter from "./routes/torneosClub.js";

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

// Portal (torneos, partidos, equipos)
app.use("/api/torneos", torneosRouter);

// Subida de imágenes (admin)
app.use("/api/upload", uploadRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
