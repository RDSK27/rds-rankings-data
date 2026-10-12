# rds-rankings-data

Copia de los rankings de la suite RDS en archivos JSON (`data/<coleccion>.json`), publicada con GitHub Pages:

`https://rdsk27.github.io/rds-rankings-data/data/<coleccion>.json`

Las apps y SuiteRDS descargan estos archivos (gratis) en vez de leer toda la coleccion de Firestore, y a partir de la ultima marca
del archivo piden a Firestore solo lo nuevo. Asi se gastan muchas menos lecturas de la cuota diaria.

- `generate.js` lee Firestore por REST (sin clave: las reglas ya permiten leer) y actualiza `data/`. Lectura completa cada 20 h (y se prueban las combinaciones de Reaction); el resto solo lo nuevo.
- `.github/workflows/update.yml` lo ejecuta cada 20 minutos y sube los cambios.
- Para anadir un ranking nuevo: anadirlo a `COLS` en `generate.js` y a `STATIC_COLS` en SuiteRDS.

Probar a mano: `node generate.js` (o `--full`, o `--only scores_squares`).
