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
    version: "1.6.0",
    name: "Cinema Dates Radar",
    description: "Upcoming (10) + Now Playing (30) = 40 films. No cache.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
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
    const monthNames = ["January","February","March","April","May","June","July",
                        "August","September","October","November","December"];
    const month = monthNames[dateObj.getMonth()];
    if (day <= 10) return `Early ${month}`;
    if (day <= 20) return `Mid ${month}`;
    return `Late ${month}`;
}

// Returneaza cinemaDate RAW (fara ajustare VOD) si bucket initial
// Ajustarea cu VOD se face in processMovie dupa ce avem si vodInfo
function resolveCinemaDate(movie, detailData) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let mainDate = new Date(movie.release_date || detailData.release_date || '');

    let type3Dates = [];
    if (detailData.release_dates && detailData.release_dates.results) {
        for (const r of detailData.release_dates.results) {
            if (r.iso_3166_1 === 'US' || r.iso_3166_1 === 'RO' || r.iso_3166_1 === 'GB') {
                for (const rel of r.release_dates) {
                    if (rel.type === 3) {
                        const d = new Date(rel.release_date);
                        if (!isNaN(d.getTime())) type3Dates.push(d);
                    }
                }
            }
        }
    }

    let cinemaDate = mainDate;
    if (type3Dates.length > 0) {
        const futureT3 = type3Dates.filter(d => d >= today);
        const pastT3   = type3Dates.filter(d => d < today);
        if (futureT3.length > 0) {
            cinemaDate = new Date(Math.min(...futureT3));
        } else if (pastT3.length > 0) {
            cinemaDate = new Date(Math.max(...pastT3));
        }
    }

    if (isNaN(cinemaDate.getTime())) return null;
    cinemaDate.setHours(0, 0, 0, 0);
    return cinemaDate;
}

// FIX 2 + 3 + 4: logica completa VOD
// bucket = bucket initial bazat pe cinemaDate (inainte de ajustare)
// cinemaDate = data cinema raw
// Returneaza { typeLabel, chosenDateStr, isEstimated, sortDateObj }
// SI corecteaza cinemaDate daca VOD < cinemaDate (FIX 4)
function calculateVOD(movie, detailData, cinemaDate, bucket) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Colecteaza toate datele digitale (type 4=VOD, 5=BluRay, 6=TV)
    let digitalDates = [];
    if (detailData.release_dates && detailData.release_dates.results) {
        for (const r of detailData.release_dates.results) {
            for (const release of r.release_dates) {
                if (release.type === 4 || release.type === 5 || release.type === 6) {
                    const releaseDate = new Date(release.release_date);
                    if (!isNaN(releaseDate.getTime())) {
                        digitalDates.push({ date: releaseDate, type: release.type });
                    }
                }
            }
        }
    }

    let typeLabel = "", sortDateObj = null, isEstimated = false, chosenDateStr = "";
    let adjustedCinemaDate = cinemaDate; // poate fi modificata de FIX 4
    let adjustedBucket = bucket;

    if (digitalDates.length > 0) {
        // FIX 2: Daca exista date in TRECUT => cea mai recenta din trecut
        // Daca DOAR date in viitor => cea mai apropiata viitoare
        const pastDates   = digitalDates.filter(x => x.date <= today).sort((a, b) => b.date - a.date);
        const futureDates = digitalDates.filter(x => x.date > today).sort((a, b) => a.date - b.date);

        const chosen = pastDates.length > 0 ? pastDates[0] : futureDates[0];
        sortDateObj  = chosen.date;

        if (chosen.type === 4) typeLabel = "VOD";
        else if (chosen.type === 5) typeLabel = "BluRay";
        else if (chosen.type === 6) typeLabel = "TV";

        chosenDateStr = formatDateEU(sortDateObj);

        // FIX 4: Daca data digitala e INAINTE de cinemaDate
        // => cinemaDate devine data digitala, re-evaluam bucket
        if (sortDateObj < cinemaDate) {
            adjustedCinemaDate = new Date(sortDateObj);
            adjustedCinemaDate.setHours(0, 0, 0, 0);
            // Re-evaluam bucket: daca data digitala e in trecut => NP
            adjustedBucket = adjustedCinemaDate < today ? 'NP' : 'UP';
            console.log(`[FIX4] ${movie.title}: cinemaDate ${formatDateEU(cinemaDate)} -> ${formatDateEU(adjustedCinemaDate)}, bucket ${bucket} -> ${adjustedBucket}`);
        }

    } else {
        // Nu exista date digitale confirmate => estimam
        isEstimated = true;
        typeLabel   = "EST";

        // Baza de calcul: cinemaDate (data lansarii in cinema)
        let baseDate = new Date(cinemaDate);

        let daysToAdd = 45;
        if (movie.original_language && movie.original_language !== 'en') {
            daysToAdd = 130;
        } else {
            const pop = detailData.popularity || movie.popularity || 0;
            const rev = detailData.revenue || 0;
            const bud = detailData.budget || 0;
            if (pop > 800 || rev > 150000000 || bud > 100000000) daysToAdd = 75;
            else if (pop < 150) daysToAdd = 21;
            else daysToAdd = 38;
        }

        sortDateObj = new Date(baseDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));

        // FIX 3: Daca estimatul a iesit in TRECUT (film NP fara VOD confirmat)
        // => recalculam de la AZI in viitor (filmul inca nu a aparut pe digital)
        if (bucket === 'NP' && sortDateObj < today) {
            console.log(`[FIX3] ${movie.title}: EST was in past (${formatDateEU(sortDateObj)}), recalculating from today`);
            sortDateObj = new Date(today.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));
        }

        chosenDateStr = getEstimatedPeriod(sortDateObj);
    }

    return {
        typeLabel,
        chosenDateStr,
        isEstimated,
        sortDateObj,
        adjustedCinemaDate,  // FIX 4: poate diferi de cinemaDate original
        adjustedBucket       // FIX 4: poate diferi de bucket original
    };
}

async function processMovie(movie, apiKey) {
    try {
        const detailRes  = await fetch(
            `${TMDB_BASE_URL}/movie/${movie.id}?api_key=${apiKey}&append_to_response=release_dates,external_ids`
        );
        const detailData = await detailRes.json();

        const imdbId = detailData.external_ids ? detailData.external_ids.imdb_id : null;
        if (!imdbId) {
            console.log(`[SKIP] ${movie.title || movie.id} - no imdb_id`);
            return null;
        }

        // Filtru tara origine
        let isAllowedOrigin = false;
        const origins = detailData.origin_country || [];
        if (origins.length > 0) {
            isAllowedOrigin = origins.some(c => allowedCountries.includes(c));
        } else {
            const prods = detailData.production_countries || [];
            isAllowedOrigin = prods.some(c => allowedCountries.includes(c.iso_3166_1));
        }
        if (!isAllowedOrigin) {
            console.log(`[SKIP] ${movie.title} - country not allowed: ${JSON.stringify(origins)}`);
            return null;
        }

        // FIX 1: Eliminat GUARANTEED - filtru simplu: original release_date max 2 ani in urma
        const originalReleaseDate = new Date(movie.release_date || detailData.release_date || '');
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        if (!isNaN(originalReleaseDate.getTime()) && originalReleaseDate < twoYearsAgo) {
            console.log(`[SKIP] ${movie.title} - too old: ${movie.release_date}`);
            return null;
        }

        // Obtine cinemaDate raw
        const cinemaDateRaw = resolveCinemaDate(movie, detailData);
        if (!cinemaDateRaw) {
            console.log(`[SKIP] ${movie.title} - no valid cinemaDate`);
            return null;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const bucketRaw = cinemaDateRaw >= today ? 'UP' : 'NP';

        // Calculeaza VOD cu toate fix-urile (2, 3, 4)
        const vodInfo = calculateVOD(movie, detailData, cinemaDateRaw, bucketRaw);

        // Bucket si cinemaDate finale (pot fi ajustate de FIX 4)
        const finalBucket     = vodInfo.adjustedBucket;
        const finalCinemaDate = vodInfo.adjustedCinemaDate;

        console.log(`[OK] ${movie.title} | bucket=${finalBucket} | cinemaDate=${formatDateEU(finalCinemaDate)} | vod=${vodInfo.typeLabel}:${vodInfo.chosenDateStr} | pop=${movie.popularity}`);

        return {
            bucket: finalBucket,
            movie,
            detailData,
            imdbId,
            vodInfo,
            cinemaDate: finalCinemaDate
        };
    } catch (err) {
        console.log(`[ERR] ${movie.id} - ${err.message}`);
        return null;
    }
}

async function fetchMovies(apiKey) {
    try {
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);

        const threeMonthsAgo = new Date(todayMidnight.getTime() -  90 * 24 * 60 * 60 * 1000);
        const nineMonthsAgo  = new Date(todayMidnight.getTime() - 270 * 24 * 60 * 60 * 1000);
        const sixMonthsLater = new Date(todayMidnight.getTime() + 180 * 24 * 60 * 60 * 1000);

        const todayStr     = todayMidnight.toISOString().split('T')[0];
        const sixMonthsStr = sixMonthsLater.toISOString().split('T')[0];

        console.log(`
========== FETCH START ${new Date().toISOString()} ==========`);

        const pagePromises = [];

        for (let i = 1; i <= 10; i++) {
            pagePromises.push(
                fetch(`${TMDB_BASE_URL}/movie/now_playing?api_key=${apiKey}&language=en-US&page=${i}`)
                    .then(r => r.json()).catch(() => ({ results: [] }))
            );
        }
        for (let i = 1; i <= 10; i++) {
            pagePromises.push(
                fetch(`${TMDB_BASE_URL}/discover/movie?api_key=${apiKey}&language=en-US&sort_by=popularity.desc&primary_release_date.gte=${todayStr}&primary_release_date.lte=${sixMonthsStr}&page=${i}`)
                    .then(r => r.json()).catch(() => ({ results: [] }))
            );
        }
        for (let i = 1; i <= 10; i++) {
            pagePromises.push(
                fetch(`${TMDB_BASE_URL}/movie/upcoming?api_key=${apiKey}&language=en-US&region=US&page=${i}`)
                    .then(r => r.json()).catch(() => ({ results: [] }))
            );
        }
        for (let i = 1; i <= 5; i++) {
            pagePromises.push(
                fetch(`${TMDB_BASE_URL}/discover/movie?api_key=${apiKey}&language=en-US&sort_by=popularity.desc&primary_release_date.gte=${todayStr}&page=${i}`)
                    .then(r => r.json()).catch(() => ({ results: [] }))
            );
        }

        const pagesData = await Promise.all(pagePromises);

        const uniqueMoviesMap = new Map();
        pagesData.forEach(p => {
            if (p && p.results) {
                p.results.forEach(m => {
                    if (!uniqueMoviesMap.has(m.id)) uniqueMoviesMap.set(m.id, m);
                });
            }
        });

        let masterList = Array.from(uniqueMoviesMap.values());
        console.log(`Total unique before filter: ${masterList.length}`);

        // Popularity >= 15 + limba acceptata
        masterList = masterList.filter(m => {
            if (!allowedLangs.includes(m.original_language)) return false;
            return m.popularity >= 15;
        });

        console.log(`After filter (pop>=15): ${masterList.length}`);

        let poolNP = [];
        let poolUP = [];

        const chunkSize = 20;
        for (let i = 0; i < masterList.length; i += chunkSize) {
            const chunk   = masterList.slice(i, i + chunkSize);
            const results = await Promise.all(chunk.map(m => processMovie(m, apiKey)));
            results.forEach(res => {
                if (res) {
                    if (res.bucket === 'NP') poolNP.push(res);
                    if (res.bucket === 'UP') poolUP.push(res);
                }
            });
        }

        console.log(`Pool NP: ${poolNP.length} | Pool UP: ${poolUP.length}`);

        let globalSeenIds = new Set();

        // --- UPCOMING: 10 filme ---
        // FIX 5: sortat dupa vodSortDate (nu cinemaDate)
        // Selectie: cel mai iminent VOD primul
        poolUP.sort((a, b) => a.vodInfo.sortDateObj.getTime() - b.vodInfo.sortDateObj.getTime());
        let finalUpcoming = [];
        for (const item of poolUP) {
            if (finalUpcoming.length === 10) break;
            if (!globalSeenIds.has(item.imdbId)) {
                globalSeenIds.add(item.imdbId);
                finalUpcoming.push(item);
            }
        }
        // Dupa selectie: cel mai indepartat VOD primul pentru afisare Stremio
        finalUpcoming.sort((a, b) => b.vodInfo.sortDateObj.getTime() - a.vodInfo.sortDateObj.getTime());
        console.log(`Final UP (${finalUpcoming.length}): ${finalUpcoming.map(x => `${x.movie.title}(${formatDateEU(x.vodInfo.sortDateObj)})`).join(', ')}`);

        // --- NOW PLAYING: 30 filme ---
        let filteredNP = poolNP.filter(item => item.cinemaDate >= nineMonthsAgo);

        // Elimina EST mai vechi de 3 luni (deja recalculate de FIX 3, deci nu ar trebui sa existe)
        // Pastram filtrul ca safety net
        filteredNP = filteredNP.filter(item => {
            if (item.vodInfo.isEstimated && item.vodInfo.sortDateObj < threeMonthsAgo) return false;
            return true;
        });

        filteredNP.sort((a, b) => b.movie.popularity - a.movie.popularity);

        let finalNowPlaying = [];
        for (const item of filteredNP) {
            if (finalNowPlaying.length === 30) break;
            if (!globalSeenIds.has(item.imdbId)) {
                globalSeenIds.add(item.imdbId);
                finalNowPlaying.push(item);
            }
        }
        // NP sortat descrescator dupa VOD (viitor -> trecut)
        finalNowPlaying.sort((a, b) => b.vodInfo.sortDateObj.getTime() - a.vodInfo.sortDateObj.getTime());
        console.log(`Final NP (${finalNowPlaying.length}): ${finalNowPlaying.map(x => `${x.movie.title}(${vodLabel(x)})`).join(', ')}`);

        // Helper log
        function vodLabel(item) {
            return `${item.vodInfo.typeLabel}:${item.vodInfo.chosenDateStr}`;
        }

        // --- GENERARE POSTERE IMAGEKIT ---
        const metasNP = finalNowPlaying.map(item => {
            const topText = encodeURIComponent(Buffer.from("In Cinema").toString('base64'));
            const botText = encodeURIComponent(
                Buffer.from(`${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`).toString('base64')
            );
            const transform = `?tr=l-text,ie-${topText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-top,l-end:l-text,ie-${botText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-bottom,l-end`;
            return {
                id: item.imdbId,
                type: "movie",
                name: item.movie.title,
                poster: `https://ik.imagekit.io/${IMAGEKIT_ID}/tmdb/t/p/w500${item.movie.poster_path}${transform}`,
                description: item.movie.overview
            };
        });

        const metasUP = finalUpcoming.map(item => {
            // FIX 5: data afisata pe poster = cinemaDate (pentru filme cu cinema real)
            // sau vodDate (pentru filme direct streaming unde cinema=vod)
            const displayDate = formatDateEU(item.cinemaDate);
            const topText = encodeURIComponent(Buffer.from(`Upcoming | ${displayDate}`).toString('base64'));
            const botText = encodeURIComponent(
                Buffer.from(`${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`).toString('base64')
            );
            const transform = `?tr=l-text,ie-${topText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-top,l-end:l-text,ie-${botText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-bottom,l-end`;
            return {
                id: item.imdbId,
                type: "movie",
                name: item.movie.title,
                poster: `https://ik.imagekit.io/${IMAGEKIT_ID}/tmdb/t/p/w500${item.movie.poster_path}${transform}`,
                description: item.movie.overview
            };
        });

        const finalMetas = [...metasUP, ...metasNP];
        console.log(`========== TOTAL: ${metasUP.length} UP + ${metasNP.length} NP = ${finalMetas.length} ==========
`);

        return finalMetas;

    } catch (error) {
        console.error('fetchMovies FATAL:', error);
        return [];
    }
}

app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });
app.get("/:apiKey/manifest.json", (req, res) => { res.json(manifest); });

async function handleCatalog(req, res) {
    const { apiKey, type, id } = req.params;
    if (type === "movie" && id === "cinema_radar") {
        const metas = await fetchMovies(apiKey);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.json({ metas });
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
