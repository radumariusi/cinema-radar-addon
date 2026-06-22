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
    version: "1.1.2", // Versiunea stabilă: Fetch secvențial anti-crash și filtru geografic sigur
    name: "Cinema Dates Radar",
    description: "Anti-Crash Sequential Loading. Strict Origin US/UK. Pop>50.",
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

        // --- FILTRAREA BRUTĂ (Limba, Popularitate, Vechime 9 Luni) ---
        let cleanMovies = allMovies.filter(movie => {
            const releaseDate = new Date(movie.release_date);
            const isLanguageAllowed = allowedLangs.includes(movie.original_language);
            const isPopularityAllowed = movie.popularity >= 50;
            const isNotTooOld = !isNaN(releaseDate.getTime()) && releaseDate >= maxOldDate;

            return isLanguageAllowed && isPopularityAllowed && isNotTooOld;
        });

        // --- PRE-SORTARE: Cele mai noi lansări primele ---
        cleanMovies.sort((a, b) => {
            const dateA = new Date(a.release_date).getTime();
            const dateB = new Date(b.release_date).getTime();
            return dateB - dateA; // Ordine descrescătoare
        });

        const seenImdbIds = new Set();
        let uniqueNewestMovies = [];

        // --- PROCESARE SECVENȚIALĂ (Rezolvă problema cu TMDB Rate Limit) ---
        for (const movie of cleanMovies) {
            // Ne oprim exact când am adunat 30 de filme valide
            if (uniqueNewestMovies.length === 30) break;

            try {
                // Interogăm TMDB unul câte unul
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId || seenImdbIds.has(imdbId)) continue; // Sărim dacă n-are ID sau e dublură

                // --- FILTRUL GEOGRAFIC STRICT MUTAT AICI (Unde datele sunt 100% sigure) ---
                if (movie.original_language === 'en') {
                    const originCountries = detailData.origin_country || [];
                    if (originCountries.length > 0) {
                        const isUSorUK = originCountries.includes('US') || originCountries.includes('GB');
                        if (!isUSorUK) continue; // Eliminăm Australia, Canada etc.
                    } else {
                        // Plan de rezervă dacă origin_country lipsește total din baza lor
                        const prodCountries = detailData.production_countries || [];
                        const isUSorUKProd = prodCountries.some(c => c.iso_3166_1 === 'US' || c.iso_3166_1 === 'GB');
                        if (!isUSorUKProd) continue;
                    }
                }

                const vodInfo = calculateVOD(movie, detailData);

                // Sărim dacă estimarea e în trecut
                if (vodInfo.isEstimated && vodInfo.sortDateObj < todayMidnight) {
                    continue;
                }

                const textToStamp = `${vodInfo.typeLabel}: ${vodInfo.chosenDateStr}`;
                const base64Text = Buffer.from(textToStamp).toString('base64');
                const encodedText = encodeURIComponent(base64Text);
                
                const imageKitTransform = `?tr=l-text,ie-${encodedText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-bottom,l-end`;
                const customPosterUrl = `https://ik.imagekit.io/${IMAGEKIT_ID}/tmdb/t/p/w500${movie.poster_path}${imageKitTransform}`;

                seenImdbIds.add(imdbId);
                uniqueNewestMovies.push({
                    meta: {
                        id: imdbId,
                        type: "movie",
                        name: movie.title,
                        poster: customPosterUrl,
                        description: movie.overview
                    },
                    sortDate: vodInfo.sortDateObj,
                    isEstimated: vodInfo.isEstimated
                });

            } catch (err) { 
                continue; // Dacă avem vreo eroare la un film, pur și simplu trecem la următorul
            }
        }

        // --- SORTAREA FINALĂ PENTRU NUVIO (Estimări sus, Confirmări jos) ---
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
