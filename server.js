const express = require("express");
const path = require("path");

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const manifest = {
    id: "ro.radar.cinemadates",
    version: "1.0.0",
    name: "Cinema Dates Radar",
    description: "Filme cinema & date lansare VOD/Fizic/TV. Sortate din viitor spre trecut.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & Lansări VOD" }],
    idPrefixes: ["tt"]
};

async function fetchMovies(apiKey) {
    try {
        // 1. Tragem 3 pagini (60 de filme) ca să avem de unde tăia indienii
        const [page1Res, page2Res, page3Res] = await Promise.all([
            fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=1`),
            fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=2`),
            fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=3`)
        ]);
        
        const p1 = await page1Res.json();
        const p2 = await page2Res.json();
        const p3 = await page3Res.json();
        
        let allMovies = (p1.results || []).concat(p2.results || []).concat(p3.results || []);

        // 2. FILTRARE BOLLYWOOD (și alte limbi indiene majore)
        const indianLangs = ['hi', 'te', 'ta', 'ml', 'kn', 'bn'];
        let cleanMovies = allMovies.filter(movie => !indianLangs.includes(movie.original_language));

        // 3. Oprim primele 30 de filme CURATE
        cleanMovies = cleanMovies.slice(0, 30);
        const today = new Date();

        const promises = cleanMovies.map(async (movie) => {
            try {
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId) return null;

                let validDates = [];
                if (detailData.release_dates && detailData.release_dates.results) {
                    for (const r of detailData.release_dates.results) {
                        for (const release of r.release_dates) {
                            // Căutăm doar 4 (Digital), 5 (Fizic), 6 (TV)
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
                let typeLabel = "Cinema";
                let chosenDateObj = null;

                if (validDates.length > 0) {
                    // Alege data CEA MAI APROPIATĂ de prezent (viitor sau trecut)
                    validDates.sort((a, b) => Math.abs(a.date - today) - Math.abs(b.date - today));
                    
                    chosenDateObj = validDates[0].date;
                    chosenDateStr = validDates[0].string;
                    
                    if (validDates[0].type === 4) typeLabel = "VOD";
                    else if (validDates[0].type === 5) typeLabel = "BluRay";
                    else if (validDates[0].type === 6) typeLabel = "TV";
                }

                const displayTitle = chosenDateStr !== "Nespecificat" ? `[${typeLabel}: ${chosenDateStr}] ${movie.title}` : `[Cinema] ${movie.title}`;

                // Returnăm un obiect complex ca să putem face sortarea la final
                return {
                    meta: {
                        id: imdbId,
                        type: "movie",
                        name: displayTitle,
                        poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                        description: `Type: ${typeLabel}\nDate: ${chosenDateStr}\n\n${movie.overview}`
                    },
                    sortDate: chosenDateObj
                };
            } catch (err) { return null; }
        });

        // Așteptăm să se proceseze toate cele 30 de filme
        let processedMovies = (await Promise.all(promises)).filter(m => m !== null);

        // 4. SORTARE FINALĂ: Viitor -> Trecut -> Nespecificat
        processedMovies.sort((a, b) => {
            if (a.sortDate && b.sortDate) {
                // Descrescător: Dacă B e mai mare (mai în viitor), B trece în față
                return b.sortDate.getTime() - a.sortDate.getTime();
            } else if (a.sortDate && !b.sortDate) {
                return -1; // A are dată, B nu. B se duce la coadă.
            } else if (!a.sortDate && b.sortDate) {
                return 1;  // B are dată, A nu. A se duce la coadă.
            } else {
                return 0;  // Ambele sunt Nespecificate
            }
        });

        // Extragem doar bucata "meta" de care are nevoie Stremio
        return processedMovies.map(item => item.meta);

    } catch (error) { return []; }
}

// RUTARE WEB ȘI MANIFEST
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/:apiKey/manifest.json", (req, res) => {
    res.json(manifest);
});

// RUTARE CATALOG STREMIO
async function handleCatalog(req, res) {
    const apiKey = req.params.apiKey;
    const type = req.params.type;
    const id = req.params.id;

    if (type === "movie" && id === "cinema_radar") {
        const metas = await fetchMovies(apiKey);
        res.json({ metas: metas });
    } else {
        res.json({ metas: [] });
    }
}

app.get("/:apiKey/catalog/:type/:id.json", handleCatalog);
app.get("/:apiKey/catalog/:type/:id/:extra", handleCatalog);

const port = process.env.PORT || 8000;
app.listen(port, () => {
    console.log(`Server pornit pe portul ${port}`);
});
