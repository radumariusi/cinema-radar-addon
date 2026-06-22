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
    version: "1.2.2", // Logica Master, Popularitate > 50 Peste Tot, Date Precise RO/US
    name: "Cinema Dates Radar",
    description: "Hybrid NP/UP Filter. Concrete Wall Active. ImageKit Fix.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
};

const globalCache = {
    movies: [],          
    lastFetch: 0        
};

// "Zidul de Beton" Geografic
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

// Funcție inteligentă care extrage data pentru US/RO. 
// wantFuture=true (pentru Upcoming), wantFuture=false (pentru Now Playing)
function getResolvedCinemaDate(movie, detailData, wantFuture) {
    let dates = [];
    if (detailData.release_dates && detailData.release_dates.results) {
        for (const r of detailData.release_dates.results) {
            if (r.iso_3166_1 === 'US' || r.iso_3166_1 === 'RO') {
                for (const rel of r.release_dates) {
                    if (rel.type >= 1 && rel.type <= 3) {
                        dates.push(new Date(rel.release_date));
                    }
                }
            }
        }
    }
    const fallback = new Date(movie.release_date);
    if (!isNaN(fallback.getTime())) dates.push(fallback);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (wantFuture) {
        // Pentru UP: luăm data viitoare cea mai apropiată
        const futureDates = dates.filter(d => d > today);
        if (futureDates.length > 0) return new Date(Math.min(...futureDates));
    } else {
        // Pentru NP: luăm data trecută cea mai recentă (cea mai apropiată de noi)
        const pastDates = dates.filter(d => d <= today);
        if (pastDates.length > 0) return new Date(Math.max(...pastDates));
    }
    return null;
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
        // MODULUL 1: "NOW PLAYING" (DEJA LANSATE)
        // ==========================================
        const npPromises = [];
        for (let i = 1; i <= 10; i++) npPromises.push(fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
        const npData = await Promise.all(npPromises);
        let npMovies = [];
        npData.forEach(p => { if (p.results) npMovies = npMovies.concat(p.results); });

        // Filtrul de Bază (Limbă + Popularitate Strict >= 50)
        let npClean = npMovies.filter(m => m.popularity >= 50 && allowedLangs.includes(m.original_language));
        npClean.sort((a, b) => b.popularity - a.popularity); // Sortăm după popularitate ca să le luăm pe cele mai mari

        let top45NP = [];

        for (const movie of npClean) {
            if (top45NP.length === 45) break;

            try {
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId || seenImdbIds.has(imdbId)) continue;

                // Verificare Țară Origine Strictă
                let isAllowedOrigin = false;
                const origins = detailData.origin_country || [];
                if (origins.length > 0) {
                    isAllowedOrigin = origins.some(c => allowedCountries.includes(c));
                } else {
                    const prods = detailData.production_countries || [];
                    isAllowedOrigin = prods.some(c => allowedCountries.includes(c.iso_3166_1));
                }
                if (!isAllowedOrigin) continue;

                // Data de lansare în cinema (trecută)
                const cinemaDate = getResolvedCinemaDate(movie, detailData, false);
                if (!cinemaDate) continue;

                cinemaDate.setHours(0, 0, 0, 0);

                // Nu mai vechi de 6 luni
                if (cinemaDate < sixMonthsAgo) continue;

                const vodInfo = calculateVOD(movie, detailData);

                // Eliminăm estimările de VOD mai vechi de 3 luni
                if (vodInfo.isEstimated && vodInfo.sortDateObj < threeMonthsAgo) continue;

                seenImdbIds.add(imdbId);
                top45NP.push({ movie, detailData, imdbId, vodInfo });
            } catch (err) { continue; }
        }

        // Tăiem la 30 și le sortăm descrescător din viitor în trecut
        top45NP.sort((a, b) => b.vodInfo.sortDateObj.getTime() - a.vodInfo.sortDateObj.getTime());
        const finalNowPlaying = top45NP.slice(0, 30);


        // ==========================================
        // MODULUL 2: "UPCOMING" (LANSĂRI VIITOARE IN CINEMA)
        // ==========================================
        const upPromises = [];
        for (let i = 1; i <= 10; i++) upPromises.push(fetch(`${TMDB_BASE_URL}/movie/upcoming?api_key=${apiKey}&language=en-US&page=${i}`).then(r => r.json()));
        const upData = await Promise.all(upPromises);
        let upMovies = [];
        upData.forEach(p => { if (p.results) upMovies = upMovies.concat(p.results); });

        // Filtrul de Bază (Limbă + Popularitate Strict >= 50)
        let upClean = upMovies.filter(m => m.popularity >= 50 && allowedLangs.includes(m.original_language));
        
        // Pentru a prinde cele mai apropiate de lansare, sortăm cronologic crescător după data generică TMDB
        upClean.sort((a, b) => new Date(a.release_date).getTime() - new Date(b.release_date).getTime());

        let top10UP = [];

        for (const movie of upClean) {
            if (top10UP.length === 10) break;

            try {
                const detailRes = await fetch(`${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`);
                const detailData = await detailRes.json();
                
                const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
                if (!imdbId || seenImdbIds.has(imdbId)) continue; 

                // Verificare Țară Origine Strictă
                let isAllowedOrigin = false;
                const origins = detailData.origin_country || [];
                if (origins.length > 0) {
                    isAllowedOrigin = origins.some(c => allowedCountries.includes(c));
                } else {
                    const prods = detailData.production_countries || [];
                    isAllowedOrigin = prods.some(c => allowedCountries.includes(c.iso_3166_1));
                }
                if (!isAllowedOrigin) continue;

                // Data de lansare în cinema (viitoare)
                const cinemaDate = getResolvedCinemaDate(movie, detailData, true);
                if (!cinemaDate) continue;

                const vodInfo = calculateVOD(movie, detailData);
                
                seenImdbIds.add(imdbId);
                top10UP.push({ movie, detailData, imdbId, vodInfo, cinemaDate });
            } catch (err) { continue; }
        }

        // Sortăm Upcoming descrescător după data premierei (de la cel mai îndepărtat viitor spre prezent)
        top10UP.sort((a, b) => b.cinemaDate.getTime() - a.cinemaDate.getTime());


        // ==========================================
        // MODULUL 3: GENERARE GRAFICĂ IMAGEKIT
        // ==========================================
        
        const metasNP = finalNowPlaying.map(item => {
            const topText = encodeURIComponent(Buffer.from("In Cinema").toString('base64'));
            const botText = encodeURIComponent(Buffer.from(`${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`).toString('base64'));
            
            // Folosim ":" pentru suprapuneri multiple corecte
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

        const metasUP = top10UP.map(item => {
            const dateStr = formatDateEU(item.cinemaDate);
            const topTextRaw = `Upcoming\n${dateStr}`; 
            
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
