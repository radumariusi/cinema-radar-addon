const express = require("express");
const path = require("path");

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const IMAGEKIT_ID = "cinemaradar"; 

const manifest = {
    id: "ro.radar.cinemadates",
    version: "1.0.4", // Versiune nouă pentru a aplica noile reguli grafice și de cache
    name: "Cinema Dates Radar",
    description: "VOD estimates. Font 45, 60% opacity, 12h Cache.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
};

// Seiful intern de memorie (Koyeb RAM Cache)
const globalCache = {
    movies: [],          
    lastFetch: 0        
};

// Format european: ZZ.LL.AAAA
function formatDateEU(dateObj) {
    const d = String(dateObj.getDate()).padStart(2, '0');
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const y = dateObj.getFullYear();
    return `${d}.${m}.${y}`;
}

// Algoritmul de predicție
function calculateVOD(movie, detailData) {
    let validDates = [];
    const today = new Date();

    if (detailData.release_dates && detailData.release_dates.results) {
        for (const r of detailData.release_dates.results) {
            for (const release of r.release_dates) {
                if (release.type === 4 || release.type === 5 || release.type === 6) {
                    const releaseDate = new Date(release.release_date);
                    if (!isNaN(releaseDate.getTime())) validDates.push({ date: releaseDate, type: release.type });
                }
            }
        }
    }

    let typeLabel = "", sortDateObj = null, isEstimated = false;

    if (validDates.length > 0) {
        validDates.sort((a, b) => Math.abs(a.date - today) - Math.abs(b.date - today));
        sortDateObj = validDates[0].date;
        if (validDates[0].type === 4) typeLabel = "VOD";
        else if (validDates[0].type === 5) typeLabel = "BluRay";
        else if (validDates[0].type === 6) typeLabel = "TV";
    } else {
        isEstimated = true;
        typeLabel = "EST";
        let cinemaDate = new Date(movie.release_date);
        if (isNaN(cinemaDate.getTime())) cinemaDate = today;
        
        let daysToAdd = 45; 
        if (movie.original_language && movie.original_language !== 'en') daysToAdd = 130;
        else {
            const pop = detailData.popularity || movie.popularity || 0;
            const rev = detailData.revenue || 0;
            const bud = detailData.budget || 0;
            if (pop > 800 || rev > 150000000 || bud > 100000000) daysToAdd = 75;
            else if (pop < 150) daysToAdd = 21;
            else daysToAdd = 38;
        }
        sortDateObj = new Date(cinemaDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));
    }
    
    const chosenDateStr = formatDateEU(sortDateObj);
    return { typeLabel, chosenDateStr, isEstimated, sortDateObj };
}

async function fetchMovies(apiKey) {
    // Cache intern setat la 12 ore (43200000 milisecunde)
    if (globalCache.movies.length > 0 && (Date.now() - globalCache.lastFetch < 43200000)) {
        return globalCache.movies;
    }

    try {
        const pagePromises = [];
        for (let i = 1; i <= 5; i++) pagePromises.push(fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
        
        const pagesData = await Promise.all(pagePromises);
        let allMovies = [];
        pagesData.forEach(p => { if (p.results) allMovies = allMovies.concat(p.results); });

        const allowedLangs = ['en', 'fr', 'de', 'it', 'es', 'nl', 'sv', 'da', 'no', 'fi'];
        let cleanMovies = allMovies.filter(movie => allowedLangs.includes(movie.original_language)).slice(0, 30);

        const promises = cleanMovies.map(async (movie) => {
            try {
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId) return null;

                const vodInfo = calculateVOD(movie, detailData);
                const textToStamp = `${vodInfo.typeLabel}: ${vodInfo.chosenDateStr}`;
                const displayTitle = `[${textToStamp}] ${movie.title}`;

                // Base64 Text
                const base64Text = Buffer.from(textToStamp).toString('base64');
                const encodedText = encodeURIComponent(base64Text);
                
                // Setări grafice aplicate: fs-45 (Font 45), bg-00000099 (Negru 60% Opacitate)
                const imageKitTransform = `?tr=l-text,ie-${encodedText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-bottom,l-end`;
                const customPosterUrl = `https://ik.imagekit.io/${IMAGEKIT_ID}/tmdb/t/p/w500${movie.poster_path}${imageKitTransform}`;

                return {
                    meta: {
                        id: imdbId,
                        type: "movie",
                        name: displayTitle,
                        poster: customPosterUrl,
                        description: movie.overview
                    },
                    sortDate: vodInfo.sortDateObj,
                    isEstimated: vodInfo.isEstimated
                };
            } catch (err) { return null; }
        });

        let processedMovies = (await Promise.all(promises)).filter(m => m !== null);
        processedMovies.sort((a, b) => {
            if (a.isEstimated && !b.isEstimated) return -1;
            if (!a.isEstimated && b.isEstimated) return 1;
            return b.sortDate.getTime() - a.sortDate.getTime();
        });

        const finalMetas = processedMovies.map(item => item.meta);

        globalCache.movies = finalMetas;
        globalCache.lastFetch = Date.now();

        return finalMetas;
    } catch (error) { 
        return globalCache.movies; 
    }
}

// Rutări
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });
app.get("/:apiKey/manifest.json", (req, res) => { res.json(manifest); });

async function handleCatalog(req, res) {
    const apiKey = req.params.apiKey;
    const type = req.params.type;
    const id = req.params.id;

    if (type === "movie" && id === "cinema_radar") {
        const metas = await fetchMovies(apiKey);
        // Ordonăm playerului (Nuvio/Stremio) să țină minte catalogul 12 ore (43200 secunde)
        res.setHeader('Cache-Control', 'max-age=43200, public');
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
