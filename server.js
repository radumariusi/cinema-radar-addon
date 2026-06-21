const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const path = require("path");

const app = express();

// 1. Definim setările Addon-ului
const manifest = {
    id: "ro.radar.cinemadates",
    version: "1.0.0",
    name: "Cinema & Digital Dates Radar",
    description: "Filme din cinema și data lansării VOD/Digital pe poster.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & Lansări VOD" }],
    idPrefixes: ["tt"],
    // Îi spunem lui Stremio că acest addon are o pagină de configurare!
    behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

// 2. Extragem datele doar DACĂ primim o cheie TMDB din setările tale
builder.defineCatalogHandler(async (args) => {
    if (args.type === "movie" && args.id === "cinema_radar") {
        
        // Aici extragem cheia pe care ai pus-o pe pagina web
        const TMDB_API_KEY = args.config ? args.config.tmdb : null;
        
        // Dacă nu ai pus cheie, nu afișăm niciun film
        if (!TMDB_API_KEY) {
            return { metas: [] };
        }

        const metas = [];
        try {
            const moviesRes = await fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${TMDB_API_KEY}&language=ro-RO&page=1`);
            const moviesData = await moviesRes.json();
            const movies = moviesData.results || [];

            for (const movie of movies.slice(0, 15)) {
                const datesRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}/release_dates?api_key=${TMDB_API_KEY}`);
                const datesData = await datesRes.json();
                const results = datesData.results || [];
                
                let digitalDate = "Nespecificat";
                for (const r of results) {
                    for (const release of r.release_dates) {
                        if (release.type === 4) { // 4 înseamnă VOD/Digital
                            digitalDate = release.release_date.split("T")[0];
                            break;
                        }
                    }
                }

                const extRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}/external_ids?api_key=${TMDB_API_KEY}`);
                const extData = await extRes.json();
                const imdbId = extData.imdb_id;

                if (imdbId) {
                    const displayTitle = digitalDate !== "Nespecificat" ? `[VOD: ${digitalDate}] ${movie.title}` : `[Cinema] ${movie.title}`;
                    metas.push({
                        id: imdbId,
                        type: "movie",
                        name: displayTitle,
                        poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                        description: `Data estimată VOD: ${digitalDate}\n\n${movie.overview}`
                    });
                }
            }
            return { metas: metas };
        } catch (error) { return { metas: [] }; }
    } else { return { metas: [] }; }
});

// 3. Legăm pagina web (index.html) de server
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Legăm logica de Stremio la server
app.use("/", getRouter(builder.getInterface()));

// 4. Pornim serverul
const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon-ul a pornit pe portul ${port}`);
});
