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
            const m3uLink = `${window.location.origin}/playlist.m3u?username=${u.username}&password=PON_AQUI_LA_CONTRASEÑA`;
            tbody.innerHTML += `
                <tr>
                    <td>#${u.id}</td>
                    <td><strong>${u.username}</strong></td>
                    <td>${u.max_connections}</td>
                    <td><span class="status-badge ${u.active ? 'status-active' : ''}">${u.active ? 'Active' : 'Inactive'}</span></td>
                    <td><span class="link-box" onclick="copyToClipboard('${m3uLink}')">Copy Link</span></td>
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

// Init
window.onload = loadUsers;
