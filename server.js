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
    const { username, password } = req.query;

    try {
        const user = await User.findOne({ username, password, active: true });
        if (!user) return res.status(401).send("Unauthorized");

        res.setHeader('Content-Type', 'audio/x-mpegurl');
        res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u"');
        res.write("#EXTM3U\n");
        
        const host = req.protocol + '://' + req.get('host');

        // Use cursor to stream channels row by row
        const cursor = Channel.find().cursor();
        
        cursor.on('data', (ch) => {
            const safeName = ch.name ? ch.name.replace(/\n/g, '') : 'Unknown';
            const safeLogo = ch.logo ? ch.logo.replace(/\n/g, '') : '';
            const safeCat = ch.category ? ch.category.replace(/\n/g, '') : 'General';
            
            res.write(`#EXTINF:-1 tvg-id="" tvg-name="${safeName}" tvg-logo="${safeLogo}" group-title="${safeCat}",${safeName}\n`);
            res.write(`${host}/live/${username}/${password}/${ch._id}.m3u8\n`);
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
