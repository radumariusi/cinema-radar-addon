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
    version: "1.2.5", // THE DEFINITIVE FIX: Swapped broken 'upcoming' for 'discover' engine.
    name: "Cinema Dates Radar",
    description: "Discover API Bypass for Upcoming. Flawless NP/UP separation.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
};

const globalCache = {
    movies: [],          
    lastFetch: 0        
};

const allowedLangs = ['en', 'ro', 'fr', 'de', 'it', 'es', 'nl', 'sv', 'da', 'no', 'fi'];
const allowedCountries = ['US', 'GB', 'RO', 'FR', 'DE', 'IT', 'ES', 'NL', 'SE', 'DK', 'NO', 'FI'];

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

// Analizatorul precis al datelor
function resolveBucketAndDates(movie, detailData) {
    let type3Dates = [];

    if (detailData.release_dates && detailData.release_dates.results) {
        for (const r of detailData.release_dates.results) {
            if (r.iso_3166_1 === 'US' || r.iso_3166_1 === 'RO') {
                for (const rel of r.release_dates) {
                    // Căutăm doar lansarea comercială de masă
                    if (rel.type === 3) {
                        type3Dates.push(new Date(rel.release_date));
                    }
                }
            }
        }
    }

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    // Dacă avem date oficiale Type 3 pentru US/RO
    if (type3Dates.length > 0) {
        const futureDates = type3Dates.filter(d => d > todayMidnight);
        if (futureDates.length > 0) {
            return { bucket: 'UP', cinemaDate: new Date(Math.min(...futureDates)) };
        } else {
            const pastDates = type3Dates.filter(d => d <= todayMidnight);
            return { bucket: 'NP', cinemaDate: new Date(Math.max(...pastDates)) };
        }
    }

    // Fallback inteligent dacă moderatorii TMDB încă nu au băgat Type 3 regional
    const fallbackStr = movie.release_date;
    if (!fallbackStr) return { bucket: 'NONE', cinemaDate: null };

    const fallbackDate = new Date(fallbackStr);
    if (isNaN(fallbackDate.getTime())) return { bucket: 'NONE', cinemaDate: null };

    if (fallbackDate > todayMidnight) {
        return { bucket: 'UP', cinemaDate: fallbackDate };
    } else {
        return { bucket: 'NP', cinemaDate: fallbackDate };
    }
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
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);
        const sixMonthsAgo = new Date(todayMidnight.getTime() - 180 * 24 * 60 * 60 * 1000);
        const threeMonthsAgo = new Date(todayMidnight.getTime() - 90 * 24 * 60 * 60 * 1000);
        const todayStr = todayMidnight.toISOString().split('T')[0];

        const pagePromises = [];
        // Tragem 8 pagini de Now Playing și 8 pagini de DISCOVER (Filme viitoare ordonate după popularitate reală)
        for (let i = 1; i <= 8; i++) {
            pagePromises.push(fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
            pagePromises.push(fetch(`${TMDB_BASE_URL}/discover/movie?api_key=${apiKey}&language=en-US&region=US&sort_by=popularity.desc&primary_release_date.gte=${todayStr}&page=${i}`).then(r => r.json()));
        }
        
        const pagesData = await Promise.all(pagePromises);
        
        const uniqueMoviesMap = new Map();
        pagesData.forEach(p => {
            if (p.results) {
                p.results.forEach(m => {
                    if (!uniqueMoviesMap.has(m.id)) uniqueMoviesMap.set(m.id, m);
                });
            }
        });
        
        let masterList = Array.from(uniqueMoviesMap.values());

        // Filtrul Anti-Mizerii: Dacă n-ai popularitate >= 50, zbori.
        masterList = masterList.filter(m => m.popularity >= 50 && allowedLangs.includes(m.original_language));

        let poolNP = [];
        let poolUP = [];

        const chunkSize = 20;
        for (let i = 0; i < masterList.length; i += chunkSize) {
            const chunk = masterList.slice(i, i + chunkSize);
            
            const chunkPromises = chunk.map(async movie => {
                try {
                    const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                    const detailData = await detailRes.json();
                    
                    const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                    if (!imdbId) return null;

                    let isAllowedOrigin = false;
                    const origins = detailData.origin_country || [];
                    if (origins.length > 0) {
                        isAllowedOrigin = origins.some(c => allowedCountries.includes(c));
                    } else {
                        const prods = detailData.production_countries || [];
                        isAllowedOrigin = prods.some(c => allowedCountries.includes(c.iso_3166_1));
                    }
                    if (!isAllowedOrigin) return null;

                    const { bucket, cinemaDate } = resolveBucketAndDates(movie, detailData);
                    if (!bucket || bucket === 'NONE') return null;

                    const vodInfo = calculateVOD(movie, detailData);

                    return { bucket, movie, detailData, imdbId, vodInfo, cinemaDate };
                } catch (err) { return null; }
            });

            const results = await Promise.all(chunkPromises);
            results.forEach(res => {
                if (res) {
                    if (res.bucket === 'NP') poolNP.push(res);
                    if (res.bucket === 'UP') poolUP.push(res);
                }
            });
        }

        // --- GĂLEATA NOW PLAYING ---
        poolNP = poolNP.filter(item => item.cinemaDate >= sixMonthsAgo);
        poolNP.sort((a, b) => b.movie.popularity - a.movie.popularity);
        
        let validNP = [];
        let globalSeenIds = new Set();

        for (const item of poolNP) {
            if (validNP.length === 45) break; 
            if (item.vodInfo.isEstimated && item.vodInfo.sortDateObj < threeMonthsAgo) continue;
            if (!globalSeenIds.has(item.imdbId)) {
                globalSeenIds.add(item.imdbId);
                validNP.push(item);
            }
        }
        
        let finalNowPlaying = validNP.slice(0, 30);
        finalNowPlaying.sort((a, b) => b.vodInfo.sortDateObj.getTime() - a.vodInfo.sortDateObj.getTime());

        // --- GĂLEATA UPCOMING ---
        // Sortăm crescător pentru a alege filmele cele mai apropiate de ziua de azi
        poolUP.sort((a, b) => a.cinemaDate.getTime() - b.cinemaDate.getTime());
        
        let validUP = [];
        for (const item of poolUP) {
            if (validUP.length === 10) break;
            if (!globalSeenIds.has(item.imdbId)) {
                globalSeenIds.add(item.imdbId);
                validUP.push(item);
            }
        }

        // Inversăm ordinea pentru afișarea estetică pe ecran
        validUP.sort((a, b) => b.cinemaDate.getTime() - a.cinemaDate.getTime());

        // --- ȘTAMPILELE IMAGEKIT ---
        const metasNP = finalNowPlaying.map(item => {
            const topText = encodeURIComponent(Buffer.from("In Cinema").toString('base64'));
            const botText = encodeURIComponent(Buffer.from(`${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`).toString('base64'));
            
            const transform = `?tr=l-text,ie-${topText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-top,l-end:l-text,ie-${botText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-bottom,l-end`;
            const posterUrl = `https://ik.imagekit.io/${IMAGEKIT_ID}/tmdb/t/p/w500${item.movie.poster_path}${transform}`;

            return {
                id: item.imdbId,
                type: "movie",
                name: item.movie.title,
                poster: posterUrl,
                description: item.movie.overview
            };
        });

        const metasUP = validUP.map(item => {
            const dateStr = formatDateEU(item.cinemaDate);
            const topTextRaw = `Upcoming | ${dateStr}`; 
            
            const topText = encodeURIComponent(Buffer.from(topTextRaw).toString('base64'));
            const botText = encodeURIComponent(Buffer.from(`${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`).toString('base64'));
            
            const transform = `?tr=l-text,ie-${topText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-top,l-end:l-text,ie-${botText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-bottom,l-end`;
            const posterUrl = `https://ik.imagekit.io/${IMAGEKIT_ID}/tmdb/t/p/w500${item.movie.poster_path}${transform}`;

            return {
                id: item.imdbId,
                type: "movie",
                name: item.movie.title,
                poster: posterUrl,
                description: item.movie.overview
            };
        });

        const finalMetas = [...metasNP, ...metasUP];

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
