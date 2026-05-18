const API_URL = window.location.origin + '/api';

let globalChannels = [];
let liveChannels = [];
let movieChannels = [];

// Tab Switching
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.sidebar li').forEach(li => li.classList.remove('active'));
    
    document.getElementById(`tab-${tabId}`).classList.add('active');
    
    // Safely highlight active sidebar item
    const activeItem = document.querySelector(`.sidebar li[onclick*="switchTab('${tabId}')"]`);
    if (activeItem) activeItem.classList.add('active');
    
    if (tabId === 'users') loadUsers();
    if (tabId === 'channels' || tabId === 'movies') loadChannels();
}

// Modals
function showModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// Load Data
async function loadUsers() {
    try {
        const res = await fetch(`${API_URL}/users`);
        const users = await res.json();
        const tbody = document.getElementById('users-tbody');
        tbody.innerHTML = '';
        
        users.forEach(u => {
            tbody.innerHTML += `
                <tr>
                    <td>#${u.id}</td>
                    <td><strong>${u.username}</strong></td>
                    <td>${u.max_connections}</td>
                    <td><span class="status-badge ${u.active ? 'status-active' : ''}">${u.active ? 'Active' : 'Inactive'}</span></td>
                    <td><span class="link-box" onclick="copyPlaylistLink('${u.username}')">Copy Link</span></td>
                </tr>
            `;
        });
    } catch (e) { console.error(e); }
}

async function loadChannels() {
    try {
        const res = await fetch(`${API_URL}/channels`);
        globalChannels = await res.json();
        
        // Split into Live TV and Movies based on category keywords safely
        const movieRegex = /movie|cine|pelicula|vod|serie|film|drama|comedia|acción/i;
        
        liveChannels = globalChannels.filter(c => {
            const category = c.category || 'General';
            const streamUrl = c.stream_url || '';
            return !movieRegex.test(category) && !streamUrl.endsWith('.mp4');
        });
        
        movieChannels = globalChannels.filter(c => {
            const category = c.category || 'General';
            const streamUrl = c.stream_url || '';
            return movieRegex.test(category) || streamUrl.endsWith('.mp4');
        });
        
        // Populate Live TV filters
        const categoryFilter = document.getElementById('category-filter');
        const countryFilter = document.getElementById('country-filter');
        const categories = [...new Set(liveChannels.map(c => c.category))].filter(Boolean).sort();
        const countries = [...new Set(liveChannels.map(c => c.country))].filter(Boolean).sort();
        
        if (categoryFilter.options.length <= 1) { // Only populate if empty
            categoryFilter.innerHTML = '<option value="ALL">All Categories</option>';
            categories.forEach(cat => { categoryFilter.innerHTML += `<option value="${cat}">${cat}</option>`; });
            countryFilter.innerHTML = '<option value="ALL">All Countries</option>';
            countries.forEach(co => { countryFilter.innerHTML += `<option value="${co}">${co}</option>`; });
        }

        // Populate Movies filters
        const movieCatFilter = document.getElementById('movie-category-filter');
        const movieCats = [...new Set(movieChannels.map(c => c.category))].filter(Boolean).sort();
        
        if (movieCatFilter.options.length <= 1) {
            movieCatFilter.innerHTML = '<option value="ALL">All Genres</option>';
            movieCats.forEach(cat => { movieCatFilter.innerHTML += `<option value="${cat}">${cat}</option>`; });
        }

        renderChannels();
        renderMovies();
    } catch (e) { console.error("Error loading channels:", e); }
}

function renderChannels() {
    const tbody = document.getElementById('channels-tbody');
    const selectedCat = document.getElementById('category-filter').value;
    const selectedCountry = document.getElementById('country-filter').value;
    
    let filtered = liveChannels;
    if (selectedCat !== 'ALL') filtered = filtered.filter(c => c.category === selectedCat);
    if (selectedCountry !== 'ALL') filtered = filtered.filter(c => c.country === selectedCountry);

    const displayChannels = filtered.slice(0, 1000); 
    let htmlStr = '';
    
    displayChannels.forEach(c => {
        htmlStr += `
            <tr>
                <td>#${c.id}</td>
                <td><img src="${c.logo || 'https://via.placeholder.com/40'}" class="ch-logo" loading="lazy" onerror="this.src='https://via.placeholder.com/40'"></td>
                <td><strong>${c.name}</strong></td>
                <td>${c.category}</td>
                <td>${c.country}</td>
            </tr>
        `;
    });
    
    if(filtered.length > 1000) {
        htmlStr += `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Showing 1000 of ${filtered.length} live channels...</td></tr>`;
    }
    
    tbody.innerHTML = htmlStr;
}

function renderMovies() {
    const tbody = document.getElementById('movies-tbody');
    if (!tbody) return; // Prevent error if called before tab exists
    
    const selectedCat = document.getElementById('movie-category-filter').value;
    
    let filtered = movieChannels;
    if (selectedCat !== 'ALL') filtered = filtered.filter(c => c.category === selectedCat);

    const displayChannels = filtered.slice(0, 1000); 
    let htmlStr = '';
    
    displayChannels.forEach(c => {
        htmlStr += `
            <tr>
                <td>#${c.id}</td>
                <td><img src="${c.logo || 'https://via.placeholder.com/40'}" class="ch-logo" loading="lazy" style="height:60px; width:40px; object-fit:cover;" onerror="this.src='https://via.placeholder.com/40'"></td>
                <td><strong>${c.name}</strong></td>
                <td>${c.category}</td>
                <td>${c.country}</td>
            </tr>
        `;
    });
    
    if(filtered.length > 1000) {
        htmlStr += `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Showing 1000 of ${filtered.length} movies...</td></tr>`;
    }
    tbody.innerHTML = htmlStr;
}

// Add User
async function addUser() {
    const username = document.getElementById('new_username').value;
    const password = document.getElementById('new_password').value;
    const max_connections = document.getElementById('new_max_conn').value;

    if(!username || !password) return alert("Username and password required");

    await fetch(`${API_URL}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, max_connections: parseInt(max_connections) })
    });
    
    closeModal('userModal');
    document.getElementById('new_username').value = '';
    document.getElementById('new_password').value = '';
    loadUsers();
}

// Add Channel
async function addChannel() {
    const name = document.getElementById('new_ch_name').value;
    const stream_url = document.getElementById('new_ch_url').value;
    const logo = document.getElementById('new_ch_logo').value;
    const category = document.getElementById('new_ch_cat').value;

    if(!name || !stream_url) return alert("Name and Stream URL required");

    await fetch(`${API_URL}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream_url, logo, category })
    });
    
    closeModal('channelModal');
    document.getElementById('new_ch_name').value = '';
    document.getElementById('new_ch_url').value = '';
    loadChannels();
}

// Import M3U
async function importM3U() {
    const m3u_url = document.getElementById('m3u_url').value;
    const status = document.getElementById('import-status');
    if(!m3u_url) return alert("M3U URL required");

    status.innerText = "Importing... Please wait.";
    status.style.color = "var(--primary)";

    try {
        const res = await fetch(`${API_URL}/m3u/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ m3u_url })
        });
        const data = await res.json();
        
        if (res.ok) {
            status.innerText = data.message;
            status.style.color = "#4ade80";
        } else {
            status.innerText = "Error: " + data.error;
            status.style.color = "#ef4444";
        }
    } catch (e) {
        status.innerText = "Failed to connect to server.";
        status.style.color = "#ef4444";
    }
}

// Copy Playlist Link with custom password input
function copyPlaylistLink(username) {
    const password = prompt(`Introduce la contraseña de "${username}" para generar el enlace completo (o déjala en blanco para rellenarla manualmente más tarde):`);
    
    // If they cancel, don't copy anything
    if (password === null) return;
    
    const finalPassword = password.trim() || "PON_AQUI_LA_CONTRASEÑA";
    const m3uLink = `${window.location.origin}/playlist.m3u?username=${username}&password=${finalPassword}`;
    
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(m3uLink).then(() => {
            alert("¡Enlace M3U copiado al portapapeles con éxito!");
        }).catch(err => {
            prompt("Copia este enlace manualmente:", m3uLink);
        });
    } else {
        prompt("Copia este enlace manualmente:", m3uLink);
    }
}

// Utils
function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            alert("Copied to clipboard!");
        }).catch(err => {
            prompt("Please copy this link manually:", text);
        });
    } else {
        // Fallback for non-HTTPS network IP connections
        prompt("Please copy this link manually:", text);
    }
}

// Clear all channels
async function clearAllChannels() {
    if (!confirm("¿Estás seguro de que quieres eliminar todos los canales? Esta acción no se puede deshacer y la base de datos quedará en 0.")) {
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/channels`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (res.ok) {
            alert(data.message || "Canales eliminados correctamente.");
            // Reload channels to update UI count/view
            loadChannels();
        } else {
            alert("Error al eliminar los canales: " + (data.error || "Desconocido"));
        }
    } catch (e) {
        console.error(e);
        alert("No se pudo conectar con el servidor.");
    }
}

// --- IPTV EXPLORER LOGIC ---
let scrapedChannels = [];

function loadPresetUrl() {
    const select = document.getElementById('explorer-preset');
    const input = document.getElementById('explorer-m3u-url');
    if (select.value) {
        input.value = select.value;
    }
}

async function scrapePublicList() {
    const url = document.getElementById('explorer-m3u-url').value.trim();
    const tbody = document.getElementById('explorer-tbody');
    if (!url) return alert("Por favor, selecciona una lista o introduce una URL M3U válida.");

    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--primary); padding: 32px;">⚡ Descargando y analizando lista pública... Por favor espera.</td></tr>`;

    try {
        const res = await fetch(`${API_URL}/scraper/list?url=${encodeURIComponent(url)}`);
        const data = await res.json();
        
        if (res.ok) {
            scrapedChannels = data;
            renderScrapedChannels();
        } else {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 32px;">❌ Error: ${data.error || "No se pudo procesar la lista."}</td></tr>`;
        }
    } catch (e) {
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 32px;">❌ Error de conexión al conectar con el servidor de raspado.</td></tr>`;
    }
}

function renderScrapedChannels() {
    const tbody = document.getElementById('explorer-tbody');
    const searchVal = document.getElementById('explorer-search').value.toLowerCase().trim();
    
    let filtered = scrapedChannels;
    if (searchVal) {
        filtered = scrapedChannels.filter(c => 
            (c.name && c.name.toLowerCase().includes(searchVal)) || 
            (c.category && c.category.toLowerCase().includes(searchVal))
        );
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 32px;">No se encontraron canales que coincidan con la búsqueda.</td></tr>`;
        return;
    }

    let htmlStr = '';
    filtered.forEach((c, index) => {
        const streamUrlShort = c.stream_url.length > 50 ? c.stream_url.substring(0, 50) + "..." : c.stream_url;
        
        htmlStr += `
            <tr id="scraped-row-${index}">
                <td><img src="${c.logo || 'https://via.placeholder.com/40'}" class="ch-logo" loading="lazy" onerror="this.src='https://via.placeholder.com/40'"></td>
                <td><strong>${c.name}</strong></td>
                <td><span style="font-size:0.85rem; color:var(--text-muted);">${c.category}</span></td>
                <td><span class="link-box" style="font-family: monospace; font-size: 0.75rem;" onclick="copyToClipboard('${c.stream_url}')" title="${c.stream_url}">${streamUrlShort}</span></td>
                <td id="status-col-${index}">
                    <button class="btn" style="padding: 4px 10px; font-size: 0.8rem; background: rgba(59, 130, 246, 0.1); border: 1px solid var(--primary); color: var(--primary);" onclick="checkStreamStatus('${c.stream_url}', ${index})">🔍 Check Live</button>
                </td>
                <td>
                    <button class="btn btn-primary" style="padding: 6px 12px; font-size: 0.85rem;" onclick="addScrapedChannel(${index})">+ Add Channel</button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = htmlStr;
}

async function checkStreamStatus(streamUrl, index) {
    const col = document.getElementById(`status-col-${index}`);
    col.innerHTML = `<span style="font-size:0.85rem; color:var(--primary);">Checking...</span>`;

    try {
        const res = await fetch(`${API_URL}/channels/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream_url: streamUrl })
        });
        const data = await res.json();
        
        if (res.ok && data.status === "ONLINE") {
            col.innerHTML = `<span class="status-badge" style="background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.4);">🟢 ONLINE (${data.code})</span>`;
        } else {
            col.innerHTML = `<span class="status-badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4);">🔴 OFFLINE</span>`;
        }
    } catch (e) {
        col.innerHTML = `<span class="status-badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4);">🔴 ERROR</span>`;
    }
}

async function addScrapedChannel(index) {
    const c = scrapedChannels[index];
    if (!c) return;
    try {
        const res = await fetch(`${API_URL}/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: c.name, stream_url: c.stream_url, logo: c.logo, category: c.category })
        });
        const data = await res.json();
        
        if (res.ok) {
            alert(`¡Canal "${c.name}" agregado correctamente a tu servidor!`);
            loadChannels(); // Refresh live TV tab
        } else {
            alert("Error al agregar canal: " + (data.error || "Desconocido"));
        }
    } catch (e) {
        console.error(e);
        alert("Error de conexión al guardar el canal.");
    }
}

// Init
window.onload = loadUsers;
