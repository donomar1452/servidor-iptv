const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}
const mongoose = require('mongoose');


// Cambia esta URL por la de tu cluster gratuito de MongoDB Atlas (lo haremos al subir a Render)
// Por ahora usa una local o de memoria si quieres probar, pero para Render necesitarás tu URL.
let mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/iptv";

// Programmatic correction for deprecated options in the connection URI string
try {
    const urlObj = new URL(mongoURI);
    let urlChanged = false;
    for (const key of [...urlObj.searchParams.keys()]) {
        if (['usenewurlparser', 'useunifiedtopology'].includes(key.toLowerCase())) {
            urlObj.searchParams.delete(key);
            urlChanged = true;
        }
    }
    if (urlChanged) {
        mongoURI = urlObj.toString();
    }
} catch (e) {
    // Leave mongoURI as is if it fails to parse as a standard URL object
}

mongoose.connect(mongoURI).then(() => {
    console.log('Connected to the MongoDB database.');
    initDb();
}).catch(err => {
    console.error('Error connecting to MongoDB', err.message);
});

// Definir esquemas (Tablas)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    max_connections: { type: Number, default: 1 },
    active: { type: Boolean, default: true },
    created_at: { type: Date, default: Date.now }
});

const channelSchema = new mongoose.Schema({
    name: String,
    stream_url: String,
    logo: String,
    category: String,
    country: { type: String, default: 'Unknown' },
    active: { type: Boolean, default: true },
    created_at: { type: Date, default: Date.now }
});

const autopilotSchema = new mongoose.Schema({
    enabled: { type: Boolean, default: false },
    intervalHours: { type: Number, default: 24 },
    actionOnDead: { type: String, enum: ['delete', 'disable', 'none'], default: 'disable' },
    keywords: { type: [String], default: [] },
    lastRun: Date,
    nextRun: Date,
    logs: { type: [String], default: [] }
});

// Modelos
const User = mongoose.model('User', userSchema);
const Channel = mongoose.model('Channel', channelSchema);
const Autopilot = mongoose.model('Autopilot', autopilotSchema);

async function initDb() {
    try {
        // Insert default admin if not exists
        const adminExists = await User.findOne({ username: 'admin' });
        if (!adminExists) {
            await User.create({ username: 'admin', password: 'admin', max_connections: 999 });
            console.log("Default admin user created.");
        }

        // Initialize default autopilot settings if not exists
        const autopilotExists = await Autopilot.findOne({});
        if (!autopilotExists) {
            await Autopilot.create({
                enabled: false,
                intervalHours: 24,
                actionOnDead: 'disable',
                keywords: ['latino', 'deportes'],
                logs: ['[System] Autopilot initialized. Waiting to be enabled.']
            });
            console.log("Default autopilot settings initialized.");
        }
    } catch (e) {
        console.error("Error initializing DB values:", e);
    }
}

module.exports = { User, Channel, Autopilot, mongoose };
