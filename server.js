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
    version: "1.5.1",
    name: "Cinema Dates Radar",
    description: "Upcoming (10) + Now Playing (30) = 40 films. No cache.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
};

const allowedLangs = ['en', 'ro', 'fr', 'de', 'it', 'es', 'nl', 'sv', 'da', 'no', 'fi'];
const allowedCountries = ['US', 'GB', 'RO', 'FR', 'DE', 'IT', 'ES', 'NL', 'SE', 'DK', 'NO', 'FI'];

const GUARANTEED_TMDB_IDS = [
    1081003,  // Supergirl: Woman of Tomorrow
    986056,   // Thunderbolts*
    574475,   // Final Destination: Bloodlines
    950387,   // A Minecraft Movie
    558449,   // Gladiator II
    748783,   // The Wild Robot
];

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

function resolveBucketAndDates(movie, detailData) {
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

    if (isNaN(cinemaDate.getTime())) return { bucket: 'NONE', cinemaDate: null };
    cinemaDate.setHours(0, 0, 0, 0);

    if (cinemaDate >= today) {
        return { bucket: 'UP', cinemaDate };
    } else {
        return { bucket: 'NP', cinemaDate };
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
                    if (!isNaN(releaseDate.getTime())) {
                        validDates.push({ date: releaseDate, type: release.type });
                    }
                }
            }
        }
    }

    let typeLabel = "", sortDateObj = null, isEstimated = false, chosenDateStr = "";

    if (validDates.length > 0) {
        const future = validDates.filter(x => x.date >= today).sort((a, b) => a.date - b.date);
        const past   = validDates.filter(x => x.date < today).sort((a, b) => b.date - a.date);
        const chosen = future.length > 0 ? future[0] : past[0];
        sortDateObj   = chosen.date;
        if (chosen.type === 4) typeLabel = "VOD";
        else if (chosen.type === 5) typeLabel = "BluRay";
        else if (chosen.type === 6) typeLabel = "TV";
        chosenDateStr = formatDateEU(sortDateObj);
    } else {
        isEstimated = true;
        typeLabel   = "EST";
        let cinemaDate = new Date(movie.release_date || '');
        if (isNaN(cinemaDate.getTime())) cinemaDate = today;

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
        sortDateObj   = new Date(cinemaDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));
        chosenDateStr = getEstimatedPeriod(sortDateObj);
    }

    return { typeLabel, chosenDateStr, isEstimated, sortDateObj };
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

        // FIX FILME VECHI: data originala de release (release_date din TMDB, inainte de type3)
        // Daca filmul a fost lansat prima data in urma cu mai mult de 2 ani => exclus din NP
        // Exceptie: filmele din GUARANTEED_TMDB_IDS trec indiferent
        const originalReleaseDate = new Date(movie.release_date || detailData.release_date || '');
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

        if (!GUARANTEED_TMDB_IDS.includes(movie.id) &&
            !isNaN(originalReleaseDate.getTime()) &&
            originalReleaseDate < twoYearsAgo) {
            console.log(`[SKIP] ${movie.title} - original release too old: ${movie.release_date}`);
            return null;
        }

        const { bucket, cinemaDate } = resolveBucketAndDates(movie, detailData);
        if (!bucket || bucket === 'NONE') {
            console.log(`[SKIP] ${movie.title} - bucket NONE, release_date: ${movie.release_date}`);
            return null;
        }

        const vodInfo = calculateVOD(movie, detailData);
        console.log(`[OK] ${movie.title} | bucket=${bucket} | cinemaDate=${cinemaDate ? formatDateEU(cinemaDate) : 'N/A'} | pop=${movie.popularity} | origRelease=${movie.release_date}`);

        return { bucket, movie, detailData, imdbId, vodInfo, cinemaDate };
    } catch (err) {
        console.log(`[ERR] ${movie.id} - ${err.message}`);
        return null;
    }
}

async function fetchMovies(apiKey) {
    try {
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);

        const threeMonthsAgo  = new Date(todayMidnight.getTime() -  90 * 24 * 60 * 60 * 1000);
        // FIX: fereastra NP revenita la 9 luni (270 zile) dar cu filtrul de 2 ani pe release original
        const nineMonthsAgo   = new Date(todayMidnight.getTime() - 270 * 24 * 60 * 60 * 1000);
        const sixMonthsLater  = new Date(todayMidnight.getTime() + 180 * 24 * 60 * 60 * 1000);

        const todayStr      = todayMidnight.toISOString().split('T')[0];
        const sixMonthsStr  = sixMonthsLater.toISOString().split('T')[0];

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

        for (const tmdbId of GUARANTEED_TMDB_IDS) {
            if (!uniqueMoviesMap.has(tmdbId)) {
                console.log(`[GUARANTEED] Fetching forced: ${tmdbId}`);
                try {
                    const r = await fetch(`${TMDB_BASE_URL}/movie/${tmdbId}?api_key=${apiKey}&language=en-US`);
                    const d = await r.json();
                    if (d.id) {
                        uniqueMoviesMap.set(d.id, d);
                        console.log(`[GUARANTEED] Added: ${d.title} (pop=${d.popularity})`);
                    }
                } catch(e) {
                    console.log(`[GUARANTEED] Failed ${tmdbId}: ${e.message}`);
                }
            } else {
                console.log(`[GUARANTEED] Already in pool: ${uniqueMoviesMap.get(tmdbId).title}`);
            }
        }

        let masterList = Array.from(uniqueMoviesMap.values());
        console.log(`Total unique before filter: ${masterList.length}`);

        // Popularity >= 15 pentru toate, limba acceptata, garantatele trec
        masterList = masterList.filter(m => {
            if (GUARANTEED_TMDB_IDS.includes(m.id)) return true;
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

        // --- UPCOMING: 10 filme, iminente primele la selectie ---
        poolUP.sort((a, b) => a.cinemaDate.getTime() - b.cinemaDate.getTime());
        let finalUpcoming = [];
        for (const item of poolUP) {
            if (finalUpcoming.length === 10) break;
            if (!globalSeenIds.has(item.imdbId)) {
                globalSeenIds.add(item.imdbId);
                finalUpcoming.push(item);
            }
        }
        finalUpcoming.sort((a, b) => b.cinemaDate.getTime() - a.cinemaDate.getTime());
        console.log(`Final UP (${finalUpcoming.length}): ${finalUpcoming.map(x => x.movie.title).join(', ')}`);

        // --- NOW PLAYING: 30 filme ---
        let filteredNP = poolNP.filter(item => item.cinemaDate >= nineMonthsAgo);
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
        finalNowPlaying.sort((a, b) => b.vodInfo.sortDateObj.getTime() - a.vodInfo.sortDateObj.getTime());
        console.log(`Final NP (${finalNowPlaying.length}): ${finalNowPlaying.map(x => x.movie.title).join(', ')}`);

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
            const dateStr = formatDateEU(item.cinemaDate);
            const topText = encodeURIComponent(Buffer.from(`Upcoming | ${dateStr}`).toString('base64'));
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
