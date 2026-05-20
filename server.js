const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const { User, Channel, Autopilot } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
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

    // 1. Scraping Yahoo Search to find Pastebin, Gist, and GitHub links (rate-limit free and captcha-free)
    const crawlYahoo = async () => {
        try {
            const yahooUrl = `https://search.yahoo.com/search?p=site:github.com+OR+site:pastebin.com+OR+site:gist.github.com+iptv+m3u+${encodeURIComponent(query)}`;
            const response = await axios.get(yahooUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
                },
                timeout: 8000
            });

            const html = response.data;
            const regex = /href="[^"]*r\.search\.yahoo\.com[^"]*RU=([^"&'\s]+)/gi;
            let match;
            const targetLinks = [];

            while ((match = regex.exec(html)) !== null) {
                try {
                    let decodedUrl = decodeURIComponent(match[1]);
                    decodedUrl = decodedUrl.replace(/\/RK=2\/RS=.+$/, '');
                    decodedUrl = decodedUrl.replace(/\/$/, '');

                    const urlObj = new URL(decodedUrl);
                    const hostname = urlObj.hostname;

                    // Ensure it is a real target and not a Yahoo self-reference containing github in a query parameter
                    if (hostname.includes('github.com') || hostname.includes('pastebin.com') || hostname.includes('raw.githubusercontent.com')) {
                        targetLinks.push({ url: decodedUrl, hostname });
                    }
                } catch (e) {
                    // Ignore single link issues
                }
            }

            // Process discovered target URLs and resolve standard URLs to raw file URLs
            for (const item of targetLinks) {
                const { url, hostname } = item;
                
                if (hostname.includes('pastebin.com')) {
                    let rawUrl = url;
                    if (!url.includes('/raw/')) {
                        rawUrl = url.replace(/pastebin\.com\/([a-zA-Z0-9]+)$/, 'pastebin.com/raw/$1');
                    }
                    const parts = url.split('/');
                    const id = parts[parts.length - 1] || 'list';
                    discoveredUrls.set(rawUrl, {
                        name: `Pastebin: ${id.substring(0, 10)}`,
                        url: rawUrl,
                        source: 'Pastebin'
                    });
                } 
                else if (hostname.includes('gist.github.com')) {
                    let rawUrl = url;
                    if (!url.includes('/raw')) {
                        rawUrl = url + '/raw';
                    }
                    const parts = url.split('/');
                    const id = parts[parts.length - 1] || 'gist';
                    discoveredUrls.set(rawUrl, {
                        name: `GitHub Gist (${id.substring(0, 10)})`,
                        url: rawUrl,
                        source: 'GitHub Gist'
                    });
                } 
                else if (hostname.includes('github.com')) {
                    if (url.includes('/blob/')) {
                        // Direct file link conversion
                        const rawUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
                        const parts = url.split('/');
                        const filename = parts[parts.length - 1] || 'playlist.m3u';
                        discoveredUrls.set(rawUrl, {
                            name: `GitHub File: ${filename}`,
                            url: rawUrl,
                            source: 'GitHub File'
                        });
                    } else if (!url.includes('/tree/') && !url.includes('/releases/') && !url.includes('/pulse') && !url.includes('/issues') && !url.includes('/pulls')) {
                        // GitHub Repository page scraping
                        try {
                            const repoRes = await axios.get(url, {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                                },
                                timeout: 4000
                            });
                            
                            const repoHtml = repoRes.data;
                            // Regex to find .m3u/m3u8 blob files inside Github HTML
                            const m3uRegex = /\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/blob\/[a-zA-Z0-9_./-]+\.m3u8?)/gi;
                            let m3uMatch;
                            
                            while ((m3uMatch = m3uRegex.exec(repoHtml)) !== null) {
                                const relativePath = m3uMatch[1];
                                const fullUrl = `https://github.com/${relativePath}`;
                                const rawUrl = fullUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
                                const parts = relativePath.split('/');
                                const filename = parts[parts.length - 1];
                                const repoName = `${parts[0]}/${parts[1]}`;
                                
                                discoveredUrls.set(rawUrl, {
                                    name: `${repoName} - ${filename}`,
                                    url: rawUrl,
                                    source: 'GitHub Repo'
                                });
                            }
                        } catch (err) {
                            // Suppress individual repo scraping errors
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Yahoo deep-search scraping error:", err.message);
        }
    };

    // 2. Fallback unauthenticated GitHub API search (only search repos, but skip contents scanning to protect rate limits)
    const crawlGitHubApi = async () => {
        try {
            const searchUrl = `https://api.github.com/search/repositories?q=iptv+m3u+${encodeURIComponent(query)}&sort=stars&order=desc`;
            const response = await axios.get(searchUrl, {
                headers: { 
                    'User-Agent': 'IPTV-Server-Admin-Scraper (Mozilla/5.0)',
                    'Accept': 'application/vnd.github.v3+json'
                },
                timeout: 5000
            });
            
            const repos = response.data.items || [];
            repos.slice(0, 3).forEach(repo => {
                // We guess common raw file targets for this repository!
                const commonPaths = ['playlist.m3u', 'playlist.m3u8', 'iptv.m3u', 'iptv.m3u8', 'channels.m3u'];
                commonPaths.forEach(path => {
                    const rawUrlMain = `https://raw.githubusercontent.com/${repo.full_name}/main/${path}`;
                    const rawUrlMaster = `https://raw.githubusercontent.com/${repo.full_name}/master/${path}`;
                    
                    discoveredUrls.set(rawUrlMain, {
                        name: `${repo.full_name} / ${path} (main)`,
                        url: rawUrlMain,
                        source: 'GitHub API (Guess)'
                    });
                    discoveredUrls.set(rawUrlMaster, {
                        name: `${repo.full_name} / ${path} (master)`,
                        url: rawUrlMaster,
                        source: 'GitHub API (Guess)'
                    });
                });
            });
        } catch (err) {
            // Ignore API rate limiting issues gracefully
        }
    };

    // Run both crawlers in parallel
    await Promise.allSettled([crawlYahoo(), crawlGitHubApi()]);

    const results = Array.from(discoveredUrls.values());

    // 3. Fallback to Curated premium lists if no results were found
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
        
        const queryLower = query.toLowerCase();
        const filteredFallbacks = fallbacks.filter(f => 
            f.name.toLowerCase().includes(queryLower) || 
            f.url.toLowerCase().includes(queryLower)
        );

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
    const { m3u_url, keep_existing } = req.body;
    if (!m3u_url) return res.status(400).json({error: "M3U URL is required"});
    
    try {
        // Clear previous channels if keep_existing is not true to prevent duplicates and server OOM crashes
        if (!keep_existing) {
            console.log("Clearing previous channels from database...");
            await Channel.deleteMany({});
        } else {
            console.log("Keeping previous channels in database (appending)...");
        }
        
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

// Parse M3U text endpoint (for local file upload)
app.post('/api/m3u/import-text', async (req, res) => {
    const { m3u_text, keep_existing } = req.body;
    if (!m3u_text) return res.status(400).json({error: "M3U text is required"});
    
    try {
        // Clear previous channels if keep_existing is not true to prevent duplicates and server OOM crashes
        if (!keep_existing) {
            console.log("Clearing previous channels from database...");
            await Channel.deleteMany({});
        } else {
            console.log("Keeping previous channels in database (appending)...");
        }
        
        console.log(`Parsing uploaded M3U text...`);
        const lines = m3u_text.split(/\r?\n/);
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
        
        console.log(`M3U Text Upload Imported Successfully. Added ${addedCount} channels.`);
        res.json({ message: `M3U Text Upload Imported Successfully. Added ${addedCount} channels.` });
    } catch (err) {
        console.error("M3U Text Import Error:", err.message);
        res.status(500).json({ error: 'Failed to parse M3U text', details: err.message });
    }
});

// Extract VOD channels from any M3U URL (utility download endpoint)
app.get('/api/m3u/extract-vod', async (req, res) => {
    const { url, keyword } = req.query;
    if (!url) return res.status(400).send("URL is required");

    try {
        console.log(`Extracting VOD from: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        const lines = response.data.split(/\r?\n/);
        let currentChannel = {};
        let vodChannels = [];
        const kwLower = keyword ? keyword.toLowerCase().trim() : null;

        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('#EXTINF:')) {
                const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                const groupMatch = line.match(/group-title="([^"]+)"/);
                const nameMatch = line.split(',').pop();
                
                let cat = groupMatch ? groupMatch[1] : 'General';
                
                currentChannel = {
                    name: nameMatch ? nameMatch.trim() : 'Unknown',
                    logo: logoMatch ? logoMatch[1] : '',
                    category: cat
                };
            } else if (line.startsWith('http')) {
                const streamUrl = line;
                const ch = {
                    name: currentChannel.name || 'Unknown',
                    stream_url: streamUrl,
                    logo: currentChannel.logo || '',
                    category: currentChannel.category || 'General'
                };

                // Check if it is a VOD channel
                if (isVODChannel(ch, true)) {
                    // Apply keyword filter if provided (e.g. 'estrenos')
                    if (kwLower) {
                        const nameLower = ch.name.toLowerCase();
                        const catLower = ch.category.toLowerCase();
                        if (nameLower.includes(kwLower) || catLower.includes(kwLower)) {
                            vodChannels.push(ch);
                        }
                    } else {
                        vodChannels.push(ch);
                    }
                }
                currentChannel = {};
            }
        }

        // Generate M3U output
        res.setHeader('Content-Type', 'audio/x-mpegurl');
        res.setHeader('Content-Disposition', `attachment; filename="vod_extracted${keyword ? '_' + keyword : ''}.m3u"`);
        
        res.write("#EXTM3U\n");
        vodChannels.forEach(ch => {
            res.write(`#EXTINF:-1 tvg-logo="${ch.logo}" group-title="${ch.category}",${ch.name}\n`);
            res.write(`${ch.stream_url}\n`);
        });
        res.end();

    } catch (err) {
        console.error("VOD extraction error:", err.message);
        res.status(500).send("Error extracting VOD: " + err.message);
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

// Helper to precisely detect VOD (movies & series) channels, keeping Live TV untouched
function isVODChannel(ch, isScrapePhase = false) {
    if (!ch) return false;
    const name = (ch.name || '').toLowerCase();
    const cat = (ch.category || '').toLowerCase();
    const url = (ch.stream_url || '').toLowerCase();

    // 1. Static video file extensions are 100% VOD
    if (url.endsWith('.mp4') || url.endsWith('.mkv') || url.endsWith('.avi') || url.endsWith('.mov') || url.endsWith('.webm')) {
        return true;
    }

    // 2. Xtream Codes VOD URL paths (standard for IPTV movies/series)
    if ((url.includes('/movie/') || url.includes('/movies/') || url.includes('/series/') || url.includes('/vod/')) && !url.includes('/live/')) {
        return true;
    }

    // 3. Category prefixes specifically added by the scraper
    if (cat.startsWith('scraped -') || cat.startsWith('pelicula -') || cat.startsWith('auto-scraped')) {
        return true;
    }

    // 4. Keywords for movies but EXCLUDING keywords indicating live television channels
    const vodKeywords = ['vod', 'pelicula', 'película', 'filme', 'film', 'estreno', 'estrenos', 'cinema hd', 'cine-hd', 'cine hd', 'movie', 'movies', 'series'];
    const liveKeywords = ['live', 'tv', 'television', 'televisión', 'canal', 'canales', 'en vivo', 'señal', 'tdt', 'deportes', 'sports', 'noticias', 'news', 'hbo', 'star channel', 'warner', 'axn', 'tnt', 'fox', 'cinecanal', 'cine latino', 'cine de hoy', 'cinema live', 'cine live', 'tele', 'broadcasting'];

    const matchesVOD = vodKeywords.some(kw => cat.includes(kw) || name.includes(kw));
    const matchesLive = liveKeywords.some(kw => cat.includes(kw) || name.includes(kw));

    if (matchesVOD && !matchesLive) {
        return true;
    }

    // 5. During scrape phase, if the playlist is from Autopilot, we consider all channels VOD unless they explicitly match live TV
    if (isScrapePhase) {
        if (!matchesLive) {
            return true;
        }
    }

    return false;
}

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

        // 1. Validate stream health of existing MOVIE (VOD) channels only! Leave Live TV untouched!
        const channels = await Channel.find({});
        const movieChannels = channels.filter(isVODChannel);

        await addAutopilotLog(settings, `🔍 Health Check: Scanning ${movieChannels.length} movie (VOD) channels in database (Live TV skipped)...`);

        let onlineCount = 0;
        let offlineCount = 0;
        let deletedCount = 0;

        // Check streams in concurrent batches of 15 to avoid overloading
        const batchSize = 15;
        for (let i = 0; i < movieChannels.length; i += batchSize) {
            const batch = movieChannels.slice(i, i + batchSize);
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
            // Build target VOD queries
            const targetQueries = ['iptv peliculas', 'iptv movies', 'iptv vod', 'm3u peliculas', 'm3u movies'];
            
            // Add user keywords combined with 'iptv' or 'm3u' to keep them highly targeted
            settings.keywords.forEach(kw => {
                const cleanKw = kw.trim();
                if (cleanKw) {
                    targetQueries.push(`iptv ${cleanKw}`);
                    targetQueries.push(`m3u ${cleanKw}`);
                }
            });

            // Deduplicate queries and select up to 3 queries to avoid GitHub search API rate limits
            const activeQueries = [...new Set(targetQueries)].sort(() => 0.5 - Math.random()).slice(0, 3);
            
            await addAutopilotLog(settings, `📡 Scraper: Deep Crawling GitHub repositories for [${activeQueries.join(', ')}]...`);
            
            let discoveredUrls = new Map();

            for (const q of activeQueries) {
                try {
                    const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc`;
                    const response = await axios.get(searchUrl, {
                        headers: { 
                            'User-Agent': 'IPTV-Autopilot-Scraper (Mozilla/5.0)',
                            'Accept': 'application/vnd.github.v3+json'
                        },
                        timeout: 6000
                    });
                    
                    const repos = response.data.items || [];
                    // Process top 4 repositories per search result to find many M3U playlists
                    const topRepos = repos.slice(0, 4);
                    
                    await Promise.all(topRepos.map(async (repo) => {
                        try {
                            const contentsUrl = `https://api.github.com/repos/${repo.full_name}/contents`;
                            const contentsRes = await axios.get(contentsUrl, {
                                headers: { 
                                    'User-Agent': 'IPTV-Autopilot-Scraper (Mozilla/5.0)',
                                    'Accept': 'application/vnd.github.v3+json'
                                },
                                timeout: 4000
                            });
                            
                            const files = contentsRes.data || [];
                            if (Array.isArray(files)) {
                                files.forEach(file => {
                                    const nameLower = file.name.toLowerCase();
                                    if (file.type === 'file' && (nameLower.endsWith('.m3u') || nameLower.endsWith('.m3u8'))) {
                                        discoveredUrls.set(file.download_url, {
                                            name: `${repo.full_name} / ${file.name}`,
                                            url: file.download_url
                                        });
                                    }
                                });
                            }
                        } catch (errInner) {
                            // Suppress individual repo contents fetch errors
                        }
                    }));
                } catch (errSearch) {
                    console.error(`GitHub API search failed for query "${q}":`, errSearch.message);
                }
                
                // Add a small delay between GitHub search API calls to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            await addAutopilotLog(settings, `🔗 Discovered ${discoveredUrls.size} M3U playlists from web sources. Syncing channels...`);

            let crawledChannelsCount = 0;
            const plistUrls = Array.from(discoveredUrls.keys()).slice(0, 10); // Read up to 10 playlists for a thorough search
            
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
                                if (isVODChannel({ name: currentChannel.name, category: currentChannel.category, stream_url: url }, true)) {
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
                        const insertLimit = channelsToInsert.slice(0, 1500); // Insert up to 1500 VOD channels per list for a thorough import
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
