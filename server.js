const express = require("express");
const path = require("path");
const Jimp = require("jimp");

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
    description: "VOD estimates stamped directly on posters. EU Date format & Smart Caching.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
};

// --- SEIFUL DE MEMORIE (GARBAGE COLLECTOR) ---
const globalCache = {
    movies: [],          // Lista celor 30 de filme finale
    lastFetch: 0,        // Momentul ultimei interogări TMDB
    posters: {}          // RAM-ul unde ținem posterele ștampilate
};

// --- FORMATATOR DE DATĂ EU (ZZ.LL.AAAA) ---
function formatDateEU(dateObj) {
    const d = String(dateObj.getDate()).padStart(2, '0');
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const y = dateObj.getFullYear();
    return `${d}.${m}.${y}`;
}

// --- ESTIMATOR ---
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
    
    // Generăm string-ul final în format European
    const chosenDateStr = formatDateEU(sortDateObj);
    return { typeLabel, chosenDateStr, isEstimated, sortDateObj };
}

// --- GENERARE CATALOG CU "PATCHING" ---
async function fetchMovies(apiKey, baseUrl) {
    // Dacă am generat lista în ultima oră, o dăm direct din memorie să nu stresăm serverul
    if (globalCache.movies.length > 0 && (Date.now() - globalCache.lastFetch < 3600000)) {
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

        const newValidPosterKeys = [];

        const promises = cleanMovies.map(async (movie) => {
            try {
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId) return null;

                const vodInfo = calculateVOD(movie, detailData);
                const textToStamp = `${vodInfo.typeLabel}: ${vodInfo.chosenDateStr}`;
                
                // Setăm cheia unică pentru curățenia memoriei
                const posterKey = `${textToStamp}_${movie.poster_path}`;
                newValidPosterKeys.push(posterKey);

                const customPosterUrl = `${baseUrl}/poster/${encodeURIComponent(textToStamp)}/${encodeURIComponent(movie.poster_path)}`;
                const displayTitle = `[${textToStamp}] ${movie.title}`;

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

        // --- GARBAGE COLLECTION ---
        // Ștergem din RAM orice poster vechi care nu se mai regăsește în lista actualizată
        for (const cachedKey in globalCache.posters) {
            if (!newValidPosterKeys.includes(cachedKey)) {
                delete globalCache.posters[cachedKey];
            }
        }

        // Salvăm lista proaspătă
        globalCache.movies = finalMetas;
        globalCache.lastFetch = Date.now();

        return finalMetas;
    } catch (error) { 
        return globalCache.movies; // Dacă pică TMDB, dăm ultima listă salvată
    }
}

// --- FABRICA DE POSTERE CU VERIFICARE ÎN MEMORIE ---
app.get("/poster/:text/:posterPath", async (req, res) => {
    try {
        const text = decodeURIComponent(req.params.text);
        const posterPath = decodeURIComponent(req.params.posterPath);
        const cacheKey = `${text}_${posterPath}`;

        // Dacă posterul cu această dată există deja în RAM, îl livrăm instant!
        if (globalCache.posters[cacheKey]) {
            res.set("Content-Type", "image/jpeg");
            res.set("Cache-Control", "public, max-age=86400");
            return res.send(globalCache.posters[cacheKey]);
        }

        // Altfel, pornim fabrica strict pentru acest poster nou
        const tmdbUrl = `https://image.tmdb.org/t/p/w500/${posterPath.replace(/^\//, '')}`;
        const image = await Jimp.read(tmdbUrl);
        
        // Font de 64 pentru vizibilitate maximă
        const font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE); 

        // Bandă mai înaltă (120px) ca să încapă textul mare
        const barHeight = 120;
        const bar = new Jimp(image.bitmap.width, barHeight, 0x000000CC);
        image.blit(bar, 0, image.bitmap.height - barHeight);

        image.print(font, 0, image.bitmap.height - barHeight, {
            text: text,
            alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
            alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
        }, image.bitmap.width, barHeight);

        const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        
        // Salvăm posterul editat în RAM pentru a nu-l mai procesa niciodată cât e în top 30
        globalCache.posters[cacheKey] = buffer;

        res.set("Content-Type", "image/jpeg");
        res.set("Cache-Control", "public, max-age=86400");
        res.send(buffer);
    } catch (err) {
        const fallbackUrl = `https://image.tmdb.org/t/p/w500/${req.params.posterPath.replace(/^\//, '')}`;
        res.redirect(fallbackUrl);
    }
});

// --- RUTARI MANUALE ---
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

app.get("/:apiKey/manifest.json", (req, res) => { res.json(manifest); });

async function handleCatalog(req, res) {
    const apiKey = req.params.apiKey;
    const type = req.params.type;
    const id = req.params.id;

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;

    if (type === "movie" && id === "cinema_radar") {
        const metas = await fetchMovies(apiKey, baseUrl);
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
