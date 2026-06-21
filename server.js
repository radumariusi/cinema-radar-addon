const express = require("express");
const { addonBuilder } = require("stremio-addon-sdk");
const path = require("path");

const app = express();

// Setări obligatorii de securitate (CORS)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

const manifest = {
    id: "ro.radar.cinemadates",
    version: "1.0.0",
    name: "Cinema & Digital Dates Radar",
    description: "Filme din cinema și data lansării VOD/Digital/Fizic/TV.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & Lansări VOD" }],
    idPrefixes: ["tt"]
};

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

async function fetchMovies(apiKey) {
    try {
        // Schimbat în language=en-US pentru a trage titlurile și descrierile direct în engleză
        const moviesRes = await fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=1`);
        const moviesData = await moviesRes.json();
        const movies = moviesData.results || [];

        const today = new Date();

        // Schimbat la slice(0, 30) pentru a procesa primele 30 de filme din cinema
        const promises = movies.slice(0, 30).map(async (movie) => {
            try {
                const [datesRes, extRes] = await Promise.all([
                    fetch(`${TMDB_BASE_URL}/movie/${movie.id}/release_dates?api_key=${apiKey}`),
                    fetch(`${TMDB_BASE_URL}/movie/${movie.id}/external_ids?api_key=${apiKey}`)
                ]);
                
                const datesData = await datesRes.json();
                const extData = await extRes.json();
                
                let validDates = [];

                if (datesData.results) {
                    for (const r of datesData.results) {
                        for (const release of r.release_dates) {
                            // Verificăm tipurile: 4 (Digital), 5 (Fizic/BluRay) sau 6 (TV)
                            if (release.type === 4 || release.type === 5 || release.type === 6) {
                                const releaseDate = new Date(release.release_date);
                                if (!isNaN(releaseDate.getTime())) {
                                    validDates.push({
                                        string: release.release_date.split("T")[0],
                                        date: releaseDate,
                                        type: release.type
                                    });
                                }
                            }
                        }
                    }
                }

                let chosenDateStr = "Nespecificat";
                let typeLabel = "Release";

                if (validDates.length > 0) {
                    // Sortăm datele în funcție de cea mai mică diferență absolută față de data de azi
                    validDates.sort((a, b) => Math.abs(a.date - today) - Math.abs(b.date - today));
                    
                    chosenDateStr = validDates[0].string;
                    if (validDates[0].type === 4) typeLabel = "VOD";
                    else if (validDates[0].type === 5) typeLabel = "BluRay";
                    else if (validDates[0].type === 6) typeLabel = "TV";
                }

                if (extData.imdb_id) {
                    const displayTitle = chosenDateStr !== "Nespecificat" ? `[${typeLabel}: ${chosenDateStr}] ${movie.title}` : `[Cinema] ${movie.title}`;
                    return {
                        id: extData.imdb_id,
                        type: "movie",
                        name: displayTitle,
                        poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                        description: `Tip lansare detectat: ${typeLabel}\nData: ${chosenDateStr}\n\n${movie.overview}`
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get('/manifest.json', (req, res) => {
    res.json(addonInterface.manifest);
});

app.get('/:config/manifest.json', (req, res) => {
    res.json(addonInterface.manifest);
});

async function handleCatalogRequest(req, res) {
    let configObj = {};
    try {
        configObj = JSON.parse(decodeURIComponent(req.params.config));
    } catch(e) {
        try { configObj = JSON.parse(req.params.config); } catch(err) {}
    }
    
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
}

app.get('/:config/catalog/:type/:id.json', handleCatalogRequest);
app.get('/:config/catalog/:type/:id/:extra', handleCatalogRequest);

const port = process.env.PORT || 8000;
app.listen(port, () => {
    console.log(`Server pornit pe portul ${port}`);
});
