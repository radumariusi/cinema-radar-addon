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
    version: "1.2.1", // Sincronizare perfectă: ImageKit fix, Type 3 Cinema strict, 10 Pagini Upcoming
    name: "Cinema Dates Radar",
    description: "Hybrid NP/UP architecture. Corrected Layer syntax. US/UK/RO/EUR filters.",
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

// Extrage exclusiv data premierei oficiale largi în cinema (Type 3 Theatrical) pentru US și RO
function getLocalCinemaDates(detailData, fallbackStr) {
    let usDate = null, roDate = null;
    if (detailData.release_dates && detailData.release_dates.results) {
        for (const r of detailData.release_dates.results) {
            if (r.iso_3166_1 === 'US' || r.iso_3166_1 === 'RO') {
                let bestDate = null;
                for (const rel of r.release_dates) {
                    // Tipul 3 reprezintă lansarea oficială în cinematografe ("Theatrical Wide Release")
                    if (rel.type === 3) { 
                        const d = new Date(rel.release_date);
                        if (!bestDate || d < bestDate) bestDate = d;
                    }
                }
                if (r.iso_3166_1 === 'US') usDate = bestDate;
                if (r.iso_3166_1 === 'RO') roDate = bestDate;
            }
        }
    }
    const fallback = new Date(fallbackStr);
    return {
        us: usDate,
        ro: roDate,
        fallback: isNaN(fallback.getTime()) ? new Date() : fallback
    };
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

        let seenImdbIds = new Set();

        // ==========================================
        // MODULUL 1: "NOW PLAYING" (FILME LANSATE)
        // ==========================================
        const npPromises = [];
        for (let i = 1; i <= 10; i++) npPromises.push(fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
        const npData = await Promise.all(npPromises);
        let npMovies = [];
        npData.forEach(p => { if (p.results) npMovies = npMovies.concat(p.results); });

        let npClean = npMovies.filter(m => allowedLangs.includes(m.original_language));
        npClean.sort((a, b) => b.popularity - a.popularity); // Sortează după popularitate

        let top45NP = [];

        for (const movie of npClean) {
            if (top45NP.length === 45) break;

            try {
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId || seenImdbIds.has(imdbId)) continue;

                const origins = detailData.origin_country || [];
                if (!origins.some(c => allowedCountries.includes(c))) continue;

                const dates = getLocalCinemaDates(detailData, movie.release_date);
                
                // Ultima dată dintre US și RO (cea mai recentă premieră cinema comercială)
                let cinemaDate = null;
                if (dates.us && dates.ro) cinemaDate = dates.us > dates.ro ? dates.us : dates.ro;
                else if (dates.us) cinemaDate = dates.us;
                else if (dates.ro) cinemaDate = dates.ro;
                else cinemaDate = dates.fallback;
                
                cinemaDate.setHours(0, 0, 0, 0);

                // Regula: Lansat deja (<= azi) și nu mai vechi de 6 luni
                if (cinemaDate > todayMidnight || cinemaDate < sixMonthsAgo) continue;

                const vodInfo = calculateVOD(movie, detailData);

                // Regula: Eliminăm estimările mai vechi de 3 luni din trecut
                if (vodInfo.isEstimated && vodInfo.sortDateObj < threeMonthsAgo) continue;

                seenImdbIds.add(imdbId);
                top45NP.push({ movie, detailData, imdbId, vodInfo });
            } catch (err) { continue; }
        }

        // Sortare mixtă cerută: descrescător din viitor în trecut pe axa digitală (VOD/EST)
        top45NP.sort((a, b) => b.vodInfo.sortDateObj.getTime() - a.vodInfo.sortDateObj.getTime());
        const finalNowPlaying = top45NP.slice(0, 30);


        // ==========================================
        // MODULUL 2: "UPCOMING" (LANSĂRI VIITOARE IN CINEMA)
        // ==========================================
        const upPromises = [];
        // Mărit la 10 pagini ca să fim siguri că avem destul volum brut după filtrele de calitate
        for (let i = 1; i <= 10; i++) upPromises.push(fetch(`${TMDB_BASE_URL}/movie/upcoming?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
        const upData = await Promise.all(upPromises);
        let upMovies = [];
        upData.forEach(p => { if (p.results) upMovies = upMovies.concat(p.results); });

        let upClean = upMovies.filter(m => allowedLangs.includes(m.original_language) && m.popularity >= 50);
        let upcomingList = [];

        for (const movie of upClean) {
            try {
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId || seenImdbIds.has(imdbId)) continue; 

                const origins = detailData.origin_country || [];
                if (!origins.some(c => allowedCountries.includes(c))) continue;

                const dates = getLocalCinemaDates(detailData, movie.release_date);
                
                // Căutăm data viitoare cea mai apropiată din punct de vedere comercial (Minimul valid dintre US și RO)
                let validFutureDates = [];
                if (dates.us && dates.us >= todayMidnight) validFutureDates.push(dates.us);
                if (dates.ro && dates.ro >= todayMidnight) validFutureDates.push(dates.ro);

                let cinemaDate = null;
                if (validFutureDates.length > 0) cinemaDate = new Date(Math.min(...validFutureDates));
                else if (dates.fallback >= todayMidnight) cinemaDate = dates.fallback;

                if (!cinemaDate) continue; // Nu este lansare viitoare certă comerciaă în regiunile noastre

                const vodInfo = calculateVOD(movie, detailData);
                
                seenImdbIds.add(imdbId);
                upcomingList.push({ movie, detailData, imdbId, vodInfo, cinemaDate });
            } catch (err) { continue; }
        }

        // Sortăm întâi cronologic crescător ca să extragem cele 10 care bat cel mai curând la ușă în cinema
        upcomingList.sort((a, b) => a.cinemaDate.getTime() - b.cinemaDate.getTime());
        let top10Upcoming = upcomingList.slice(0, 10);
        
        // Ordinea finală în catalog: descrescător de la cel mai îndepărtat punct din viitor
        top10Upcoming.sort((a, b) => b.cinemaDate.getTime() - a.cinemaDate.getTime());


        // ==========================================
        // MODULUL 3: COCOȘAREA PARSURILOR IN IMAGEKIT (DUAL LAYERS)
        // ==========================================
        
        const metasNP = finalNowPlaying.map(item => {
            const topText = encodeURIComponent(Buffer.from("In Cinema").toString('base64'));
            const botText = encodeURIComponent(Buffer.from(`${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`).toString('base64'));
            
            // CORECTAT: Folosim caracterul ":" ca separator valid de layere ImageKit în loc de ","
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

        const metasUP = top10Upcoming.map(item => {
            const dateStr = formatDateEU(item.cinemaDate);
            const topTextRaw = `Upcoming\n${dateStr}`; // Două rânduri sus
            
            const topText = encodeURIComponent(Buffer.from(topTextRaw).toString('base64'));
            const botText = encodeURIComponent(Buffer.from(`${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`).toString('base64'));
            
            // CORECTAT: Separator ":" activ și pentru stratul de Upcoming
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
