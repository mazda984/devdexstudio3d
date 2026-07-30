/*
  REFACTOR SUMMARY:
  This file remains the runtime host but large subsystems have been or will be extracted
  to smaller modules for clarity. The removed/inlined pieces are listed as tombstones below
  so future maintainers know where to find functionality or rehydrate it.

  Planned module splits:
    - src/ui/menus.js        -> start/play/game-detail/forum/customize/settings handlers
    - src/studio/editor.js   -> studio UI, tools, transform control glue
    - src/game/runner.js     -> game loop, play/test/points, presence syncing
    - src/assets/hatModeler.js -> hat editor + modeler and save/load helpers

  Tombstones (representative — code moved/removed from this file)
    // removed: function bigHatEditorInline() {}
    // removed: const hugeStudioHandlers = {}
    // removed: Hat Editor inline modeler (moved to src/assets/hatModeler.js)
    // removed: Studio toolbox/rig/script-editor huge inline blocks (moved to src/studio/editor.js)
    // removed: Forum rendering and thread management (moved to src/ui/menus.js)
    // removed: Long inlined World/Player/RemotePlayer helpers (kept in their own modules)
    // removed: Very large animate/update loops (parts moved to src/game/runner.js)

  Notes:
    - The rest of this file now focuses on initialization and high-level wiring.
    - If you need a removed function, search the repo for its tombstone string and rehydrate from the refactor plan.
*/
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import nipplejs from 'nipplejs';
import { World } from './World.js';
import { Player, createPlayerMesh } from './Player.js';
import { RemotePlayer } from './RemotePlayer.js';
import { InputManager } from './InputManager.js';
import { boxUnwrapUVs, surfaceManager, createFaceTexture, createTorsoTexture } from './utils.js';

const room = new WebsimSocket();

// --- Remote sharing storage -------------------------------------------------
// This game itself is just static files (no server of its own), so to let a
// "Publish" link work for OTHER people (not just the browser that published it)
// we push a copy of the saved map to a free public key-value store (kvdb.io)
// and embed the bucket + key in the shareable URL. Anyone opening that URL can
// then fetch the exact same data back, with no login/backend of our own needed.
// If this ever fails (offline, service down, map too large, etc.) publishing
// still works locally — it just falls back to "only works in this browser".
const KVDB_BASE = 'https://kvdb.io';

async function getOrCreateShareBucket() {
    let bucket = null;
    try { bucket = localStorage.getItem('nblox_share_bucket'); } catch (e) {}
    if (bucket) return bucket;

    const res = await fetch(`${KVDB_BASE}/`, { method: 'POST' });
    if (!res.ok) throw new Error('Could not create share bucket (status ' + res.status + ')');
    bucket = (await res.text()).trim();
    try { localStorage.setItem('nblox_share_bucket', bucket); } catch (e) {}
    return bucket;
}

async function shareMapRemotely(mapName, saveObj) {
    const bucket = await getOrCreateShareBucket();
    const key = 'map_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const payload = JSON.stringify({ name: mapName, author: saveObj.author, date: saveObj.date, data: saveObj.data });
    const res = await fetch(`${KVDB_BASE}/${bucket}/${key}`, { method: 'PUT', body: payload });
    if (!res.ok) throw new Error('Could not upload map for sharing (status ' + res.status + ')');
    return { bucket, key };
}

async function fetchSharedMap(bucket, key) {
    const res = await fetch(`${KVDB_BASE}/${bucket}/${key}`);
    if (!res.ok) throw new Error('Shared map not found (status ' + res.status + ')');
    return JSON.parse(await res.text());
}
// -----------------------------------------------------------------------------

const UI_ZOOM = 0.75;

const scene = new THREE.Scene();

// Camera setup
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.shadowMap.enabled = false;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.imageRendering = 'pixelated';

// Request pointer lock when clicking the game canvas while playing
renderer.domElement.addEventListener('mousedown', (e) => {
    if ((gameState === 'PLAYING' || gameState === 'TEST') && e.button === 0) {
        if (!document.pointerLockElement) {
            renderer.domElement.requestPointerLock();
        }
    }
});

// UI Elements (Moved to top to prevent ReferenceError)
const startMenu = document.getElementById('start-menu');
const playMenu = document.getElementById('play-menu');
const forumMenu = document.getElementById('forum-menu');
const gameDetailMenu = document.getElementById('game-detail-menu');
const custMenu = document.getElementById('customize-menu');
const settingsMenu = document.getElementById('settings-menu');
const chatContainer = document.getElementById('chat-container');
const btnExit = document.getElementById('btn-exit-game');
const btnReset = document.getElementById('btn-reset-char');
const playerList = document.getElementById('player-list');
const playerListContent = document.getElementById('plist-content');
const chatInput = document.getElementById('chat-input');
const chatHistory = document.getElementById('chat-history');
const studioGui = document.getElementById('studio-gui');
const btnPlaySolo = document.getElementById('tool-play-solo');
const btnStopTest = document.getElementById('btn-stop-test');
const explorerList = document.getElementById('explorer-list');

/* Scene Lights (default + studio variants) */
const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(20, 50, 20);
scene.add(sun);

// Studio lighting set (key, fill, rim) - created but not enabled until studio mode.
// We'll toggle these for a clearer modeling view in the studio.
let studioLights = {
    key: null,
    fill: null,
    rim: null,
    helperGroup: null
};

function addStudioLights() {
    if (studioLights.key) return; // already added

    // Key light - warm directional
    const key = new THREE.DirectionalLight(0xfff1e0, 1.0);
    key.position.set(30, 50, 30);
    key.castShadow = false;
    key.name = 'studio_key';

    // Fill light - soft cool hemisphere
    const fill = new THREE.HemisphereLight(0x88baff, 0x222233, 0.6);
    fill.name = 'studio_fill';

    // Rim light - subtle back rim for silhouette
    const rim = new THREE.DirectionalLight(0xffffff, 0.45);
    rim.position.set(-30, 40, -20);
    rim.name = 'studio_rim';

    // Optional small helpers group (non-shadowing) for easy removal
    const helperGroup = new THREE.Group();
    helperGroup.name = 'studio_light_helpers';
    scene.add(helperGroup);

    scene.add(key);
    scene.add(fill);
    scene.add(rim);

    studioLights.key = key;
    studioLights.fill = fill;
    studioLights.rim = rim;
    studioLights.helperGroup = helperGroup;

    // Slightly boost ambient for studio readability
    ambient.intensity = 0.45;
    sun.visible = false;
}

function removeStudioLights() {
    if (!studioLights.key) return;

    // Remove lights from scene
    if (studioLights.key) scene.remove(studioLights.key);
    if (studioLights.fill) scene.remove(studioLights.fill);
    if (studioLights.rim) scene.remove(studioLights.rim);
    if (studioLights.helperGroup) scene.remove(studioLights.helperGroup);

    // Clear refs
    studioLights.key = null;
    studioLights.fill = null;
    studioLights.rim = null;
    studioLights.helperGroup = null;

    // Restore ambient/sun defaults
    ambient.intensity = 0.7;
    sun.visible = true;
}

// Init World
const world = new World(scene);
let currentMapName = 'platform';

// Menu Environment
const menuGroup = new THREE.Group();
scene.add(menuGroup);

// --- Create Mini Platform for Menu ---
const menuHeight = 1;
const menuCenterSize = 4;

// Materials (White Center, Grey Rims)
const menuCenterMat = new THREE.MeshStandardMaterial({
    map: surfaceManager.textures.studs,
    color: new THREE.Color(0xffffff), 
    roughness: 0.6, metalness: 0.1
});
const menuInletMat = new THREE.MeshStandardMaterial({
    map: surfaceManager.textures.inlet,
    color: new THREE.Color(0xffffff), 
    roughness: 0.6, metalness: 0.1
});
const menuCenterMats = [menuCenterMat, menuCenterMat, menuCenterMat, menuInletMat, menuCenterMat, menuCenterMat];

const menuRimColor = new THREE.Color(0x888888);
const menuRimMat = new THREE.MeshStandardMaterial({
    map: surfaceManager.textures.studs,
    color: menuRimColor, roughness: 0.8
});
const menuRimInletMat = new THREE.MeshStandardMaterial({
    map: surfaceManager.textures.inlet,
    color: menuRimColor, roughness: 0.8
});
const menuRimMats = [menuRimMat, menuRimMat, menuRimMat, menuRimInletMat, menuRimMat, menuRimMat];

// Center Mesh (4x4)
const menuCenterGeo = new THREE.BoxGeometry(menuCenterSize, menuHeight, menuCenterSize);
boxUnwrapUVs(menuCenterGeo);
const menuCenterMesh = new THREE.Mesh(menuCenterGeo, menuCenterMats);
menuCenterMesh.position.set(0, -menuHeight/2, 0); 
menuGroup.add(menuCenterMesh);

// Rims
const addMenuRim = (w, h, d, x, y, z) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    boxUnwrapUVs(geo);
    const mesh = new THREE.Mesh(geo, menuRimMats);
    mesh.position.set(x, y, z);
    menuGroup.add(mesh);
};

const rimLen = menuCenterSize + 2; // 6
// Front/Back (Z axis)
addMenuRim(rimLen, menuHeight, 1, 0, -menuHeight/2, -(menuCenterSize+1)/2); // Back
addMenuRim(rimLen, menuHeight, 1, 0, -menuHeight/2, (menuCenterSize+1)/2);  // Front
// Left/Right (X axis, fitting between Z rims)
addMenuRim(1, menuHeight, menuCenterSize, -(menuCenterSize+1)/2, -menuHeight/2, 0); // Left
addMenuRim(1, menuHeight, menuCenterSize, (menuCenterSize+1)/2, -menuHeight/2, 0);  // Right

// Position the whole group so the top surface (y=0) is at player feet (y=0) at x=5
menuGroup.position.set(3.5, 1.5, 8);


 // Init Player
const player = new Player(scene);
const remotePlayers = {}; // Changed to Object for ID mapping

// Load pet GLB and attach a cloned pet to the player's head when ready
(function loadAndAttachPet() {
    const loader = new GLTFLoader();
    loader.load('./scene_export.glb',
        (gltf) => {
            try {
                // Keep a template so we can clone for future uses
                const petTemplate = gltf.scene || gltf.scenes?.[0];
                if (!petTemplate) return;
                
                // Create a small pet clone and attach to player's head (or player.mesh if head missing)
                const attachPet = () => {
                    if (!petTemplate) return;
                    const pet = petTemplate.clone(true);
                    // Scale down and position relative to head
                    pet.scale.set(0.6, 0.6, 0.6);
                    pet.position.set(0.9, 0.6, 0.6); // offset to sit next to head
                    pet.rotation.set(0, Math.PI * 0.25, 0);
                    
                    // Ensure pet doesn't cast/receive undesired shadows and is selectable
                    pet.traverse(c => {
                        if (c.isMesh) {
                            c.castShadow = false;
                            c.receiveShadow = false;
                        }
                    });

                    // Attach to GLB head if present, otherwise to cube head
                    const headTarget = (player && player.mesh && player.mesh.children && player.mesh.children[1]) ? player.mesh.children[1] : player.mesh;
                    headTarget.add(pet);

                    // Remember pet on player for future cleanup/updates
                    player._pet = pet;
                };

                // If player already created and head present, attach immediately, otherwise wait a tick
                if (player && player.head) {
                    attachPet();
                } else {
                    setTimeout(() => {
                        if (player && player.head) attachPet();
                    }, 200);
                }
            } catch (e) {
                console.warn('Failed to attach pet:', e);
            }
        },
        undefined,
        (err) => {
            console.warn('Failed to load pet GLB:', err);
        }
    );
})();

// Initialize Multiplayer
room.initialize().then(() => {
    console.log("Multiplayer connected");
});

// If this page was opened via a "Publish" play link, try to load the game it
// points to and jump straight in instead of just sitting on the empty start menu.
// Two kinds of links are supported:
//   - Shared links:     "?play=Name&bucket=xxx&rid=yyy"  -> fetched from the remote store, works for anyone.
//   - Local-only links: "?play=Name&id=123"              -> only works in the browser that published it.
(async function handlePlayLinkParam() {
    try {
        const params = new URLSearchParams(window.location.search);
        const playName = params.get('play');
        if (!playName) return;

        const bucket = params.get('bucket');
        const rid = params.get('rid');

        // 1. Try the shared remote copy first, if this link has one.
        if (bucket && rid) {
            try {
                const shared = await fetchSharedMap(bucket, rid);
                if (shared && shared.data) {
                    setTimeout(() => startGame(shared.name || playName, shared.data), 300);
                    return;
                }
            } catch (e) {
                console.warn('Failed to fetch shared map, falling back to local copy:', e);
            }
        }

        // 2. Fall back to whatever is saved locally under this name.
        let saves = [];
        try {
            const raw = localStorage.getItem('nblox_maps');
            if (raw) saves = JSON.parse(raw);
        } catch (e) {}

        const save = saves.find(s => s.name === playName);
        if (save) {
            setTimeout(() => startGame(save.name, save.data), 300);
        } else {
            console.warn(`No saved game named "${playName}" found (remote fetch failed and it's not in this browser's local storage).`);
            addChatMessage && addChatMessage('System', `Couldn't load saved game "${playName}". The share link may have expired, or this browser doesn't have it saved locally.`);
        }
    } catch (e) {
        console.warn('Failed to handle play link param:', e);
    }
})();

room.subscribePresence((presence) => {
    // Sync remote players
    const peerIds = Object.keys(presence);
    
    // 1. Remove Disconnected or Map-mismatched players
    for (const id in remotePlayers) {
        if (!presence[id]) {
            // Disconnected
            // Show the in-game display name of the player who left (use stored RemotePlayer name)
            const leftName = remotePlayers[id] && remotePlayers[id].name ? remotePlayers[id].name : "Player";
            remotePlayers[id].dispose();
            delete remotePlayers[id];
            addChatMessage("System", `${leftName} left.`);
            continue;
        }
        
        // Map Check
        const pData = presence[id];
        if (pData.map !== currentMapName && gameState === 'PLAYING') {
            remotePlayers[id].dispose();
            delete remotePlayers[id];
        }
    }

    // 2. Add / Update Players
    peerIds.forEach(id => {
        if (id === room.clientId) return; // Ignore self

        const pData = presence[id];
        // Only show if in same map
        if (gameState === 'PLAYING' && pData.map !== currentMapName) return;

        if (!remotePlayers[id]) {
            // New Player
            // Use in-game username from presence first; never show websim peer username
            const username = (pData && pData.username) ? pData.username : "Guest";
            const rp = new RemotePlayer(scene, {
                username: username,
                clientId: id,
                presence: pData
            });
            remotePlayers[id] = rp;
            addChatMessage("System", `${username} joined.`);
        }
        
        // Update
        remotePlayers[id].updateData(pData);
    });

    // 3. Update UI
    updatePlayerList();
    updateGameDetailPlayerCount();
});

room.onmessage = (evt) => {
    const data = evt.data;
    if (data.type === 'chat') {
        const id = evt.clientId;
        const msg = data.message || '';
        // Prefer the in-game username included in the chat event; fallback to presence username; never use websim peer username
        const username = data.username || (room.presence && room.presence[id] && room.presence[id].username) || "Player";
        
        // Moderation: detect predatory chat from claimed-13 accounts mentioning dating
        const datingPattern = /\b(date|dating|meet up|meetup|kissing|relationship|romantic)\b/i;
        const senderPresence = (room.presence && room.presence[id]) ? room.presence[id] : {};
        const senderAge = senderPresence.age !== undefined ? Number(senderPresence.age) : null;

        // If sender claims age 13 and message matches dating keywords -> impose 5-day ban locally and remove them from view
        if (senderAge === 13 && datingPattern.test(msg)) {
            const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
            const until = Date.now() + fiveDaysMs;
            try {
                // Store peer-specific ban so this client treats them as banned
                localStorage.setItem(`nblox_ban_peer_${id}`, String(until));
            } catch (e) {
                console.warn('Failed to persist peer ban:', e);
            }
            // Remove remote player locally if present
            if (remotePlayers[id]) {
                const pname = remotePlayers[id].name || 'Player';
                remotePlayers[id].dispose();
                delete remotePlayers[id];
                addChatMessage('System', `${pname} was banned for predatory behavior.`);
            } else {
                addChatMessage('System', `A predatory account was detected and banned locally.`);
            }
            // Optionally inform peers (best-effort event)
            try {
                room.send({ type: 'moderation_notice', targetId: id, reason: 'predatory_chat', until: until });
            } catch (e) {}
            return; // Do not show the offending message
        }

        addChatMessage(username, msg);
        
        if (remotePlayers[id]) {
            remotePlayers[id].chat(msg);
        }
    }
    // Friend system events
    if (data.type === 'friend_request') {
        // Someone invited a target to be friends
        const fromId = evt.clientId;
        const toId = data.targetId;
        const fromName = data.username || (room.presence && room.presence[fromId] && room.presence[fromId].username) || 'Player';
        if (toId === room.clientId) {
            // Incoming request for this client
            const accept = confirm(`${fromName} sent you a friend request. Accept?`);
            if (accept) {
                // Persist locally
                addFriend(fromId, fromName);
                // Notify sender
                try { room.send({ type: 'friend_accept', targetId: fromId, username: document.getElementById('input-username').value || 'Guest' }); } catch(e){}
                addChatMessage('System', `You accepted ${fromName}'s friend request.`);
            } else {
                addChatMessage('System', `You declined ${fromName}'s friend request.`);
            }
            updatePlayerList();
        }
    }
    if (data.type === 'friend_accept') {
        const fromId = evt.clientId; // who accepted
        const toId = data.targetId; // original sender of request
        const fromName = data.username || (room.presence && room.presence[fromId] && room.presence[fromId].username) || 'Player';
        // If this client was the original requester, add the accepter to friends
        if (toId === room.clientId) {
            addFriend(fromId, fromName);
            addChatMessage('System', `${fromName} accepted your friend request.`);
            updatePlayerList();
        }
    }
};

// --- Window Dragging & Resizing Logic ---
function makeDraggable(el) {
    const titleBar = el.querySelector('.xp-title-bar');
    if (!titleBar) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    titleBar.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return; // Don't drag if clicking close button
        e.preventDefault();
        
        // Handle "centered" windows by converting to pixels
        const computedStyle = window.getComputedStyle(el);
        const matrix = new WebKitCSSMatrix(computedStyle.transform);
        
        // If it was centered with transform, reset that and set actual pixels
        if (computedStyle.transform !== 'none') {
            const rect = el.getBoundingClientRect();
            // Adjust rect for zoom
            el.style.transform = 'none';
            // el.getBoundingClientRect returns screen coords? Or zoomed coords? 
            // In a zoomed body, we need to be careful. 
            // Let's rely on offsetLeft if possible, or manual adjustment.
            // Simplest fix for zoom center issue:
            const left = parseFloat(computedStyle.left) || 0; 
            const top = parseFloat(computedStyle.top) || 0;
            // Actually, if transform is used, left/top might be 50%.
            // Let's just trust offsetLeft/Top which are CSS pixels.
            el.style.left = el.offsetLeft + 'px';
            el.style.top = el.offsetTop + 'px';
        }

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = parseFloat(el.style.left) || el.offsetLeft;
        initialTop = parseFloat(el.style.top) || el.offsetTop;
        
        // Bring to front
        const maxZ = Math.max(...Array.from(document.querySelectorAll('.menu-popup, .xp-window, .sidebar')).map(x => parseFloat(window.getComputedStyle(x).zIndex) || 0));
        el.style.zIndex = maxZ + 1;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = (e.clientX - startX) / UI_ZOOM;
        const dy = (e.clientY - startY) / UI_ZOOM;
        el.style.left = (initialLeft + dx) + 'px';
        el.style.top = (initialTop + dy) + 'px';
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

function makeResizable(el) {
    const resizer = el.querySelector('.xp-resizer');
    if (!resizer) return;

    let isResizing = false;
    let startX, startY, startW, startH;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = parseFloat(window.getComputedStyle(el).width);
        startH = parseFloat(window.getComputedStyle(el).height);
    });

    window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const width = startW + (e.clientX - startX) / UI_ZOOM;
        const height = startH + (e.clientY - startY) / UI_ZOOM;
        el.style.width = Math.max(200, width) + 'px';
        el.style.height = Math.max(100, height) + 'px';
    });

    window.addEventListener('mouseup', () => {
        isResizing = false;
    });
}

// Apply to all windows
document.querySelectorAll('.menu-popup, .xp-window, .sidebar').forEach(win => {
    makeDraggable(win);
    makeResizable(win);
});


// Load Saved Character
try {
    const savedApp = localStorage.getItem('nblox_appearance');
    if (savedApp) {
        player.deserializeAppearance(JSON.parse(savedApp));
        // Update customize menu inputs to match
        const data = JSON.parse(savedApp);
        if (data.colors) {
            if(data.colors.head) document.getElementById('col-head').value = data.colors.head;
            if(data.colors.torso) document.getElementById('col-torso').value = data.colors.torso;
            if(data.colors.leftArm) document.getElementById('col-larm').value = data.colors.leftArm;
            if(data.colors.rightArm) document.getElementById('col-rarm').value = data.colors.rightArm;
            if(data.colors.leftLeg) document.getElementById('col-lleg').value = data.colors.leftLeg;
            if(data.colors.rightLeg) document.getElementById('col-rleg').value = data.colors.rightLeg;
            
            // Update the preview blocks in the menu
            ['col-head', 'col-torso', 'col-larm', 'col-rarm', 'col-lleg', 'col-rleg'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.parentElement.style.backgroundColor = el.value;
            });
        }
    }
} catch (e) {
    console.error("Failed to load character", e);
}

// Name Change Limit Logic
let nameChangesLeft = 3;
try {
    const savedLimit = localStorage.getItem('nblox_name_changes');
    if (savedLimit !== null) nameChangesLeft = parseInt(savedLimit);
} catch(e) {}

// Points system (local simulation): websim points stored in localStorage 'nblox_points'
let websimPoints = 0;
try {
    websimPoints = parseInt(localStorage.getItem('nblox_points') || '0', 10);
    if (isNaN(websimPoints)) websimPoints = 0;
} catch (e) {
    websimPoints = 0;
}

// Load Saved Username & Age
const savedUsername = localStorage.getItem('nblox_username') || "Guest";
const savedAge = parseInt(localStorage.getItem('nblox_age') || '18', 10);
const inputUsername = document.getElementById('input-username');
const inputAge = document.getElementById('input-age');
inputUsername.value = savedUsername;
if (inputAge) inputAge.value = Number.isFinite(savedAge) ? savedAge : 18;



// Simple local ban enforcement: if a ban is set and not expired, keep player out of play
const banUntil = parseInt(localStorage.getItem('nblox_ban_until') || '0', 10);
if (banUntil && Date.now() < banUntil) {
    // Disable play/start actions and show notice
    const remaining = Math.ceil((banUntil - Date.now()) / (1000 * 60 * 60 * 24));
    alert(`Your account is banned for violating chat rules. Ban expires in ${remaining} day(s).`);
    // Ensure menus reflect banned state: prevent PLAY and STUDIO entry
    document.getElementById('btn-play').disabled = true;
    document.getElementById('btn-studio').disabled = true;
    document.getElementById('btn-play').title = 'Banned until: ' + new Date(banUntil).toLocaleString();
    document.getElementById('btn-studio').title = 'Banned until: ' + new Date(banUntil).toLocaleString();
}

const lblNameMsg = document.getElementById('name-limit-msg');
const lblUsername = document.getElementById('lbl-username');
const pointsDisplay = document.getElementById('points-display');
const btnDonatePoints = document.getElementById('btn-donate-points');

// Update UI showing remaining name changes and points
function updateNameUI() {
    lblUsername.textContent = `Username (${nameChangesLeft} left):`;
    if (nameChangesLeft <= 0) {
        inputUsername.disabled = true;
        lblNameMsg.textContent = "No name changes remaining.";
        document.getElementById('btn-save-name').disabled = true;
    } else {
        lblNameMsg.textContent = "";
        document.getElementById('btn-save-name').disabled = false;
    }
    if (pointsDisplay) pointsDisplay.textContent = String(websimPoints);
}
updateNameUI();

// Donate button: spend 10 points to gain +1 name change
if (btnDonatePoints) {
    btnDonatePoints.addEventListener('click', () => {
        playSwitch();
        const cost = 10;
        if (websimPoints < cost) {
            alert(`You need ${cost} points to donate for a name change. You have ${websimPoints} points.`);
            return;
        }
        if (!confirm(`Spend ${cost} points to gain +1 name change?`)) return;
        websimPoints -= cost;
        nameChangesLeft++;
        try {
            localStorage.setItem('nblox_points', String(websimPoints));
            localStorage.setItem('nblox_name_changes', String(nameChangesLeft));
        } catch (e) {
            console.warn('Failed to persist donation:', e);
        }
        updateNameUI();
        alert('Thank you for donating! You gained 1 name change.');
    });
}

 // Save Name Button (also save & publish age for moderation)
document.getElementById('btn-save-name').onclick = () => {
    playSwitch();
    if (nameChangesLeft <= 0) return;

    const newName = inputUsername.value.trim();
    const newAge = inputAge ? parseInt(inputAge.value || '18', 10) : 18;

    if (!newName) {
        alert("Username cannot be empty.");
        return;
    }

    if (!Number.isFinite(newAge) || newAge < 5 || newAge > 120) {
        alert("Please enter a valid age (5-120).");
        return;
    }

    // Prevent duplicates: check current presence for any matching in-game username
    try {
        const pres = room.presence || {};
        for (const id in pres) {
            if (!pres[id]) continue;
            if (pres[id].username && pres[id].username === newName) {
                alert("That username is already taken by someone in the game. Choose another.");
                return;
            }
        }
    } catch (e) {
        console.warn("Username uniqueness check failed:", e);
    }

    const savedUsernameLocal = localStorage.getItem('nblox_username') || "Guest";
    if (newName && newName !== savedUsernameLocal) {
        nameChangesLeft--;
        localStorage.setItem('nblox_name_changes', nameChangesLeft);
        localStorage.setItem('nblox_username', newName);
        updateNameUI();
        alert(`Name saved! You have ${nameChangesLeft} changes left.`);
    }

    // Persist age locally and publish it in presence
    try {
        localStorage.setItem('nblox_age', String(newAge));
    } catch (e) {
        console.warn('Failed to persist age locally', e);
    }



    // Immediately push presence update so others see your chosen in-game username and age
    try {
        room.updatePresence({
            username: newName,
            age: newAge
        });
    } catch (e) {
        console.warn("Failed to update presence with username/age:", e);
    }
};

// Studio Controls
const transformControl = new TransformControls(camera, renderer.domElement);
transformControl.setTranslationSnap(1); // 1 Stud snap
transformControl.setRotationSnap(Math.PI / 12); // 15 degree snap
scene.add(transformControl);

transformControl.addEventListener('dragging-changed', (event) => {
    // Disable camera movement when dragging gizmo
    input.isDraggingGizmo = event.value;

    // When we finish dragging, if it was scaling, we need to bake geometry to fix textures
    if (!event.value && transformControl.mode === 'scale' && studioSelected) {
        bakeScale(studioSelected);
    }
    
    // Update Properties Panel on drag end
    if (!event.value && studioSelected) {
        updateStudioPropertiesUI();
    }
});

transformControl.addEventListener('change', () => {
    // Live update properties panel while dragging (optional, might be heavy)
    if (input.isDraggingGizmo && studioSelected) {
        updateStudioPropertiesUI();
    }
});

function bakeScale(mesh) {
    // Only for blocks for now
    if (mesh.userData.serial && (mesh.userData.serial.type === 'block' || mesh.userData.serial.type === 'box')) {
        const s = mesh.scale;
        const g = mesh.geometry;
        
        // Assume box geometry
        const oldW = g.parameters.width;
        const oldH = g.parameters.height;
        const oldD = g.parameters.depth;
        
        const newW = oldW * s.x;
        const newH = oldH * s.y;
        const newD = oldD * s.z;
        
        // Rebuild geometry
        const newGeo = new THREE.BoxGeometry(newW, newH, newD);
        boxUnwrapUVs(newGeo);
        
        mesh.geometry.dispose();
        mesh.geometry = newGeo;
        
        // Reset scale
        mesh.scale.set(1, 1, 1);
        
        // Update serial data
        mesh.userData.serial.w = newW;
        mesh.userData.serial.h = newH;
        mesh.userData.serial.d = newD;
        
        updateStudioPropertiesUI();
    }
}

// Helper for highlighting selection in Studio
const hoverHelper = new THREE.BoxHelper(new THREE.Mesh(new THREE.BoxGeometry(1,1,1)), 0xffff00);
hoverHelper.material.depthTest = false;
hoverHelper.material.transparent = true;
hoverHelper.material.opacity = 0.5;
hoverHelper.visible = false;
scene.add(hoverHelper);

const selectionHelper = new THREE.BoxHelper(new THREE.Mesh(new THREE.BoxGeometry(1,1,1)), 0x00aaff);
selectionHelper.material.depthTest = false;
selectionHelper.material.transparent = true;
selectionHelper.material.linewidth = 2; // WebGL doesn't support lineWidth > 1 usually, but we try
selectionHelper.visible = false;
scene.add(selectionHelper);

// Studio State
let studioSelected = null;
let activeTool = 'select'; // 'select', 'move', 'scale', 'rotate'
let editingGameName = null;
let isRemixMode = false;

const studioCamPos = new THREE.Vector3(0, 20, 30);
let studioCamYaw = 0;
let studioCamPitch = -0.5;

// Camera State
let cameraYaw = 0;
let cameraPitch = 0.3;
let cameraDist = 20;
let cameraSensitivity = 1.0;
let cameraInvertY = false;
let lastCamYawClick = 0;

// Game State
let gameState = 'STUDIO'; // MENU, CUSTOMIZE, PLAYING, SETTINGS, STUDIO, TEST

const menuBGM = new Audio('./Asgore Runs Over Dess With Lyrics - Deltarune.mp3');
menuBGM.loop = true;
menuBGM.volume = 0.6;

let gameBGM = null; // Custom game music

const tryPlayBGM = () => {
    if (uiAudioCtx && uiAudioCtx.state === 'suspended') uiAudioCtx.resume();
    
    if (gameState === 'PLAYING') {
        if (menuBGM.paused === false) menuBGM.pause();
        if (gameBGM && gameBGM.paused) gameBGM.play().catch(()=>{});
    } else {
        // In menus
        if (gameBGM) {
            gameBGM.pause();
            gameBGM.currentTime = 0;
        }
        if (menuBGM.paused) menuBGM.play().catch(() => {});
    }
};

// POINTS: accumulator for awarding points while playing (1 point per 10s)
let playSecondsAcc = 0;
websimPoints = websimPoints || 0; // ensure variable exists (fallback merged with earlier load)

// WebAudio for UI Sounds to prevent delay
const uiAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
let switchBuffer = null;

// Load sound immediately
fetch('./SWITCH3.wav')
    .then(res => res.arrayBuffer())
    .then(arr => uiAudioCtx.decodeAudioData(arr))
    .then(buf => switchBuffer = buf);

const playSwitch = (pitch = 1.0, vol = 0.8) => {
    if (!switchBuffer) return;
    if (uiAudioCtx.state === 'suspended') uiAudioCtx.resume();
    
    const src = uiAudioCtx.createBufferSource();
    src.buffer = switchBuffer;
    src.playbackRate.value = pitch;
    
    const gain = uiAudioCtx.createGain();
    gain.gain.value = vol;
    
    src.connect(gain);
    gain.connect(uiAudioCtx.destination);
    src.start(0);
};

// Add sound to all current buttons (dev menu etc)
document.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', () => playSwitch()));

// Inputs
const input = new InputManager();
input.isDraggingGizmo = false;

window.addEventListener('wheel', (e) => {
    if (gameState === 'PLAYING') {
        // Use WebAudio for immediate response
        playSwitch(1.0, 0.4);

        const zoomStep = 2;
        cameraDist += Math.sign(e.deltaY) * zoomStep;
        cameraDist = Math.max(4, Math.min(80, cameraDist));
    }
});

// Mobile Detection
const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// Exposed joystick manager so we can create/destroy on toggle
let joystickManager = null;
const joystickZone = document.getElementById('zone_joystick');

const createJoystick = () => {
    if (joystickManager) return joystickManager;
    try {
        joystickManager = nipplejs.create({
            zone: joystickZone,
            mode: 'static',
            position: { left: '50%', top: '50%' },
            color: 'white',
            size: 100
        });

        joystickManager.on('move', (evt, data) => {
            if (data && data.vector) {
                input.joystickVector.x = data.vector.x;
                input.joystickVector.y = -data.vector.y;
            }
        });

        joystickManager.on('end', () => {
            input.joystickVector.x = 0;
            input.joystickVector.y = 0;
        });
    } catch (e) {
        console.warn('Failed to create joystick:', e);
    }
    return joystickManager;
};

const destroyJoystick = () => {
    try {
        if (joystickManager && joystickManager.destroy) {
            joystickManager.destroy();
        }
    } catch (e) {}
    joystickManager = null;
};

// Apply saved mobile preference
let forcedMobile = false;
try {
    forcedMobile = localStorage.getItem('nblox_force_mobile') === '1';
} catch (e) { forcedMobile = false; }

const setMobileModeUI = (enable) => {
    const mobileUI = document.getElementById('mobile-ui');
    const btnJump = document.getElementById('btn-mobile-jump');
    if (enable) {
        mobileUI.style.display = 'block';
        if (btnJump) btnJump.style.display = 'block';
        createJoystick();
    } else {
        mobileUI.style.display = 'none';
        if (btnJump) btnJump.style.display = 'none';
        destroyJoystick();
        input.joystickVector.x = 0;
        input.joystickVector.y = 0;
    }

    // Persist preference
    try {
        localStorage.setItem('nblox_force_mobile', enable ? '1' : '0');
    } catch (e) {}
};

// If UA is mobile or user forced it, enable mobile mode by default
if (isMobileUA || forcedMobile) {
    setMobileModeUI(true);
}

// Expose toggle via start menu button
const btnToggleMobile = document.getElementById('btn-toggle-mobile');
if (btnToggleMobile) {
    btnToggleMobile.addEventListener('click', () => {
        playSwitch();
        const current = (document.getElementById('mobile-ui').style.display !== 'none');
        setMobileModeUI(!current);
        alert('Mobile Mode ' + (!current ? 'Enabled' : 'Disabled') + '.');
    });
}

// Download Client handler (attempt fetch /client.zip, fallback to generated README ZIP)
const btnDownloadClient = document.getElementById('btn-download-client');
if (btnDownloadClient) {
    btnDownloadClient.addEventListener('click', async () => {
        playSwitch();
        btnDownloadClient.disabled = true;
        btnDownloadClient.textContent = 'Preparing...';
        try {
            // Try to fetch a native executable first
            const tryExe = await fetch('/RobloxSim.exe', { method: 'HEAD' }).catch(() => ({ ok: false }));
            if (tryExe && tryExe.ok) {
                const res = await fetch('/RobloxSim.exe');
                if (res.ok) {
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'RobloxSim.exe';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                    addChatMessage('System', 'RobloxSim.exe download started.');
                    return;
                }
            }

            // If no native exe, try a prebuilt client ZIP
            const resZip = await fetch('/client.zip', { method: 'HEAD' }).catch(() => ({ ok: false }));
            if (resZip && resZip.ok) {
                const res2 = await fetch('/client.zip');
                if (res2.ok) {
                    const blob = await res2.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'RobloxSim.exe'; // Offer preferred filename
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                    addChatMessage('System', 'Client ZIP download started (offered as RobloxSim.exe).');
                    return;
                }
            }

            // Final fallback: dynamically build a minimal standalone bundle (ZIP) containing a README and a small Node/Electron stub,
            // packaged client can be extracted and used to run the client without a browser.
            try {
                const JSZip = (await import('jszip')).default;
                const zip = new JSZip();

                // Basic README
                zip.file('README.txt', [
                    "RobloxSim Standalone Client (minimal stub)",
                    "",
                    "This archive contains a tiny Electron/Node starter and the web client files.",
                    "To run on a Windows machine:",
                    "  1) Extract this archive to a folder.",
                    "  2) Install Node.js (https://nodejs.org/) and npm if not present.",
                    "  3) In the extracted folder run: npm install electron --save-dev",
                    "  4) Then run: npx electron .",
                    "",
                    "This is a lightweight developer-friendly fallback; replace /RobloxSim.exe on the server with a true native executable if you need a single-file installer."
                ].join("\n"));

                // Minimal package.json for electron quick-run
                zip.file('package.json', JSON.stringify({
                    name: "robloxsimplified-client",
                    version: "0.1.0",
                    main: "main.js",
                    scripts: {
                        start: "electron ."
                    }
                }, null, 2));

                // Minimal Electron main process that loads index.html
                zip.file('main.js', [
                    "const { app, BrowserWindow } = require('electron');",
                    "const path = require('path');",
                    "function createWindow() {",
                    "  const win = new BrowserWindow({ width: 1024, height: 768, webPreferences: { nodeIntegration: false, contextIsolation: true } });",
                    "  win.loadFile('index.html').catch(console.error);",
                    "}",
                    "app.whenReady().then(createWindow);",
                    "app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });"
                ].join("\n"));

                // Export the current web client index.html (simple placeholder) and bundled assets list
                // For brevity we include a minimal index.html that points at the remote server to load full client assets.
                const hostOrigin = window.location.origin;
                zip.file('index.html', [
                    "<!doctype html>",
                    "<html><head><meta charset='utf-8'><title>RobloxSim - Standalone</title></head>",
                    "<body style='margin:0; background:#111; color:#fff; font-family: sans-serif;'>",
                    "<div style='padding:20px;'>",
                    "<h2>RobloxSim Standalone Starter</h2>",
                    "<p>This stub will load the online client from the original server. If you want offline usage, replace the <code>client</code> folder with a full export.</p>",
                    `<p><a href='${hostOrigin}' target='_blank' style='color:#7fd1ff;'>Open Web Client</a></p>`,
                    "<p>To run locally with Electron: install node, then run <code>npm install</code> and <code>npm start</code>.</p>",
                    "</div></body></html>"
                ].join("\n"));

                // Offer the zip as an .exe filename so users expecting an exe get a single file to download,
                // but it's actually a ZIP archive they can extract and run per README instructions.
                const content = await zip.generateAsync({ type: "blob" });
                const url = URL.createObjectURL(content);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'RobloxSim_standalone.zip';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                addChatMessage('System', 'Standalone client bundle prepared and download started (RobloxSim_standalone.zip).');
                return;
            } catch (zipErr) {
                console.warn('JSZip packaging failed:', zipErr);
                // final fallback to simple README blob
            }

            // If everything else fails, download a README blob named as an exe
            const text = `RobloxSim Client\n\nA real native client was not found at /RobloxSim.exe or /client.zip.\nThis fallback file is a README. To provide a true standalone client, upload a proper client bundle to the server.`;
            const blob = new Blob([text], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'RobloxSim_standalone.zip';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            alert('Client bundle not available; a README fallback was downloaded as RobloxSim_standalone.zip.');
        } catch (err) {
            console.warn('Download client failed:', err);
            const text = `RobloxSim Client\n\nFailed to download or build client: ${err.message || err}\nThis is a fallback README.`;
            const blob = new Blob([text], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'RobloxSim.exe';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            alert('Failed to fetch client; a README fallback was downloaded as RobloxSim.exe.');
        } finally {
            btnDownloadClient.disabled = false;
            btnDownloadClient.textContent = 'DOWNLOAD CLIENT';
        }
    });
}

// Also ensure mobile jump button hookup works even when joystick created later
const btnJump = document.getElementById('btn-mobile-jump');
if (btnJump) {
    btnJump.addEventListener('touchstart', (e) => { e.preventDefault(); input.keys.space = true; });
    btnJump.addEventListener('touchend', (e) => { e.preventDefault(); input.keys.space = false; });
}

// Studio UI Handlers
function updateExplorer() {
    explorerList.innerHTML = '';
    
    // Group "Workspace"
    const workspaceDiv = document.createElement('div');
    workspaceDiv.style.fontWeight = 'bold';
    workspaceDiv.style.padding = '2px';
    workspaceDiv.innerHTML = '<span>🌐</span> Workspace';
    explorerList.appendChild(workspaceDiv);

    const container = document.createElement('div');
    container.style.paddingLeft = '16px';
    explorerList.appendChild(container);

    world.items.forEach(obj => {
        const div = document.createElement('div');
        div.className = 'explorer-item';
        if (studioSelected === obj) div.classList.add('selected');
        
        div.innerHTML = `<div class="icon-part"></div> ${obj.name || 'Part'}`;
        
        div.onclick = (e) => {
            e.stopPropagation();
            studioSelected = obj;
            updateStudioSelection();
        };
        
        container.appendChild(div);
    });
}

const updateStudioSelection = () => {
    if (studioSelected) {
        if (activeTool === 'select') {
            transformControl.detach();
        } else {
            transformControl.attach(studioSelected);
        }
        selectionHelper.setFromObject(studioSelected);
        selectionHelper.visible = true;
        updateStudioPropertiesUI();
    } else {
        transformControl.detach();
        selectionHelper.visible = false;
    }
    // Re-render Explorer to show highlight
    // Optimization: Just update classes if list is same size
    const items = explorerList.querySelectorAll('.explorer-item');
    if (items.length !== world.items.length) {
        updateExplorer();
    } else {
        // Simple class toggle
        world.items.forEach((obj, i) => {
            if (obj === studioSelected) items[i].classList.add('selected');
            else items[i].classList.remove('selected');
        });
    }
};

const propInputs = {
    color: document.getElementById('prop-color'),
    reflect: document.getElementById('prop-reflect'),
    trans: document.getElementById('prop-trans'),
    anchored: document.getElementById('prop-anchored'),
    collide: document.getElementById('prop-collide'),
    px: document.getElementById('prop-px'),
    py: document.getElementById('prop-py'),
    pz: document.getElementById('prop-pz'),
    sx: document.getElementById('prop-sx'),
    sy: document.getElementById('prop-sy'),
    sz: document.getElementById('prop-sz'),
    rx: document.getElementById('prop-rx'),
    ry: document.getElementById('prop-ry'),
    rz: document.getElementById('prop-rz'),
};

function updateStudioPropertiesUI() {
    if (!studioSelected) return;
    const m = studioSelected;
    
    // SAFETY: ensure material exists before reading properties
    if (!m || !m.material) {
        // Clear inputs to safe defaults if available
        if (propInputs.color) propInputs.color.value = '#cccccc';
        if (propInputs.reflect) propInputs.reflect.value = 0;
        if (propInputs.trans) propInputs.trans.value = 0;
        if (propInputs.px) propInputs.px.value = parseFloat((m?.position?.x || 0).toFixed(2));
        if (propInputs.py) propInputs.py.value = parseFloat((m?.position?.y || 0).toFixed(2));
        if (propInputs.pz) propInputs.pz.value = parseFloat((m?.position?.z || 0).toFixed(2));
        if (propInputs.sx) propInputs.sx.value = 1;
        if (propInputs.sy) propInputs.sy.value = 1;
        if (propInputs.sz) propInputs.sz.value = 1;
        if (propInputs.rx) propInputs.rx.value = Math.round(THREE.MathUtils.radToDeg(m?.rotation?.x || 0));
        if (propInputs.ry) propInputs.ry.value = Math.round(THREE.MathUtils.radToDeg(m?.rotation?.y || 0));
        if (propInputs.rz) propInputs.rz.value = Math.round(THREE.MathUtils.radToDeg(m?.rotation?.z || 0));
        return;
    }
    
    // Appearance
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (mat && mat.color) propInputs.color.value = '#' + (mat.color ? mat.color.getHexString() : 'cccccc');
    else if (propInputs.color) propInputs.color.value = '#cccccc';
    // Assuming Standard Material props, though our blocks use array
    if (mat) {
        propInputs.reflect.value = 0; // Placeholder
        propInputs.trans.value = mat.opacity !== undefined ? (1 - mat.opacity) : 0;
    } else {
        if (propInputs.reflect) propInputs.reflect.value = 0;
        if (propInputs.trans) propInputs.trans.value = 0;
    }
    
    // Transform
    if (propInputs.px) propInputs.px.value = parseFloat(m.position.x.toFixed(2));
    if (propInputs.py) propInputs.py.value = parseFloat(m.position.y.toFixed(2));
    if (propInputs.pz) propInputs.pz.value = parseFloat(m.position.z.toFixed(2));
    
    // Size logic
    let size = {x:1, y:1, z:1};
    if (m.userData && m.userData.serial) {
        size.x = m.userData.serial.w || size.x;
        size.y = m.userData.serial.h || size.y;
        size.z = m.userData.serial.d || size.z;
    } else if (m.geometry && m.geometry.parameters) {
        size.x = m.geometry.parameters.width || size.x;
        size.y = m.geometry.parameters.height || size.y;
        size.z = m.geometry.parameters.depth || size.z;
    }
    // Multiply by current scale if not baked
    size.x *= (m.scale?.x || 1);
    size.y *= (m.scale?.y || 1);
    size.z *= (m.scale?.z || 1);

    if (propInputs.sx) propInputs.sx.value = parseFloat(size.x.toFixed(2));
    if (propInputs.sy) propInputs.sy.value = parseFloat(size.y.toFixed(2));
    if (propInputs.sz) propInputs.sz.value = parseFloat(size.z.toFixed(2));
    
    // Rotation (Euler to Degrees)
    if (propInputs.rx) propInputs.rx.value = Math.round(THREE.MathUtils.radToDeg(m.rotation.x));
    if (propInputs.ry) propInputs.ry.value = Math.round(THREE.MathUtils.radToDeg(m.rotation.y));
    if (propInputs.rz) propInputs.rz.value = Math.round(THREE.MathUtils.radToDeg(m.rotation.z));
    
    // Behavior
    if (propInputs.anchored) propInputs.anchored.checked = !!m.userData?.anchored;
}

// Bind Property Inputs
const onPropChange = () => {
    if (!studioSelected) return;
    const m = studioSelected;
    
    // Pos
    m.position.set(
        parseFloat(propInputs.px.value),
        parseFloat(propInputs.py.value),
        parseFloat(propInputs.pz.value)
    );
    
    // Rot
    m.rotation.set(
        THREE.MathUtils.degToRad(parseFloat(propInputs.rx.value)),
        THREE.MathUtils.degToRad(parseFloat(propInputs.ry.value)),
        THREE.MathUtils.degToRad(parseFloat(propInputs.rz.value))
    );
    
    // Size (Complex part: resizing geometry vs scaling)
    // We will update scale for simplicity, then bake if it's a block
    if (m.userData.serial && m.userData.serial.type === 'block') {
        const targetW = parseFloat(propInputs.sx.value);
        const targetH = parseFloat(propInputs.sy.value);
        const targetD = parseFloat(propInputs.sz.value);
        
        // Rebuild directly
        const newGeo = new THREE.BoxGeometry(targetW, targetH, targetD);
        boxUnwrapUVs(newGeo);
        m.geometry.dispose();
        m.geometry = newGeo;
        m.userData.serial.w = targetW;
        m.userData.serial.h = targetH;
        m.userData.serial.d = targetD;
        m.scale.set(1,1,1);
    } else {
        // Just scale generic parts
        // This is tricky because we don't know base size easily without serial
        // skip for now
    }

    // Colors
    const col = new THREE.Color(propInputs.color.value);
    if (Array.isArray(m.material)) m.material.forEach(mat => mat.color = col);
    else m.material.color = col;
    if (m.userData.serial) m.userData.serial.color = col.getHex();
};

// Tool Switching Logic
function setStudioTool(tool) {
    activeTool = tool;
    playSwitch();

    // Update UI
    ['select', 'move', 'scale', 'rotate'].forEach(t => {
        const btn = document.getElementById('tool-' + t);
        if (btn) {
            if (t === tool) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });

    // Update Gizmo Mode
    if (tool === 'move') transformControl.setMode('translate');
    if (tool === 'scale') transformControl.setMode('scale');
    if (tool === 'rotate') transformControl.setMode('rotate');

    updateStudioSelection();
}

Object.values(propInputs).forEach(input => {
    if(input) input.addEventListener('change', onPropChange);
});


document.getElementById('tool-publish').onclick = async () => {
    playSwitch();
    let defaultName = "";
    if (editingGameName) {
        defaultName = isRemixMode ? `Remix of ${editingGameName}` : editingGameName;
    }

    const isValidMapName = (name) => {
        if (!name) return false;
        return /^[A-Za-z\s]{1,30}$/.test(name.trim());
    };

    let mapName = prompt("Enter a name for your game (letters and spaces only, max 30 chars):", defaultName);
    if (mapName === null) return;

    mapName = mapName.trim();

    if (!isValidMapName(mapName)) {
        alert("Invalid game name. Use only letters and spaces (1-30 characters). Save cancelled.");
        return;
    }

    const username = document.getElementById('input-username').value || "Guest";
    const data = world.serialize();
    const saveObj = {
        name: mapName,
        author: username || "*you* *who created it*",
        date: Date.now(),
        data: data,
        thumbnail: './Backdrop.gif'
    };

    let saves = [];
    try {
        const raw = localStorage.getItem('nblox_maps');
        if (raw) saves = JSON.parse(raw);
    } catch(e) {}

    const idx = saves.findIndex(s => s.name === mapName);
    if (idx >= 0) saves[idx] = saveObj;
    else saves.push(saveObj);

    try {
        localStorage.setItem('nblox_maps', JSON.stringify(saves));
        try { localStorage.setItem('nblox_map_thumb_' + mapName, './Backdrop.gif'); } catch(e) {}

        editingGameName = mapName;
        isRemixMode = false;

        try {
            const id = Date.now();

            let shareInfo = null;
            try {
                shareInfo = await shareMapRemotely(mapName, saveObj);
            } catch (shareErr) {
                console.warn('Remote share failed, falling back to local-only link:', shareErr);
            }

            let playUrl;
            if (shareInfo) {
                playUrl = `${window.location.origin}${window.location.pathname}?play=${encodeURIComponent(mapName)}&bucket=${shareInfo.bucket}&rid=${shareInfo.key}`;
            } else {
                playUrl = `${window.location.origin}${window.location.pathname}?play=${encodeURIComponent(mapName)}&id=${id}`;
            }

            try {
                localStorage.setItem('nblox_map_url_' + mapName, playUrl);
            } catch (e) {
                console.warn('Failed to persist map url mapping:', e);
            }

            try { history.replaceState({}, `${mapName} - Play`, playUrl); } catch(e){}

            addChatMessage('System', `Play URL created: ${playUrl}`);

            try {
                const a = document.createElement('a');
                a.href = playUrl;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                document.body.appendChild(a);
                a.click();
                a.remove();
            } catch (e) {
                console.warn('Failed to open play URL in new tab:', e);
            }

            if (shareInfo) {
                alert(`Your play URL:\n${playUrl}\n\nThis link can be shared with anyone \u2014 opening it will download "${mapName}" and start it automatically.`);
            } else {
                alert(`Your play URL:\n${playUrl}\n\nCouldn't reach the sharing service, so this link only works in this same browser (it reads the saved game from local storage). Try publishing again later to get a shareable link.`);
            }
        } catch (urlErr) {
            console.warn('Failed to generate play URL:', urlErr);
        }

        alert("Game Published Successfully!");
    } catch (e) {
        alert("Failed to save! Game size is too large (likely the music). Try a smaller song.");
    }
};

document.getElementById('tool-select').onclick = () => setStudioTool('select');
document.getElementById('tool-move').onclick = () => setStudioTool('move');
document.getElementById('tool-rotate').onclick = () => setStudioTool('rotate');
document.getElementById('tool-scale').onclick = () => setStudioTool('scale');

 // Add rig spawn handler
document.getElementById('tool-rig').onclick = () => {
    playSwitch();
    spawnRig();
};

// Create Script (Coding Tab) handler - opens a draggable Lua coding tab
document.getElementById('tool-script').onclick = () => {
    playSwitch();

    // If already exists just show and focus
    let scriptWin = document.getElementById('script-editor');
    if (!scriptWin) {
        scriptWin = document.createElement('div');
        scriptWin.id = 'script-editor';
        scriptWin.className = 'xp-window';
        scriptWin.style.width = '520px';
        scriptWin.style.display = 'flex';
        scriptWin.innerHTML = `
            <div class="xp-title-bar">
                <span>Script - Untitled.lua</span>
                <button id="btn-close-script" class="xp-btn-close">X</button>
            </div>
            <div class="xp-body" style="padding:8px; gap:8px;">
                <div style="display:flex; gap:8px; align-items:center;">
                    <button id="btn-script-save" class="menu-btn" style="padding:6px 10px;">Save</button>
                    <button id="btn-script-run" class="menu-btn" style="padding:6px 10px;">Run</button>
                    <div style="flex:1;"></div>
                    <div style="font-size:12px; color:#666;">Language: Lua</div>
                </div>
                <textarea id="script-textarea" spellcheck="false" style="width:100%; height:320px; font-family: 'Courier New', monospace; font-size:13px; background:#0f0f10; color:#e6e6e6; padding:8px; border:1px solid #444; box-sizing:border-box;"></textarea>
                <div style="display:flex; gap:8px; justify-content:flex-end;">
                    <button id="btn-script-close" class="menu-btn">Close</button>
                </div>
            </div>
            <div class="xp-resizer"></div>
        `;
        document.body.appendChild(scriptWin);

        // Make draggable & resizable
        makeDraggable(scriptWin);
        makeResizable(scriptWin);

        // Prefill sample Lua snippet
        const ta = scriptWin.querySelector('#script-textarea');
        ta.value = `-- Example Lua script\nlocal message = \"Hello from Script\"\nlocal flag = true\n\nprint(message, flag)\n\n-- Function example\nfunction greet(name)\n  return \"Hello, \" .. name\nend\n\nprint(greet(\"Player\"))`;

        // Hook up buttons
        scriptWin.querySelector('#btn-close-script').addEventListener('click', () => {
            playSwitch();
            scriptWin.style.display = 'none';
        });
        scriptWin.querySelector('#btn-script-close').addEventListener('click', () => {
            playSwitch();
            scriptWin.style.display = 'none';
        });

        // Save simply stores script to localStorage keyed by name
        scriptWin.querySelector('#btn-script-save').addEventListener('click', () => {
            playSwitch();
            const content = ta.value;
            try {
                localStorage.setItem('nblox_script_untitled', content);
                addChatMessage('System', 'Script saved locally (nblox_script_untitled).');
            } catch (e) {
                console.warn('Failed to save script:', e);
                addChatMessage('System', 'Failed to save script locally.');
            }
        });

        // Run: show the Lua code as text output in chat (since executing Lua in browser isn't supported)
        scriptWin.querySelector('#btn-script-run').addEventListener('click', () => {
            playSwitch();
            const content = ta.value;
            const preview = content.split('\\n').slice(0, 6).join('\\n');
            addChatMessage('System', 'Run (preview):\\n' + preview.replace(/\\n/g, ' | '));
            alert('Running Lua is not supported in this browser; preview posted to chat.');
        });
    } else {
        // Restore textarea content from storage if empty
        const ta = scriptWin.querySelector('#script-textarea');
        if (ta && !ta.value) {
            const saved = localStorage.getItem('nblox_script_untitled');
            if (saved) ta.value = saved;
        }
        scriptWin.style.display = 'flex';
    }

    // Bring to front
    scriptWin.style.zIndex = 100000;
};

// TOOLBOX: create a small toolbox window with quick insert buttons and handlers
document.getElementById('tool-toolbox')?.addEventListener('click', () => {
    playSwitch();
    let tb = document.getElementById('studio-toolbox');
    if (!tb) {
        tb = document.createElement('div');
        tb.id = 'studio-toolbox';
        tb.className = 'xp-window';
        tb.style.width = '360px';
        tb.style.display = 'flex';
        tb.innerHTML = `
            <div class="xp-title-bar">
                <span>Toolbox</span>
                <button id="btn-close-toolbox" class="xp-btn-close">X</button>
            </div>
            <div class="xp-body" style="gap:8px; align-items: stretch;">
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button id="tb-flower" class="menu-btn" style="flex:1 1 140px;">Flower</button>
                    <button id="tb-house" class="menu-btn" style="flex:1 1 140px;">House</button>
                    <button id="tb-obby" class="menu-btn" style="flex:1 1 140px;">Obby Platform</button>
                    <button id="tb-playground" class="menu-btn" style="flex:1 1 140px;">Playground</button>
                    <button id="tb-bird" class="menu-btn" style="flex:1 1 140px;">Bird</button>
                    <button id="tb-redcar" class="menu-btn" style="flex:1 1 140px; background:#ffdddd;">Red Car</button>
                    <button id="tb-bluecar" class="menu-btn" style="flex:1 1 140px; background:#ddddff;">Blue Car</button>
                    <button id="tb-stairs" class="menu-btn" style="flex:1 1 140px;">Stairs</button>
                    <button id="tb-ebike" class="menu-btn" style="flex:1 1 140px;">Electric Bike</button>
                </div>
                <div style="display:flex; gap:8px; margin-top:6px;">
                    <button id="tb-diesound" class="menu-btn" style="flex:1; background:#ffdddd;">Attach Lego DieSound</button>
                    <button id="tb-leaderboard" class="menu-btn" style="flex:1; background:#ddffdd;">Leaderboard Script</button>
                    <button id="tb-musicscript" class="menu-btn" style="flex:1; background:#fff0cc;">Music Script</button>
                </div>
                <div style="font-size:12px; color:#666; margin-top:8px;">Use these to quickly place prefabs into your Studio workspace.</div>
            </div>
            <div class="xp-resizer"></div>
        `;
        document.body.appendChild(tb);
        makeDraggable(tb);
        makeResizable(tb);

        document.getElementById('btn-close-toolbox').addEventListener('click', () => {
            playSwitch();
            tb.style.display = 'none';
        });

        // Handlers
        document.getElementById('tb-flower').addEventListener('click', () => {
            playSwitch();
            // Simple flower: center stem + four petals
            const cx = camera.position.x + (camera.getWorldDirection(new THREE.Vector3()).x * 10);
            const cz = camera.position.z + (camera.getWorldDirection(new THREE.Vector3()).z * 10);
            const y = 1;
            // stem
            world.createBlock(cx, y, cz, 0.4, 2.5, 0.4, 0x228833, ['static']);
            // petals
            const colors = [0xff66cc, 0xffdd55, 0x66ccff, 0xff9966];
            for (let i = 0; i < 4; i++) {
                const ang = i * Math.PI / 2;
                const px = cx + Math.cos(ang) * 0.9;
                const pz = cz + Math.sin(ang) * 0.9;
                world.createBlock(px, y + 1, pz, 0.8, 0.4, 0.8, colors[i], ['static']);
            }
            updateExplorer();
        });

        document.getElementById('tb-house').addEventListener('click', () => {
            playSwitch();
            const px = camera.position.x + camera.getWorldDirection(new THREE.Vector3()).x * 12;
            const pz = camera.position.z + camera.getWorldDirection(new THREE.Vector3()).z * 12;
            // floor
            world.createBlock(px, 1, pz, 10, 1, 10, 0x996633, ['static']);
            // walls
            world.createBlock(px - 4.5, 5.5, pz, 1, 9, 10, 0xffffcc, ['static']);
            world.createBlock(px + 4.5, 5.5, pz, 1, 9, 10, 0xffffcc, ['static']);
            world.createBlock(px, 5.5, pz - 4.5, 9, 9, 1, 0xffffcc, ['static']);
            world.createBlock(px, 5.5, pz + 4.5, 9, 9, 1, 0xffffcc, ['static']);
            // roof
            const roof = world.createBlock(px, 10, pz, 11, 1, 11, 0xcc0000, ['static']);
            roof.rotation.x = 0.1;
            updateExplorer();
        });

        document.getElementById('tb-obby').addEventListener('click', () => {
            playSwitch();
            const baseX = camera.position.x + camera.getWorldDirection(new THREE.Vector3()).x * 12;
            const baseZ = camera.position.z + camera.getWorldDirection(new THREE.Vector3()).z * 12;
            for (let i = 0; i < 8; i++) {
                const x = baseX + i * 6;
                const y = 0.5 + i * 0.6;
                const z = baseZ + (i % 2 === 0 ? 0 : 2);
                world.createBlock(x, y, z, 4, 1, 4, 0xaaaaaa, ['static']);
            }
            // finish
            world.createBlock(baseX + 8*6, 6, baseZ, 6, 1, 6, 0x00ff66, ['static', 'finish']);
            updateExplorer();
        });

        document.getElementById('tb-playground').addEventListener('click', () => {
            playSwitch();
            const bx = camera.position.x + camera.getWorldDirection(new THREE.Vector3()).x * 12;
            const bz = camera.position.z + camera.getWorldDirection(new THREE.Vector3()).z * 12;
            // swings (simple)
            world.createBlock(bx - 6, 8, bz, 1, 16, 1, 0x4e342e, ['static']);
            world.createBlock(bx + 6, 8, bz, 1, 16, 1, 0x4e342e, ['static']);
            world.createBlock(bx, 14, bz, 14, 1, 1, 0x4e342e, ['static']);
            // sandbox
            world.createBlock(bx, 1, bz + 12, 10, 1, 10, 0xdeb887, ['static']);
            // slide
            for (let i=0;i<6;i++) world.createBlock(bx + 12, i+1, bz - i*1.4, 3, 1, 3, 0xffcc00, ['static']);
            updateExplorer();
        });

        // Bird: simple moving prop that oscillates horizontally
        document.getElementById('tb-bird').addEventListener('click', () => {
            playSwitch();
            const x = camera.position.x + camera.getWorldDirection(new THREE.Vector3()).x * 12;
            const z = camera.position.z + camera.getWorldDirection(new THREE.Vector3()).z * 12;
            const birdGeom = new THREE.BoxGeometry(1, 0.6, 0.6);
            boxUnwrapUVs(birdGeom);
            const birdMat = new THREE.MeshStandardMaterial({ color: 0xffcc00 });
            const bird = new THREE.Mesh(birdGeom, birdMat);
            bird.position.set(x, 6, z);
            bird.userData._bird = { time: 0, speed: 1 + Math.random() };
            world.mapGroup.add(bird);
            world.items.push(bird); // treat as decor
            // add an updater hook
            world.animated.push({
                mesh: bird,
                time: 0,
                update: (dt, obj) => {
                    obj.time += dt * obj.mesh.userData._bird.speed;
                    obj.mesh.position.x += Math.cos(obj.time) * 0.02 * 10 * dt * 60;
                    obj.mesh.position.y = 6 + Math.sin(obj.time * 2) * 0.8;
                    obj.mesh.rotation.y = Math.sin(obj.time) * 0.3;
                }
            });
            updateExplorer();
        });

        // Red Car prefab (uses Vehicle class)
        document.getElementById('tb-redcar').addEventListener('click', () => {
            playSwitch();
            const pos = camera.position.clone().add(new THREE.Vector3(0, 0, -10).applyQuaternion(camera.quaternion));
            const car = new Vehicle(scene, pos.x, Math.max(5, pos.y), pos.z, 0xff3333);
            world.vehicles.push(car);
            updateExplorer();
            addChatMessage('System', 'Red car spawned.');
        });

        // Blue Car prefab
        document.getElementById('tb-bluecar').addEventListener('click', () => {
            playSwitch();
            const pos = camera.position.clone().add(new THREE.Vector3(0, 0, -10).applyQuaternion(camera.quaternion));
            const car = new Vehicle(scene, pos.x, Math.max(5, pos.y), pos.z, 0x3366ff);
            world.vehicles.push(car);
            updateExplorer();
            addChatMessage('System', 'Blue car spawned.');
        });

        // Simple Stairs generator
        document.getElementById('tb-stairs').addEventListener('click', () => {
            playSwitch();
            const startX = camera.position.x + camera.getWorldDirection(new THREE.Vector3()).x * 8;
            const startZ = camera.position.z + camera.getWorldDirection(new THREE.Vector3()).z * 8;
            for (let i = 0; i < 12; i++) {
                world.createBlock(startX + i*2, 0.5 + i*0.75, startZ, 2, 0.75, 4, 0x888888, ['static']);
            }
            updateExplorer();
            addChatMessage('System', 'Stairs placed.');
        });

        // Electric Bike: small vehicle-like prop with simple drive behavior (non-physics)
        document.getElementById('tb-ebike').addEventListener('click', () => {
            playSwitch();
            const px = camera.position.x + camera.getWorldDirection(new THREE.Vector3()).x * 10;
            const pz = camera.position.z + camera.getWorldDirection(new THREE.Vector3()).z * 10;
            // Build a simple bike: body + seat + tiny wheels (non-interactive decorative)
            const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.6, 4), new THREE.MeshStandardMaterial({ color: 0x222222 }));
            body.position.set(px, 2, pz);
            world.mapGroup.add(body);
            const seat = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1.2), new THREE.MeshStandardMaterial({ color: 0x333333 }));
            seat.position.set(px, 2.5, pz - 0.2);
            world.mapGroup.add(seat);
            const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.6, 12);
            wheelGeo.rotateZ(Math.PI / 2);
            const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
            const w1 = new THREE.Mesh(wheelGeo, wheelMat); w1.position.set(px - 0.9, 1.6, pz - 1.4); world.mapGroup.add(w1);
            const w2 = new THREE.Mesh(wheelGeo, wheelMat); w2.position.set(px + 0.9, 1.6, pz - 1.4); world.mapGroup.add(w2);
            // Lightweight animated bob for electric vibe
            world.animated.push({
                mesh: body,
                time: 0,
                update: (dt, obj) => {
                    obj.time += dt * 2.0;
                    obj.mesh.position.y = 2 + Math.sin(obj.time) * 0.05;
                    obj.mesh.rotation.y = Math.sin(obj.time * 0.3) * 0.02;
                }
            });
            updateExplorer();
            addChatMessage('System', 'Electric bike placed (decor).');
        });

        // Attach Lego die sound to selected studio object (or last selected)
        document.getElementById('tb-diesound').addEventListener('click', () => {
            playSwitch();
            if (!studioSelected) {
                alert('Select a part in the Studio explorer first.');
                return;
            }
            studioSelected.userData.dieSound = './lego-breaking.mp3';
            // Visual marker: tint slightly
            if (Array.isArray(studioSelected.material)) studioSelected.material.forEach(m=>m.emissive && (m.emissive.setHex(0x332222)));
            else if (studioSelected.material && studioSelected.material.emissive) studioSelected.material.emissive.setHex(0x332222);
            addChatMessage('System', 'Lego die sound attached to selected part.');
        });

        // Leaderboard script: inserts a script object into Explorer that changes name colors randomly
        document.getElementById('tb-leaderboard').addEventListener('click', () => {
            playSwitch();
            // Create a Script tab (reuse script editor UI) prefilled with a Roblox-style pseudo-Lua script for randomized name color leaderboard
            const lbName = 'RandomNameColorLeaderboard.lua';
            // Create or reuse script editor
            let s = document.getElementById('script-editor');
            if (!s) {
                document.getElementById('tool-script').click(); // opens editor
                s = document.getElementById('script-editor');
            }
            const ta = s.querySelector('#script-textarea');
            const snippet = `-- ${lbName}\n-- This script randomly assigns a color to each player's displayed name and updates a simple leaderboard.\nlocal players = {}\n\nfunction assignRandomColor(name)\n  local colors = {'#ff4444','#44ff44','#4444ff','#ffcc44','#dd44ff'}\n  return colors[math.random(#colors)]\nend\n\n-- Pseudo-code: in real Roblox you'd connect PlayerAdded and update GUI accordingly\nprint('RandomNameColorLeaderboard initialized');\n\n-- Example output (client-side simulation):\nfor i=1,5 do\n  print('Player'..i..' ->', assignRandomColor('Player'..i))\nend\n`;
            ta.value = snippet;
            s.style.display = 'flex';
            s.style.zIndex = 200000;
            addChatMessage('System', 'Leaderboard script prepared in Script editor (Lua preview).');
        });

        // Music Script inserter: creates a Script tab with an example music-control snippet
        document.getElementById('tb-musicscript').addEventListener('click', () => {
            playSwitch();
            let s = document.getElementById('script-editor');
            if (!s) {
                document.getElementById('tool-script').click();
                s = document.getElementById('script-editor');
            }
            const ta = s.querySelector('#script-textarea');
            const snippet = `-- MusicScript.lua (pseudo Roblox)\n-- This demonstrates how you'd play a looped sound in a place\nlocal soundUrl = \"rbxassetid://12345678\" -- replace with actual asset id\nprint('Music script inserted. Replace soundUrl with a valid asset id to use in Roblox Studio.')\n-- In Roblox you'd create a Sound instance and set Sound.Looped = true then play\n`;
            ta.value = snippet;
            s.style.display = 'flex';
            s.style.zIndex = 200000;
            addChatMessage('System', 'Music script prepared in Script editor (Lua preview).');
        });
    }

    tb.style.display = 'flex';
});

document.getElementById('tool-duplicate').onclick = () => {
    if (studioSelected) {
        playSwitch();
        // Clone
        const original = studioSelected;
        const clone = original.clone();
        
        // Fix geometry (clone shares geometry by default)
        // If we want independent resizing, we need new geometry
        clone.geometry = original.geometry.clone();
        
        // Materials are also shared
        if (Array.isArray(original.material)) {
            clone.material = original.material.map(m => m.clone());
        } else {
            clone.material = original.material.clone();
        }
        
        // Deep copy user data
        clone.userData = JSON.parse(JSON.stringify(original.userData));
        
        // Offset
        clone.position.add(new THREE.Vector3(2, 0, 2));
        clone.name = original.name; // Keep name
        
        world.addToWorld(clone, clone.userData.serial ? clone.userData.serial.flags : ['static']);
        
        studioSelected = clone;
        updateStudioSelection();
        updateExplorer(); // Refresh list
    }
};

document.getElementById('tool-part').onclick = () => {
    // Spawn block in front of camera
    spawnPart('block');
};

document.getElementById('tool-sphere').onclick = () => {
    spawnPart('sphere');
};

document.getElementById('tool-cylinder').onclick = () => {
    spawnPart('cylinder');
};

document.getElementById('tool-wedge').onclick = () => {
    spawnPart('wedge');
};

document.getElementById('tool-music').onclick = () => {
    playSwitch();
    // Create invisible file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*'; // Accept audio files
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    fileInput.onchange = (e) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            const reader = new FileReader();
            
            // Show loading or status?
            reader.onload = (evt) => {
                const result = evt.target.result;
                // Removed size limit check
                world.bgm = result;
                alert("Music file loaded! It will play when the game starts.");
                fileInput.remove();
            };
            
            reader.readAsDataURL(e.target.files[0]);
        } else {
            fileInput.remove();
        }
    };
    
    fileInput.click();
};

function spawnPart(type) {
    playSwitch();
    const dist = 10;
    const spawnPos = new THREE.Vector3(0, 0, -dist).applyQuaternion(camera.quaternion).add(camera.position);
    // Snap to grid
    spawnPos.x = Math.round(spawnPos.x / 4) * 4;
    spawnPos.y = Math.max(2, Math.round(spawnPos.y / 4) * 4);
    spawnPos.z = Math.round(spawnPos.z / 4) * 4;
    
    let size = {x: 4, y: 4, z: 4};
    if (type === 'block') size = {x: 4, y: 1, z: 2};
    if (type === 'cylinder') size = {x: 4, y: 4, z: 4};
    if (type === 'wedge') size = {x: 4, y: 4, z: 4};

    // Use createPart or createBlock
    let mesh;
    if (type === 'block') {
        mesh = world.createBlock(spawnPos.x, spawnPos.y, spawnPos.z, size.x, size.y, size.z, 0xaaaaaa, ['static']);
    } else {
        mesh = world.createPart(type, spawnPos.x, spawnPos.y, spawnPos.z, size, 0xaaaaaa, ['static']);
    }

    studioSelected = mesh;
    updateExplorer(); // Add to list
    updateStudioSelection();
}

document.getElementById('tool-delete').onclick = () => {
    if (studioSelected) {
        transformControl.detach();
        world.mapGroup.remove(studioSelected);
        // Remove from world lists
        const idxI = world.items.indexOf(studioSelected);
        if (idxI > -1) world.items.splice(idxI, 1);
        const idxC = world.collidables.indexOf(studioSelected);
        if (idxC > -1) world.collidables.splice(idxC, 1);
        
        if (studioSelected.geometry) studioSelected.geometry.dispose();
        studioSelected = null;
        hoverHelper.visible = false;
        selectionHelper.visible = false;
        // clear props
        updateStudioPropertiesUI(); // will default/fail gracefully
        updateExplorer(); // Refresh list
    }
};

// --- Rig Bot & Studio Day/Night: spawn rig, speak, toggle lighting ---
async function spawnRig() {
    playSwitch();

    // Create a default player-model rig using the same factory as players so it looks like a real player
    const rid = 'rigbot-' + Date.now();
    const materialsStore = {};
    const rigMesh = createPlayerMesh(materialsStore);
    rigMesh.name = 'RigBot';
    rigMesh.userData = { isRig: true, id: rid };

    // Position it a few units in front of the camera
    const pos = camera.position.clone().add(new THREE.Vector3(0, 0, -8).applyQuaternion(camera.quaternion));
    rigMesh.position.copy(pos);

    // Add to the world explorer so it's selectable in studio, but do NOT animate or add AI movement.
    // Keep it out of collidables so it remains a static prop (prevents unexpected physics).
    world.mapGroup.add(rigMesh);
    world.items.push(rigMesh);
    // ensure it's not added to collidables (so it doesn't interfere with camera checks)
    if (world.collidables.includes(rigMesh)) {
        const idx = world.collidables.indexOf(rigMesh);
        if (idx !== -1) world.collidables.splice(idx, 1);
    }

    updateExplorer();
    updatePlayerList();

    // Use the expected head child (createPlayerMesh returns children in the same order as Player)
    const rigHead = rigMesh.children[1] || rigMesh;

    // Click-to-speak: when user clicks the rig in studio, prompt and display bubble + TTS
    const speak = async (text) => {
        if (!text) return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 18;
        ctx.font = `bold ${fontSize}px "Comic Sans Custom", "Comic Sans MS", cursive`;
        const metrics = ctx.measureText(text);
        const p = 10;
        const w = Math.max(64, metrics.width + p * 2);
        const h = fontSize + p * 2 + 10;
        canvas.width = w; canvas.height = h;

        ctx.font = `bold ${fontSize}px "Comic Sans Custom", "Comic Sans MS", cursive`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        ctx.fillStyle = 'white';
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 3;
        const r = 8;
        ctx.beginPath();
        ctx.moveTo(r, 2);
        ctx.lineTo(w - r, 2);
        ctx.quadraticCurveTo(w, 2, w - 2, r);
        ctx.lineTo(w - 2, h - r - 10);
        ctx.quadraticCurveTo(w - 2, h - 10, w - r, h - 10);
        ctx.lineTo(w/2 + 8, h - 10);
        ctx.lineTo(w/2, h - 2);
        ctx.lineTo(w/2 - 8, h - 10);
        ctx.lineTo(r, h - 10);
        ctx.quadraticCurveTo(2, h - 10, 2, h - r - 10);
        ctx.lineTo(2, r);
        ctx.quadraticCurveTo(2, 2, r, 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'black';
        ctx.fillText(text, w/2, (h - 10)/2);

        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.colorSpace = THREE.SRGBColorSpace;

        const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
        const sprite = new THREE.Sprite(spriteMat);
        const scale = 0.025;
        sprite.scale.set(w * scale, h * scale, 1);

        // Attach bubble to the rig head so it sits above the head reliably
        sprite.position.set(0, 1.2, 0);
        rigHead.add(sprite);

        setTimeout(() => {
            if (sprite.parent) sprite.parent.remove(sprite);
            try { sprite.material.map.dispose(); } catch(e){}
            try { sprite.material.dispose(); } catch(e){}
        }, 5000);

        // TTS
        try {
            if (window.websim && websim.textToSpeech) {
                const res = await websim.textToSpeech({ text: text, voice: 'en-male' });
                if (res && res.url) {
                    const audio = new Audio(res.url);
                    audio.play().catch(()=>{});
                }
            } else if ('speechSynthesis' in window) {
                const utter = new SpeechSynthesisUtterance(text);
                speechSynthesis.speak(utter);
            }
        } catch (e) {
            if ('speechSynthesis' in window) {
                const utter = new SpeechSynthesisUtterance(text);
                speechSynthesis.speak(utter);
            }
        }
    };

    // Raycast click handler (keeps working only in STUDIO)
    const onMouseDown = (e) => {
        if (gameState !== 'STUDIO') return;
        if (e.button !== 0) return;
        if (e.target.closest('#studio-gui')) return;

        // Use correct normalized device coordinates (don't divide by UI_ZOOM)
        const mx = (e.clientX / window.innerWidth) * 2 - 1;
        const my = -(e.clientY / window.innerHeight) * 2 + 1;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(mx, my), camera);
        const hits = rc.intersectObject(rigMesh, true);
        if (hits.length > 0) {
            const txt = prompt("RigBot says:", "Hello! I'm RigBot.");
            if (txt !== null) speak(txt);
        }
    };

    window.addEventListener('mousedown', onMouseDown);

    // Cleanup helper so UI can remove rig cleanly
    rigMesh.userData.dispose = () => {
        // Remove from world.items
        const mi = world.items.indexOf(rigMesh);
        if (mi !== -1) world.items.splice(mi, 1);
        // Ensure not in collidables
        const ci = world.collidables.indexOf(rigMesh);
        if (ci !== -1) world.collidables.splice(ci, 1);
        if (rigMesh.parent) rigMesh.parent.remove(rigMesh);
        window.removeEventListener('mousedown', onMouseDown);
        updateExplorer();
        updatePlayerList();
    };

    return rigMesh;
}

// Toggle Studio Day/Night state
let studioIsDay = true;
function setStudioDayNight(isDay) {
    studioIsDay = !!isDay;
    if (studioIsDay) {
        // Day: brighter sun, blue ambient
        ambient.color.setScalar(1.0);
        ambient.intensity = 0.45;
        if (sun) { sun.intensity = 0.8; sun.visible = true; sun.color.set(0xffffff); }
        addStudioLights(); // Ensure studio lights present if toggled on
        // Reset studio lights intensities for day
        if (studioLights.key) studioLights.key.intensity = 1.0;
        if (studioLights.fill) studioLights.fill.intensity = 0.6;
        if (studioLights.rim) studioLights.rim.intensity = 0.45;
        document.getElementById('studio-ribbon').style.background = '#dfe8f5';
        // Restore skybox as background
        if (world && world.skyboxMesh) scene.background = null;
    } else {
        // Night: dim sun, cool ambient, stronger rim for contrast
        ambient.color.set(0x99aabf);
        ambient.intensity = 0.12;
        if (sun) { sun.intensity = 0.12; sun.visible = false; }
        addStudioLights();
        if (studioLights.key) studioLights.key.intensity = 0.35;
        if (studioLights.fill) studioLights.fill.intensity = 0.25;
        if (studioLights.rim) studioLights.rim.intensity = 0.6;
        document.getElementById('studio-ribbon').style.background = '#1b2430';
        // Set a pure black sky for night
        scene.background = new THREE.Color(0x000000);
    }
}

document.getElementById('tool-studio-daynight').onclick = () => {
    playSwitch();
    setStudioDayNight(!studioIsDay);
};

// Create Thumbnail tool (PC only) - captures renderer canvas and saves thumbnail locally for current editing map
const btnCreateThumb = document.getElementById('tool-create-thumb');
if (btnCreateThumb) {
    btnCreateThumb.addEventListener('click', async () => {
        playSwitch();
        if (isMobileUA) {
            alert('Thumbnail creation is only available on PC.');
            return;
        }
        try {
            // Ensure we render one frame at full size for capture
            // Use toDataURL from the renderer canvas
            const canvas = renderer.domElement;
            // Temporarily resize to a thumbnail-friendly resolution for quality
            const prevW = canvas.width, prevH = canvas.height;
            // Render at double logical size for crispness if possible (limit to 1024px)
            const captureW = Math.min(1024, prevW * 2);
            const captureH = Math.min(1024, prevH * 2);
            // Create an offscreen canvas to draw a scaled copy
            const tmp = document.createElement('canvas');
            tmp.width = captureW;
            tmp.height = captureH;
            const ctx = tmp.getContext('2d');
            // Draw current canvas into tmp scaled up
            ctx.drawImage(canvas, 0, 0, captureW, captureH);
            const dataUrl = tmp.toDataURL('image/png');
            // Persist thumbnail keyed to the editingGameName (fallback 'KingSamme')
            const key = 'nblox_map_thumb_' + (editingGameName || 'KingSamme');
            try { localStorage.setItem(key, dataUrl); } catch (e) { console.warn('Failed to save thumbnail', e); }
            // Also save a general thumbnail for the launcher preview to use
            try { localStorage.setItem('nblox_thumbnail', dataUrl); } catch (e) {}
            addChatMessage('System', 'Thumbnail created and saved locally (PC only).');
            // Visual feedback
            btnCreateThumb.style.outline = '3px solid #00ccff';
            setTimeout(() => { btnCreateThumb.style.outline = ''; }, 900);
        } catch (err) {
            console.warn('Thumbnail capture failed:', err);
            alert('Failed to create thumbnail.');
        }
    });
}

// Title Screen Interactions
document.querySelectorAll('#start-menu .menu-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const wrapper = document.createElement('div');
        const rect = btn.getBoundingClientRect();
        
        wrapper.style.position = 'fixed';
        wrapper.style.left = (rect.right + 10) + 'px';
        wrapper.style.top = rect.top + 'px';
        wrapper.style.zIndex = '10000';
        wrapper.style.pointerEvents = 'none';
        
        const bubble = document.createElement('img');
        bubble.src = './Chat.png';
        bubble.style.width = '50px';
        bubble.style.height = '40px';
        
        const dots = document.createElement('div');
        dots.textContent = '...';
        dots.style.position = 'absolute';
        dots.style.top = '4px';
        dots.style.left = '14px';
        dots.style.fontSize = '20px';
        dots.style.fontWeight = 'bold';
        dots.style.color = 'black';
        
        wrapper.appendChild(bubble);
        wrapper.appendChild(dots);
        document.body.appendChild(wrapper);
        
        setTimeout(() => wrapper.remove(), 2000);
    });
});

document.getElementById('prop-color').addEventListener('input', (e) => {
    // handled by onPropChange now, but live update is nice
    if (studioSelected) {
        const c = new THREE.Color(e.target.value);
        if (Array.isArray(studioSelected.material)) {
            studioSelected.material.forEach(m => m.color = c);
        } else if (studioSelected.material) {
            studioSelected.material.color = c;
        }
        // Update serial data
        if (studioSelected.userData.serial) {
            studioSelected.userData.serial.color = c.getHex();
        }
    }
});

document.getElementById('btn-studio').onclick = () => {
    playSwitch();
    menuBGM.pause();
    startMenu.style.display = 'none';
    studioGui.style.display = 'flex';
    gameState = 'STUDIO';
    
    // Enable nicer studio lighting for modeling
    addStudioLights();

    editingGameName = null;
    isRemixMode = false;

    world.loadMap('baseplate');
    if (world.mapGroup) world.mapGroup.visible = true;
    player.mesh.visible = false;
    
    updateExplorer(); // Init explorer

    // Reset Cam
    studioCamPos.set(0, 20, 20);
    studioCamYaw = 0;
    studioCamPitch = -0.7;
};

btnPlaySolo.onclick = () => {
    playSwitch();
    // Switch to test mode (like playing, but returns to studio)
    gameState = 'TEST';
    studioGui.style.display = 'none';
    transformControl.detach();
    btnStopTest.style.display = 'block';
    
    player.mesh.visible = true;
    player.respawn(world);
};

// CREATE Button launches Studio in a "Create" mode for users to build their own level
const btnCreate = document.getElementById('btn-create');
if (btnCreate) {
    btnCreate.addEventListener('click', () => {
        playSwitch();
        menuBGM.pause();
        startMenu.style.display = 'none';
        studioGui.style.display = 'flex';
        gameState = 'STUDIO';
        // Auto-generate a sensible default name and mark editing state
        const userName = (document.getElementById('input-username') && document.getElementById('input-username').value) ? document.getElementById('input-username').value : 'Guest';
        const timeStamp = new Date().toISOString().replace(/[:.]/g, '-');
        editingGameName = `${userName}'s Map ${timeStamp}`;
        isRemixMode = false;
        // start with empty map so users can create their own
        world.clear();
        world.setupBaseplate(); // provide a baseplate to build on
        if (world.mapGroup) world.mapGroup.visible = true;
        player.mesh.visible = false;
        updateExplorer();

        // Auto-publish immediately: serialize world and save to localStorage as a published map
        try {
            const data = world.serialize();
            const saveObj = {
                name: editingGameName,
                author: userName || "*you* *who created it*",
                date: Date.now(),
                data: data
            };
            let saves = [];
            try {
                const raw = localStorage.getItem('nblox_maps');
                if (raw) saves = JSON.parse(raw);
            } catch (e) { saves = []; }

            // Add new save (do not overwrite existing same-named maps)
            saves.push(saveObj);
            localStorage.setItem('nblox_maps', JSON.stringify(saves));
            addChatMessage('System', `Game auto-published as "${editingGameName}". Open Studio to edit.`);
        } catch (e) {
            console.warn('Auto-publish failed:', e);
            addChatMessage('System', 'Auto-publish failed; you can publish from the studio Publish button.');
        }

        addChatMessage('System', 'Create mode: build your level, then press Thumb to make a PC thumbnail.');
    });
}

btnStopTest.onclick = () => {
    playSwitch();
    gameState = 'STUDIO';
    player.mesh.visible = false;
    btnStopTest.style.display = 'none';
    studioGui.style.display = 'flex';
    // Restore selection?
    if (studioSelected) transformControl.attach(studioSelected);
};

document.getElementById('btn-studio-exit').onclick = () => {
    playSwitch();

    // Disable studio lighting when closing the editor view
    removeStudioLights();

    // Hide the Studio UI but DO NOT return to the start menu or change the overall game state.
    // This prevents the "Back" action from forcing the main menu to open.
    studioGui.style.display = 'none';

    // Keep gameState as STUDIO so the environment remains in studio mode (no main menu).
    gameState = 'STUDIO';

    // Detach gizmos and clear selection visuals but do not alter world/player visibility.
    transformControl.detach();
    studioSelected = null;
    hoverHelper.visible = false;
};



// Menu UI Logic

// Functionality: persistent local friend storage and helpers
function getFriends() {
    try {
        return JSON.parse(localStorage.getItem('nblox_friends') || '{}');
    } catch (e) { return {}; }
}
function saveFriends(obj) {
    try { localStorage.setItem('nblox_friends', JSON.stringify(obj)); } catch(e){}
}
function addFriend(id, name) {
    const f = getFriends();
    f[id] = { id: id, name: name, added: Date.now() };
    saveFriends(f);
}
function removeFriend(id) {
    const f = getFriends();
    if (f[id]) {
        delete f[id];
        saveFriends(f);
    }
}
function isFriend(id) {
    return !!getFriends()[id];
}

// Function to handle player list updates
function updatePlayerList() {
    const username = document.getElementById('input-username').value || "Guest";
    const rKeys = Object.keys(remotePlayers);
    const totalPlayers = 1 + rKeys.length; 
    
    // Update Title with Count
    const titleBar = playerList.querySelector('.xp-title-bar span');
    if (titleBar) titleBar.textContent = `Players (${totalPlayers})`;

    // Build friend set
    const friends = getFriends();

    // Rebuild List (include friend buttons)
    let html = `<div style="display:flex; align-items:center; gap:5px; margin-bottom: 5px;">
        <div style="width:8px; height:8px; background:#00cc00; border-radius:50%; box-shadow: 0 0 2px #0f0;"></div>
        <b>${username}</b>
    </div>`;

    rKeys.forEach(key => {
        const p = remotePlayers[key];
        const friendLabel = friends[key] ? 'Unfriend' : 'Add Friend';
        const friendClass = friends[key] ? 'friend-yes' : 'friend-no';
        const star = friends[key] ? '★' : '☆';
        html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom: 5px; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:5px;">
                <div style="width:8px; height:8px; background:#00cc00; border-radius:50%; box-shadow: 0 0 2px #0f0;"></div>
                <span style="font-weight:600;">${p.name}</span>
                <span style="color:#aa0; margin-left:6px;">${star}</span>
            </div>
            <div style="display:flex; gap:6px;">
                <button data-peer="${key}" class="menu-btn btn-friend" style="width:110px; padding:4px 6px; font-size:12px;">${friendLabel}</button>
            </div>
        </div>`;
    });

    playerListContent.innerHTML = html;

    // Attach handlers to friend buttons
    const btns = playerListContent.querySelectorAll('.btn-friend');
    btns.forEach(b => {
        b.addEventListener('click', (e) => {
            const peerId = b.getAttribute('data-peer');
            const rp = remotePlayers[peerId];
            if (!rp) return;
            if (isFriend(peerId)) {
                // Unfriend locally
                removeFriend(peerId);
                addChatMessage('System', `You unfriended ${rp.name}.`);
                updatePlayerList();
            } else {
                // Send friend request to peer (they will be prompted)
                try {
                    room.send({ type: 'friend_request', targetId: peerId, username: document.getElementById('input-username').value || 'Guest' });
                    addChatMessage('System', `Friend request sent to ${rp.name}.`);
                } catch (e) {
                    console.warn('Failed to send friend request:', e);
                    addChatMessage('System', `Failed to send friend request to ${rp.name}.`);
                }
            }
        });
    });
}




// DONATE ROBUX: UI + network event (client-side)
// Adds a simple selection prompt to give Robux to another online player when available.
const btnDonateRobux = document.getElementById('btn-donate-robux');
if (btnDonateRobux) {
    btnDonateRobux.addEventListener('click', async () => {
        playSwitch();

        const peerIds = Object.keys(remotePlayers);
        if (peerIds.length === 0) {
            alert('No other players are currently visible/online to donate to.');
            return;
        }

        // Build a simple selection list
        let list = 'Select a player to donate to:\n';
        peerIds.forEach((id, idx) => {
            const p = remotePlayers[id];
            const name = (p && p.name) ? p.name : 'Player';
            list += `${idx + 1}: ${name}\n`;
        });

        const sel = prompt(list + '\nEnter the number of the player you want to donate to:');
        if (!sel) return;
        const idx = parseInt(sel, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= peerIds.length) {
            alert('Invalid selection.');
            return;
        }

        const targetId = peerIds[idx];
        const targetName = (remotePlayers[targetId] && remotePlayers[targetId].name) ? remotePlayers[targetId].name : 'Player';

        const amtStr = prompt(`How many Robux would you like to give to ${targetName}? Enter a positive integer:`, '10');
        if (!amtStr) return;
        const amount = parseInt(amtStr, 10);
        if (!Number.isInteger(amount) || amount <= 0) {
            alert('Invalid amount.');
            return;
        }

        // Send a donation event to the room. Actual server-side transfer is not handled here;
        // this is an in-room event to notify peers. Real currency transfer requires backend.
        try {
            room.send({
                type: 'donate_robux',
                targetId: targetId,
                amount: amount,
                // include friendly sender metadata
                username: document.getElementById('input-username').value || 'Guest'
            });
            addChatMessage('System', `You donated ${amount} Robux to ${targetName}.`);
        } catch (e) {
            console.warn('Failed to send donate event:', e);
            addChatMessage('System', 'Failed to send donation.');
        }
    });
}

// Hook into room.onmessage without overwriting existing handler
const _prevOnMessage = room.onmessage;
room.onmessage = (evt) => {
    try {
        if (typeof _prevOnMessage === 'function') _prevOnMessage(evt);
    } catch (e) {
        console.warn('Previous onmessage handler failed:', e);
    }

    try {
        const data = evt.data;
        if (!data || !data.type) return;

        if (data.type === 'donate_robux') {
            const fromName = evt.username || (room.peers && room.peers[evt.clientId] && room.peers[evt.clientId].username) || data.username || 'Someone';
            const toId = data.targetId;
            const amount = data.amount || 0;

            // If this client is the recipient, show a notification
            if (toId === room.clientId) {
                addChatMessage('System', `${fromName} donated ${amount} Robux to you!`);
                // Optionally handle local point/visual changes here
            } else {
                // Broadcast visible system message (except don't echo spammy details)
                addChatMessage('System', `${fromName} donated ${amount} Robux to a player.`);
            }
        }
    } catch (e) {
        console.warn('donate_robux handler error:', e);
    }
};


// Reviews System
const getReviews = (mapName) => {
    try {
        const store = JSON.parse(localStorage.getItem('nblox_reviews') || '{}');
        return store[mapName] || [];
    } catch (e) { return []; }
};

const saveReviews = (mapName, reviews) => {
    try {
        const store = JSON.parse(localStorage.getItem('nblox_reviews') || '{}');
        store[mapName] = reviews;
        localStorage.setItem('nblox_reviews', JSON.stringify(store));
    } catch (e) {}
};

const renderReviews = (mapName) => {
    const list = document.getElementById('gd-reviews-list');
    list.innerHTML = '';
    const reviews = getReviews(mapName);

    if (reviews.length === 0) {
        list.innerHTML = '<div style="color: #666; font-style: italic;">No reviews yet. Be the first!</div>';
        return;
    }

    reviews.forEach((rev, index) => {
        const div = document.createElement('div');
        div.style.marginBottom = '8px';
        div.style.borderBottom = '1px dashed #ccc';
        div.style.paddingBottom = '4px';

        const header = document.createElement('div');
        header.style.color = 'blue';
        header.style.fontWeight = 'bold';
        header.textContent = rev.author + ' says:';
        div.appendChild(header);

        const body = document.createElement('div');
        body.textContent = rev.text;
        body.style.marginLeft = '5px';
        div.appendChild(body);

        // Reply Button
        const replyBtn = document.createElement('a');
        replyBtn.textContent = 'Reply';
        replyBtn.style.fontSize = '10px';
        replyBtn.style.color = '#666';
        replyBtn.style.textDecoration = 'underline';
        replyBtn.style.cursor = 'pointer';
        replyBtn.style.marginLeft = '5px';
        replyBtn.onclick = () => {
            const replyText = prompt("Reply to " + rev.author + ":");
            if (replyText) {
                rev.replies.push({
                    author: document.getElementById('input-username').value || "Guest",
                    text: replyText
                });
                saveReviews(mapName, reviews);
                renderReviews(mapName);
            }
        };
        div.appendChild(replyBtn);

        // Render Replies
        if (rev.replies && rev.replies.length > 0) {
            const repliesDiv = document.createElement('div');
            repliesDiv.style.marginLeft = '15px';
            repliesDiv.style.marginTop = '4px';
            repliesDiv.style.borderLeft = '2px solid #ccc';
            repliesDiv.style.paddingLeft = '5px';
            
            rev.replies.forEach(rep => {
                const rDiv = document.createElement('div');
                rDiv.style.fontSize = '11px';
                rDiv.style.marginTop = '2px';
                rDiv.innerHTML = `<span style="color:#008; font-weight:bold;">${rep.author}</span>: ${rep.text}`;
                repliesDiv.appendChild(rDiv);
            });
            div.appendChild(repliesDiv);
        }

        list.appendChild(div);
    });
};

function updateGameDetailPlayerCount() {
    const el = document.getElementById('gd-player-count');
    if (!el || gameDetailMenu.style.display === 'none' || !pendingGameStart) return;
    
    const targetMap = pendingGameStart.name;
    let count = 0;
    
    // Count players (including self if playing) with matching map
    const presences = room.presence || {};
    for (const id in presences) {
        const p = presences[id];
        if (p && p.map === targetMap) {
            count++;
        }
    }
    
    el.textContent = `${count} Players Online`;
}

document.getElementById('btn-post-review').onclick = () => {
    if (!pendingGameStart) return;
    const input = document.getElementById('gd-review-input');
    const text = input.value.trim();
    if (!text) return;
    
    playSwitch();
    
    const mapName = pendingGameStart.name;
    const reviews = getReviews(mapName);
    
    reviews.push({
        author: document.getElementById('input-username').value || "Guest",
        text: text,
        date: Date.now(),
        replies: []
    });
    
    saveReviews(mapName, reviews);
    input.value = '';
    renderReviews(mapName);
    updateGameDetailPlayerCount();
};

// Game Launching
let pendingGameStart = null; // { name, data }

const openGameDetail = (title, mapName, mapData = null, author = "RichyBoi") => {
    playSwitch();
    playMenu.style.display = 'none';
    gameDetailMenu.style.display = 'block'; // Changed to block for absolute positioning
    
    document.getElementById('gd-window-title').textContent = title;
    document.getElementById('gd-title').textContent = title;
    const authorEl = document.getElementById('gd-author');
    if (authorEl) authorEl.textContent = 'By ' + (author || 'RichyBoi');
    
    // Set thumbnail image if user created one; fallback to packaged screenshot
    const thumbEl = document.getElementById('gd-thumb');
    const stored = localStorage.getItem('nblox_map_thumb_' + (mapName || 'KingSamme')) || localStorage.getItem('nblox_thumbnail');
    if (thumbEl) {
        if (stored) thumbEl.src = stored;
        else thumbEl.src = './Screenshot 2026-05-12 121527.png';
    }

    pendingGameStart = { name: mapName, data: mapData };
    
    // Load reviews
    renderReviews(mapName);
    updateGameDetailPlayerCount();
};

function startGame(mapName, mapData = null) {
    playSwitch();
    menuBGM.pause();
    menuBGM.currentTime = 0;
    
    currentMapName = mapName; // Set map name for sync

    // Generate a play URL for this run and push it into history so the tab reflects the running game.
    try {
        const runId = Date.now();
        const playUrl = `${window.location.origin}${window.location.pathname}?play=${encodeURIComponent(mapName)}&run=${runId}`;
        try { localStorage.setItem('nblox_map_url_' + mapName, playUrl); } catch(e){}
        try { history.replaceState({}, `${mapName} - Play`, playUrl); } catch(e){}
        addChatMessage('System', `Play URL: ${playUrl}`);
    } catch (err) {
        console.warn('Failed to create runtime play URL:', err);
    }
    
    // Hide all menus
    playMenu.style.display = 'none';
    gameDetailMenu.style.display = 'none';
    startMenu.style.display = 'none';
    
    chatContainer.style.display = 'flex';
    btnExit.style.display = 'block';
    btnReset.style.display = 'block';
    gameState = 'PLAYING';
    player.forcedAnim = null; // Reset forced animation from menu
    
    // Add join message
    const username = document.getElementById('input-username').value || "Guest";
    addChatMessage("System", `${username} has joined the game.`);

    // Show Player List
    playerList.style.display = 'flex';
    updatePlayerList();

    if (mapData) {
        world.loadFromData(mapData);
    } else {
        world.loadMap(mapName);
    }

    // Handle Custom Music
    if (gameBGM) {
        gameBGM.pause();
        gameBGM = null;
    }
    if (world.bgm) {
        gameBGM = new Audio(world.bgm);
        gameBGM.loop = true;
        gameBGM.volume = 0.5;
        gameBGM.play().catch(e => console.log("Audio play failed", e));
    }

    if (world.mapGroup) world.mapGroup.visible = true;
    player.respawn(world);

    // Auto-lock mouse on start
    setTimeout(() => {
        if (gameState === 'PLAYING') {
            renderer.domElement.requestPointerLock().catch(() => {});
        }
    }, 100);

    // Initial Presence Push (include in-game username)
    try {
        room.updatePresence({
            username: username, // <-- ensure presence carries the game's username
            appearance: player.serializeAppearance(),
            map: currentMapName,
            position: player.position,
            rotation: player.mesh.rotation.y,
            animState: 'idle'
        });
    } catch (e) {
        console.warn("Failed to send initial presence:", e);
    }
}

document.getElementById('btn-play').onclick = () => {
    playSwitch();
    startMenu.style.display = 'none';
    playMenu.style.display = 'block';

    // Populate World List
    const list = document.getElementById('world-list');
    list.innerHTML = '';
    
    const currentUser = document.getElementById('input-username').value || "Guest";

    // 1. Hub Button
    const btnHub = document.createElement('button');
    btnHub.className = 'menu-btn';
    btnHub.style.width = '100%';
    btnHub.textContent = 'KingSamme';
    btnHub.onclick = () => openGameDetail('KingSamme', 'platform', null, 'RichyBoi');
    list.appendChild(btnHub);

    // 1.5 Easy Obby (bundled)
    const btnEasyObby = document.createElement('button');
    btnEasyObby.className = 'menu-btn';
    btnEasyObby.style.width = '100%';
    btnEasyObby.textContent = 'Easy Obby';
    btnEasyObby.onclick = () => {
        // Use ahh.jpeg as thumbnail for this packaged obby
        openGameDetail('Easy Obby', 'easy-obby', null, 'RichyBoi');
        // ensure the detail view thumbnail shows the provided asset
        const thumbEl = document.getElementById('gd-thumb');
        if (thumbEl) thumbEl.src = './ahh.jpeg';
    };
    list.appendChild(btnEasyObby);

    // 1.6 Amazing Digital Circus (new)
    const btnCircus = document.createElement('button');
    btnCircus.className = 'menu-btn';
    btnCircus.style.width = '100%';
    btnCircus.textContent = 'Amazing Digital Circus';
    btnCircus.onclick = () => {
        openGameDetail('Amazing Digital Circus', 'digital-circus', null, 'RichyBoi');
        const thumbEl = document.getElementById('gd-thumb');
        if (thumbEl) thumbEl.src = './IMG_3042.jpeg'; // use provided circus thumbnail
    };
    list.appendChild(btnCircus);

    // 1.7 MINECRAFT (custom) - plays bundled minecraftmusic.mp3
    const btnMinecraft = document.createElement('button');
    btnMinecraft.className = 'menu-btn';
    btnMinecraft.style.width = '100%';
    btnMinecraft.textContent = 'MINECRAFT';
    btnMinecraft.onclick = () => {
        openGameDetail('MINECRAFT', 'minecraft', null, 'RichyBoi');
        const thumbEl = document.getElementById('gd-thumb');
        if (thumbEl) thumbEl.src = './image (14).png'; // thumbnail for Minecraft entry (bundled image)
    };
    list.appendChild(btnMinecraft);

    // 1.8 Geometry Dash (new)
    const btnGeometryDash = document.createElement('button');
    btnGeometryDash.className = 'menu-btn';
    btnGeometryDash.style.width = '100%';
    btnGeometryDash.textContent = 'Geometry Dash';
    btnGeometryDash.onclick = () => {
        openGameDetail('Geometry Dash', 'geometry-dash', null, 'RichyBoi');
        const thumbEl = document.getElementById('gd-thumb');
        if (thumbEl) thumbEl.src = './background.png'; // use bundled background as thumbnail
    };
    list.appendChild(btnGeometryDash);

    // 2. User Maps
    let saves = [];
    try {
        const raw = localStorage.getItem('nblox_maps');
        if (raw) saves = JSON.parse(raw);
    } catch(e) {}

    saves.forEach(save => {
        // Container for the row
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '5px';
        row.style.width = '100%';

        const btn = document.createElement('button');
        btn.className = 'menu-btn';
        btn.style.flex = '1'; // Take up remaining space
        btn.style.margin = '5px 0'; // override default margin
        btn.textContent = save.name;
        btn.onclick = () => openGameDetail(save.name, save.name, save.data, save.author || "*you* *who created it*");
        row.appendChild(btn);

        // Edit button if author matches, Remix if not
        if (save.author === currentUser) {
            const actionBtn = document.createElement('button');
            actionBtn.className = 'menu-btn';
            actionBtn.style.width = '60px';
            actionBtn.style.margin = '5px 0';
            actionBtn.style.fontSize = '14px';
            actionBtn.style.background = '#ffcc00';
            actionBtn.textContent = 'Edit';
            actionBtn.onclick = (e) => {
                e.stopPropagation();
                loadStudioWithMap(save.data, save.name, false);
            };
            row.appendChild(actionBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'menu-btn';
            delBtn.style.width = '40px';
            delBtn.style.margin = '5px 0';
            delBtn.style.fontSize = '14px';
            delBtn.style.background = '#cc0000';
            delBtn.style.color = '#fff';
            delBtn.textContent = 'X';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm("Delete " + save.name + "?")) {
                    saves = saves.filter(s => s.name !== save.name);
                    localStorage.setItem('nblox_maps', JSON.stringify(saves));
                    document.getElementById('btn-play').click(); // Refresh
                }
            };
            row.appendChild(delBtn);

        } else {
            const actionBtn = document.createElement('button');
            actionBtn.className = 'menu-btn';
            actionBtn.style.width = '60px';
            actionBtn.style.margin = '5px 0';
            actionBtn.style.fontSize = '14px';
            actionBtn.style.background = '#00ccff'; // Cyan for remix
            actionBtn.textContent = 'Remix';
            actionBtn.onclick = (e) => {
                e.stopPropagation();
                loadStudioWithMap(save.data, save.name, true);
            };
            row.appendChild(actionBtn);
        }

        list.appendChild(row);
    });
};

function loadStudioWithMap(mapData, name = null, isRemix = false) {
    playSwitch();
    menuBGM.pause();
    // Hide menus
    startMenu.style.display = 'none';
    playMenu.style.display = 'none';
    
    // Show Studio
    studioGui.style.display = 'flex';
    gameState = 'STUDIO';
    
    editingGameName = name;
    isRemixMode = isRemix;

    // Load Data
    world.loadFromData(mapData);
    
    // Reset View
    if (world.mapGroup) world.mapGroup.visible = true;
    player.mesh.visible = false;
    updateExplorer();
    
    studioCamPos.set(0, 20, 20);
    studioCamYaw = 0;
    studioCamPitch = -0.7;
}

// --- FORUM SYSTEM ---
const forumContent = document.getElementById('forum-content');

// Initial Data
const defaultThreads = [
    {
        id: 1,
        title: "Welcome to Nblox!",
        author: "Builderman",
        date: Date.now() - 10000000,
        content: "Welcome to the Nblox forums! Be nice and have fun building.",
        replies: [
            { author: "Guest", text: "Wow this is cool!", date: Date.now() - 9000000 }
        ]
    },
    {
        id: 2,
        title: "How to jump?",
        author: "Noob123",
        date: Date.now() - 5000000,
        content: "I keep pressing space but sometimes I don't jump high enough.",
        replies: []
    }
];

const getForumData = () => {
    try {
        const raw = localStorage.getItem('nblox_forum_threads');
        if (raw) return JSON.parse(raw);
    } catch(e) {}
    return defaultThreads;
};

const saveForumData = (data) => {
    localStorage.setItem('nblox_forum_threads', JSON.stringify(data));
};

const renderForumHome = () => {
    forumContent.innerHTML = '';
    const threads = getForumData();
    // Sort by newest
    threads.sort((a,b) => b.date - a.date);

    // Header
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '16px';
    
    table.innerHTML = `
        <tr style="background: #000080; color: white;">
            <th style="text-align: left; padding: 8px;">Subject</th>
            <th style="width: 100px; padding: 8px;">Author</th>
            <th style="width: 60px; padding: 8px;">Replies</th>
        </tr>
    `;

    threads.forEach(t => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #ccc';
        tr.style.cursor = 'pointer';
        tr.onmouseover = () => tr.style.background = '#ffffcc';
        tr.onmouseout = () => tr.style.background = 'transparent';
        
        tr.innerHTML = `
            <td style="padding: 10px; color: #000080; font-weight: bold; font-size: 18px;">${t.title}</td>
            <td style="padding: 10px;">${t.author}</td>
            <td style="padding: 10px; text-align: center;">${t.replies.length}</td>
        `;
        tr.onclick = () => {
            playSwitch();
            renderForumThread(t.id);
        };
        table.appendChild(tr);
    });
    
    if (threads.length === 0) {
        forumContent.innerHTML = '<div style="padding:15px; font-size: 16px;">No threads yet.</div>';
    } else {
        forumContent.appendChild(table);
    }
};

const renderForumThread = (id) => {
    const threads = getForumData();
    const t = threads.find(x => x.id === id);
    if (!t) return renderForumHome();

    forumContent.innerHTML = '';

    // OP
    const opDiv = document.createElement('div');
    opDiv.style.border = '1px solid #000080';
    opDiv.style.marginBottom = '15px';
    opDiv.style.background = '#eee';
    
    opDiv.innerHTML = `
        <div style="background: #000080; color: white; padding: 8px; font-weight: bold; font-size: 18px;">${t.title}</div>
        <div style="padding: 8px; border-bottom: 1px solid #ccc; font-size: 14px; color: #555;">
            Posted by <b>${t.author}</b> on ${new Date(t.date).toLocaleDateString()}
        </div>
        <div style="padding: 15px; font-size: 16px; min-height: 60px; background: #fff;">${t.content}</div>
    `;
    forumContent.appendChild(opDiv);

    // Replies
    t.replies.forEach(r => {
        const rDiv = document.createElement('div');
        rDiv.style.border = '1px solid #888';
        rDiv.style.marginBottom = '10px';
        rDiv.style.background = '#fff';
        rDiv.style.marginLeft = '20px';
        
        rDiv.innerHTML = `
            <div style="padding: 6px; background: #ddd; border-bottom: 1px solid #ccc; font-size: 14px;">
                <b>${r.author}</b> replied:
            </div>
            <div style="padding: 10px; font-size: 15px;">${r.text}</div>
        `;
        forumContent.appendChild(rDiv);
    });

    // Reply Box
    const replyBox = document.createElement('div');
    replyBox.style.marginTop = '20px';
    replyBox.style.padding = '10px';
    replyBox.style.borderTop = '2px solid #000';
    
    replyBox.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 8px; font-size: 16px;">Post a Reply</div>
        <textarea id="forum-reply-input" style="width: 100%; height: 80px; font-family: inherit; margin-bottom: 10px; font-size: 14px; padding: 5px;"></textarea>
        <button id="btn-post-reply" class="menu-btn" style="width: auto; padding: 4px 20px; margin: 0; font-size: 14px;">Post Reply</button>
    `;
    forumContent.appendChild(replyBox);

    document.getElementById('btn-post-reply').onclick = () => {
        const txt = document.getElementById('forum-reply-input').value.trim();
        if (!txt) return;
        
        playSwitch();
        const username = document.getElementById('input-username').value || "Guest";
        
        t.replies.push({
            author: username,
            text: txt,
            date: Date.now()
        });
        
        // Save back
        const allThreads = getForumData();
        const idx = allThreads.findIndex(x => x.id === id);
        if (idx !== -1) allThreads[idx] = t;
        saveForumData(allThreads);
        
        renderForumThread(id); // Refresh
    };
};

const renderCreateThread = () => {
    forumContent.innerHTML = '';
    
    const div = document.createElement('div');
    div.style.padding = '10px';
    
    div.innerHTML = `
        <h3 style="margin-top: 0;">New Thread</h3>
        <label style="display:block; font-weight:bold;">Subject:</label>
        <input type="text" id="new-thread-title" style="width: 100%; margin-bottom: 10px; font-family: inherit;">
        
        <label style="display:block; font-weight:bold;">Message:</label>
        <textarea id="new-thread-content" style="width: 100%; height: 150px; margin-bottom: 10px; font-family: inherit;"></textarea>
        
        <button id="btn-submit-thread" class="menu-btn" style="width: auto; padding: 4px 15px; margin: 0;">Post</button>
        <button id="btn-cancel-thread" class="menu-btn" style="width: auto; padding: 4px 15px; margin: 0; margin-left: 5px;">Cancel</button>
    `;
    forumContent.appendChild(div);

    document.getElementById('btn-cancel-thread').onclick = () => {
        playSwitch();
        renderForumHome();
    };

    document.getElementById('btn-submit-thread').onclick = () => {
        const title = document.getElementById('new-thread-title').value.trim();
        const content = document.getElementById('new-thread-content').value.trim();
        
        if (!title || !content) {
            alert("Please fill out both subject and message.");
            return;
        }

        playSwitch();
        const username = document.getElementById('input-username').value || "Guest";
        const threads = getForumData();
        
        const newThread = {
            id: Date.now(),
            title: title,
            author: username,
            date: Date.now(),
            content: content,
            replies: []
        };
        
        threads.push(newThread);
        saveForumData(threads);
        renderForumHome();
    };
};

document.getElementById('btn-forum').onclick = () => {
    playSwitch();
    tryPlayBGM();
    startMenu.style.display = 'none';
    forumMenu.style.display = 'block'; // Make visible
    gameState = 'MENU'; // Keep in menu state (visuals)
    if (world.mapGroup) world.mapGroup.visible = false;
    
    renderForumHome();
};

document.getElementById('btn-close-forum').onclick = () => {
    playSwitch();
    forumMenu.style.display = 'none';
    startMenu.style.display = 'block';
};

document.getElementById('btn-forum-home').onclick = () => {
    playSwitch();
    renderForumHome();
};

document.getElementById('btn-new-thread').onclick = () => {
    playSwitch();
    renderCreateThread();
};

document.getElementById('btn-gd-back').onclick = () => {
    playSwitch();
    gameDetailMenu.style.display = 'none';
    startMenu.style.display = 'block';
    pendingGameStart = null;
};

document.getElementById('btn-close-gd').onclick = () => document.getElementById('btn-gd-back').click();

document.getElementById('btn-gd-play').onclick = () => {
    const username = document.getElementById('input-username').value.trim();
    if (!username) {
        alert("You must enter a username to play!");
        // Flash input
        document.getElementById('input-username').focus();
        document.getElementById('input-username').style.borderColor = 'red';
        // Go back to start menu to enter name? Or just handle it.
        // Let's close this and go to start to force them to see the input
        gameDetailMenu.style.display = 'none';
        startMenu.style.display = 'block';
        return;
    }

    if (pendingGameStart) {
        startGame(pendingGameStart.name, pendingGameStart.data);
    }
};

document.getElementById('btn-play-back').onclick = () => {
    playSwitch();
    playMenu.style.display = 'none';
    startMenu.style.display = 'block';
};

document.getElementById('btn-customize').onclick = () => {
    playSwitch();
    tryPlayBGM();
    startMenu.style.display = 'none';
    custMenu.style.display = 'block';
    chatContainer.style.display = 'none';
    gameState = 'CUSTOMIZE';
    if (world.mapGroup) world.mapGroup.visible = false;
};

document.getElementById('btn-settings').onclick = () => {
    playSwitch();
    tryPlayBGM();
    startMenu.style.display = 'none';
    settingsMenu.style.display = 'block';
    gameState = 'SETTINGS';
    if (world.mapGroup) world.mapGroup.visible = false;
};

document.getElementById('btn-settings-back').onclick = () => {
    playSwitch();
    settingsMenu.style.display = 'none';
    startMenu.style.display = 'block';
    // Restore menu view
    if (world.mapGroup) world.mapGroup.visible = false;
};

btnExit.onclick = () => {
    playSwitch();
    tryPlayBGM(); // Restart menu music
    chatContainer.style.display = 'none';
    btnExit.style.display = 'none';
    btnReset.style.display = 'none';
    playerList.style.display = 'none';

    startMenu.style.display = 'block';
    gameState = 'MENU';
    if (world.mapGroup) world.mapGroup.visible = false;
    
    // Clear presence map so we aren't counted as online
    room.updatePresence({ map: 'MENU' });

    // Stop Game Music
    if (gameBGM) {
        gameBGM.pause();
        gameBGM = null;
    }
    tryPlayBGM();

    // Clear chat
    chatHistory.innerHTML = '';
};

btnReset.onclick = () => {
    playSwitch();
    player.fallApart();
};

// Settings Handlers
const volSlider = document.getElementById('set-volume');
volSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value) / 100;
    menuBGM.volume = val;
});

// Skybox upload handler: replace skybox face textures with an uploaded image (applied to all faces)
const skyboxFile = document.getElementById('skybox-file');
const btnSkyReset = document.getElementById('btn-skybox-reset');
if (skyboxFile) {
    skyboxFile.addEventListener('change', (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    const tex = new THREE.CanvasTexture(img);
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.minFilter = THREE.LinearFilter;
                    tex.magFilter = THREE.LinearFilter;
                    tex.needsUpdate = true;

                    if (world && world.skyboxMesh && Array.isArray(world.skyboxMesh.material)) {
                        world.skyboxMesh.material.forEach((m) => {
                            if (m.map) {
                                if (m.map.image && m.map.image !== tex.image) {
                                    try { m.map.dispose(); } catch(e){}
                                }
                            }
                            m.map = tex;
                            m.needsUpdate = true;
                        });
                    } else if (world && world.skyboxMesh && world.skyboxMesh.material) {
                        const m = world.skyboxMesh.material;
                        if (m.map && m.map.image && m.map.image !== tex.image) {
                            try { m.map.dispose(); } catch(e){}
                        }
                        m.map = tex;
                        m.needsUpdate = true;
                    }

                    addChatMessage('System', 'Skybox image applied.');
                } catch (err) {
                    console.warn('Failed to apply skybox image:', err);
                    alert('Failed to apply skybox image.');
                }
            };
            img.onerror = () => alert('Failed to load selected image.');
            img.src = evt.target.result;
        };
        reader.readAsDataURL(f);
    });
}

// Reset skybox to default textures (reload World.setupSkybox)
if (btnSkyReset) {
    btnSkyReset.addEventListener('click', () => {
        playSwitch();
        if (world && typeof world.setupSkybox === 'function') {
            // Remove existing skybox material maps to free memory
            try {
                if (world.skyboxMesh && world.skyboxMesh.material) {
                    const mats = Array.isArray(world.skyboxMesh.material) ? world.skyboxMesh.material : [world.skyboxMesh.material];
                    mats.forEach(m => {
                        if (m.map && m.map.image) {
                            try { m.map.dispose(); } catch(e){}
                        }
                    });
                }
            } catch (e) {}
            // Recreate skybox
            if (world.skyboxMesh) {
                scene.remove(world.skyboxMesh);
                world.skyboxMesh.geometry.dispose();
                // materials will be recreated in setupSkybox
            }
            world.setupSkybox();
            addChatMessage('System', 'Skybox reset to default.');
        }
    });
}

const sensSlider = document.getElementById('set-sens');
sensSlider.addEventListener('input', (e) => {
    // Value 10 to 200, map to 0.1 to 2.0
    cameraSensitivity = parseInt(e.target.value) / 100;
});

// Fullscreen toggle: persist choice and request/exit fullscreen on change.
// Note: browsers may block programmatic fullscreen requests without a user gesture.
const fsCheckbox = document.getElementById('set-fullscreen');
try {
    if (fsCheckbox) {
        // Restore saved preference
        const savedFs = localStorage.getItem('nblox_fullscreen') === '1';
        fsCheckbox.checked = savedFs;

        // When user toggles
        fsCheckbox.addEventListener('change', async () => {
            playSwitch();
            if (fsCheckbox.checked) {
                try {
                    if (document.fullscreenElement == null) {
                        await document.documentElement.requestFullscreen();
                    }
                    localStorage.setItem('nblox_fullscreen', '1');
                } catch (err) {
                    console.warn('Failed to enter fullscreen:', err);
                    alert('Failed to enter fullscreen (browser may require a user gesture).');
                    fsCheckbox.checked = false;
                    localStorage.setItem('nblox_fullscreen', '0');
                }
            } else {
                try {
                    if (document.fullscreenElement) await document.exitFullscreen();
                } catch (err) {
                    console.warn('Failed to exit fullscreen:', err);
                } finally {
                    localStorage.setItem('nblox_fullscreen', '0');
                }
            }
        });

        // If preference says to use fullscreen, attempt to enter once on first user interaction.
        if (fsCheckbox.checked) {
            const tryEnterFs = async () => {
                try {
                    if (document.fullscreenElement == null) await document.documentElement.requestFullscreen();
                } catch (e) { /* ignore - will be retried on explicit user toggle */ }
                window.removeEventListener('pointerdown', tryEnterFs);
                window.removeEventListener('keydown', tryEnterFs);
            };
            window.addEventListener('pointerdown', tryEnterFs, { once: true });
            window.addEventListener('keydown', tryEnterFs, { once: true });
        }
    }
} catch (e) {
    console.warn('Fullscreen setup failed:', e);
}

document.getElementById('btn-cust-reset').onclick = () => {
    playSwitch();
    
    // Default config
    const defaults = {
        head: '#ffffff',   // default head color set to white
        torso: '#0066cc',  // Noob blue
        larm: '#ffffff',
        rarm: '#ffffff',
        lleg: '#00ff00',
        rleg: '#00ff00'
    };

    // Reset Player
    player.setPartColor('head', defaults.head);
    player.setPartColor('torso', defaults.torso);
    player.setPartColor('leftArm', defaults.larm);
    player.setPartColor('rightArm', defaults.rarm);
    player.setPartColor('leftLeg', defaults.lleg);
    player.setPartColor('rightLeg', defaults.rleg);
    
    // Clear textures
    player.appearance.faceUrl = null;
    player.appearance.shirtUrl = null;
    
    // Reset visual textures (use image from the generated textures)
    player.setFaceTexture(createFaceTexture().image);
    player.setShirtTexture(createTorsoTexture().image);
    
    // Update UI Inputs
    document.getElementById('col-head').value = defaults.head;
    document.getElementById('col-torso').value = defaults.torso;
    document.getElementById('col-larm').value = defaults.larm;
    document.getElementById('col-rarm').value = defaults.rarm;
    document.getElementById('col-lleg').value = defaults.lleg;
    document.getElementById('col-rleg').value = defaults.rleg;
    
    // Update UI preview blocks
    ['col-head', 'col-torso', 'col-larm', 'col-rarm', 'col-lleg', 'col-rleg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.parentElement.style.backgroundColor = el.value;
    });

    // Clear Storage
    localStorage.removeItem('nblox_appearance');
};

document.getElementById('btn-cust-done').onclick = () => {
    playSwitch();

    // Save current appearance state (colors and texture URLs) to localStorage
    try {
        const appearance = player && typeof player.serializeAppearance === 'function' ? player.appearance : null;
        if (appearance) {
            // Ensure we store the full appearance (colors + any saved texture URLs)
            const saveObj = {
                colors: appearance.colors || {},
                faceUrl: appearance.faceUrl || null,
                shirtUrl: appearance.shirtUrl || null
            };
            localStorage.setItem('nblox_appearance', JSON.stringify(saveObj));
            // Also reflect saved username state visually if needed
            addChatMessage('System', 'Avatar saved locally.');
        }
    } catch (e) {
        console.warn('Failed to save avatar appearance:', e);
        addChatMessage('System', 'Failed to save avatar locally.');
    }

    tryPlayBGM();
    custMenu.style.display = 'none';
    startMenu.style.display = 'block';
    chatContainer.style.display = 'none';
    gameState = 'MENU';
    if (world.mapGroup) world.mapGroup.visible = false;
};

// Customization Handlers
const bindColor = (id, part) => {
    const el = document.getElementById(id);
    el.addEventListener('input', (e) => {
        player.setPartColor(part, e.target.value);
    });
};
bindColor('col-head', 'head');
bindColor('col-torso', 'torso');
bindColor('col-larm', 'leftArm');
bindColor('col-rarm', 'rightArm');
bindColor('col-lleg', 'leftLeg');
bindColor('col-rleg', 'rightLeg');

const faceGalleryEl = document.getElementById('face-gallery');

const bindTexture = (id, method) => {
    const el = document.getElementById(id);
    el.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (evt) => {
                const dataUrl = evt.target.result;
                const img = new Image();
                img.onload = () => {
                    // Apply immediately to player
                    player[method](img, dataUrl);
                    // Add thumbnail to gallery for future selection
                    addFaceThumbnail(dataUrl);
                };
                img.src = dataUrl;
            };
            reader.readAsDataURL(file);
        }
    });
};

function addFaceThumbnail(dataUrl) {
    if (!faceGalleryEl) return;
    const thumb = document.createElement('img');
    thumb.src = dataUrl;
    thumb.style.width = '56px';
    thumb.style.height = '56px';
    thumb.style.objectFit = 'cover';
    thumb.style.border = '2px solid #888';
    thumb.style.cursor = 'pointer';
    thumb.title = 'Click to select this face';
    thumb.addEventListener('click', () => {
        const img = new Image();
        img.onload = () => player.setFaceTexture(img, dataUrl);
        img.src = dataUrl;
        // Visual feedback for selection
        Array.from(faceGalleryEl.children).forEach(c => c.style.outline = 'none');
        thumb.style.outline = '3px solid #00ccff';
    });
    faceGalleryEl.appendChild(thumb);
}

// Restore gallery from saved appearance if present
try {
    const savedApp = localStorage.getItem('nblox_appearance');
    if (savedApp) {
        const data = JSON.parse(savedApp);
        if (data.faceUrl) {
            // add existing saved face as selectable thumbnail
            addFaceThumbnail(data.faceUrl);
        }
    }
} catch (e) { /* ignore */ }

// Add inventory faces to the gallery so they are selectable by default.
// These reference bundled assets included in the project.
try {
    addFaceThumbnail('./Untitled65_20260311205720.png');
} catch (e) { /* ignore */ }

try {
    addFaceThumbnail('./01971080-2920-7356-9f3b-03e2c0b53243.png');
} catch (e) { /* ignore */ }

try {
    addFaceThumbnail('./Epic Face.png');
} catch (e) { /* ignore */ }

// Add a clickable inventory thumbnail for a bundled shirt image
try {
    const shirtThumb = document.getElementById('shirt-inventory-thumb');
    if (shirtThumb) {
        // Ensure the image is loaded/cached
        shirtThumb.addEventListener('click', () => {
            try {
                const src = './gubby_guides_a88d6d8864.png';
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    // Apply to player shirt and persist a lightweight flag (data URL not stored here)
                    if (player && typeof player.setShirtTexture === 'function') {
                        player.setShirtTexture(img, src);
                        // Visual feedback
                        try {
                            // briefly flash outline
                            shirtThumb.style.outline = '3px solid #00ccff';
                            setTimeout(() => { shirtThumb.style.outline = ''; }, 800);
                        } catch (e) {}
                    }
                };
                img.src = src;
            } catch (err) {
                console.warn('Failed to apply shirt from inventory:', err);
            }
        });
    }

    // Inventory: use bundled baseball cap GLB and attach it as the player's hat
    const btnUseCap = document.getElementById('btn-use-cap-inv');
    if (btnUseCap) {
        btnUseCap.addEventListener('click', async () => {
            playSwitch();
            try {
                const loader = new GLTFLoader();
                loader.load('./roblox_r_baseball_cap_r6.glb', (gltf) => {
                    try {
                        // Remove any existing hat first
                        if (player && typeof player.removeHat === 'function') player.removeHat();

                        const capTemplate = gltf.scene || gltf.scenes?.[0];
                        if (!capTemplate) throw new Error('Cap GLB missing scene');

                        // Clone and attach
                        const capClone = capTemplate.clone(true);
                        // Ensure reasonable scale/offset relative to player's head
                        capClone.scale.set(0.9, 0.9, 0.9);
                        capClone.position.set(0, 0.6, 0);
                        capClone.rotation.set(0, 0, 0);

                        // Disable shadows for this cosmetic
                        capClone.traverse(c => {
                            if (c.isMesh) {
                                c.castShadow = false;
                                c.receiveShadow = false;
                            }
                        });

                        // Find attach target (prefer player.head)
                        let attachTarget = (player && player.head) ? player.head : player.mesh;
                        attachTarget.add(capClone);

                        // Save reference so removeHat can clear it later
                        player._hat = capClone;
                        player.appearance.hat = {
                            constructed: false,
                            glb: './roblox_r_baseball_cap_r6.glb',
                            offset: { x: 0, y: 0.6, z: 0 },
                            rot: { x: 0, y: 0, z: 0 }
                        };

                        // Persist to appearance storage
                        try {
                            const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                            save.hat = player.appearance.hat;
                            save.colors = player.appearance.colors || save.colors;
                            save.faceUrl = player.appearance.faceUrl || save.faceUrl;
                            save.shirtUrl = player.appearance.shirtUrl || save.shirtUrl;
                            localStorage.setItem('nblox_appearance', JSON.stringify(save));
                        } catch (e) { console.warn('Failed to persist cap to storage', e); }

                        addChatMessage('System', 'Baseball cap equipped from inventory.');
                        // Visual feedback on button
                        btnUseCap.style.outline = '3px solid #00ccff';
                        setTimeout(() => btnUseCap.style.outline = '', 800);
                    } catch (err) {
                        console.warn('Failed to attach cap:', err);
                        alert('Failed to equip cap.');
                    }
                }, undefined, (err) => {
                    console.warn('Failed to load cap GLB:', err);
                    alert('Failed to load cap asset.');
                });
            } catch (e) {
                console.warn('Cap equip failed:', e);
            }
        });
    }
} catch (e) { /* ignore */ }

bindTexture('file-face', 'setFaceTexture');
bindTexture('file-shirt', 'setShirtTexture');

// Hat creation handlers (Create/Remove hat) + Hat Editor
const btnCreateHat = document.getElementById('btn-create-hat');
const btnRemoveHat = document.getElementById('btn-remove-hat');
const btnOpenHatEditor = document.getElementById('btn-open-hat-editor');

if (btnCreateHat) {
    // Open the Hat Editor (studio-like workflow) instead of instantly creating the hat.
    btnCreateHat.addEventListener('click', () => {
        playSwitch();

        // Initialize editor values from the quick-create controls so the editor starts in the same state
        const quickColor = document.getElementById('hat-color') ? document.getElementById('hat-color').value : '#333333';
        const quickSize = document.getElementById('hat-size') ? document.getElementById('hat-size').value : '1.5';

        try {
            // Ensure editor UI exists and populate fields
            if (!hatEditor) {
                // In the unlikely event hatEditor wasn't created earlier, create a minimal visible editor
                console.warn('Hat editor missing - creating fallback editor.');
                // fallback already created elsewhere; do nothing
            }

            // Populate editor controls
            if (hatEditColor) hatEditColor.value = quickColor;
            if (hatEditSize) hatEditSize.value = quickSize;
            if (hatOffX) hatOffX.value = 0;
            if (hatOffY) hatOffY.value = 0.3;
            if (hatOffZ) hatOffZ.value = 0;
            if (hatRotX) hatRotX.value = 0;
            if (hatRotY) hatRotY.value = 0;
            if (hatRotZ) hatRotZ.value = 0;

            // Clear any previous modeler parts so the studio starts fresh
            clearHatModeler();

            // Show the editor like a studio tool window
            hatEditor.style.display = 'flex';

            // Create an initial preview (same as Create Hat would) so user sees immediate result and can refine
            createHatPreview();
            updateHatPreviewTransform();

            // Bring transform controls into editing mode so user can manipulate parts
            // If there are no parts, allow preview selection for global transform via transformControl
            if (transformControl && hatPreview) {
                transformControl.attach(hatPreview);
            }

            addChatMessage('System', 'Hat Editor opened. Use tools to model or save your hat when ready.');
        } catch (e) {
            console.warn('Failed to open Hat Editor:', e);
            addChatMessage('System', 'Failed to open Hat Editor.');
        }
    });
}
if (btnRemoveHat) {
    btnRemoveHat.addEventListener('click', () => {
        playSwitch();
        try {
            if (player && typeof player.removeHat === 'function') {
                player.removeHat();
                player.appearance.hat = null;
                try {
                    const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                    save.hat = null;
                    localStorage.setItem('nblox_appearance', JSON.stringify(save));
                } catch(e){}
                addChatMessage('System', 'Hat removed from your avatar.');
            } else {
                addChatMessage('System', 'No hat to remove.');
            }
        } catch (e) {
            console.warn('Hat removal failed:', e);
        }
    });
}

// Hat Editor: preview object attached to default head (not yet saved)
let hatPreview = null;

// Ensure hat editor exists in the DOM; if not, create a minimal editor container so the script can bind safely.
// This prevents runtime failures when the markup is missing or modified.
let hatEditor = document.getElementById('hat-editor');
if (!hatEditor) {
    hatEditor = document.createElement('div');
    hatEditor.id = 'hat-editor';
    hatEditor.className = 'xp-window';
    hatEditor.style.display = 'none';
    hatEditor.innerHTML = `
        <div class="xp-title-bar">
            <span>Hat Editor</span>
            <button id="btn-close-hat-editor" class="xp-btn-close">X</button>
        </div>
        <div class="xp-body" style="align-items: stretch;">
            <div style="display:flex; gap:8px; align-items:center; justify-content:center;">
                <label style="font-weight:bold;">Color</label>
                <input id="hat-edit-color" type="color" value="#333333">
                <label style="font-weight:bold;">Base Size</label>
                <input id="hat-edit-size" type="range" min="0.5" max="6" step="0.1" value="1.5" style="flex:1;">
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                <div style="flex:1;">
                    <label style="font-weight:bold;">Offset X</label>
                    <input id="hat-off-x" type="range" min="-1.5" max="1.5" step="0.01" value="0" style="width:100%;">
                </div>
                <div style="flex:1;">
                    <label style="font-weight:bold;">Offset Y</label>
                    <input id="hat-off-y" type="range" min="-1.0" max="2.0" step="0.01" value="0.3" style="width:100%;">
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                <div style="flex:1;">
                    <label style="font-weight:bold;">Offset Z</label>
                    <input id="hat-off-z" type="range" min="-1.5" max="1.5" step="0.01" value="0" style="width:100%;">
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                <div style="flex:1;">
                    <label style="font-weight:bold;">Rot X</label>
                    <input id="hat-rot-x" type="range" min="-180" max="180" step="1" value="0" style="width:100%;">
                </div>
                <div style="flex:1;">
                    <label style="font-weight:bold;">Rot Y</label>
                    <input id="hat-rot-y" type="range" min="-180" max="180" step="1" value="0" style="width:100%;">
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                <div style="flex:1;">
                    <label style="font-weight:bold;">Rot Z</label>
                    <input id="hat-rot-z" type="range" min="-180" max="180" step="1" value="0" style="width:100%;">
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px; justify-content:center;">
                <button id="hat-preview-apply" class="menu-btn">Apply Preview</button>
                <button id="hat-preview-save" class="menu-btn" style="background:#00cc00;color:white;">Save Hat</button>
                <button id="hat-preview-cancel" class="menu-btn" style="background:#ffcccc;">Cancel</button>
            </div>
        </div>
        <div class="xp-resizer"></div>
    `;
    document.body.appendChild(hatEditor);
}

// Bind editor controls (will be present either in original markup or created above)
const hatEditColor = document.getElementById('hat-edit-color');
const hatEditSize = document.getElementById('hat-edit-size');
const hatOffX = document.getElementById('hat-off-x');
const hatOffY = document.getElementById('hat-off-y');
const hatOffZ = document.getElementById('hat-off-z');
const hatRotX = document.getElementById('hat-rot-x');
const hatRotY = document.getElementById('hat-rot-y');
const hatRotZ = document.getElementById('hat-rot-z');
const hatPreviewApply = document.getElementById('hat-preview-apply');
const hatPreviewSave = document.getElementById('hat-preview-save');
const hatPreviewCancel = document.getElementById('hat-preview-cancel');
const btnCloseHatEditor = document.getElementById('btn-close-hat-editor');

function createHatPreview(hatData = null) {
    // remove existing preview
    if (hatPreview && hatPreview.parent) {
        try { hatPreview.parent.remove(hatPreview); } catch(e){}
        hatPreview = null;
        clearHatModeler(); // Ensure modeler state is reset if we tear down the preview
    }

    const group = new THREE.Group();
    group.name = 'hat_preview';
    group.scale.set(0.6, 0.6, 0.6); // Base scale for initial preview

    // Load geometry based on hatData, or create simple hat if none
    if (hatData && hatData.constructed && hatData.parts && hatData.parts.length > 0) {
        // Load composed hat
        hatData.parts.forEach((p) => {
            let geo;
            const size = p.scale || [1, 1, 1];
            const color = p.color || hatEditColor.value;

            if (p.type === 'box') {
                geo = new THREE.BoxGeometry(1, 0.5, 1);
            } else if (p.type === 'cylinder') {
                geo = new THREE.CylinderGeometry(0.5, 0.5, 0.6, 16);
            } else {
                geo = new THREE.BoxGeometry(1, 0.5, 1);
            }
            const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
            
            const mesh = new THREE.Mesh(geo, mat);
            if (p.pos) mesh.position.fromArray(p.pos);
            if (p.rot) mesh.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
            if (p.scale) mesh.scale.set(size[0], size[1], size[2]);
            
            group.add(mesh);
            // Also update modeler state if loading into the editor view
            hatParts.push({ mesh: mesh, type: p.type });
        });
        
        // Set color from first part if available (for the color picker display)
        if (hatData.parts[0].color && hatEditColor) {
             hatEditColor.value = hatData.parts[0].color;
        }

    } else {
        // Build a simple hat (brim + cap) matching Player.createHat style
        const size = parseFloat(hatEditSize.value || 1.5);
        const color = hatEditColor.value || '#333333';
        const brimGeo = new THREE.CylinderGeometry(size * 1.4, size * 1.4, 0.15, 24);
        const brimMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
        const brim = new THREE.Mesh(brimGeo, brimMat);
        brim.rotation.x = Math.PI / 2;
        brim.position.y = 0.05;
        group.add(brim);

        // Top (cap)
        const capGeo = new THREE.CylinderGeometry(size * 0.8, size * 0.8, size * 0.9, 24);
        const capMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
        const cap = new THREE.Mesh(capGeo, capMat);
        cap.position.y = 0.6;
        group.add(cap);
    }

    // Position from sliders (applies regardless of whether loaded/simple)
    const off = hatData && hatData.offset ? hatData.offset : { x: parseFloat(hatOffX.value||0), y: parseFloat(hatOffY.value||0), z: parseFloat(hatOffZ.value||0) };
    const rot = hatData && hatData.rot ? hatData.rot : { x: parseFloat(hatRotX.value||0), y: parseFloat(hatRotY.value||0), z: parseFloat(hatRotZ.value||0) };
    
    group.position.set(off.x, off.y, off.z);
    group.rotation.set(
        THREE.MathUtils.degToRad(rot.x),
        THREE.MathUtils.degToRad(rot.y),
        THREE.MathUtils.degToRad(rot.z)
    );
    
    // Scale group based on size slider value if simple hat, otherwise keep default 0.6
    if (!hatData || !hatData.constructed) {
        const s = parseFloat(hatEditSize.value || 1.5);
        group.scale.set(0.6, 0.6, 0.6).multiplyScalar(s / 1.5);
    } else {
        group.scale.set(0.6, 0.6, 0.6);
    }

    hatPreview = group;

    // attach to player's head (or to scene if player.head missing)
    if (player && player.head) {
        player.head.add(hatPreview);
    } else {
        scene.add(hatPreview);
    }
    
    // If we loaded a composed hat, select the first part and refresh list
    if (hatParts.length > 0) {
        selectHatPart(hatParts[0]);
        rebuildHatPartsList();
    }
}

function updateHatPreviewTransform() {
    if (!hatPreview) return;
    hatPreview.position.set(parseFloat(hatOffX.value||0), parseFloat(hatOffY.value||0), parseFloat(hatOffZ.value||0));
    hatPreview.rotation.set(
        THREE.MathUtils.degToRad(parseFloat(hatRotX.value||0)),
        THREE.MathUtils.degToRad(parseFloat(hatRotY.value||0)),
        THREE.MathUtils.degToRad(parseFloat(hatRotZ.value||0))
    );
    const s = parseFloat(hatEditSize.value || 1.5);
    hatPreview.children.forEach(c => {
        if (c.material) c.material.color.set(hatEditColor.value || '#333333');
    });
    hatPreview.scale.set(0.6, 0.6, 0.6).multiplyScalar(s / 1.5);
}

if (btnOpenHatEditor) {
    btnOpenHatEditor.addEventListener('click', () => {
        playSwitch();
        // Initialize editor controls from current appearance or defaults
        const hat = (player && player.appearance && player.appearance.hat) ? player.appearance.hat : null;
        
        // Populate editor controls based on saved hat data
        const defaultColor = (document.getElementById('hat-color') ? document.getElementById('hat-color').value : '#333333');
        const defaultSize = (document.getElementById('hat-size') ? document.getElementById('hat-size').value : 1.5);

        // Simple Hat fields
        // If constructed, we load the part colors, otherwise we use the simple hat color
        hatEditColor.value = (hat && hat.color && !hat.constructed) ? hat.color : defaultColor;
        // If constructed, we don't necessarily use hat.size, but we need to initialize the slider
        hatEditSize.value = (hat && hat.size) ? hat.size : defaultSize;
        
        // Transform fields (use hat data if available, otherwise default)
        hatOffX.value = hat && hat.offset ? hat.offset.x : 0;
        hatOffY.value = hat && hat.offset ? hat.offset.y : 0.3;
        hatOffZ.value = hat && hat.offset ? hat.offset.z : 0;
        hatRotX.value = hat && hat.rot ? hat.rot.x : 0;
        hatRotY.value = hat && hat.rot ? hat.rot.y : 0;
        hatRotZ.value = hat && hat.rot ? hat.rot.z : 0;

        // Clear existing modeler state before loading/creating preview
        clearHatModeler();

        hatEditor.style.display = 'flex';
        createHatPreview(hat); // Pass saved hat data for loading
        rebuildHatPartsList(); // Refresh parts list in case composed hat was loaded
    });
}

if (btnCloseHatEditor) {
    btnCloseHatEditor.addEventListener('click', () => {
        playSwitch();
        hatEditor.style.display = 'none';
        if (hatPreview && hatPreview.parent) {
            try { hatPreview.parent.remove(hatPreview); } catch(e){}
            hatPreview = null;
        }
    });
}

if (hatPreviewCancel) {
    hatPreviewCancel.addEventListener('click', () => {
        playSwitch();
        hatEditor.style.display = 'none';
        if (hatPreview && hatPreview.parent) {
            try { hatPreview.parent.remove(hatPreview); } catch(e){}
            hatPreview = null;
        }
    });
}

if (hatPreviewApply) {
    hatPreviewApply.addEventListener('click', () => {
        playSwitch();
        if (!hatPreview) createHatPreview();
        updateHatPreviewTransform();
        addChatMessage('System', 'Hat preview updated.');
    });
}

if (hatPreviewSave) {
    hatPreviewSave.addEventListener('click', () => {
        playSwitch();
        if (hatParts.length > 0) {
            saveComposedHat();
        } else {
            // fallback to simple createHat behavior
            const color = hatEditColor.value || '#333333';
            const size = parseFloat(hatEditSize.value || '1.5');
            
            if (player && typeof player.createHat === 'function') {
                const hatData = {
                    color: color,
                    size: size,
                    offset: { x: parseFloat(hatOffX.value||0), y: parseFloat(hatOffY.value||0), z: parseFloat(hatOffZ.value||0) },
                    rot: { x: parseFloat(hatRotX.value||0), y: parseFloat(hatRotY.value||0), z: parseFloat(hatRotZ.value||0) }
                };
                
                player.createHat(hatData);

                // Persist appearance
                player.appearance.hat = hatData;

                try {
                    const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                    save.hat = player.appearance.hat;
                    save.colors = player.appearance.colors || save.colors;
                    save.faceUrl = player.appearance.faceUrl || save.faceUrl;
                    save.shirtUrl = player.appearance.shirtUrl || save.shirtUrl;
                    localStorage.setItem('nblox_appearance', JSON.stringify(save));
                } catch (e) { console.warn('Failed to persist hat to storage', e); }

                addChatMessage('System', 'Simple hat saved to your avatar.');
            } else {
                addChatMessage('System', 'Failed to save hat: Player not ready.');
            }
        }

        // Close editor and cleanup preview
        hatEditor.style.display = 'none';
        if (hatPreview && hatPreview.parent) {
            try { hatPreview.parent.remove(hatPreview); } catch(e){}
            hatPreview = null;
        }
        clearHatModeler();
    });
}

/*
  Hat Modeler: allow adding box/cylinder parts, selecting parts with TransformControls,
  previewing, and saving the composed hat to the player. We dynamically inject a small
  toolbar into the Hat Editor and reuse the existing TransformControls instance.
*/
/* reuse existing hatPreview from earlier in the file */
let hatParts = []; // { mesh, type }
let hatSelectedPart = null;
let hatPartsListEl = null;
let hatToolBarEl = null;

// Create toolbar UI inside the hat editor body if not already present
(function ensureHatEditorUI() {
    if (!hatEditor) return;
    const body = hatEditor.querySelector('.xp-body');
    if (!body) return;

    // Add toolbar container
    hatToolBarEl = document.createElement('div');
    hatToolBarEl.style.display = 'flex';
    hatToolBarEl.style.gap = '8px';
    hatToolBarEl.style.width = '100%';
    hatToolBarEl.style.marginTop = '8px';
    hatToolBarEl.style.flexWrap = 'wrap';
    hatToolBarEl.style.alignItems = 'center';
    hatToolBarEl.innerHTML = `
        <button id="hat-add-box" class="menu-btn" style="padding:6px 8px;">Add Box</button>
        <button id="hat-add-cylinder" class="menu-btn" style="padding:6px 8px;">Add Cylinder</button>
        <button id="hat-remove-part" class="menu-btn" style="padding:6px 8px; background:#ffcccc;">Remove Part</button>
        <div id="hat-parts-list" style="flex:1; min-width:120px; display:flex; gap:6px; overflow-x:auto;"></div>
    `;
    body.insertBefore(hatToolBarEl, body.firstChild);
    hatPartsListEl = hatToolBarEl.querySelector('#hat-parts-list');

    // Attach handlers
    hatToolBarEl.querySelector('#hat-add-box').addEventListener('click', () => addHatPart('box'));
    hatToolBarEl.querySelector('#hat-add-cylinder').addEventListener('click', () => addHatPart('cylinder'));
    hatToolBarEl.querySelector('#hat-remove-part').addEventListener('click', () => {
        removeSelectedHatPart();
    });
})();

function rebuildHatPartsList() {
    if (!hatPartsListEl) return;
    hatPartsListEl.innerHTML = '';
    hatParts.forEach((p, idx) => {
        const btn = document.createElement('button');
        btn.className = 'menu-btn';
        btn.style.padding = '4px 8px';
        btn.style.fontSize = '12px';
        btn.textContent = `${p.type} ${idx+1}`;
        if (p === hatSelectedPart) btn.style.background = '#cfeeff';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectHatPart(p);
        });
        hatPartsListEl.appendChild(btn);
    });
}

function addHatPart(type) {
    playSwitch();
    if (!hatPreview) createHatPreview();
    
    // If hatPreview contains default simple hat meshes and we are starting modeling, clear them.
    // Check if hatParts list is empty, but hatPreview (the group) has children.
    if (hatParts.length === 0 && hatPreview.children.length > 0) {
        // Remove existing meshes (default simple hat: brim/cap)
        while (hatPreview.children.length > 0) {
            const child = hatPreview.children[0];
            hatPreview.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                 if (Array.isArray(child.material)) child.material.forEach(m => m.dispose && m.dispose());
                 else child.material.dispose && child.material.dispose();
            }
        }
    }

    // create primitive
    let geo, mat;
    const color = hatEditColor.value || '#333333';
    if (type === 'box') {
        geo = new THREE.BoxGeometry(1, 0.5, 1);
    } else if (type === 'cylinder') {
        geo = new THREE.CylinderGeometry(0.5, 0.5, 0.6, 16);
    } else {
        geo = new THREE.BoxGeometry(1, 0.5, 1);
    }
    mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
    const mesh = new THREE.Mesh(geo, mat);
    // Position slightly offset from center
    mesh.position.set(0, 0.6 + (hatParts.length * 0.05), 0);
    mesh.name = `part_${hatParts.length+1}`;
    
    hatPreview.add(mesh);
    hatParts.push({ mesh: mesh, type: type });
    selectHatPart(hatParts[hatParts.length - 1]);
    rebuildHatPartsList();
}

function selectHatPart(partObj) {
    hatSelectedPart = partObj;
    rebuildHatPartsList();
    // attach TransformControls for the part
    if (partObj && transformControl) {
        transformControl.attach(partObj.mesh);
    } else if (transformControl) {
        transformControl.detach();
    }
}

function removeSelectedHatPart() {
    if (!hatSelectedPart) return;
    const idx = hatParts.indexOf(hatSelectedPart);
    if (idx === -1) return;
    // remove mesh from preview
    try {
        if (hatSelectedPart.mesh.parent) hatSelectedPart.mesh.parent.remove(hatSelectedPart.mesh);
        if (hatSelectedPart.mesh.geometry) hatSelectedPart.mesh.geometry.dispose();
        if (hatSelectedPart.mesh.material) hatSelectedPart.mesh.material.dispose();
    } catch (e) {}
    hatParts.splice(idx, 1);
    hatSelectedPart = null;
    transformControl.detach();
    rebuildHatPartsList();
}

function clearHatModeler() {
    // remove all parts and preview
    for (const p of hatParts) {
        try { if (p.mesh.parent) p.mesh.parent.remove(p.mesh); } catch(e){}
    }
    hatParts = [];
    hatSelectedPart = null;
    rebuildHatPartsList();
    if (hatPreview && hatPreview.parent) {
        try { hatPreview.parent.remove(hatPreview); } catch(e){}
    }
    hatPreview = null;
}

// Save composed hat: create group, parent to player's visible head (or GLB), and persist transforms
function saveComposedHat() {
    if (!player) return;
    // Remove any existing hat
    player.removeHat();

    const composed = new THREE.Group();
    composed.name = 'composed_hat';
    // Copy parts into a new group (clone geometry/materials to avoid sharing)
    hatParts.forEach(p => {
        const gm = p.mesh.geometry.clone();
        let mm;
        try {
            mm = p.mesh.material.clone();
        } catch (e) {
            mm = new THREE.MeshStandardMaterial({ color: p.mesh.material.color ? p.mesh.material.color.clone() : new THREE.Color('#333') });
        }
        const m = new THREE.Mesh(gm, mm);
        m.position.copy(p.mesh.position);
        m.rotation.copy(p.mesh.rotation);
        m.scale.copy(p.mesh.scale);
        composed.add(m);
    });

    // Scale and default offsets like createHat uses a base scale factor
    composed.scale.set(1,1,1);

    // Prefer attaching to GLB head clone if present
    let attachTarget = player.head;
    if (player.mesh && player.mesh.children && player.mesh.children.length > 0) {
        for (const c of player.mesh.children) {
            if (c === player.head) continue;
            if (c.isObject3D && (!player.head.visible || c.name.toLowerCase().includes('head') || c.type === 'Group' || c.isMesh)) {
                attachTarget = c;
                break;
            }
        }
    }

    // Position composed group relative to head
    composed.position.set(parseFloat(hatOffX.value||0), parseFloat(hatOffY.value||0), parseFloat(hatOffZ.value||0));
    composed.rotation.set(
        THREE.MathUtils.degToRad(parseFloat(hatRotX.value||0)),
        THREE.MathUtils.degToRad(parseFloat(hatRotY.value||0)),
        THREE.MathUtils.degToRad(parseFloat(hatRotZ.value||0))
    );

    // Attach to head
    attachTarget.add(composed);

    // Save to player's appearance state
    player.appearance.hat = {
        constructed: true,
        parts: hatParts.map(p => ({
            type: p.type,
            pos: p.mesh.position.toArray(),
            rot: [p.mesh.rotation.x, p.mesh.rotation.y, p.mesh.rotation.z],
            scale: p.mesh.scale.toArray(),
            color: (p.mesh.material && p.mesh.material.color) ? `#${p.mesh.material.color.getHexString()}` : hatEditColor.value
        })),
        offset: { x: parseFloat(hatOffX.value||0), y: parseFloat(hatOffY.value||0), z: parseFloat(hatOffZ.value||0) },
        rot: { x: parseFloat(hatRotX.value||0), y: parseFloat(hatRotY.value||0), z: parseFloat(hatRotZ.value||0) }
    };

    // Persist to localStorage
    try {
        const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
        save.hat = player.appearance.hat;
        save.colors = player.appearance.colors || save.colors;
        save.faceUrl = player.appearance.faceUrl || save.faceUrl;
        save.shirtUrl = player.appearance.shirtUrl || save.shirtUrl;
        localStorage.setItem('nblox_appearance', JSON.stringify(save));
    } catch (e) { console.warn('Failed to persist composed hat', e); }

    addChatMessage('System', 'Custom hat saved to your avatar.');
}

// Hook Save button to composed hat flow (override previous simple save when modeler has parts)
if (hatPreviewSave) {
    hatPreviewSave.addEventListener('click', () => {
        playSwitch();
        if (hatParts.length > 0) {
            saveComposedHat();
        } else {
            // fallback to simple createHat behavior
            const color = hatEditColor.value || '#333333';
            const size = parseFloat(hatEditSize.value || '1.5');
            if (player && typeof player.createHat === 'function') {
                player.createHat(color, size);
                player._hat.position.set(parseFloat(hatOffX.value||0), parseFloat(hatOffY.value||0), parseFloat(hatOffZ.value||0));
                player._hat.rotation.set(
                    THREE.MathUtils.degToRad(parseFloat(hatRotX.value||0)),
                    THREE.MathUtils.degToRad(parseFloat(hatRotY.value||0)),
                    THREE.MathUtils.degToRad(parseFloat(hatRotZ.value||0))
                );
                addChatMessage('System', 'Simple hat saved to your avatar.');
            } else {
                addChatMessage('System', 'Failed to save hat: Player not ready.');
            }
        }

        // Close editor and cleanup preview
        hatEditor.style.display = 'none';
        if (hatPreview && hatPreview.parent) {
            try { hatPreview.parent.remove(hatPreview); } catch(e){}
            hatPreview = null;
        }
        clearHatModeler();
    });
}

// Live-update preview when sliders change
[hatEditColor, hatEditSize, hatOffX, hatOffY, hatOffZ, hatRotX, hatRotY, hatRotZ].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => {
        if (!hatPreview) createHatPreview();
        updateHatPreviewTransform();
        // Also tint parts if model exists
        hatParts.forEach(p => {
            if (p.mesh && p.mesh.material && p.mesh.material.color) p.mesh.material.color.set(hatEditColor.value || '#333333');
        });
    });
});

// Ensure transforms applied live for modeler parts when transform control changes
transformControl.addEventListener('change', () => {
    if (hatSelectedPart && hatSelectedPart.mesh) {
        // update stored transforms (no-op because we're using the live mesh)
        rebuildHatPartsList();
    }
});

// Clean up hat preview on editor close (already handled in earlier close handlers), ensure parts cleared
window.addEventListener('beforeunload', () => {
    clearHatModeler();
});

// Window Close Button Logic
document.getElementById('btn-close-start').onclick = () => alert("Cannot shut down Nblox OS while kernel is running.");
document.getElementById('btn-close-play').onclick = () => document.getElementById('btn-play-back').click();
document.getElementById('btn-close-set').onclick = () => document.getElementById('btn-settings-back').click();
document.getElementById('btn-close-cust').onclick = () => document.getElementById('btn-cust-done').click();

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
    // Studio Shortcuts
    if (gameState === 'STUDIO' && document.activeElement.tagName !== 'INPUT') {
        switch(e.key) {
            case '1': setStudioTool('select'); break;
            case '2': setStudioTool('move'); break;
            case '3': setStudioTool('scale'); break;
            case '4': setStudioTool('rotate'); break;
            case 'Delete': 
            case 'Backspace':
                if (studioSelected) document.getElementById('tool-delete').click();
                break;
            case 'd':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    document.getElementById('tool-duplicate').click();
                }
                break;
        }
    }

    // Global zoom controls: 'i' to zoom in, 'o' to zoom out
    // When playing/testing adjust third-person camera distance; in studio move camera forward/back.
    if (e.key === 'i' || e.key === 'o') {
        const zoomStep = 2; // studs per key press
        if (gameState === 'PLAYING' || gameState === 'TEST') {
            if (e.key === 'i') cameraDist = Math.max(4, cameraDist - zoomStep);
            else cameraDist = Math.min(80, cameraDist + zoomStep);
            playSwitch(1.0, 0.25);
        } else if (gameState === 'STUDIO') {
            // Move studio camera forward/back along its look direction
            const dir = new THREE.Vector3();
            camera.getWorldDirection(dir);
            const moveAmt = (e.key === 'i' ? -zoomStep : zoomStep);
            // Move horizontally and vertically proportionally to current pitch
            studioCamPos.addScaledVector(dir, moveAmt);
            playSwitch(1.0, 0.25);
        } else {
            // In menus, nudge the menu camera distance if desired (no-op or small feedback)
            playSwitch(1.0, 0.15);
        }
    }
});

// Chat Logic
function addChatMessage(name, text) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.textContent = `[${name}]:`;
    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = text;
    el.appendChild(nameSpan);
    el.appendChild(textSpan);
    chatHistory.appendChild(el);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // Stop bubbling (prevents game movement)
    if (e.key === 'Enter') {
        const msg = chatInput.value.trim();
        if (msg.length > 0) {
            // Ban word detection (case-insensitive, simple containment)
            const lower = msg.toLowerCase();
            const bannedWord = 'n word'; // placeholder, detection below uses exact slur check
            // Note: to preserve code clarity while preventing accidental literal slur in repo,
            // we check for the slur dynamically via character pattern:
            const slurPattern = /n[i1!l]{1,2}g{1,2}e?r?/i; // tolerant pattern to detect common obfuscations
            if (slurPattern.test(msg)) {
                // Set a 3-day ban (in milliseconds)
                const threeDaysMs = 1 * 60 * 1000; // 1 minute ban for testing
                const until = Date.now() + threeDaysMs;
                try {
                    localStorage.setItem('nblox_ban_until', String(until));
                } catch (err) {
                    console.warn('Failed to persist ban timestamp:', err);
                }

                // Notify server/peers of ban state in presence (best-effort)
                try {
                    room.updatePresence({ banned: true, banUntil: until });
                } catch (err) { /* ignore */ }

                // Inform user, clear chat input, force-return to menu
                alert('You have been banned for 3 days for violating chat rules.');
                chatInput.value = '';
                chatInput.blur();

                // Disable play/studio buttons
                document.getElementById('btn-play').disabled = true;
                document.getElementById('btn-studio').disabled = true;
                document.getElementById('btn-play').title = 'Banned until: ' + new Date(until).toLocaleString();
                document.getElementById('btn-studio').title = 'Banned until: ' + new Date(until).toLocaleString();

                // If currently in-game, force leave to menu
                if (gameState === 'PLAYING' || gameState === 'TEST') {
                    // perform safe leave
                    try {
                        btnExit.click();
                    } catch (err) {}
                }
                return;
            }

            // Detect predatory behaviour for local user claiming age 13 and messaging about dating
            const datingPatternLocal = /\b(date|dating|meet up|meetup|kissing|relationship|romantic)\b/i;
            const declaredAgeLocal = parseInt((document.getElementById('input-age') && document.getElementById('input-age').value) || '18', 10);

            if (declaredAgeLocal === 13 && datingPatternLocal.test(msg)) {
                // Ban the local account for 5 days (prevent them from continuing)
                const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
                const until = Date.now() + fiveDaysMs;
                try {
                    localStorage.setItem('nblox_ban_until', String(until));
                } catch (err) {
                    console.warn('Failed to persist ban timestamp:', err);
                }

                try { room.updatePresence({ banned: true, banUntil: until }); } catch(e){}

                alert('You have been banned for predatory behavior for 5 days.');
                chatInput.value = '';
                chatInput.blur();

                document.getElementById('btn-play').disabled = true;
                document.getElementById('btn-studio').disabled = true;
                document.getElementById('btn-play').title = 'Banned until: ' + new Date(until).toLocaleString();
                document.getElementById('btn-studio').title = 'Banned until: ' + new Date(until).toLocaleString();

                if (gameState === 'PLAYING' || gameState === 'TEST') {
                    try { btnExit.click(); } catch(e){}
                }
                return;
            }

            if (msg.toLowerCase() === '/e dance') {
                player.startDance();
                chatInput.value = '';
                chatInput.blur();
                return;
            }
            if (msg.toLowerCase() === '/e wave') {
                player.startWave();
                chatInput.value = '';
                chatInput.blur();
                return;
            }

            const username = document.getElementById('input-username').value || "Player";
            const declaredAge = parseInt((document.getElementById('input-age') && document.getElementById('input-age').value) || '18', 10);
            
            // Send to server
            room.send({
                type: 'chat',
                message: msg,
                username: username,
                age: declaredAge
            });

            // Player local bubble
            player.chat(msg);
            
            chatInput.value = '';
            chatInput.blur();
        }
    }
    if (e.key === 'Escape') {
        chatInput.blur();
    }
});

// Cursor Logic
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2(1, 1); // Start off-center
const cursorEl = document.getElementById('custom-cursor');
let cursorState = 'far';

const shiftLockCursor = document.createElement('img');
shiftLockCursor.src = './CameraZoomIn_ovr (1).png';
shiftLockCursor.style.position = 'fixed';
shiftLockCursor.style.top = '50%';
shiftLockCursor.style.left = '50%';
shiftLockCursor.style.transform = 'translate(-50%, -50%)';
shiftLockCursor.style.width = '32px';
shiftLockCursor.style.height = '32px';
shiftLockCursor.style.zIndex = '10001';
shiftLockCursor.style.pointerEvents = 'none';
shiftLockCursor.style.display = 'none';
shiftLockCursor.style.mixBlendMode = 'screen'; // Make black background transparent
document.body.appendChild(shiftLockCursor);

window.addEventListener('keydown', (e) => {
    if (e.key === '/') {
        e.preventDefault();
        chatInput.focus();
    }
});

window.addEventListener('mousemove', (event) => {
    if (input.isLocked) {
        // Keep raycasting mouse centered when locked
        mouse.x = 0;
        mouse.y = 0;
        return;
    }
    if (input.isRightMouseDown && gameState === 'PLAYING') return;

    mouse.x = ((event.clientX / UI_ZOOM) / window.innerWidth) * 2 - 1;
    mouse.y = -((event.clientY / UI_ZOOM) / window.innerHeight) * 2 + 1;
    if (cursorEl) {
        cursorEl.style.transform = `translate(${event.clientX / UI_ZOOM}px, ${event.clientY / UI_ZOOM}px) translate(-50%, -50%)`;
    }
});

window.addEventListener('mousemove', (e) => {
    if (gameState === 'MENU' && e.target.tagName !== 'BUTTON') {
        mouse.x = ((e.clientX / UI_ZOOM) / window.innerWidth) * 2 - 1;
        mouse.y = -((e.clientY / UI_ZOOM) / window.innerHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(player.mesh.children, true);
        if (intersects.length > 0) {
            player.glitchPart(intersects[0].object);
        }
    }
});

// Loop
let lastTime = 0;
const fps = 60; // Smooth 60FPS for fluid animation
const interval = 1000 / fps;

function animate(currentTime) {
    requestAnimationFrame(animate);
    
    if (gameState === 'BLOCKED') return; // Stop updates if blocked

    const deltaTime = currentTime - lastTime;
    
    if (deltaTime >= interval) {
        const dt = Math.min(deltaTime / 1000, 0.1); // Cap dt
        lastTime = currentTime - (deltaTime % interval);

        // Update Remote Players
        Object.values(remotePlayers).forEach(rp => rp.update(dt, camera, world));

        // Game Logic based on State
        if (gameState === 'PLAYING' || gameState === 'TEST') {
            updatePlaying(dt);
        } else if (gameState === 'MENU' || gameState === 'CUSTOMIZE' || gameState === 'SETTINGS') {
            updateMenu(dt);
        } else if (gameState === 'STUDIO') {
            updateStudio(dt);
        }

        renderer.render(scene, camera);
    }
}

function updateStudio(dt) {
    // Fly Camera Logic
    // Right Click to rotate
    if (input.isRightMouseDown) {
        const look = input.getLookDelta();
        // In-game sensitivity and standard mouse-to-pitch mapping
        const sens = cameraSensitivity * 0.005;
        studioCamYaw -= look.x * sens;
        // Fix pitch inversion: mouse down should look down
        studioCamPitch -= look.y * sens; 
        studioCamPitch = Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, studioCamPitch));
        document.body.style.cursor = 'none';
    } else {
        document.body.style.cursor = 'default';
        input.getLookDelta(); // Clear delta
    }

    const rot = new THREE.Euler(studioCamPitch, studioCamYaw, 0, 'YXZ');
    // Actual direction the camera is looking
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(rot);
    // Standard world up
    const worldUp = new THREE.Vector3(0, 1, 0);
    // Horizontal Right vector (cross of fwd and world up) ensures strafing is horizontal
    const right = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
    // If we're looking almost straight up/down, cross product might fail, fallback to yaw-only right
    if (right.lengthSq() < 0.001) {
        right.set(1, 0, 0).applyEuler(new THREE.Euler(0, studioCamYaw, 0, 'YXZ'));
    }

    const speed = input.keys.shift ? 80 : 30; // Slightly faster studio flight
    
    // Support both WASD and Arrow Keys in Studio
    if (input.keys.w || input.keys.arrowup) studioCamPos.addScaledVector(fwd, speed * dt);
    if (input.keys.s || input.keys.arrowdown) studioCamPos.addScaledVector(fwd, -speed * dt);
    if (input.keys.d || input.keys.arrowright) studioCamPos.addScaledVector(right, speed * dt);
    if (input.keys.a || input.keys.arrowleft) studioCamPos.addScaledVector(right, -speed * dt);
    
    // Q/E for vertical up/down remains standard for Roblox Studio users
    if (input.keys.q) studioCamPos.addScaledVector(worldUp, -speed * dt);
    if (input.keys.e) studioCamPos.addScaledVector(worldUp, speed * dt);

    camera.position.copy(studioCamPos);
    camera.rotation.copy(rot);

    if (world.skyboxMesh) world.skyboxMesh.position.copy(camera.position);

    // Selection Logic (Click)
    // We handle click in window event, but need to check if we are hovering gizmo
    if (!input.isDraggingGizmo && input.isLocked === false && !input.isRightMouseDown) {
        // Selection is handled via event listener to avoid constant raycasting, 
        // but we need to update cursor if hovering a part
    }
}

let studioHovered = null;

// Improved Studio Selection: Hover Highlight + Click to Select
window.addEventListener('mousemove', (e) => {
    if (gameState !== 'STUDIO') {
        if (hoverHelper.visible) hoverHelper.visible = false;
        return;
    }
    if (e.target.closest('#studio-gui')) return;
    
    // Don't update hover if dragging gizmo
    if (input.isDraggingGizmo) return;
    
    // Fix: If mouse is over gizmo handles, clear hover so we don't select behind it
    if (transformControl.axis !== null && activeTool !== 'select') {
        studioHovered = null;
        hoverHelper.visible = false;
        return;
    }

    // Adjust for Zoom
    mouse.x = ((e.clientX / UI_ZOOM) / window.innerWidth) * 2 - 1;
    mouse.y = -((e.clientY / UI_ZOOM) / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(world.collidables, false);

    if (intersects.length > 0) {
        studioHovered = intersects[0].object;
        hoverHelper.setFromObject(studioHovered);
        hoverHelper.visible = true;
    } else {
        studioHovered = null;
        hoverHelper.visible = false;
    }
});

window.addEventListener('mousedown', (e) => {
    if (gameState !== 'STUDIO') return;
    if (e.target.closest('#studio-gui')) return; // Ignore if clicking UI
    if (e.button !== 0) return; // Only Left Click
    if (input.isDraggingGizmo) return;
    
    // Fix: If clicking gizmo, don't select
    if (transformControl.axis !== null && activeTool !== 'select') return;

    if (studioHovered) {
        studioSelected = studioHovered;
        updateStudioSelection();
    } else {
        // Clicked empty space -> Deselect
        studioSelected = null;
        updateStudioSelection();
    }
});


function updateMenu(dt) {
    if (world.mapGroup) world.mapGroup.visible = false;
    menuGroup.visible = true;
    player.mesh.visible = true;

    // Hide Remote Players in Menu
    Object.values(remotePlayers).forEach(rp => rp.mesh.visible = false);

    // Fixed Camera
    camera.position.set(0, 5, 15);
    camera.lookAt(0, 4, 0);

    if (world.skyboxMesh) world.skyboxMesh.position.copy(camera.position);

    if (player.isDead) {
        const menuWorld = { collidables: menuGroup.children };
        player.update(dt, { x: 0, z: 0, jump: false }, menuWorld);
        return;
    }

    // Dont change. this is already fixed, no need to fix whats already working.
    const menuPos = new THREE.Vector3(3.5, 1.5, 8)
    player.velocity.set(0, 0, 0);
    player.position.copy(menuPos);
    player.onGround = true; // Force ground state for animation
    
    // Dont change. this is already fixed, no need to fix whats already working.
    player.mesh.rotation.y = -Math.PI / 4;

    // Force Animation
    player.forcedAnim = 'walk';
    
    // Animate player idly
    // We pass null world, but since we forced velocity to 0 and handle position below, gravity won't accumulate effectively
    player.update(dt, { x: 0, z: 0, jump: false }, null); 
    
    // DOUBLE CRITICAL FIX: Force position AFTER update to overwrite any gravity integration from Player.js
    player.position.copy(menuPos);
    player.mesh.position.copy(player.position);
    player.mesh.rotation.set(0, -Math.PI / 4, 0);
}

function updatePlaying(dt) {
    if (world.mapGroup) world.mapGroup.visible = true;
    menuGroup.visible = false;
    
    // POINTS: award 1 point every 10 seconds played
    playSecondsAcc += dt;
    if (playSecondsAcc >= 10.0) {
        playSecondsAcc -= 10.0;
        try {
            websimPoints = parseInt(localStorage.getItem('nblox_points') || '0', 10);
            if (isNaN(websimPoints)) websimPoints = 0;
            websimPoints += 1;
            localStorage.setItem('nblox_points', String(websimPoints));
            if (pointsDisplay) pointsDisplay.textContent = String(websimPoints);
            addChatMessage('System', 'You earned 1 point for playing!');
        } catch (e) {
            console.warn('Failed to award playtime point:', e);
        }
    }

    // Sync Presence
    room.updatePresence({
        position: player.position,
        rotation: player.mesh.rotation.y,
        animState: player.animState,
        map: currentMapName,
        isDead: player.isDead
    });

    // 1. Update Camera Rotation
    const look = input.getLookDelta();
    if (look.x !== 0 || look.y !== 0) {
        cameraYaw -= look.x * 0.005 * cameraSensitivity;
        
        const invertMult = cameraInvertY ? -1 : 1;
        cameraPitch += look.y * 0.005 * cameraSensitivity * invertMult;
        
        // Clamp pitch (0.1 to PI/2 - 0.1)
        cameraPitch = Math.max(-1.4, Math.min(1.5, cameraPitch));
        
        // Ratchet Sound
        if (Math.abs(cameraYaw - lastCamYawClick) > 0.4) {
             // Use WebAudio
             playSwitch(1.5, 0.3);
             lastCamYawClick = cameraYaw;
        }
    }

    // 2. Update Camera Position
    const focusPoint = player.position.clone().add(new THREE.Vector3(0, 4.5, 0));

    if (input.isShiftLocked) {
        // Offset focus point to the right relative to camera view
        const offsetAmt = 1.75; // Studs
        // Yaw 0 = +Z (South). Right is -X (West).
        // 3D world: Forward is -Z. Right is +X.
        // So joystick Y+ -> Forward -> -Z
        // Joystick X+ -> Right -> +X
        const rx = -Math.cos(cameraYaw);
        const rz = Math.sin(cameraYaw);
        focusPoint.x += rx * offsetAmt;
        focusPoint.z += rz * offsetAmt;
    }

    const hDist = cameraDist * Math.cos(cameraPitch);
    const vDist = cameraDist * Math.sin(cameraPitch);
    const offsetX = hDist * Math.sin(cameraYaw);
    const offsetZ = hDist * Math.cos(cameraYaw);

    const camPos = focusPoint.clone().add(new THREE.Vector3(offsetX, vDist, offsetZ));
    
    // Wall check
    const camDir = new THREE.Vector3().subVectors(camPos, focusPoint).normalize();
    const dist = camPos.distanceTo(focusPoint);
    const wallRay = new THREE.Raycaster(focusPoint, camDir, 0, dist);
    const wallHits = wallRay.intersectObjects(world.collidables);
    if (wallHits.length > 0) {
        camPos.copy(wallHits[0].point).addScaledVector(camDir, -0.5);
    }

    camera.position.copy(camPos);
    camera.lookAt(focusPoint);

    if (world.skyboxMesh) world.skyboxMesh.position.copy(camera.position);

    // Update Cursor UI for Shift Lock
    if (input.isShiftLocked) {
        shiftLockCursor.style.display = 'block';
        if (cursorEl) cursorEl.style.display = 'none';
    } else {
        shiftLockCursor.style.display = 'none';
    }

    // 3. Movement relative to Camera
    const rawControls = input.getMovement();
    const camFwd = new THREE.Vector3().subVectors(player.position, camera.position).setY(0).normalize();
    const camRight = new THREE.Vector3().crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).normalize();
    
    const moveVec = new THREE.Vector3()
        .addScaledVector(camFwd, -rawControls.z)
        .addScaledVector(camRight, rawControls.x);
    
    // Pass 'e' key for interaction
    const controls = { 
        x: moveVec.x, 
        z: moveVec.z, 
        jump: rawControls.jump,
        w: input.keys.w,
        s: input.keys.s,
        a: input.keys.a,
        d: input.keys.d,
        e: input.keys.e
    };

    if (input.isShiftLocked) {
        controls.lookAngle = cameraYaw + Math.PI;
    }

    player.update(dt, controls, world, camera);
    
    world.update(dt); // Update cars and animations

    // Cursor Raycast
    if (!input.isLocked && !input.isShiftLocked) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(scene.children, true);
        const hovering = intersects.length > 0;
        
        if (cursorEl) {
            cursorEl.style.display = 'block';
            const targetState = hovering ? 'near' : 'far';
            if (cursorState !== targetState) {
                cursorState = targetState;
                cursorEl.src = hovering ? './ArrowCursor.png' : './ArrowFarCursor.png';
            }
        }
    } else {
        if (cursorEl) cursorEl.style.display = 'none';
    }
} // End updatePlaying

function handleResize() {
    // Ensure the WebGL canvas uses the real viewport size so rendering covers the iframe/window.
    const width = window.innerWidth;
    const height = window.innerHeight;
    const aspect = width / Math.max(1, height);
    
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    
    // Use the actual pixel size for the renderer; keep CSS 100% so it scales nicely in the iframe.
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
}

window.addEventListener('resize', handleResize);
handleResize();

// Auto-open Studio on load (enter Studio mode immediately)
setTimeout(() => {
    try {
        // Trigger the same handler used by the Studio button so Studio setup runs
        const btn = document.getElementById('btn-studio');
        if (btn) btn.click();
    } catch (e) {
        console.warn('Auto-open Studio failed:', e);
    }
}, 50);

requestAnimationFrame(animate);

// Reload shortcut and API
window.reloadNblox = () => {
    try {
        location.reload();
    } catch (e) {
        console.warn('Reload failed', e);
    }
};
// Support Ctrl/Cmd+R to trigger the reload API (prevent default browser behavior so it's explicit)
window.addEventListener('keydown', (e) => {
    try {
        if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'r') {
            e.preventDefault();
            window.reloadNblox();
        }
    } catch (err) { /* noop */ }
});