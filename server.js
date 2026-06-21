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
    description: "VOD releases with smart missing-date estimation algorithm.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
};

// Converts date to readable format (e.g., Late August)
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
        // 1. Fetch 5 pages (100 movies)
        const pagePromises = [];
        for (let i = 1; i <= 5; i++) {
            pagePromises.push(fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
        }
        
        const pagesData = await Promise.all(pagePromises);
        let allMovies = [];
        pagesData.forEach(p => {
            if (p.results) allMovies = allMovies.concat(p.results);
        });

        // 2. WHITELIST (Hollywood & Mainstream Europe)
        const allowedLangs = ['en', 'fr', 'de', 'it', 'es', 'nl', 'sv', 'da', 'no', 'fi'];
        let cleanMovies = allMovies.filter(movie => allowedLangs.includes(movie.original_language));

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
                let estReasonText = ""; 

                if (validDates.length > 0) {
                    // Official date found
                    validDates.sort((a, b) => Math.abs(a.date - today) - Math.abs(b.date - today));
                    sortDateObj = validDates[0].date;
                    chosenDateStr = validDates[0].string;
                    
                    if (validDates[0].type === 4) typeLabel = "VOD";
                    else if (validDates[0].type === 5) typeLabel = "BluRay";
                    else if (validDates[0].type === 6) typeLabel = "TV";
                } else {
                    // SMART ESTIMATION ALGORITHM
                    isEstimated = true;
                    typeLabel = "EST";
                    
                    let cinemaDate = new Date(movie.release_date);
                    if (isNaN(cinemaDate.getTime())) cinemaDate = today;
                    
                    let daysToAdd = 45; 

                    if (movie.original_language !== 'en') {
                        // European Rule
                        daysToAdd = 130;
                        estReasonText = "European Film (Slow release window: ~130 days)";
                    } else {
                        // American Rule
                        const pop = detailData.popularity || movie.popularity || 0;
                        const rev = detailData.revenue || 0;
                        const bud = detailData.budget || 0;

                        if (pop > 800 || rev > 150000000 || bud > 100000000) {
                            daysToAdd = 75;
                            estReasonText = "Blockbuster Hit / Massive Budget (~75 days)";
                        } else if (pop < 150) {
                            daysToAdd = 21;
                            estReasonText = "Small Film / BO Flop (~21 days)";
                        } else {
                            daysToAdd = 38;
                            estReasonText = "Standard Performance (~38 days)";
                        }
                    }
                    
                    sortDateObj = new Date(cinemaDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));
                    chosenDateStr = getEstimateString(sortDateObj);
                }

                const displayTitle = `[${typeLabel}: ${chosenDateStr}] ${movie.title}`;
                
                let descText = `Release Type: ${typeLabel}\nDate: ${chosenDateStr}`;
                if (isEstimated) {
                    descText += `\nPrediction Algorithm: ${estReasonText}`;
                }
                descText += `\n\n${movie.overview}`;

                return {
                    meta: {
                        id: imdbId,
                        type: "movie",
                        name: displayTitle,
                        poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                        description: descText
                    },
                    sortDate: sortDateObj,
                    isEstimated: isEstimated
                };
            } catch (err) { return null; }
        });

        let processedMovies = (await Promise.all(promises)).filter(m => m !== null);

        // 4. SORTING
        processedMovies.sort((a, b) => {
            if (a.isEstimated && !b.isEstimated) return -1;
            if (!a.isEstimated && b.isEstimated) return 1;
            return b.sortDate.getTime() - a.sortDate.getTime();
        });

        return processedMovies.map(item => item.meta);

    } catch (error) { return []; }
}

// MANUAL ROUTING FOR STREMIO
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/:apiKey/manifest.json", (req, res) => {
    res.json(manifest);
});

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
    console.log(`Server started on port ${port}`);
});
