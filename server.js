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
    description: "Filme cinema & date lansare VOD/Fizic/TV.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & Lansări VOD" }],
    idPrefixes: ["tt"]
};

async function fetchMovies(apiKey) {
    try {
        const [page1Res, page2Res] = await Promise.all([
            fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=1`),
            fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=2`)
        ]);
        
        const page1Data = await page1Res.json();
        const page2Data = await page2Res.json();
        
        let movies = (page1Data.results || []).concat(page2Data.results || []).slice(0, 30);
        const today = new Date();

        const promises = movies.map(async (movie) => {
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

                let chosenDateStr = "Nespecificat";
                let typeLabel = "Release";

                if (validDates.length > 0) {
                    validDates.sort((a, b) => Math.abs(a.date - today) - Math.abs(b.date - today));
                    chosenDateStr = validDates[0].string;
                    if (validDates[0].type === 4) typeLabel = "VOD";
                    else if (validDates[0].type === 5) typeLabel = "BluRay";
                    else if (validDates[0].type === 6) typeLabel = "TV";
                }

                const displayTitle = chosenDateStr !== "Nespecificat" ? `[${typeLabel}: ${chosenDateStr}] ${movie.title}` : `[Cinema] ${movie.title}`;

                return {
                    id: imdbId,
                    type: "movie",
                    name: displayTitle,
                    poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                    description: `Type: ${typeLabel}\nDate: ${chosenDateStr}\n\n${movie.overview}`
                };
            } catch (err) { return null; }
        });

        return (await Promise.all(promises)).filter(m => m !== null);
    } catch (error) { return []; }
}

// RUTAREA MANUALA (ANTIGLONT)

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

// Ruta normală
app.get("/:apiKey/catalog/:type/:id.json", handleCatalog);
// Ruta specială pentru Stremio Discover (interceptează acel "skip=0.json")
app.get("/:apiKey/catalog/:type/:id/:extra", handleCatalog);

const port = process.env.PORT || 8000;
app.listen(port, () => {
    console.log(`Server pornit pe portul ${port}`);
});
