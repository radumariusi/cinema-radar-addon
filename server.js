const express = require("express");
const path = require("path");
const Jimp = require("jimp"); // Am importat fabrica de imagini

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
    description: "VOD estimates stamped directly on posters.",
    resources: ["catalog"],
    types: ["movie"],
    catalogs: [{ type: "movie", id: "cinema_radar", name: "Cinema & VOD Releases" }],
    idPrefixes: ["tt"]
};

// --- ESTIMATOR ---
function getEstimateString(dateObj) {
    const day = dateObj.getDate();
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let period = "Late";
    if (day <= 10) period = "Early";
    else if (day <= 20) period = "Mid";
    return `${period} ${monthNames[dateObj.getMonth()]}`;
}

function calculateVOD(movie, detailData) {
    let validDates = [];
    const today = new Date();

    if (detailData.release_dates && detailData.release_dates.results) {
        for (const r of detailData.release_dates.results) {
            for (const release of r.release_dates) {
                if (release.type === 4 || release.type === 5 || release.type === 6) {
                    const releaseDate = new Date(release.release_date);
                    if (!isNaN(releaseDate.getTime())) validDates.push({ string: release.release_date.split("T")[0], date: releaseDate, type: release.type });
                }
            }
        }
    }

    let chosenDateStr = "", typeLabel = "", sortDateObj = null, isEstimated = false;

    if (validDates.length > 0) {
        validDates.sort((a, b) => Math.abs(a.date - today) - Math.abs(b.date - today));
        sortDateObj = validDates[0].date;
        chosenDateStr = validDates[0].string;
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
        chosenDateStr = getEstimateString(sortDateObj);
    }
    return { typeLabel, chosenDateStr, isEstimated, sortDateObj };
}

// --- GENERARE CATALOG ---
async function fetchMovies(apiKey, baseUrl) {
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
                const displayTitle = `[${vodInfo.typeLabel}: ${vodInfo.chosenDateStr}] ${movie.title}`;
                
                // GENERAREA LINK-ULUI PENTRU POSTERUL PERSONALIZAT
                const textToStamp = `${vodInfo.typeLabel}: ${vodInfo.chosenDateStr}`;
                const customPosterUrl = `${baseUrl}/poster/${encodeURIComponent(textToStamp)}/${encodeURIComponent(movie.poster_path)}`;

                return {
                    meta: {
                        id: imdbId,
                        type: "movie",
                        name: displayTitle,
                        poster: customPosterUrl, // Nuvio va cere poza de la noi, nu de la TMDB
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

        return processedMovies.map(item => item.meta);
    } catch (error) { return []; }
}

// --- FABRICA DE POSTERE (Ruta Nouă) ---
app.get("/poster/:text/:posterPath", async (req, res) => {
    try {
        const text = decodeURIComponent(req.params.text);
        const posterPath = decodeURIComponent(req.params.posterPath);
        const tmdbUrl = `https://image.tmdb.org/t/p/w500/${posterPath.replace(/^\//, '')}`;

        // Citim posterul original
        const image = await Jimp.read(tmdbUrl);
        // Încărcăm un font alb predefinit de mărime 32
        const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE); 

        // Desenăm banda neagră la baza posterului (w500 e 500x750 pixeli)
        const barHeight = 80;
        const bar = new Jimp(image.bitmap.width, barHeight, 0x000000CC); // Negru cu opacitate 80%
        image.blit(bar, 0, image.bitmap.height - barHeight);

        // Printăm textul pe acea bandă
        image.print(font, 0, image.bitmap.height - barHeight, {
            text: text,
            alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
            alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
        }, image.bitmap.width, barHeight);

        // Trimitem poza procesată înapoi către Nuvio
        const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        res.set("Content-Type", "image/jpeg");
        res.set("Cache-Control", "public, max-age=86400"); // Păstrează în memorie 24h să nu ceară de 100 de ori
        res.send(buffer);
    } catch (err) {
        // Dacă ceva eșuează la editare, îl trimitem la posterul original ca să nu apară ecran negru
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

    // Aflăm adresa exactă a serverului Koyeb pentru a ști unde să trimitem Nuvio după postere
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
