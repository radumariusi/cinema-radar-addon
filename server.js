const express = require("express");
const { addonBuilder } = require("stremio-addon-sdk"); // Am eliminat complet getRouter
const path = require("path");

const app = express();

// 1. Setări obligatorii de securitate (CORS) - Fără ele Stremio blochează addon-ul
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

const manifest = {
    id: "ro.radar.cinemadates",
    version: "1.0.0",
    name: "Cinema & Digital Dates Radar",
    description: "Filme din cinema și data lansării VOD/Digital.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & Lansări VOD" }],
    idPrefixes: ["tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

async function fetchMovies(apiKey) {
    try {
        const moviesRes = await fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=ro-RO&page=1`);
        const moviesData = await moviesRes.json();
        const movies = moviesData.results || [];

        const promises = movies.slice(0, 15).map(async (movie) => {
            try {
                const [datesRes, extRes] = await Promise.all([
                    fetch(`${TMDB_BASE_URL}/movie/${movie.id}/release_dates?api_key=${apiKey}`),
                    fetch(`${TMDB_BASE_URL}/movie/${movie.id}/external_ids?api_key=${apiKey}`)
                ]);
                
                const datesData = await datesRes.json();
                const extData = await extRes.json();
                
                let digitalDate = "Nespecificat";
                if (datesData.results) {
                    for (const r of datesData.results) {
                        for (const release of r.release_dates) {
                            if (release.type === 4) {
                                digitalDate = release.release_date.split("T")[0];
                                break;
                            }
                        }
                    }
                }

                if (extData.imdb_id) {
                    return {
                        id: extData.imdb_id,
                        type: "movie",
                        name: digitalDate !== "Nespecificat" ? `[VOD: ${digitalDate}] ${movie.title}` : `[Cinema] ${movie.title}`,
                        poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                        description: `Data VOD: ${digitalDate}\n\n${movie.overview}`
                    };
                }
            } catch (e) { return null; }
        });

        return (await Promise.all(promises)).filter(m => m !== null);
    } catch (e) { return []; }
}

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async (args) => {
    if (args.type === "movie" && args.id === "cinema_radar") {
        const apiKey = args.config ? args.config.tmdb : null;
        if (!apiKey) return { metas: [] };
        const metas = await fetchMovies(apiKey);
        return { metas: metas };
    }
    return { metas: [] };
});

const addonInterface = builder.getInterface();

// 2. RUTARE MANUALĂ (Am scris noi regulile, serverul nu mai dă "Cannot GET")
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Ruta standard pentru manifest
app.get('/manifest.json', (req, res) => {
    res.json(addonInterface.manifest);
});

// Ruta pentru manifest care conține cheia TMDB în URL
app.get('/:config/manifest.json', (req, res) => {
    res.json(addonInterface.manifest);
});

// Ruta care aduce filmele, folosind cheia din URL
app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    let configObj = {};
    try {
        // Luăm cheia din URL
        configObj = JSON.parse(req.params.config);
    } catch(e) {}
    
    try {
        const response = await addonInterface.get("catalog", { 
            type: req.params.type, 
            id: req.params.id, 
            config: configObj 
        });
        res.json(response);
    } catch(e) {
        res.json({ metas: [] });
    }
});

// 3. Pornirea serverului
const port = process.env.PORT || 8000;
app.listen(port, () => {
    console.log(`Server pornit pe portul ${port}`);
});
