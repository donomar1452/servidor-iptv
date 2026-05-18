const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const { User, Channel } = require('./database');

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

    try {
        console.log(`Starting GitHub Deep Scrape for keywords: ${query}`);
        
        // Search public repositories on GitHub matching iptv + m3u + query
        const searchUrl = `https://api.github.com/search/repositories?q=iptv+m3u+${encodeURIComponent(query)}&sort=stars&order=desc`;
        
        const response = await axios.get(searchUrl, {
            headers: { 
                'User-Agent': 'IPTV-Server-Admin-Scraper (Mozilla/5.0)',
                'Accept': 'application/vnd.github.v3+json'
            },
            timeout: 10000
        });
        
        const repos = response.data.items || [];
        console.log(`Found ${repos.length} repositories matching query. Crawling top 10...`);
        
        let discoveredUrls = new Map(); // Use Map to avoid duplicate URLs

        // Crawl top 10 repos in parallel
        const promises = repos.slice(0, 10).map(async (repo) => {
            try {
                // 1. Scan repository description for external M3U/M3U8 URLs
                const desc = repo.description || '';
                const urlRegex = /https?:\/\/[a-zA-Z0-9-._~:\/?#\[\]@!$&'()*+,;=%]+(?:\.m3u8?)/gi;
                let match;
                while ((match = urlRegex.exec(desc)) !== null) {
                    const matchedUrl = match[0];
                    discoveredUrls.set(matchedUrl, {
                        name: `${repo.full_name} (Enlace en descripción)`,
                        url: matchedUrl,
                        source: 'GitHub Link'
                    });
                }
                
                // 2. Scan repository root files for M3U playlist files
                const contentsUrl = `https://api.github.com/repos/${repo.full_name}/contents`;
                const contentsRes = await axios.get(contentsUrl, {
                    headers: { 
                        'User-Agent': 'IPTV-Server-Admin-Scraper (Mozilla/5.0)',
                        'Accept': 'application/vnd.github.v3+json'
                    },
                    timeout: 5000
                });
                
                const files = contentsRes.data || [];
                if (Array.isArray(files)) {
                    files.forEach(file => {
                        const nameLower = file.name.toLowerCase();
                        const isM3u = nameLower.endsWith('.m3u') || nameLower.endsWith('.m3u8');
                        const isPlaylistKeyword = nameLower.includes('playlist') || nameLower.includes('lista') || nameLower.includes('canal');
                        
                        if (file.type === 'file' && (isM3u || (isPlaylistKeyword && file.size < 5000000))) {
                            discoveredUrls.set(file.download_url, {
                                name: `${repo.full_name} / ${file.name}`,
                                url: file.download_url,
                                source: 'GitHub File'
                            });
                        }
                    });
                }
            } catch (e) {
                // Silently swallow single repo crawl errors (e.g. empty repo, 404, rate limit on one repo content)
                console.log(`Skipped repository scanning for ${repo.full_name}: ${e.message}`);
            }
        });

        await Promise.all(promises);

        const results = Array.from(discoveredUrls.values());
        console.log(`Deep scrape complete. Found ${results.length} active playlists.`);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: "Deep search failed", details: err.message });
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

        // Use cursor to stream channels row by row
        const cursor = Channel.find().lean().cursor();
        
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

app.listen(PORT, () => {
    console.log(`IPTV Server running on http://localhost:${PORT}`);
});
