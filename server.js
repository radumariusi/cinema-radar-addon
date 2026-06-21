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
    description: "Filme din cinema și data lansării VOD/Fizic/TV.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & Lansări VOD" }],
    idPrefixes: ["tt"]
};

// Funcția pură de extragere
async function fetchMovies(apiKey) {
    try {
        const moviesRes = await fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=1`);
        if (!moviesRes.ok) return []; // Dacă cheia e greșită, oprește-te
        
        const moviesData = await moviesRes.json();
        const movies = moviesData.results || [];
        const today = new Date();

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

                if (extData.imdb_id) {
                    const displayTitle = chosenDateStr !== "Nespecificat" ? `[${typeLabel}: ${chosenDateStr}] ${movie.title}` : `[Cinema] ${movie.title}`;
                    return {
                        id: extData.imdb_id,
                        type: "movie",
                        name: displayTitle,
                        poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                        description: `Tip lansare: ${typeLabel}\nData: ${chosenDateStr}\n\n${movie.overview}`
                    };
                }
            } catch (e) { return null; }
        });

        return (await Promise.all(promises)).filter(m => m !== null);
    } catch (e) { return []; }
}

// RUTAREA MANUALA CARE REZOLVA TOATE ERORILE STREMIO

// Pagina principală Web
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Stremio cere manifestul -> Extragem cheia direct din URL-ul curat
app.get('/:apiKey/manifest.json', (req, res) => {
    res.json(manifest);
});

// Stremio cere catalogul (inclusiv mizeria cu /skip=0.json din Discover) -> Extragem cheia direct din URL
app.get('/:apiKey/catalog/:type/:id/:extra?', async (req, res) => {
    const apiKey = req.params.apiKey;
    const type = req.params.type;
    const id = req.params.id;

    if (type === "movie" && id === "cinema_radar") {
        const metas = await fetchMovies(apiKey);
        return res.json({ metas: metas });
    }
    
    return res.json({ metas: [] });
});

const port = process.env.PORT || 8000;
app.listen(port, () => {
    console.log(`Server pornit pe portul ${port}`);
});
