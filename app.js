// ==========================================================================
// FIFA World Cup 2026 Sleek Dashboard JS Controller
// Handles WASM integration, API fetching, DOM updates, and pitch visualizer
// ==========================================================================

// Global state
let matchesData = [];
let standingsData = {};
let teamsMap = {};
let stadiumsMap = {};
let playersData = {};
let commentaryData = {};

let activeTab = 'match-center';
let selectedTeamCode = '';
let currentSpeechUtterance = null;

// DOM Elements
const loadingOverlay = document.getElementById('loading-overlay');
const globalSearch = document.getElementById('global-search');
const clearSearchBtn = document.getElementById('clear-search');
const searchResultsPanel = document.getElementById('search-results');
const searchResultsList = document.getElementById('search-results-list');
const matchModal = document.getElementById('match-modal');
const closeModalBtn = document.getElementById('close-modal');

// Wait for DOM to load
document.addEventListener('DOMContentLoaded', async () => {
    setupTabListeners();
    setupSearchListeners();
    setupModalListeners();

    try {
        // 1. Initialize Go WASM
        const go = new Go();
        let wasmResult;
        
        // Robust WASM instantiation with ArrayBuffer fallback for MIME type compatibility
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                wasmResult = await WebAssembly.instantiateStreaming(
                    fetch("main.wasm"),
                    go.importObject
                );
            } catch (e) {
                console.warn("instantiateStreaming failed, falling back to ArrayBuffer:", e);
                const response = await fetch("main.wasm");
                const bytes = await response.arrayBuffer();
                wasmResult = await WebAssembly.instantiate(bytes, go.importObject);
            }
        } else {
            const response = await fetch("main.wasm");
            const bytes = await response.arrayBuffer();
            wasmResult = await WebAssembly.instantiate(bytes, go.importObject);
        }
        
        go.run(wasmResult.instance);
        console.log("Go WASM instance running.");

        // 2. Fetch Data
        await fetchAllData();

        // 3. Render Initial State
        updateDashboardStats();
        renderMatchCenter('all');
        renderStandings();
        renderTeamTrackerList();
        renderStadiums();

        // Hide Loading Overlay
        loadingOverlay.style.display = 'none';
    } catch (err) {
        console.error("Initialization error:", err);
        loadingOverlay.innerHTML = `
            <div class="error-msg" style="color: #ef4444; text-align: center; padding: 20px;">
                <i class="fa-solid fa-triangle-exclamation" style="font-size: 3rem; margin-bottom: 10px;"></i>
                <p>Failed to initialize application. Please check if server is running.</p>
                <code style="display: block; margin-top: 10px; font-size: 0.8rem; background: rgba(0,0,0,0.3); padding: 8px;">${err.message}</code>
            </div>
        `;
    }
});

// Setup tab navigation
function setupTabListeners() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab');
            document.getElementById(`tab-${tabId}`).classList.add('active');
            activeTab = tabId;

            // Stop speech synthesis if changing tabs
            stopAnnouncing();
        });
    });
}

// Setup global modal events
function setupModalListeners() {
    closeModalBtn.addEventListener('click', () => {
        matchModal.style.display = 'none';
        stopAnnouncing();
    });

    matchModal.addEventListener('click', (e) => {
        if (e.target === matchModal) {
            matchModal.style.display = 'none';
            stopAnnouncing();
        }
    });
}

// Fetch all required data from server/APIs
async function fetchAllData() {
    console.log("Fetching World Cup dataset...");
    
    // Fetch directly from live HTTPS API endpoints and local static JSON files
    // This allows 100% serverless static deployment (e.g. GitHub Pages)
    try {
        const [teamsRes, gamesRes, stadiumsRes, groupsRes, playersRes, commRes] = await Promise.all([
            fetch('https://worldcup26.ir/get/teams').then(r => r.json()),
            fetch('https://worldcup26.ir/get/games').then(r => r.json()),
            fetch('https://worldcup26.ir/get/stadiums').then(r => r.json()),
            fetch('https://worldcup26.ir/get/groups').then(r => r.json()),
            fetch('players.json').then(r => r.json()),
            fetch('commentary.json').then(r => r.json())
        ]);

        // Process Teams
        if (teamsRes && teamsRes.teams) {
            teamsRes.teams.forEach(t => {
                teamsMap[t.id] = t;
            });
        }

        // Process Stadiums
        if (stadiumsRes && stadiumsRes.stadiums) {
            stadiumsRes.stadiums.forEach(s => {
                stadiumsMap[s.id] = s;
            });
        }

        // Process Games / Matches
        if (gamesRes && gamesRes.games) {
            matchesData = gamesRes.games.map(g => {
                const home = teamsMap[g.home_team_id] || { name_en: g.home_team_label || g.home_team_name_en || 'TBD', fifa_code: '' };
                const away = teamsMap[g.away_team_id] || { name_en: g.away_team_label || g.away_team_name_en || 'TBD', fifa_code: '' };
                const stadium = stadiumsMap[g.stadium_id] || { name_en: 'World Cup Stadium', city_en: '' };
                
                // Parse scores
                const homeScore = g.home_score !== "" && g.home_score !== null ? parseInt(g.home_score) : 0;
                const awayScore = g.away_score !== "" && g.away_score !== null ? parseInt(g.away_score) : 0;

                // Match status matching C++
                let status = "UPCOMING";
                const isFinished = g.finished === "TRUE" || g.time_elapsed === "finished";
                const isLive = g.time_elapsed && g.time_elapsed !== "notstarted" && g.time_elapsed !== "finished";

                if (isFinished) {
                    status = "COMPLETED";
                } else if (isLive) {
                    status = "LIVE";
                }

                return {
                    group: g.group,
                    home_team: home.name_en,
                    home_code: home.fifa_code,
                    away_team: away.name_en,
                    away_code: away.fifa_code,
                    home_score: homeScore,
                    away_score: awayScore,
                    status: status,
                    date_str: g.local_date,
                    venue: `${stadium.name_en}, ${stadium.city_en}`,
                    time_str: g.time_elapsed === "finished" ? "FT" : (g.time_elapsed === "notstarted" ? g.local_date.split(' ')[1] || '' : g.time_elapsed || ''),
                    home_scorers: cleanScorers(g.home_scorers),
                    away_scorers: cleanScorers(g.away_scorers),
                    stadium_id: g.stadium_id
                };
            });
        }

        // Process Groups Standings
        if (groupsRes && groupsRes.groups) {
            groupsRes.groups.forEach(g => {
                const groupTeams = (g.teams || []).map(gt => {
                    const t = teamsMap[gt.team_id] || { name_en: 'TBD', fifa_code: '' };
                    return {
                        name: t.name_en,
                        code: t.fifa_code,
                        played: parseInt(gt.mp || 0),
                        won: parseInt(gt.w || 0),
                        drawn: parseInt(gt.d || 0),
                        lost: parseInt(gt.l || 0),
                        gd: parseInt(gt.gd || 0),
                        points: parseInt(gt.pts || 0)
                    };
                }).sort((a, b) => b.points - a.points || b.gd - a.gd);

                standingsData[g.name] = groupTeams;
            });
        }

        // Store local caches
        playersData = playersRes || {};
        commentaryData = commRes || {};

        console.log("Successfully fetched dataset.", {
            matchesCount: matchesData.length,
            standingsCount: Object.keys(standingsData).length,
            cachedTeamsCount: Object.keys(playersData).length
        });
    } catch (err) {
        console.error("Failed to fetch API data:", err);
        throw err;
    }
}

// Clean scorers string (analogous to C++ logic)
function cleanScorers(raw) {
    if (!raw || raw === "null") return "";
    return raw.replace(/[{}"\\]/g, '').replace(/,/g, ', ').trim();
}

// Update dashboard stats by calling WASM
function updateDashboardStats() {
    if (typeof wasmCalculateStats !== 'function') return;

    try {
        const statsStr = wasmCalculateStats(JSON.stringify(matchesData));
        const stats = JSON.parse(statsStr);

        document.getElementById('stat-total-goals').textContent = stats.total_goals;
        document.getElementById('stat-played-matches').textContent = stats.played_matches;
        document.getElementById('stat-goals-per-match').textContent = stats.goals_per_match.toFixed(2);
        document.getElementById('stat-top-team').textContent = stats.top_scoring_team;
    } catch (err) {
        console.error("WASM calculate stats error:", err);
    }
}

// Render Match Center tab content
function renderMatchCenter(filterStatus) {
    const container = document.getElementById('match-grid-container');
    container.innerHTML = '';

    // Set filter button active state
    document.querySelectorAll('.filter-btn').forEach(btn => {
        if (btn.getAttribute('data-status') === filterStatus) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    const filtered = matchesData.filter(m => filterStatus === 'all' || m.status === filterStatus);

    if (filtered.length === 0) {
        container.innerHTML = `<div class="no-matches-msg">No ${filterStatus.toLowerCase()} matches found</div>`;
        return;
    }

    filtered.forEach(m => {
        const card = document.createElement('div');
        card.className = `match-card ${m.status.toLowerCase()}`;
        
        // Match live indicator markup
        const statusBadge = m.status === 'LIVE' 
            ? `<span class="match-status-badge"><span class="pulse-dot"></span> LIVE</span>`
            : `<span class="match-status-badge">${m.status}</span>`;

        const homeFlag = getFlagUrl(m.home_code);
        const awayFlag = getFlagUrl(m.away_code);

        const isLive = m.status === 'LIVE';
        const isUpcoming = m.status === 'UPCOMING';

        let scoreArea = '';
        if (isUpcoming) {
            scoreArea = `<div class="score-box"><div class="upcoming-vs">VS</div></div>`;
        } else {
            scoreArea = `
                <div class="score-box">
                    <span>${m.home_score}</span>
                    <span style="font-size: 1.1rem; color: var(--text-muted); font-weight:400;">-</span>
                    <span>${m.away_score}</span>
                </div>
            `;
        }

        // Live ticker details
        let liveTicker = '';
        if (isLive) {
            liveTicker = `<div class="live-time-ticker">${m.time_str}'</div>`;
        }

        card.innerHTML = `
            <div class="match-card-header">
                <span class="match-group">${m.group}</span>
                ${statusBadge}
            </div>
            <div class="match-teams-area">
                <div class="team-box">
                    <img src="${homeFlag}" alt="${m.home_code}" class="team-flag" onerror="this.src='https://placehold.co/44x28/1a2130/ffffff?text=${m.home_code || 'TBD'}'">
                    <span class="team-name">${m.home_team}</span>
                </div>
                <div class="score-live-wrapper">
                    ${scoreArea}
                    ${liveTicker}
                </div>
                <div class="team-box">
                    <img src="${awayFlag}" alt="${m.away_code}" class="team-flag" onerror="this.src='https://placehold.co/44x28/1a2130/ffffff?text=${m.away_code || 'TBD'}'">
                    <span class="team-name">${m.away_team}</span>
                </div>
            </div>
            ${m.home_scorers || m.away_scorers ? `
            <div class="match-card-scorers">
                <div class="scorers-col left">${m.home_scorers || ''}</div>
                <div class="scorers-col right">${m.away_scorers || ''}</div>
            </div>
            ` : ''}
            <div class="match-venue">
                <i class="fa-solid fa-location-dot"></i>
                <span>${m.venue} - ${m.date_str.split(' ')[0]}</span>
            </div>
        `;

        card.addEventListener('click', () => openMatchModal(m));
        container.appendChild(card);
    });
}

// Setup match filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const status = e.currentTarget.getAttribute('data-status');
        renderMatchCenter(status);
    });
});

// Render Standings Group Tables
function renderStandings() {
    const container = document.getElementById('standings-grid-container');
    container.innerHTML = '';

    const sortedGroups = Object.keys(standingsData).sort();

    sortedGroups.forEach(groupName => {
        const teams = standingsData[groupName];
        const card = document.createElement('div');
        card.className = 'group-table-card';
        card.innerHTML = `<h3>${groupName}</h3>`;

        const table = document.createElement('div');
        table.className = 'group-table';
        table.innerHTML = `
            <div class="table-header">
                <div class="team-pos">#</div>
                <div class="team-name-col">Team</div>
                <div class="team-stat">P</div>
                <div class="team-stat">W</div>
                <div class="team-stat">GD</div>
                <div class="team-stat points">PTS</div>
            </div>
        `;

        teams.forEach((t, i) => {
            const flag = getFlagUrl(t.code);
            const row = document.createElement('div');
            row.className = 'table-row';
            row.innerHTML = `
                <div class="team-pos">${i + 1}</div>
                <div class="team-name-col">
                    <img src="${flag}" alt="${t.code}" class="team-mini-flag" onerror="this.src='https://placehold.co/20x13/1a2130/ffffff?text=${t.code}'">
                    <span>${t.name}</span>
                </div>
                <div class="team-stat">${t.played}</div>
                <div class="team-stat">${t.won}</div>
                <div class="team-stat">${t.gd > 0 ? '+' + t.gd : t.gd}</div>
                <div class="team-stat points">${t.points}</div>
            `;
            
            // Interaction to trace team in selector
            row.addEventListener('click', () => {
                if (playersData[t.code]) {
                    // Activate Team Tracker tab
                    document.querySelector('.tab-btn[data-tab="team-tracker"]').click();
                    selectTeamTrackerTeam(t.code);
                }
            });

            table.appendChild(row);
        });

        card.appendChild(table);
        container.appendChild(card);
    });
}

// Render team list in Team Tracker sidebar
function renderTeamTrackerList() {
    const container = document.getElementById('tracker-team-list');
    container.innerHTML = '';

    // Find all teams we have squad details for (from playersData keys)
    const availableCodes = Object.keys(playersData).sort();

    availableCodes.forEach(code => {
        // Find team name from standings
        let teamName = code;
        for (const grp of Object.values(standingsData)) {
            const found = grp.find(t => t.code === code);
            if (found) {
                teamName = found.name;
                break;
            }
        }

        const btn = document.createElement('div');
        btn.className = `team-select-item ${code === selectedTeamCode ? 'active' : ''}`;
        btn.innerHTML = `
            <img src="${getFlagUrl(code)}" alt="${code}" class="team-mini-flag" style="width: 24px; height: 16px;">
            <span>${teamName}</span>
        `;
        btn.addEventListener('click', () => selectTeamTrackerTeam(code));
        container.appendChild(btn);
    });
}

// Highlight team selection in tracker
function selectTeamTrackerTeam(code) {
    selectedTeamCode = code;
    document.querySelectorAll('.team-select-item').forEach(btn => {
        btn.classList.remove('active');
    });

    const activeBtn = Array.from(document.querySelectorAll('.team-select-item')).find(item => {
        return item.querySelector('span').textContent.toLowerCase() === getTeamName(code).toLowerCase() || item.innerHTML.includes(code);
    });
    if (activeBtn) activeBtn.classList.add('active');

    // Show details
    document.getElementById('tracker-no-selection-msg').style.display = 'none';
    const trackerContainer = document.getElementById('tracker-details-container');
    trackerContainer.style.display = 'block';

    // Set title
    const teamName = getTeamName(code);
    document.getElementById('tracker-team-title').textContent = teamName;
    document.getElementById('tracker-team-group').textContent = `Group ${getTeamGroup(code)}`;

    // Render Sub Tab contents
    renderTeamSquad(code);
    renderTeamTactics(code);
    renderTeamSchedule(code);
    renderTeamQA(code);
}

// Get team name from code
function getTeamName(code) {
    for (const grp of Object.values(standingsData)) {
        const found = grp.find(t => t.code === code);
        if (found) return found.name;
    }
    return code;
}

// Get team group name from code
function getTeamGroup(code) {
    for (const [grpName, grpTeams] of Object.entries(standingsData)) {
        const found = grpTeams.find(t => t.code === code);
        if (found) return grpName.replace("Group ", "");
    }
    return "-";
}

// Render Squad list subtab
function renderTeamSquad(code) {
    const container = document.getElementById('tracker-player-grid');
    container.innerHTML = '';

    const squad = playersData[code].players || [];
    squad.forEach(p => {
        const card = document.createElement('div');
        card.className = 'player-card';

        const photoHtml = p.photo_url && p.photo_url !== 'failed'
            ? `<img src="${p.photo_url}" class="player-photo" alt="${p.name}">`
            : `<i class="fa-solid fa-user player-no-photo-icon"></i>`;

        card.innerHTML = `
            <div class="player-photo-container">
                ${photoHtml}
            </div>
            <div class="player-jersey">${p.jersey_number}</div>
            <div class="player-name">${p.name}</div>
            <div class="player-pos">${p.position}</div>
            <div class="player-comment">${p.comment || ''}</div>
        `;
        container.appendChild(card);
    });
}

// Render interactive pitch subtab
function renderTeamTactics(code) {
    const container = document.getElementById('pitch-players-list');
    container.innerHTML = '';

    const lineup = playersData[code].lineup || [];
    const infoPanel = document.getElementById('pitch-selected-player-info');
    infoPanel.style.display = 'none';

    // Position coordinates mapping based on player index / roles
    // We map a standard 4-3-3 or 4-4-2 visually on the vertical field (GK bottom, FW top)
    const coordinates = [
        { x: 50, y: 90 }, // GK
        { x: 15, y: 73 }, // LB
        { x: 38, y: 75 }, // LCB
        { x: 62, y: 75 }, // RCB
        { x: 85, y: 73 }, // RB
        { x: 30, y: 52 }, // LCM
        { x: 50, y: 56 }, // CM
        { x: 70, y: 52 }, // RCM
        { x: 20, y: 26 }, // LW
        { x: 50, y: 22 }, // CF
        { x: 80, y: 26 }  // RW
    ];

    lineup.forEach((p, idx) => {
        const node = document.createElement('div');
        node.className = 'pitch-player-node';
        
        // Fetch coordinate, clamp if index overflows
        const coords = coordinates[idx] || { x: 50, y: 50 };
        node.style.left = `${coords.x}%`;
        node.style.top = `${coords.y}%`;

        node.innerHTML = `
            <div class="jersey-circle">${p.jersey_number}</div>
            <div class="pitch-player-name-label">${p.name.split(' ').pop()}</div>
        `;

        // Interaction
        node.addEventListener('click', () => {
            // Find comments/squad details of this player if available
            const fullSquad = playersData[code].players || [];
            const squadInfo = fullSquad.find(s => s.name.toLowerCase() === p.name.toLowerCase());
            
            infoPanel.style.display = 'block';
            document.getElementById('pitch-selected-player-name').textContent = `${p.name} (#${p.jersey_number})`;
            
            const comment = squadInfo ? squadInfo.comment : 'Lineup starting player. Details are not cached in the local DB.';
            document.getElementById('pitch-selected-player-meta').textContent = `${p.position} — ${comment}`;
        });

        container.appendChild(node);
    });
}

// Render schedule & matches for selected team
function renderTeamSchedule(code) {
    const container = document.getElementById('tracker-schedule-list');
    container.innerHTML = '';

    const teamName = getTeamName(code);
    const related = matchesData.filter(m => 
        m.home_team.toLowerCase() === teamName.toLowerCase() || 
        m.away_team.toLowerCase() === teamName.toLowerCase()
    );

    if (related.length === 0) {
        container.innerHTML = `<div class="no-matches-msg">No scheduled matches found for ${teamName}</div>`;
        return;
    }

    related.forEach(m => {
        const item = document.createElement('div');
        item.className = 'match-card';
        item.style.marginBottom = '12px';

        const statusLabel = m.status === 'LIVE' ? 'LIVE' : m.status;

        item.innerHTML = `
            <div class="match-card-header">
                <span class="match-group">${m.group} - ${m.venue}</span>
                <span class="match-status-badge">${statusLabel}</span>
            </div>
            <div class="match-teams-area">
                <div class="team-box" style="flex-direction:row; justify-content:flex-end;">
                    <span class="team-name" style="margin-right:12px;">${m.home_team}</span>
                    <img src="${getFlagUrl(m.home_code)}" alt="${m.home_code}" class="team-mini-flag">
                </div>
                <div class="score-box" style="font-size:1.4rem;">
                    <span>${m.home_score}</span>
                    <span>-</span>
                    <span>${m.away_score}</span>
                </div>
                <div class="team-box" style="flex-direction:row; justify-content:flex-start;">
                    <img src="${getFlagUrl(m.away_code)}" alt="${m.away_code}" class="team-mini-flag" style="margin-right:12px;">
                    <span class="team-name">${m.away_team}</span>
                </div>
            </div>
            <div style="font-size: 0.78rem; color: var(--text-dim); text-align: center; margin-top:4px;">
                ${m.date_str}
            </div>
        `;

        item.addEventListener('click', () => openMatchModal(m));
        container.appendChild(item);
    });
}

// Render QA list accordeon
function renderTeamQA(code) {
    const container = document.getElementById('tracker-qa-list');
    container.innerHTML = '';

    const qaList = playersData[code].qa || [];

    if (qaList.length === 0) {
        container.innerHTML = `<div class="no-matches-msg">No custom AI Analyst Q&A matches this team.</div>`;
        return;
    }

    qaList.forEach((qa, idx) => {
        const card = document.createElement('div');
        card.className = 'qa-card';
        
        card.innerHTML = `
            <div class="qa-question-bar" id="qa-q-${idx}">
                <span>${qa.question}</span>
                <i class="fa-solid fa-chevron-down"></i>
            </div>
            <div class="qa-answer" id="qa-a-${idx}" style="display: none;">
                ${qa.answer}
            </div>
        `;

        // Add accordion trigger
        card.querySelector('.qa-question-bar').addEventListener('click', () => {
            const answer = card.querySelector('.qa-answer');
            const icon = card.querySelector('.qa-question-bar i');
            if (answer.style.display === 'none') {
                answer.style.display = 'block';
                icon.className = 'fa-solid fa-chevron-up';
            } else {
                answer.style.display = 'none';
                icon.className = 'fa-solid fa-chevron-down';
            }
        });

        container.appendChild(card);
    });
}

// Render Stadium list
function renderStadiums() {
    const container = document.getElementById('stadiums-grid-container');
    container.innerHTML = '';

    // Capacity mappings (rough/standard stats)
    const capacities = {
        "1": "Capacity: 83,000",
        "2": "Capacity: 104,000",
        "3": "Capacity: 80,000",
        "4": "Capacity: 68,000",
        "5": "Capacity: 64,000",
        "6": "Capacity: 70,000",
        "7": "Capacity: 82,500",
        "8": "Capacity: 54,000",
        "9": "Capacity: 48,000",
        "10": "Capacity: 50,000"
    };

    const stadiumList = Object.values(stadiumsMap);
    stadiumList.forEach(s => {
        const card = document.createElement('div');
        card.className = 'stadium-card';

        const cap = capacities[s.id] || "Capacity: 65,000";

        card.innerHTML = `
            <div class="stadium-photo-placeholder">
                <i class="fa-solid fa-tree-city"></i>
            </div>
            <div class="stadium-info">
                <h3>${s.name_en}</h3>
                <div class="stadium-city">${s.city_en}</div>
                <div class="stadium-capacity"><i class="fa-solid fa-users"></i> ${cap}</div>
            </div>
        `;

        container.appendChild(card);
    });
}

// Modal popup: detailed match information & AI commentary
function openMatchModal(m) {
    const modalBody = document.getElementById('match-modal-body');
    modalBody.innerHTML = '';

    // Get key for commentary cache: HOMECODE_AWAYCODE_DATESTR
    // Note that dates contain slashes, which needs to match the JSON key: "ARG_AUT_06/22/2026 12:00"
    const matchKey = `${m.home_code}_${m.away_code}_${m.date_str}`;
    const commentary = commentaryData[matchKey];

    const homeFlag = getFlagUrl(m.home_code);
    const awayFlag = getFlagUrl(m.away_code);

    let commHtml = '';
    if (commentary) {
        // Strip markdown reference link footnotes like [[1]](url) or convert to tags
        let parsedText = commentary.text;
        parsedText = parsedText.replace(/\[\[\d+\]\]\([^\)]+\)/g, ''); // Remove markup footnotes

        commHtml = `
            <div class="commentary-section">
                <div class="commentary-title">
                    <h4><i class="fa-solid fa-microphone-lines"></i> AI Commentator (Spanish style Hype)</h4>
                    <button class="speak-btn" id="btn-speak-comm"><i class="fa-solid fa-volume-high"></i> Read Out Loud</button>
                </div>
                <div class="commentary-text" id="modal-comm-text">${parsedText}</div>
            </div>
        `;
    } else {
        commHtml = `
            <div class="commentary-section" style="text-align: center; color: var(--text-dim);">
                <i class="fa-regular fa-comment-dots" style="font-size: 2.5rem; margin-bottom: 10px; display:block;"></i>
                <p>No commentator logs found for this matchup yet. Check back during live action!</p>
            </div>
        `;
    }

    modalBody.innerHTML = `
        <div class="comm-match-header">
            <div class="comm-match-teams">
                <img src="${homeFlag}" alt="${m.home_code}" class="team-mini-flag" style="width: 32px; height: 20px;">
                <span>${m.home_team} ${m.status === 'UPCOMING' ? 'vs' : m.home_score + ' - ' + m.away_score} ${m.away_team}</span>
                <img src="${awayFlag}" alt="${m.away_code}" class="team-mini-flag" style="width: 32px; height: 20px;">
            </div>
            <div class="comm-match-meta">${m.venue} | ${m.group} | Status: ${m.status}</div>
        </div>
        ${commHtml}
    `;

    // Try to extract YouTube highlight link from commentary text if available
    if (commentary) {
        const ytMatch = commentary.text.match(/https:\/\/www\.youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/);
        if (ytMatch) {
            const ytLink = ytMatch[0];
            const ytBox = document.createElement('div');
            ytBox.className = 'highlights-link-box';
            ytBox.innerHTML = `
                <div class="highlights-text">
                    <i class="fa-brands fa-youtube youtube-icon"></i>
                    <span>Official Match Highlights Summary Video Found!</span>
                </div>
                <a href="${ytLink}" target="_blank" class="watch-btn">Watch Highlights</a>
            `;
            modalBody.appendChild(ytBox);
        }
    }

    // Speech events
    const speakBtn = document.getElementById('btn-speak-comm');
    if (speakBtn && commentary) {
        speakBtn.addEventListener('click', () => {
            const rawText = document.getElementById('modal-comm-text').textContent;
            announceCommentary(rawText, speakBtn);
        });
    }

    matchModal.style.display = 'flex';
}

// Text-to-speech announcer
function announceCommentary(text, btnElement) {
    if (currentSpeechUtterance) {
        stopAnnouncing();
        btnElement.innerHTML = `<i class="fa-solid fa-volume-high"></i> Read Out Loud`;
        return;
    }

    // Configure Speech Synthesis
    const utterance = new SpeechSynthesisUtterance(text);
    // Find an exciting english voice or fallback
    const voices = window.speechSynthesis.getVoices();
    // Try to find a voice that sounds energetic
    const preferredVoice = voices.find(v => v.lang.includes('en-US') || v.lang.includes('en-GB')) || voices[0];
    if (preferredVoice) {
        utterance.voice = preferredVoice;
    }
    
    utterance.rate = 1.05; // Slightly faster for high energy announcer style
    utterance.pitch = 1.0;

    utterance.onend = () => {
        stopAnnouncing();
        btnElement.innerHTML = `<i class="fa-solid fa-volume-high"></i> Read Out Loud`;
    };

    btnElement.innerHTML = `<i class="fa-solid fa-volume-xmark"></i> Mute Announcer`;
    currentSpeechUtterance = utterance;
    window.speechSynthesis.speak(utterance);
}

function stopAnnouncing() {
    if (window.speechSynthesis && window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
    }
    currentSpeechUtterance = null;
}

// Setup search bar listeners
function setupSearchListeners() {
    globalSearch.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        
        if (query === "") {
            clearSearchBtn.style.display = 'none';
            searchResultsPanel.style.display = 'none';
            return;
        }

        clearSearchBtn.style.display = 'block';
        
        // Execute WASM Search
        if (typeof wasmSearchData === 'function') {
            try {
                const resultsStr = wasmSearchData(
                    query, 
                    JSON.stringify(matchesData),
                    JSON.stringify(standingsData),
                    JSON.stringify(playersData)
                );
                
                const results = JSON.parse(resultsStr);
                renderSearchResults(results);
            } catch (err) {
                console.error("WASM search data failed:", err);
            }
        }
    });

    clearSearchBtn.addEventListener('click', () => {
        globalSearch.value = "";
        clearSearchBtn.style.display = 'none';
        searchResultsPanel.style.display = 'none';
    });

    // Close search panel on clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrapper')) {
            searchResultsPanel.style.display = 'none';
        }
    });
}

// Render search items dynamically
function renderSearchResults(results) {
    searchResultsList.innerHTML = '';

    if (results.length === 0) {
        searchResultsList.innerHTML = `<div style="padding: 12px 16px; color: var(--text-dim); text-align: center;">No matches found for this query</div>`;
        searchResultsPanel.style.display = 'block';
        return;
    }

    results.forEach(res => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.innerHTML = `
            <div class="search-result-main">
                <span class="result-title">${res.title}</span>
                <span class="result-subtitle">${res.subtitle}</span>
            </div>
            <span class="result-badge ${res.type}">${res.type}</span>
        `;

        item.addEventListener('click', () => {
            handleSearchResultClick(res);
            searchResultsPanel.style.display = 'none';
        });

        searchResultsList.appendChild(item);
    });

    searchResultsPanel.style.display = 'block';
}

// Search result item click behavior: jump tabs & select items
function handleSearchResultClick(res) {
    if (res.type === 'match') {
        // Find match in dataset
        const m = matchesData.find(game => 
            game.home_team === res.ref_data.home_team && 
            game.away_team === res.ref_data.away_team &&
            game.date_str === res.ref_data.date_str
        );
        if (m) {
            openMatchModal(m);
        }
    } else if (res.type === 'team') {
        // Go to Team Tracker
        document.querySelector('.tab-btn[data-tab="team-tracker"]').click();
        selectTeamTrackerTeam(res.ref_data.code);
    } else if (res.type === 'player') {
        // Find which team this player belongs to
        let foundCode = '';
        for (const [code, teamData] of Object.entries(playersData)) {
            const matchPlayer = (teamData.players || []).find(p => p.name === res.ref_data.name);
            if (matchPlayer) {
                foundCode = code;
                break;
            }
        }
        
        if (foundCode) {
            document.querySelector('.tab-btn[data-tab="team-tracker"]').click();
            selectTeamTrackerTeam(foundCode);
            // Switch to Squad pane
            document.querySelector('.sub-tab-btn[data-subtab="tracker-squad"]').click();
        }
    }
}

// Wire up Sub-tab switching in Team Tracker details
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('sub-tab-btn')) {
        const parent = e.target.parentElement;
        parent.querySelectorAll('.sub-tab-btn').forEach(btn => btn.classList.remove('active'));
        
        const paneContainer = parent.nextElementSibling;
        paneContainer.querySelectorAll('.sub-tab-pane').forEach(pane => pane.classList.remove('active'));

        e.target.classList.add('active');
        const subtabId = e.target.getAttribute('data-subtab');
        document.getElementById(subtabId).classList.add('active');
    }
});

// Flag rendering helper (SVG links)
function getFlagUrl(code) {
    if (!code) return "https://placehold.co/44x28/1a2130/ffffff?text=TBD";
    // Mapping all 48 teams in the FIFA World Cup 2026 to flagcdn country codes
    const codeMap = {
        "ARG": "ar", "AUT": "at", "ALG": "dz", "JOR": "jo", "URU": "uy", 
        "MEX": "mx", "RSA": "za", "HAI": "ht", "SCO": "gb-sct", "MAR": "ma", 
        "SEN": "sn", "NOR": "no", "IRN": "ir", "NZL": "nz", "KOR": "kr", "CZE": "cz",
        "KSA": "sa", "BRA": "br", "FRA": "fr", "IRQ": "iq", "TUR": "tr", "CIV": "ci",
        "NED": "nl", "CPV": "cv", "TUN": "tn", "EGY": "eg", "POR": "pt", "UZB": "uz",
        "COL": "co", "ECU": "ec", "JPN": "jp", "GHA": "gh", "ESP": "es", "COD": "cd",
        "ENG": "gb-eng", "CAN": "ca", "QAT": "qa", "SUI": "ch", "PAR": "py", "CUW": "cw",
        "SWE": "se", "GER": "de", "PAN": "pa", "BIH": "ba", "USA": "us", "AUS": "au",
        "BEL": "be", "CRO": "hr"
    };

    const mapped = codeMap[code.toUpperCase()];
    if (mapped) {
        return `https://flagcdn.com/w40/${mapped}.png`;
    }
    return `https://placehold.co/44x28/1a2130/ffffff?text=${code}`;
}
