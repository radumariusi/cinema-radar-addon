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
    version: "1.1.1", // Versiune nouă pentru filtrare geografică strictă și pre-sortare cronologică
    name: "Cinema Dates Radar",
    description: "Newest First, US/UK Strict Origin, Max 9 Months, Pop > 50.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
};

const globalCache = {
    movies: [],          
    lastFetch: 0        
};

function formatDateEU(dateObj) {
    const d = String(dateObj.getDate()).padStart(2, '0');
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const y = dateObj.getFullYear();
    return `${d}.${m}.${y}`;
}

function getEstimatedPeriod(dateObj) {
    const day = dateObj.getDate();
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const month = monthNames[dateObj.getMonth()];
    
    if (day <= 10) return `Early ${month}`;
    if (day <= 20) return `Mid ${month}`;
    return `Late ${month}`;
}

function calculateVOD(movie, detailData) {
    let validDates = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0); 

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

    let typeLabel = "", sortDateObj = null, isEstimated = false, chosenDateStr = "";

    if (validDates.length > 0) {
        validDates.sort((a, b) => Math.abs(a.date - today) - Math.abs(b.date - today));
        sortDateObj = validDates[0].date;
        if (validDates[0].type === 4) typeLabel = "VOD";
        else if (validDates[0].type === 5) typeLabel = "BluRay";
        else if (validDates[0].type === 6) typeLabel = "TV";
        
        chosenDateStr = formatDateEU(sortDateObj); 
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
        
        chosenDateStr = getEstimatedPeriod(sortDateObj); 
    }
    
    return { typeLabel, chosenDateStr, isEstimated, sortDateObj };
}

async function fetchMovies(apiKey) {
    if (globalCache.movies.length > 0 && (Date.now() - globalCache.lastFetch < 43200000)) {
        return globalCache.movies;
    }

    try {
        const pagePromises = [];
        // Tragem 10 pagini simultan (~200 filme) ca să avem de unde selecta cele mai noi 30
        for (let i = 1; i <= 10; i++) {
            pagePromises.push(fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
        }
        
        const pagesData = await Promise.all(pagePromises);
        let allMovies = [];
        pagesData.forEach(p => { if (p.results) allMovies = allMovies.concat(p.results); });

        const allowedLangs = ['en', 'fr', 'de', 'it', 'es', 'nl', 'sv', 'da', 'no', 'fi'];
        
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);

        const nineMonthsInMs = 270 * 24 * 60 * 60 * 1000;
        const maxOldDate = new Date(todayMidnight.getTime() - nineMonthsInMs);

        // --- FILTRAREA BRUTĂ (Vechime, Popularitate, Origine) ---
        let cleanMovies = allMovies.filter(movie => {
            const releaseDate = new Date(movie.release_date);
            const isLanguageAllowed = allowedLangs.includes(movie.original_language);
            const isPopularityAllowed = movie.popularity >= 50;
            const isNotTooOld = !isNaN(releaseDate.getTime()) && releaseDate >= maxOldDate;

            if (!isLanguageAllowed || !isPopularityAllowed || !isNotTooOld) return false;

            // Filtrul Geografic Strict pentru Engleză
            if (movie.original_language === 'en') {
                const originCountries = movie.origin_country || [];
                const isUSorUK = originCountries.includes('US') || originCountries.includes('GB');
                if (!isUSorUK) return false;
            }

            return true;
        });

        // --- PRE-SORTARE: Cele mai proaspete lansări din cinema primele ---
        cleanMovies.sort((a, b) => {
            const dateA = new Date(a.release_date).getTime();
            const dateB = new Date(b.release_date).getTime();
            return dateB - dateA; // Ordine descrescătoare
        });

        const promises = cleanMovies.map(async (movie) => {
            try {
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId) return null;

                const vodInfo = calculateVOD(movie, detailData);

                // Aruncăm estimările care au expirat
                if (vodInfo.isEstimated && vodInfo.sortDateObj < todayMidnight) {
                    return null;
                }

                const textToStamp = `${vodInfo.typeLabel}: ${vodInfo.chosenDateStr}`;
                const base64Text = Buffer.from(textToStamp).toString('base64');
                const encodedText = encodeURIComponent(base64Text);
                
                const imageKitTransform = `?tr=l-text,ie-${encodedText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-bottom,l-end`;
                const customPosterUrl = `https://ik.imagekit.io/${IMAGEKIT_ID}/tmdb/t/p/w500${movie.poster_path}${imageKitTransform}`;

                return {
                    meta: {
                        id: imdbId,
                        type: "movie",
                        name: movie.title,
                        poster: customPosterUrl,
                        description: movie.overview
                    },
                    sortDate: vodInfo.sortDateObj,
                    isEstimated: vodInfo.isEstimated
                };
            } catch (err) { return null; }
        });

        // Promise.all păstrează ordinea exactă a array-ului 'cleanMovies' (cele mai noi primele)
        let processedMovies = (await Promise.all(promises)).filter(m => m !== null);
        
        // --- COLECTAREA CELOR 30 (Cele mai noi 30 de filme valide) ---
        const seenImdbIds = new Set();
        let uniqueNewestMovies = [];
        
        for (const m of processedMovies) {
            if (!seenImdbIds.has(m.meta.id)) {
                seenImdbIds.add(m.meta.id);
                uniqueNewestMovies.push(m);
                // Ne oprim din adăugat imediat ce am strâns 30 de lansări valide
                if (uniqueNewestMovies.length === 30) break;
            }
        }

        // --- SORTAREA FINALĂ PENTRU AFIȘARE (Estimat sus, Confirmate jos) ---
        uniqueNewestMovies.sort((a, b) => {
            if (a.isEstimated && !b.isEstimated) return -1;
            if (!a.isEstimated && b.isEstimated) return 1;
            return b.sortDate.getTime() - a.sortDate.getTime();
        });

        const finalMetas = uniqueNewestMovies.map(item => item.meta);

        globalCache.movies = finalMetas;
        globalCache.lastFetch = Date.now();

        return finalMetas;
    } catch (error) { 
        return globalCache.movies; 
    }
}

app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });
app.get("/:apiKey/manifest.json", (req, res) => { res.json(manifest); });

async function handleCatalog(req, res) {
    const apiKey = req.params.apiKey;
    const type = req.params.type;
    const id = req.params.id;

    if (type === "movie" && id === "cinema_radar") {
        const metas = await fetchMovies(apiKey);
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
