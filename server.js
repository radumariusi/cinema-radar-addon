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
    description: "Hollywood/EU Filme VOD. Estimări și date oficiale.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & Lansări VOD" }],
    idPrefixes: ["tt"]
};

// Funcție care transformă o dată în formatul "Late August", "Early Sept" etc.
function getEstimateString(dateObj) {
    const day = dateObj.getDate();
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const month = monthNames[dateObj.getMonth()];
    
    let period = "Late";
    if (day <= 10) period = "Early";
    else if (day <= 20) period = "Mid";
    
    return `${period} ${month}`;
}

async function fetchMovies(apiKey) {
    try {
        // 1. Tragem 5 pagini (100 de filme) pentru a avea balta plină înainte de filtrare
        const pagePromises = [];
        for (let i = 1; i <= 5; i++) {
            pagePromises.push(fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
        }
        
        const pagesData = await Promise.all(pagePromises);
        let allMovies = [];
        pagesData.forEach(p => {
            if (p.results) allMovies = allMovies.concat(p.results);
        });

        // 2. LISTA ALBĂ (Doar Hollywood și Mainstream Europa)
        const allowedLangs = ['en', 'fr', 'de', 'it', 'es', 'nl', 'sv', 'da', 'no', 'fi'];
        let cleanMovies = allMovies.filter(movie => allowedLangs.includes(movie.original_language));

        // 3. Tăiem la primele 30 cele mai populare filme "curate"
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

                let chosenDateStr = "";
                let typeLabel = "";
                let sortDateObj = null;
                let isEstimated = false;

                if (validDates.length > 0) {
                    // Avem dată oficială
                    validDates.sort((a, b) => Math.abs(a.date - today) - Math.abs(b.date - today));
                    sortDateObj = validDates[0].date;
                    chosenDateStr = validDates[0].string;
                    
                    if (validDates[0].type === 4) typeLabel = "VOD";
                    else if (validDates[0].type === 5) typeLabel = "BluRay";
                    else if (validDates[0].type === 6) typeLabel = "TV";
                } else {
                    // Nu avem dată oficială -> Estimăm 45 de zile
                    isEstimated = true;
                    typeLabel = "EST";
                    
                    let cinemaDate = new Date(movie.release_date);
                    if (isNaN(cinemaDate.getTime())) cinemaDate = today;
                    
                    // Adunăm 45 de zile (în milisecunde)
                    sortDateObj = new Date(cinemaDate.getTime() + (45 * 24 * 60 * 60 * 1000));
                    chosenDateStr = getEstimateString(sortDateObj);
                }

                const displayTitle = `[${typeLabel}: ${chosenDateStr}] ${movie.title}`;

                return {
                    meta: {
                        id: imdbId,
                        type: "movie",
                        name: displayTitle,
                        poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                        description: `Type: ${typeLabel}\nDate: ${chosenDateStr}\n\n${movie.overview}`
                    },
                    sortDate: sortDateObj,
                    isEstimated: isEstimated
                };
            } catch (err) { return null; }
        });

        let processedMovies = (await Promise.all(promises)).filter(m => m !== null);

        // 4. SORTAREA FINALĂ
        processedMovies.sort((a, b) => {
            // Regula 1: Cele estimate la începutul listei
            if (a.isEstimated && !b.isEstimated) return -1;
            if (!a.isEstimated && b.isEstimated) return 1;

            // Regula 2: Mai departe în viitor înseamnă mai sus în listă (descrescător)
            return b.sortDate.getTime() - a.sortDate.getTime();
        });

        return processedMovies.map(item => item.meta);

    } catch (error) { return []; }
}

// RUTARE WEB
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/:apiKey/manifest.json", (req, res) => {
    res.json(manifest);
});

// RUTARE CATALOG
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
