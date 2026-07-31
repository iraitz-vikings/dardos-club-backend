# Backend – Web Club de Dardos

## Puesta en marcha

1. Instalar dependencias:
   ```
      npm install
         ```
         2. Crear un archivo `.env` con la conexión a PostgreSQL:
            ```
               DATABASE_URL="postgresql://usuario:password@localhost:5432/dardos_club"
                  ```
                  3. Generar y aplicar el esquema en la base de datos:
                     ```
                        npm run prisma:migrate
                           ```
                           4. Arrancar el servidor en modo desarrollo:
                              ```
                                 npm run dev
                                    ```

                                    ## Estructura

                                    - `prisma/schema.prisma` — modelo de datos completo (usuarios, jugadores, plataformas, torneos, equipos, partidos, notificaciones, noticias)
                                    - `src/routes/noticias.js` — endpoints de la web pública (noticias/eventos con fotos)
                                    - `src/routes/torneos.js` — endpoints del portal privado (torneos, equipos, partidos, fijar partido → notificación)

                                    ## Próximos pasos sugeridos

                                    - Añadir autenticación (login + roles: jugador / capitán / admin)
                                    - Añadir endpoints para gestionar jugadores, equipos y plataformas
                                    - Construir el scraper como proceso independiente que escribe en esta misma base de datos
                                    - Construir el frontend (web pública + portal) consumiendo esta API
                                    
