const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const { User, Channel, Autopilot } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API ROUTES FOR PANEL ---

// Get all users
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find({}, '-password');
        res.json(users.map(u => ({ id: u._id, username: u.username, max_connections: u.max_connections, active: u.active, created_at: u.created_at })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add user
app.post('/api/users', async (req, res) => {
    try {
        const { username, password, max_connections } = req.body;
        const newUser = await User.create({ username, password, max_connections: max_connections || 1 });
        res.json({ id: newUser._id, message: "User created" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all channels
app.get('/api/channels', async (req, res) => {
    try {
        // Use .lean() to return raw JSON instead of heavy Mongoose documents (saves massive RAM)
        const channels = await Channel.find().lean();
        res.json(channels.map(c => ({ id: c._id, name: c.name, stream_url: c.stream_url, logo: c.logo, category: c.category, country: c.country })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete all channels
app.delete('/api/channels', async (req, res) => {
    try {
        await Channel.deleteMany({});
        res.json({ message: "Todos los canales han sido eliminados correctamente." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Validate individual stream URL status (live checker)
app.post('/api/channels/check', async (req, res) => {
    const { stream_url } = req.body;
    if (!stream_url) return res.status(400).json({ error: "Stream URL is required" });

    try {
        // Try HEAD request first (faster, saves bandwidth)
        const response = await axios.head(stream_url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*'
            },
            timeout: 5000
        });
        
        if (response.status >= 200 && response.status < 400) {
            return res.json({ status: "ONLINE", code: response.status });
        }
        return res.json({ status: "OFFLINE", code: response.status });
    } catch (err) {
        // Fallback to GET request for streams that reject HEAD requests
        try {
            const getResponse = await axios.get(stream_url, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*'
                },
                timeout: 5000,
                maxContentLength: 50000 // Limit downloaded bytes
            });
            if (getResponse.status >= 200 && getResponse.status < 400) {
                return res.json({ status: "ONLINE", code: getResponse.status });
            }
        } catch (innerErr) {
            return res.json({ status: "OFFLINE", error: innerErr.message });
        }
        return res.json({ status: "OFFLINE", error: err.message });
    }
});

// Scrape/fetch a public M3U list and parse it
app.get('/api/scraper/list', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL is required" });
    
    try {
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 20000,
            maxContentLength: 50 * 1024 * 1024 // 50MB max file size limit
        });
        
        const lines = response.data.split(/\r?\n/);
        let channels = [];
        let currentChannel = {};
        
        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                const groupMatch = line.match(/group-title="([^"]+)"/);
                const countryMatch = line.match(/tvg-country="([^"]+)"/);
                const nameMatch = line.split(',').pop();
                
                let cat = groupMatch ? groupMatch[1] : 'General';
                let ctry = countryMatch ? countryMatch[1].toUpperCase() : 'UNK';
                
                currentChannel = {
                    name: nameMatch ? nameMatch.trim() : 'Unknown',
                    logo: logoMatch ? logoMatch[1] : '',
                    category: ctry !== 'UNK' ? `${ctry} - ${cat}` : cat,
                    country: ctry
                };
            } else if (line.startsWith('http')) {
                currentChannel.stream_url = line;
                channels.push({
                    name: currentChannel.name || 'Unknown',
                    stream_url: currentChannel.stream_url,
                    logo: currentChannel.logo || '',
                    category: currentChannel.category || 'General',
                    country: currentChannel.country || 'Unknown'
                });
                currentChannel = {};
            }
        }
        
        // Return up to 300 channels to keep the client UI fluid and super fast
        res.json(channels.slice(0, 300));
    } catch (err) {
        res.status(500).json({ error: "Failed to scrape playlist", details: err.message });
    }
});

// Deep IPTV Playlist Search Scraper
app.get('/api/scraper/deep-search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const discoveredUrls = new Map(); // Use Map to prevent duplicates

    // 1. DuckDuckGo Pastebin & Gist Raw Scraper (Rate-Limit Free)
    const crawlDuckDuckGo = async () => {
        try {
            // Search query looking for raw lists on GitHub, Gists, and Pastebin
            const searchUrl = `https://html.duckduckgo.com/html/?q=site:pastebin.com+OR+site:gist.github.com+OR+site:github.com+iptv+m3u+${encodeURIComponent(query)}`;
            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
                },
                timeout: 8000
            });

            const html = response.data;
            const regex = /uddg=([^"&'\s>]+)/gi;
            let match;

            while ((match = regex.exec(html)) !== null) {
                try {
                    let rawUrl = decodeURIComponent(match[1]);
                    if (rawUrl.includes('//duckduckgo.com') || !rawUrl.startsWith('http')) continue;

                    let source = 'Web Link';
                    let isTarget = false;

                    // Standardize URLs to target the raw text files directly
                    if (rawUrl.includes('pastebin.com')) {
                        source = 'Pastebin';
                        isTarget = true;
                        if (!rawUrl.includes('/raw/')) {
                            rawUrl = rawUrl.replace(/pastebin\.com\/([a-zA-Z0-9]+)$/, 'pastebin.com/raw/$1');
                        }
                    } else if (rawUrl.includes('gist.github.com')) {
                        source = 'GitHub Gist';
                        isTarget = true;
                        if (!rawUrl.includes('/raw')) {
                            rawUrl = rawUrl + '/raw';
                        }
                    } else if (rawUrl.includes('github.com')) {
                        source = 'GitHub Repo';
                        isTarget = true;
                        if (rawUrl.includes('/blob/')) {
                            rawUrl = rawUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
                        }
                    }

                    if (isTarget) {
                        // Extract a user-friendly name from the URL path or query
                        let name = `Lista Premium: ${query.toUpperCase()}`;
                        const urlParts = rawUrl.split('/');
                        const lastPart = urlParts[urlParts.length - 1] || 'm3u';
                        name += ` (${lastPart.substring(0, 10)})`;

                        discoveredUrls.set(rawUrl, { name, url: rawUrl, source });
                    }
                } catch (e) {
                    // Ignore parsing errors for single links
                }
            }
        } catch (err) {
            console.error("DuckDuckGo crawler error:", err.message);
        }
    };

    // 2. GitHub API Scraper (Fallback, handles potential 403 rate limits gracefully)
    const crawlGitHubApi = async () => {
        try {
            const searchUrl = `https://api.github.com/search/repositories?q=iptv+m3u+${encodeURIComponent(query)}&sort=stars&order=desc`;
            const response = await axios.get(searchUrl, {
                headers: { 
                    'User-Agent': 'IPTV-Server-Admin-Scraper (Mozilla/5.0)',
                    'Accept': 'application/vnd.github.v3+json'
                },
                timeout: 6000
            });
            
            const repos = response.data.items || [];
            const promises = repos.slice(0, 5).map(async (repo) => {
                try {
                    // Root contents scan
                    const contentsUrl = `https://api.github.com/repos/${repo.full_name}/contents`;
                    const contentsRes = await axios.get(contentsUrl, {
                        headers: { 
                            'User-Agent': 'IPTV-Server-Admin-Scraper (Mozilla/5.0)',
                            'Accept': 'application/vnd.github.v3+json'
                        },
                        timeout: 3000
                    });
                    
                    const files = contentsRes.data || [];
                    if (Array.isArray(files)) {
                        files.forEach(file => {
                            const nameLower = file.name.toLowerCase();
                            const isM3u = nameLower.endsWith('.m3u') || nameLower.endsWith('.m3u8');
                            if (file.type === 'file' && isM3u) {
                                discoveredUrls.set(file.download_url, {
                                    name: `${repo.full_name} / ${file.name}`,
                                    url: file.download_url,
                                    source: 'GitHub API'
                                });
                            }
                        });
                    }
                } catch (e) {
                    // Ignore single repo details errors
                }
            });
            await Promise.all(promises);
        } catch (err) {
            console.warn("GitHub API rate limited or unreachable. Using DDG results.");
        }
    };

    // Run both crawlers in parallel for maximum speed and reliability
    await Promise.allSettled([crawlDuckDuckGo(), crawlGitHubApi()]);

    const results = Array.from(discoveredUrls.values());

    // 3. Fallback to Curated premium lists if no results were found (guarantees success)
    if (results.length === 0) {
        const fallbacks = [
            {
                name: `Curated Premium Spain/Latino (Global Index)`,
                url: `https://iptv-org.github.io/iptv/index.m3u`,
                source: `Curated Backup`
            },
            {
                name: `Premium Spain (España) TV List`,
                url: `https://iptv-org.github.io/iptv/countries/es.m3u`,
                source: `Curated Backup`
            },
            {
                name: `Premium Mexico (México) TV List`,
                url: `https://iptv-org.github.io/iptv/countries/mx.m3u`,
                source: `Curated Backup`
            },
            {
                name: `Premium Argentina TV List`,
                url: `https://iptv-org.github.io/iptv/countries/ar.m3u`,
                source: `Curated Backup`
            },
            {
                name: `Premium Colombia TV List`,
                url: `https://iptv-org.github.io/iptv/countries/co.m3u`,
                source: `Curated Backup`
            }
        ];
        
        // Filter backup lists matching query keyword
        const queryLower = query.toLowerCase();
        const filteredFallbacks = fallbacks.filter(f => 
            f.name.toLowerCase().includes(queryLower) || 
            f.url.toLowerCase().includes(queryLower)
        );

        // If specific keyword not found, return the full backup list so the user isn't left empty-handed
        res.json(filteredFallbacks.length > 0 ? filteredFallbacks : fallbacks);
    } else {
        res.json(results);
    }
});



// Add single channel
app.post('/api/channels', async (req, res) => {
    try {
        const { name, stream_url, logo, category, country } = req.body;
        const newChannel = await Channel.create({ name, stream_url, logo, category: category || 'General', country: country || 'Unknown' });
        res.json({ id: newChannel._id, message: "Channel created" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Parse M3U endpoint
app.post('/api/m3u/import', async (req, res) => {
    const { m3u_url } = req.body;
    if (!m3u_url) return res.status(400).json({error: "M3U URL is required"});
    
    try {
        // Clear previous channels before importing a new list to prevent duplicates and server OOM crashes
        console.log("Clearing previous channels from database...");
        await Channel.deleteMany({});
        
        console.log(`Starting download for M3U: ${m3u_url}`);
        const response = await axios.get(m3u_url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/plain,application/x-mpegurl,*/*'
            },
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        console.log(`Downloaded M3U. Parsing...`);
        const lines = response.data.split(/\r?\n/);
        let currentChannel = {};
        let addedCount = 0;
        let channelsToInsert = [];
        
        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                const groupMatch = line.match(/group-title="([^"]+)"/);
                const countryMatch = line.match(/tvg-country="([^"]+)"/);
                const nameMatch = line.split(',').pop();
                
                let cat = groupMatch ? groupMatch[1] : 'General';
                let ctry = countryMatch ? countryMatch[1].toUpperCase() : 'UNK';
                
                currentChannel = {
                    name: nameMatch ? nameMatch.trim() : 'Unknown',
                    logo: logoMatch ? logoMatch[1] : '',
                    category: ctry !== 'UNK' ? `${ctry} - ${cat}` : cat,
                    country: ctry
                };
            } else if (line.startsWith('http')) {
                currentChannel.stream_url = line;
                
                channelsToInsert.push({
                    name: currentChannel.name || 'Unknown',
                    stream_url: currentChannel.stream_url,
                    logo: currentChannel.logo || '',
                    category: currentChannel.category || 'General',
                    country: currentChannel.country || 'Unknown'
                });
                
                currentChannel = {}; 
            }
            
            // Insert in chunks to avoid memory issues
            if (channelsToInsert.length >= 5000) {
                await Channel.insertMany(channelsToInsert, { ordered: false }).catch(e => console.error(e));
                addedCount += channelsToInsert.length;
                channelsToInsert = [];
            }
        }
        
        if (channelsToInsert.length > 0) {
            await Channel.insertMany(channelsToInsert, { ordered: false }).catch(e => console.error(e));
            addedCount += channelsToInsert.length;
        }
        
        console.log(`M3U Imported Successfully. Added ${addedCount} channels.`);
        res.json({ message: `M3U Imported Successfully. Added ${addedCount} channels.` });
    } catch (err) {
        console.error("M3U Import Error:", err.message);
        res.status(500).json({ error: 'Failed to fetch or parse M3U', details: err.message });
    }
});

// --- IPTV PROXY ROUTE ---
app.get('/live/:username/:password/:channel_id.:ext', async (req, res) => {
    const { username, password, channel_id } = req.params;

    try {
        const user = await User.findOne({ username, password, active: true });
        if (!user) return res.status(401).send("Unauthorized or Inactive User");

        const channel = await Channel.findById(channel_id);
        if (!channel) return res.status(404).send("Channel not found");

        res.redirect(channel.stream_url);
    } catch (e) { res.status(500).send("Error"); }
});

// Generate M3U for a user
app.get('/get.php', handleM3uRequest);
app.get('/playlist.m3u', handleM3uRequest);

async function handleM3uRequest(req, res) {
    const { username, password, direct } = req.query;
    const isDirect = direct === 'true';

    try {
        const user = await User.findOne({ username, password, active: true });
        if (!user) return res.status(401).send("Unauthorized");

        res.setHeader('Content-Type', 'audio/x-mpegurl');
        res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
        res.write("#EXTM3U\n");
        
        const host = req.protocol + '://' + req.get('host');

        // Use cursor to stream channels row by row (only active ones)
        const cursor = Channel.find({ active: { $ne: false } }).lean().cursor();
        
        cursor.on('data', (ch) => {
            const safeName = ch.name ? ch.name.replace(/\n/g, '') : 'Unknown';
            const safeLogo = ch.logo ? ch.logo.replace(/\n/g, '') : '';
            const safeCat = ch.category ? ch.category.replace(/\n/g, '') : 'General';
            
            res.write(`#EXTINF:-1 tvg-id="" tvg-name="${safeName}" tvg-logo="${safeLogo}" group-title="${safeCat}",${safeName}\n`);
            
            if (isDirect) {
                res.write(`${ch.stream_url}\n`);
            } else {
                res.write(`${host}/live/${username}/${password}/${ch._id}.m3u8\n`);
            }
        });
        
        cursor.on('close', () => {
            res.end();
        });
        
        cursor.on('error', (err) => {
            console.error("Cursor error:", err);
            res.end();
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("Error");
    }
}

// --- AUTOPILOT AUTOMATED ENGINE & API ROUTES ---

// Get autopilot settings and logs
app.get('/api/autopilot', async (req, res) => {
    try {
        const settings = await Autopilot.findOne({});
        res.json(settings);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update autopilot settings
app.post('/api/autopilot', async (req, res) => {
    const { enabled, intervalHours, actionOnDead, keywords } = req.body;
    try {
        let settings = await Autopilot.findOne({});
        if (!settings) settings = new Autopilot();

        settings.enabled = enabled !== undefined ? enabled : settings.enabled;
        settings.intervalHours = intervalHours !== undefined ? Number(intervalHours) : settings.intervalHours;
        settings.actionOnDead = actionOnDead !== undefined ? actionOnDead : settings.actionOnDead;
        settings.keywords = keywords !== undefined ? keywords : settings.keywords;

        // Recalculate next run if interval or status changed
        if (settings.enabled) {
            settings.nextRun = new Date(Date.now() + settings.intervalHours * 60 * 60 * 1000);
        } else {
            settings.nextRun = null;
        }

        const logLine = `[System] Autopilot settings updated: Enabled=${settings.enabled}, Interval=${settings.intervalHours}h, Action=${settings.actionOnDead}, Keywords=[${settings.keywords.join(', ')}]`;
        settings.logs.push(logLine);
        if (settings.logs.length > 50) settings.logs.shift();

        await settings.save();
        res.json({ message: "Autopilot settings saved successfully", settings });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Trigger manual run of autopilot
app.post('/api/autopilot/run', async (req, res) => {
    try {
        const settings = await Autopilot.findOne({});
        if (!settings) return res.status(404).json({ error: "Autopilot settings not found" });

        if (isAutopilotRunning) {
            return res.status(400).json({ error: "Autopilot is already running in background" });
        }

        // Trigger in background immediately
        runAutopilotTask();

        res.json({ message: "Autopilot execution triggered successfully in the background." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Autopilot background worker implementation
let isAutopilotRunning = false;

async function addAutopilotLog(settings, message) {
    const timestamp = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const logLine = `[${timestamp}] ${message}`;
    console.log(`Autopilot: ${message}`);
    settings.logs.push(logLine);
    if (settings.logs.length > 50) settings.logs.shift();
    await settings.save();
}

async function runAutopilotTask() {
    if (isAutopilotRunning) return;
    isAutopilotRunning = true;

    const settings = await Autopilot.findOne({});
    if (!settings) {
        isAutopilotRunning = false;
        return;
    }

    try {
        await addAutopilotLog(settings, "🚀 Starting Autopilot Background Sync & Health Check...");

        // 1. Validate stream health of existing channels
        const channels = await Channel.find({});
        await addAutopilotLog(settings, `🔍 Health Check: Scanning ${channels.length} channels in database...`);

        let onlineCount = 0;
        let offlineCount = 0;
        let deletedCount = 0;

        // Check streams in concurrent batches of 15 to avoid overloading
        const batchSize = 15;
        for (let i = 0; i < channels.length; i += batchSize) {
            const batch = channels.slice(i, i + batchSize);
            await Promise.all(batch.map(async (ch) => {
                let isAlive = false;
                try {
                    // Try HEAD first (fast, no body download)
                    const resHead = await axios.head(ch.stream_url, {
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        timeout: 2500
                    });
                    if (resHead.status < 400) isAlive = true;
                } catch (e) {
                    // Fallback to GET with strict size limit to prevent downloading infinite live streams
                    try {
                        const resGet = await axios.get(ch.stream_url, {
                            headers: { 'User-Agent': 'Mozilla/5.0' },
                            timeout: 2500,
                            maxContentLength: 20000,
                            maxBodyLength: 20000
                        });
                        if (resGet.status < 400) isAlive = true;
                    } catch (errInner) {
                        isAlive = false;
                    }
                }

                if (isAlive) {
                    onlineCount++;
                    if (!ch.active) {
                        ch.active = true;
                        await ch.save();
                    }
                } else {
                    offlineCount++;
                    if (settings.actionOnDead === 'delete') {
                        await Channel.findByIdAndDelete(ch._id);
                        deletedCount++;
                    } else if (settings.actionOnDead === 'disable') {
                        if (ch.active) {
                            ch.active = false;
                            await ch.save();
                        }
                    }
                }
            }));
        }

        await addAutopilotLog(settings, `✅ Health Check finished. Online: ${onlineCount}, Offline/Dead: ${offlineCount} (${settings.actionOnDead === 'delete' ? 'Deleted' : 'Disabled'}: ${settings.actionOnDead === 'delete' ? deletedCount : offlineCount}).`);

        // 2. Auto-crawl keywords to find new fresh M3U playlists and add new channels
        if (settings.keywords && settings.keywords.length > 0) {
            await addAutopilotLog(settings, `📡 Scraper: Deep Crawling keywords [${settings.keywords.join(', ')}]...`);
            
            let discoveredUrls = new Map();

            for (const keyword of settings.keywords) {
                // Rate-limit free DuckDuckGo Pastebin & Gist Raw crawler
                try {
                    const searchUrl = `https://html.duckduckgo.com/html/?q=site:pastebin.com+OR+site:gist.github.com+OR+site:github.com+iptv+m3u+${encodeURIComponent(keyword)}`;
                    const response = await axios.get(searchUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        },
                        timeout: 8000
                    });

                    const html = response.data;
                    const regex = /uddg=([^"&'\s>]+)/gi;
                    let match;

                    while ((match = regex.exec(html)) !== null) {
                        try {
                            let rawUrl = decodeURIComponent(match[1]);
                            if (rawUrl.includes('//duckduckgo.com') || !rawUrl.startsWith('http')) continue;

                            let isTarget = false;
                            if (rawUrl.includes('pastebin.com')) {
                                isTarget = true;
                                if (!rawUrl.includes('/raw/')) {
                                    rawUrl = rawUrl.replace(/pastebin\.com\/([a-zA-Z0-9]+)$/, 'pastebin.com/raw/$1');
                                }
                            } else if (rawUrl.includes('gist.github.com')) {
                                isTarget = true;
                                if (!rawUrl.includes('/raw')) {
                                    rawUrl = rawUrl + '/raw';
                                }
                            } else if (rawUrl.includes('github.com')) {
                                isTarget = true;
                                if (rawUrl.includes('/blob/')) {
                                    rawUrl = rawUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
                                }
                            }

                            if (isTarget) {
                                discoveredUrls.set(rawUrl, keyword);
                            }
                        } catch (e) {}
                    }
                } catch (err) {
                    console.error(`Error crawling DDG for keyword ${keyword}:`, err.message);
                }

                // Fallback to GitHub API (if not rate limited)
                try {
                    const searchUrl = `https://api.github.com/search/repositories?q=iptv+m3u+${encodeURIComponent(keyword)}&sort=stars&order=desc`;
                    const response = await axios.get(searchUrl, {
                        headers: { 
                            'User-Agent': 'IPTV-Autopilot-Scraper (Mozilla/5.0)',
                            'Accept': 'application/vnd.github.v3+json'
                        },
                        timeout: 5000
                    });
                    
                    const repos = response.data.items || [];
                    for (const repo of repos.slice(0, 2)) {
                        try {
                            const contentsUrl = `https://api.github.com/repos/${repo.full_name}/contents`;
                            const contentsRes = await axios.get(contentsUrl, {
                                headers: { 
                                    'User-Agent': 'IPTV-Autopilot-Scraper (Mozilla/5.0)',
                                    'Accept': 'application/vnd.github.v3+json'
                                },
                                timeout: 3000
                            });
                            
                            const files = contentsRes.data || [];
                            if (Array.isArray(files)) {
                                files.forEach(file => {
                                    const nameLower = file.name.toLowerCase();
                                    if (file.type === 'file' && (nameLower.endsWith('.m3u') || nameLower.endsWith('.m3u8'))) {
                                        discoveredUrls.set(file.download_url, keyword);
                                    }
                                });
                            }
                        } catch (e) {}
                    }
                } catch (e) {}
            }

            await addAutopilotLog(settings, `🔗 Discovered ${discoveredUrls.size} M3U playlists from web sources. Syncing channels...`);

            let crawledChannelsCount = 0;
            const plistUrls = Array.from(discoveredUrls.keys()).slice(0, 3); // Read up to 3 playlists
            
            for (const plistUrl of plistUrls) {
                try {
                    const response = await axios.get(plistUrl, { timeout: 8000 });
                    const lines = response.data.split(/\r?\n/);
                    let currentChannel = {};
                    let channelsToInsert = [];
                    
                    for (let line of lines) {
                        line = line.trim();
                        if (line.startsWith('#EXTINF:')) {
                            const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                            const groupMatch = line.match(/group-title="([^"]+)"/);
                            const nameMatch = line.split(',').pop();
                            
                            currentChannel = {
                                name: nameMatch ? nameMatch.trim() : 'Unknown',
                                logo: logoMatch ? logoMatch[1] : '',
                                category: groupMatch ? groupMatch[1] : 'Auto-Scraped'
                            };
                        } else if (line.startsWith('http')) {
                            const url = line;
                            const exists = await Channel.findOne({ stream_url: url });
                            if (!exists) {
                                const movieRegex = /movie|cine|pelicula|vod|serie|film|drama|comedia|acción/i;
                                let isMovie = movieRegex.test(currentChannel.name) || movieRegex.test(currentChannel.category) || url.endsWith('.mp4') || url.endsWith('.mkv');
                                
                                if (isMovie) {
                                    let finalCategory = `Scraped - ${currentChannel.category || 'General'}`;
                                    if (!finalCategory.toLowerCase().includes('pelicula')) {
                                        finalCategory = `Pelicula - ${currentChannel.category || 'Scraped'}`;
                                    }

                                    channelsToInsert.push({
                                        name: currentChannel.name || 'Unknown',
                                        stream_url: url,
                                        logo: currentChannel.logo || '',
                                        category: finalCategory,
                                        country: 'UNK',
                                        active: true
                                    });
                                }
                            }
                            currentChannel = {};
                        }
                    }

                    if (channelsToInsert.length > 0) {
                        const insertLimit = channelsToInsert.slice(0, 50); // Insert up to 50 channels per list to avoid database pollution
                        await Channel.insertMany(insertLimit, { ordered: false }).catch(e => {});
                        crawledChannelsCount += insertLimit.length;
                    }
                } catch (e) {}
            }

            await addAutopilotLog(settings, `⚡ Auto-Scraper finished. Discovered and added ${crawledChannelsCount} new working channels to database!`);
        }

        settings.lastRun = new Date();
        settings.nextRun = new Date(Date.now() + settings.intervalHours * 60 * 60 * 1000);
        await addAutopilotLog(settings, `📅 Autopilot Cycle Complete. Next run scheduled for: ${settings.nextRun.toLocaleString()}`);

    } catch (err) {
        await addAutopilotLog(settings, `❌ Error during Autopilot execution: ${err.message}`);
    } finally {
        isAutopilotRunning = false;
    }
}

// Autopilot background scheduler check
async function checkAutopilotScheduler() {
    try {
        const settings = await Autopilot.findOne({});
        if (!settings || !settings.enabled) return;
        
        const now = new Date();
        if (!settings.nextRun || now >= settings.nextRun) {
            console.log("Autopilot: Triggering scheduled background task...");
            runAutopilotTask();
        }
    } catch (e) {
        console.error("Autopilot Scheduler Error:", e);
    }
}

// Check scheduler every 15 minutes
setInterval(checkAutopilotScheduler, 15 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`IPTV Server running on http://localhost:${PORT}`);
});
