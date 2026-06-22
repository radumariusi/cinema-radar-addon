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
    version: "1.7.0",
    name: "Cinema Dates Radar",
    description: "Upcoming (10) + Now Playing (30) = 40 films. Sorted by digital release.",
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

function calculateVOD(movie, detailData, cinemaDate, bucket) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

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
    let adjustedCinemaDate = cinemaDate;
    let adjustedBucket = bucket;

    if (digitalDates.length > 0) {
        const pastDates   = digitalDates.filter(x => x.date <= today).sort((a, b) => b.date - a.date);
        const futureDates = digitalDates.filter(x => x.date > today).sort((a, b) => a.date - b.date);
        const chosen = pastDates.length > 0 ? pastDates[0] : futureDates[0];

        sortDateObj = chosen.date;
        if (chosen.type === 4) typeLabel = "VOD";
        else if (chosen.type === 5) typeLabel = "BluRay";
        else if (chosen.type === 6) typeLabel = "TV";
        chosenDateStr = formatDateEU(sortDateObj);

        // FIX 4: data digitala inainte de cinemaDate => cinemaDate = vodDate, re-eval bucket
        if (sortDateObj < cinemaDate) {
            adjustedCinemaDate = new Date(sortDateObj);
            adjustedCinemaDate.setHours(0, 0, 0, 0);
            adjustedBucket = adjustedCinemaDate < today ? 'NP' : 'UP';
            console.log(`[FIX4] ${movie.title}: cinemaDate ${formatDateEU(cinemaDate)} -> ${formatDateEU(adjustedCinemaDate)}, bucket ${bucket} -> ${adjustedBucket}`);
        }

    } else {
        isEstimated = true;
        typeLabel   = "EST";

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

        sortDateObj = new Date(cinemaDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));

        // FIX 3: EST in trecut pentru NP => recalculeaza de la azi
        if (bucket === 'NP' && sortDateObj < today) {
            console.log(`[FIX3] ${movie.title}: EST was in past (${formatDateEU(sortDateObj)}), recalculating from today`);
            sortDateObj = new Date(today.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));
        }

        chosenDateStr = getEstimatedPeriod(sortDateObj);
    }

    return { typeLabel, chosenDateStr, isEstimated, sortDateObj, adjustedCinemaDate, adjustedBucket };
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

        const originalReleaseDate = new Date(movie.release_date || detailData.release_date || '');
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        if (!isNaN(originalReleaseDate.getTime()) && originalReleaseDate < twoYearsAgo) {
            console.log(`[SKIP] ${movie.title} - too old: ${movie.release_date}`);
            return null;
        }

        const cinemaDateRaw = resolveCinemaDate(movie, detailData);
        if (!cinemaDateRaw) {
            console.log(`[SKIP] ${movie.title} - no valid cinemaDate`);
            return null;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const bucketRaw = cinemaDateRaw >= today ? 'UP' : 'NP';

        const vodInfo = calculateVOD(movie, detailData, cinemaDateRaw, bucketRaw);

        const finalBucket     = vodInfo.adjustedBucket;
        const finalCinemaDate = vodInfo.adjustedCinemaDate;

        console.log(`[OK] ${movie.title} | bucket=${finalBucket} | cinema=${formatDateEU(finalCinemaDate)} | ${vodInfo.typeLabel}:${vodInfo.chosenDateStr} | pop=${movie.popularity}`);

        return { bucket: finalBucket, movie, detailData, imdbId, vodInfo, cinemaDate: finalCinemaDate };
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
        const todayStr       = todayMidnight.toISOString().split('T')[0];
        const sixMonthsStr   = sixMonthsLater.toISOString().split('T')[0];

        console.log(`\n========== FETCH START ${new Date().toISOString()} ==========`);

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

        // --- UPCOMING: selectie 10 dupa vodSortDate iminent ---
        poolUP.sort((a, b) => a.vodInfo.sortDateObj.getTime() - b.vodInfo.sortDateObj.getTime());
        let finalUpcoming = [];
        for (const item of poolUP) {
            if (finalUpcoming.length === 10) break;
            if (!globalSeenIds.has(item.imdbId)) {
                globalSeenIds.add(item.imdbId);
                finalUpcoming.push(item);
            }
        }
        console.log(`Selected UP (${finalUpcoming.length}): ${finalUpcoming.map(x => x.movie.title).join(', ')}`);

        // --- NOW PLAYING: selectie 30 dupa popularitate ---
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
        console.log(`Selected NP (${finalNowPlaying.length}): ${finalNowPlaying.map(x => x.movie.title).join(', ')}`);

        // --- ASAMBLARE FINALA ---
        // Fiecare item primeste eticheta corecta bazata pe bucket-ul sau
        // Apoi lista combinata e sortata GLOBAL dupa vodSortDate descrescator
        // (cel mai indepartat in viitor = primul, cel mai departe in trecut = ultimul)

        // Adauga tag-ul de lista fiecarui item inainte de unire
        finalUpcoming.forEach(item => { item._listType = 'UP'; });
        finalNowPlaying.forEach(item => { item._listType = 'NP'; });

        const combined = [...finalUpcoming, ...finalNowPlaying];

        // Sortare globala descrescatoare dupa data digitala
        combined.sort((a, b) => b.vodInfo.sortDateObj.getTime() - a.vodInfo.sortDateObj.getTime());

        console.log(`Combined & sorted: ${combined.map(x => `[${x._listType}]${x.movie.title}(${x.vodInfo.typeLabel}:${x.vodInfo.chosenDateStr})`).join(', ')}`);

        // Genereaza posterele cu eticheta corecta pt fiecare item
        const finalMetas = combined.map(item => {
            let topTextRaw, botTextRaw;

            if (item._listType === 'UP') {
                // Upcoming: sus = "Upcoming | DD.MM.YYYY" (data cinema), jos = data digitala
                topTextRaw = `Upcoming | ${formatDateEU(item.cinemaDate)}`;
                botTextRaw = `${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`;
            } else {
                // Now Playing: sus = "In Cinema", jos = data digitala
                topTextRaw = `In Cinema`;
                botTextRaw = `${item.vodInfo.typeLabel}: ${item.vodInfo.chosenDateStr}`;
            }

            const topText   = encodeURIComponent(Buffer.from(topTextRaw).toString('base64'));
            const botText   = encodeURIComponent(Buffer.from(botTextRaw).toString('base64'));
            const transform = `?tr=l-text,ie-${topText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-top,l-end:l-text,ie-${botText},fs-45,co-FFFFFF,bg-00000099,w-500,pa-15,lfo-bottom,l-end`;

            return {
                id: item.imdbId,
                type: "movie",
                name: item.movie.title,
                poster: `https://ik.imagekit.io/${IMAGEKIT_ID}/tmdb/t/p/w500${item.movie.poster_path}${transform}`,
                description: item.movie.overview
            };
        });

        console.log(`========== TOTAL: ${finalUpcoming.length} UP + ${finalNowPlaying.length} NP = ${finalMetas.length} ==========\n`);

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
