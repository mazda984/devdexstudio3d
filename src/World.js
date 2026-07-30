/*
  REFACTOR NOTICE:
  World.js has grown large; map-loading, skybox, serialization, animated entities and vehicle
  management will be split into smaller modules (e.g. src/world/skybox.js, src/world/maps.js,
  src/world/animation.js). Tombstone comments below mark code areas intended for extraction.

  Tombstone examples:
    // removed: function legacyLoadMap() {}
    // removed: const heavyAnimatedDefinitions = {}
*/
import * as THREE from 'three';
import { boxUnwrapUVs, surfaceManager } from './utils.js';
import { Vehicle } from './Vehicle.js';

export class World {
    constructor(scene) {
        this.scene = scene;
        this.mapGroup = new THREE.Group();
        this.scene.add(this.mapGroup);
        
        this.items = [];
        this.killBricks = [];
        this.collidables = [];
        this.launchPads = [];
        this.teleporters = [];
        
        this.vehicles = [];
        this.animated = [];

        this.bgm = null;

        this.skyboxMesh = null;
        this.setupSkybox();
        this.loadMap('platform');
    }

    setupSkybox() {
        const loader = new THREE.TextureLoader();

        // Use the provided sky image for all faces to create a unified skybox.
        const sharedPath = './1eprhbtmvoo51.png';

        const loadSide = (path) => {
            const tex = loader.load(path);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            return new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false });
        };

        // Create materials for every face using the same image.
        const matTop = loadSide(sharedPath);
        const matBottom = loadSide(sharedPath);
        // Rotate bottom so it doesn't appear upside-down.
        if (matBottom.map) {
            matBottom.map.center.set(0.5, 0.5);
            matBottom.map.rotation = Math.PI;
        }

        const materials = [
            loadSide(sharedPath), // px
            loadSide(sharedPath), // nx
            matTop,               // py (up)
            matBottom,            // ny (down)
            loadSide(sharedPath), // pz
            loadSide(sharedPath)  // nz
        ];

        const geo = new THREE.BoxGeometry(400, 400, 400);
        this.skyboxMesh = new THREE.Mesh(geo, materials);
        this.skyboxMesh.renderOrder = -Infinity;
        this.scene.add(this.skyboxMesh);
    }

    clear() {
        this.items.forEach(mesh => {
            this.mapGroup.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
        });
        
        this.bgm = null;

        // Clear Vehicles
        this.vehicles.forEach(v => {
            this.scene.remove(v.mesh);
            // v.dispose();
        });
        this.vehicles = [];
        this.animated = [];

        this.items = [];
        this.collidables = [];
        this.killBricks = [];
        this.launchPads = [];
        this.teleporters = [];
        this.finishPads = [];
        this.finishPads = [];
    }

    loadMap(name) {
        this.clear();
        switch(name) {
            case 'baseplate': this.setupBaseplate(); break;
            case 'platform': this.setupPlatform(); break;
            case 'easy-obby': this.setupObby(); break;
            case 'digital-circus': this.setupCircus(); break;
            case 'minecraft':
                // Custom Minecraft-like world: lime green baseplate + simple trees
                this.setupMinecraft();
                this.bgm = './minecraftmusic.mp3';
                break;
            case 'geometry-dash':
                // Load the Geometry Dash style 2D obstacle course (spikes marked as 'kill' in setupGeometryDash)
                this.setupGeometryDash();
                // Optionally choose a short, punchy music track for Geometry Dash feel
                this.bgm = './minecraftmusic.mp3';
                break;
            default: console.warn("Unknown map: " + name); this.setupPlatform(); break;
        }
    }

    // New: JSON Serialization for User Worlds
    serialize() {
        const data = [];
        // Save BGM as a special meta entry or property
        if (this.bgm) {
            data.push({ type: 'meta_bgm', url: this.bgm });
        }

        this.items.forEach(obj => {
            if (obj.userData && obj.userData.serial) {
                const s = obj.userData.serial;
                data.push({
                    type: s.type,
                    x: obj.position.x,
                    y: obj.position.y,
                    z: obj.position.z,
                    w: s.w, h: s.h, d: s.d, // Dimensions (if baked)
                    sx: obj.scale.x, // Scale (if not baked)
                    sy: obj.scale.y,
                    sz: obj.scale.z,
                    rx: obj.rotation.x,
                    ry: obj.rotation.y,
                    rz: obj.rotation.z,
                    color: s.color, // integer
                    flags: s.flags
                });
            }
        });
        return data;
    }

    loadFromData(data) {
        this.clear();
        if (!Array.isArray(data)) return;
        
        data.forEach(d => {
            if (d.type === 'meta_bgm') {
                this.bgm = d.url;
            } else if (d.type === 'block' || d.type === 'box') {
                const mesh = this.createBlock(d.x, d.y, d.z, d.w, d.h, d.d, d.color, d.flags);
                mesh.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
                mesh.scale.set(d.sx || 1, d.sy || 1, d.sz || 1);
            } else if (d.type === 'sphere' || d.type === 'cylinder' || d.type === 'wedge') {
                const mesh = this.createPart(d.type, d.x, d.y, d.z, {x:d.w, y:d.h, z:d.d}, d.color, d.flags);
                mesh.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
                mesh.scale.set(d.sx || 1, d.sy || 1, d.sz || 1);
            }
        });
    }

    addToWorld(mesh, types = ['static']) {
        this.mapGroup.add(mesh);
        this.items.push(mesh);
        if (types.includes('static')) this.collidables.push(mesh);
        if (types.includes('kill')) this.killBricks.push(mesh);
        if (types.includes('launch')) this.launchPads.push(mesh);
        if (types.includes('teleport')) this.teleporters.push(mesh);
        if (types.includes('finish')) this.finishPads.push(mesh);
    }

    createPart(type, x, y, z, size, color, flags = ['static']) {
        // Wrapper for shapes
        if (type === 'block' || type === 'box') {
            return this.createBlock(x, y, z, size.x, size.y, size.z, color, flags);
        }

        let geo;
        if (type === 'sphere') {
            geo = new THREE.SphereGeometry(Math.min(size.x, size.y, size.z) / 2, 16, 16);
        } else if (type === 'cylinder') {
            geo = new THREE.CylinderGeometry(size.x / 2, size.x / 2, size.y, 16);
        } else if (type === 'wedge') {
            // Wedge logic: Box with collapsed vertices
            geo = new THREE.BoxGeometry(size.x, size.y, size.z);
            boxUnwrapUVs(geo); // Apply standard box UVs before distorting
            
            const pos = geo.attributes.position;
            const wHalf = size.x / 2;
            const hHalf = size.y / 2;
            const dHalf = size.z / 2;
            
            // Iterate over vertices and collapse "Front Top" to "Front Bottom"
            // Front face is +z (dHalf). Top is +y (hHalf).
            // We want to collapse (x, +h, +d) -> (x, -h, +d)
            // Or typically Roblox wedge is: Back face vertical, Bottom flat, Hypotenuse slope.
            // If we assume Box is centered.
            // Front face (+z) vertices at Y=+hHalf should become Y=-hHalf
            
            for(let i=0; i<pos.count; i++) {
                const vy = pos.getY(i);
                const vz = pos.getZ(i);
                
                // Check if vertex is on the Front (+Z) and Top (+Y)
                if (vz > 0.1 && vy > 0.1) {
                    pos.setY(i, -hHalf); // Snap down
                }
            }
            pos.needsUpdate = true;
            geo.computeVertexNormals();
        }

        const col = new THREE.Color(color);
        const mat = new THREE.MeshStandardMaterial({ 
            map: surfaceManager.textures.studs, 
            color: col,
            roughness: 0.5 
        });

        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        mesh.userData.serial = {
            type: type,
            w: size.x, h: size.y, d: size.z,
            color: color,
            flags: flags
        };
        
        mesh.name = type.charAt(0).toUpperCase() + type.slice(1);
        this.addToWorld(mesh, flags);
        return mesh;
    }

    createBlock(x, y, z, w, h, d, color, types = ['static']) {
        const geo = new THREE.BoxGeometry(w, h, d);
        boxUnwrapUVs(geo);
        
        const col = new THREE.Color(color);

        const studMat = new THREE.MeshStandardMaterial({ map: surfaceManager.textures.studs, color: col });
        const inletMat = new THREE.MeshStandardMaterial({ map: surfaceManager.textures.inlet, color: col });
        const sideMat = new THREE.MeshStandardMaterial({ color: col });
        
        // Top=Studs, Bottom=Inlet
        const mats = [sideMat, sideMat, studMat, inletMat, sideMat, sideMat];
        const mesh = new THREE.Mesh(geo, mats);
        mesh.position.set(x, y, z);
        
        // Save serialization data
        mesh.userData.serial = {
            type: 'block',
            w: w, h: h, d: d,
            color: color,
            flags: types
        };

        if (types.includes('spawn')) {
            mesh.name = "SpawnLocation";
            this.addSpawnDecal(mesh);
        } else {
            mesh.name = "Part";
        }

        this.addToWorld(mesh, types);
        return mesh;
    }

    addSpawnDecal(parentMesh) {
         // Decal
         const canvas = document.createElement('canvas');
         canvas.width = 64; canvas.height = 64;
         const ctx = canvas.getContext('2d');
         ctx.fillStyle = '#888'; ctx.fillRect(0,0,64,64);
         ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
         ctx.beginPath(); ctx.arc(32,32,20,0,Math.PI*2); ctx.stroke();
         const decalTex = new THREE.CanvasTexture(canvas);
         
         const decalGeo = new THREE.PlaneGeometry(4, 4);
         decalGeo.rotateX(-Math.PI/2);
         const decal = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({ map: decalTex, transparent:true }));
         decal.position.y = parentMesh.userData.serial.h / 2 + 0.01;
         parentMesh.add(decal);
    }

    setupBaseplate() {
        // Floor
        const base = this.createBlock(0, -2, 0, 512, 4, 512, 0x242424, ['static']);
        // Ensure the main baseplate shows up as "Baseplate" in explorer/studio
        base.name = 'Baseplate';
        
        // Spawn Location
        this.createBlock(0, 0.5, 0, 6, 1, 6, 0x888888, ['static', 'spawn']);
    }

    getSpawnPoint() {
        const spawns = this.items.filter(i => 
            i.userData.serial && i.userData.serial.flags && i.userData.serial.flags.includes('spawn')
        );
        if (spawns.length > 0) {
            // Pick random if multiple
            const s = spawns[Math.floor(Math.random() * spawns.length)];
            // Spawn above the pad
            const h = s.userData.serial.h || 1;
            // World position
            return s.position.clone().add(new THREE.Vector3(0, h/2 + 5, 0));
        }
        return new THREE.Vector3(0, 10, 0);
    }

    setupPlatform() {
        // Platform Config
        const centerSize = 256; // Studs
        const height = 2;      // Studs

        // Materials
        const centerMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.studs,
            color: new THREE.Color(0xffffff), 
            roughness: 0.6, metalness: 0.1
        });
        const inletMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.inlet,
            color: new THREE.Color(0xffffff), 
            roughness: 0.6, metalness: 0.1
        });
        const centerMats = [centerMat, centerMat, centerMat, inletMat, centerMat, centerMat];

        const rimColor = new THREE.Color(0x888888);

        const rimMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.studs,
            color: rimColor, roughness: 0.8
        });
        const rimInletMat = new THREE.MeshStandardMaterial({
            map: surfaceManager.textures.inlet,
            color: rimColor, roughness: 0.8
        });
        const rimMats = [rimMat, rimMat, rimMat, rimInletMat, rimMat, rimMat];

        // 1. Center Mesh
        const centerGeo = new THREE.BoxGeometry(centerSize, height, centerSize);
        boxUnwrapUVs(centerGeo);
        const centerMesh = new THREE.Mesh(centerGeo, centerMats);
        centerMesh.position.set(0, height/2, 0);
        this.addToWorld(centerMesh);

        // 2. Rim Meshes Helper
        const addRim = (w, h, d, x, y, z) => {
            const geo = new THREE.BoxGeometry(w, h, d);
            boxUnwrapUVs(geo);
            const mesh = new THREE.Mesh(geo, rimMats);
            mesh.position.set(x, y, z);
            this.addToWorld(mesh);
        };

        // Rims
        const rl = centerSize + 2;
        addRim(rl, height, 1, 0, height/2, -(centerSize+1)/2);
        addRim(rl, height, 1, 0, height/2, (centerSize+1)/2);
        addRim(1, height, centerSize, -(centerSize+1)/2, height/2, 0);
        addRim(1, height, centerSize, (centerSize+1)/2, height/2, 0);

        // Kill Part
        const kSize = 4;
        this.createBlock(10, 2 + kSize/2, 10, kSize, kSize, kSize, 0xff0000, ['static', 'kill']);

        // --- NEW CONTENT ---

        // House
        const hx = -60;
        const hz = 60;
        // Floor
        this.createBlock(hx, 1, hz, 30, 1, 30, 0x664422);
        // Walls
        this.createBlock(hx - 14, 8, hz, 2, 14, 30, 0xffffcc); // Left
        this.createBlock(hx + 14, 8, hz, 2, 14, 30, 0xffffcc); // Right
        this.createBlock(hx, 8, hz - 14, 26, 14, 2, 0xffffcc); // Back
        // Front (Doorway)
        this.createBlock(hx - 8, 8, hz + 14, 10, 14, 2, 0xffffcc);
        this.createBlock(hx + 8, 8, hz + 14, 10, 14, 2, 0xffffcc);
        this.createBlock(hx, 12, hz + 14, 6, 6, 2, 0xffffcc); // Door header
        // Roof
        const roof = this.createBlock(hx, 16, hz, 34, 2, 34, 0xcc0000);
        roof.rotation.x = 0.1;
        
        // Trampoline
        const tx = 40; const tz = 40;
        this.createBlock(tx, 0.5, tz, 12, 1, 12, 0x111111);
        this.createBlock(tx, 1.5, tz, 10, 1, 10, 0x0000ff, ['static', 'launch']);


        // Teleporter to Mega Platform
        const tp = this.createBlock(-15, 2.1, 0, 6, 0.2, 6, 0x00ff00, ['static', 'teleport']);
        tp.userData = { destination: new THREE.Vector3(1000, 5, 0), name: "Mega Platform" };

        // MEGA PLATFORM (Offset 1000)
        const ox = 1000;
        const oz = 0;

        // Main Floor (200x200)
        this.createBlock(ox, 0, oz, 200, 2, 200, 0x555555);

        // 1. CARS
        const car1 = new Vehicle(this.scene, ox + 20, 5, oz - 20, 0xff0000);
        this.vehicles.push(car1);
        
        const car2 = new Vehicle(this.scene, ox + 30, 5, oz - 20, 0x0055ff);
        this.vehicles.push(car2);

        // 2. CRUSHER
        // Base
        this.createBlock(ox - 40, 1, oz + 40, 20, 2, 20, 0x333333);
        // Crusher Head
        const crusher = this.createBlock(ox - 40, 15, oz + 40, 18, 10, 18, 0x222222, ['static', 'kill']);
        this.animated.push({
            mesh: crusher,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt * 1.5;
                // Move between y=3 and y=25
                obj.mesh.position.y = 14 + Math.sin(obj.time) * 11;
            }
        });

        // 4. RAMP (Using steps for collision stability, as simple box collision is AABB)
        const rx = ox + 50;
        const rz = oz + 50;
        for(let i=0; i<20; i++) {
            // Ramp going up
            this.createBlock(rx, i, rz + i*2, 20, 1, 2, 0x888888);
        }
        // Jump pad at end of ramp
        this.createBlock(rx, 20, rz + 42, 20, 1, 6, 0xff00ff, ['static', 'launch']);

        // 5. SWINGSET
        const sx = ox + 20;
        const sz = oz + 60;
        // Frame
        this.createBlock(sx - 10, 15, sz, 1, 30, 1, 0x4e342e);
        this.createBlock(sx + 10, 15, sz, 1, 30, 1, 0x4e342e);
        this.createBlock(sx, 30, sz, 22, 1, 1, 0x4e342e);
        // Swing Seat
        const seat = this.createBlock(sx, 10, sz, 6, 0.5, 4, 0xff0000);
        this.animated.push({
            mesh: seat,
            time: 0,
            update: (dt, obj) => {
                obj.time += dt * 2.5;
                const angle = Math.sin(obj.time) * 0.8;
                // Pivot is at (sx, 30, sz)
                const len = 20;
                obj.mesh.position.x = sx + Math.sin(angle) * len;
                obj.mesh.position.y = 30 - Math.cos(angle) * len;
                obj.mesh.rotation.z = -angle;
            }
        });

        // 6. FLOAT ERROR TELEPORTER
        // Far out on the platform
        const fpTp = this.createBlock(ox + 90, 1.1, oz + 90, 8, 0.2, 8, 0xff00ff, ['static', 'teleport']);
        fpTp.userData = { destination: new THREE.Vector3(ox, 1000000, oz), name: "Far Lands" };
        
        // Floating Point Platform
        const fpx = ox;
        const fpy = 1000000;
        // Need to add this to world, but createBlock adds to group. 
        // Note: Rendering at 1,000,000 might cause jitter (z-fighting/precision), which is the intended effect!
        const fpGeo = new THREE.BoxGeometry(50, 2, 50);
        boxUnwrapUVs(fpGeo);
        const fpMesh = new THREE.Mesh(fpGeo, new THREE.MeshStandardMaterial({color: 0xaaaaaa, map: surfaceManager.textures.studs}));
        fpMesh.position.set(fpx, fpy - 5, oz);
        this.addToWorld(fpMesh);
    }

    setupObby() {
        // Start
        this.createBlock(0, 0, 0, 14, 1, 14, 0x00cc00);

        // Step 1
        this.createBlock(0, 0, -15, 8, 1, 8, 0xaaaaaa);

        // Step 2
        this.createBlock(0, 2, -25, 6, 1, 6, 0xaaaaaa);

        // Step 3 (Gap)
        this.createBlock(0, 4, -36, 4, 1, 4, 0xaaaaaa);

        // Step 4 (Wall Jump / High)
        this.createBlock(0, 6, -45, 4, 1, 4, 0xaaaaaa);

        // Truss/Beam
        this.createBlock(0, 6, -55, 2, 1, 10, 0x666666);
        
        // Kill obstacle on beam
        this.createBlock(0, 6.75, -55, 2, 0.5, 2, 0xff0000, ['static', 'kill']);

        // End
        this.createBlock(0, 8, -70, 15, 1, 15, 0xffff00);
        // Winner pillar
        this.createBlock(0, 12, -70, 2, 8, 2, 0xffaa00);
        // Finish pad: landing on this triggers level completion
        this.createBlock(0, 14, -70, 6, 1, 6, 0x00ff66, ['static', 'finish']);
    }

    // Simple Geometry Dash-style level: players continuously move forward and must hop gaps and avoid spikes.
    setupGeometryDash() {
        // Set a simple background music for this map if desired
        this.bgm = './minecraftmusic.mp3'; // reuse bundled music or replace with a Geometry Dash-like track

        // Build a long horizontal course with repeating obstacles
        const laneY = 1; // ground Y
        const startX = -10;
        const segmentLength = 12;
        const totalSegments = 40;
        const groundHeight = 1;

        // Start platform
        this.createBlock(startX, laneY, 0, 20, groundHeight, 12, 0x222233, ['static', 'spawn']);

        // Progressive speed/spacing obstacles
        for (let i = 0; i < totalSegments; i++) {
            const x = startX + 20 + i * segmentLength;
            // Alternating gaps and spikes
            if (i % 5 === 2) {
                // Big gap: leave empty space and place small landing pads
                // left landing pad
                this.createBlock(x - 5, laneY, 0, 6, groundHeight, 12, 0x8888ff, ['static']);
                // right landing pad
                this.createBlock(x + 5, laneY, 0, 6, groundHeight, 12, 0x8888ff, ['static']);
            } else {
                // Continuous ground
                this.createBlock(x, laneY, 0, segmentLength, groundHeight, 12, 0x333333, ['static']);
            }

            // Add spike obstacles occasionally on ground center
            if (i % 3 === 0) {
                // Spike is a small tall thin block colored red and flagged as kill
                this.createBlock(x, laneY + 1.5, 0, 1, 3, 4, 0xff2222, ['static', 'kill']);
            }

            // Add moving small hurdles (animated)
            if (i % 7 === 5) {
                const hurdle = this.createBlock(x, laneY + 1.0, 0, 2, 2, 6, 0xff8800, ['static']);
                // animate up/down to simulate timing hazard
                this.animated.push({
                    mesh: hurdle,
                    time: Math.random() * 10,
                    update: (dt, obj) => {
                        obj.time += dt * 2.0;
                        obj.mesh.position.y = laneY + 1.0 + Math.sin(obj.time) * 1.2;
                    }
                });
            }

            // Occasional bounce pads to keep gameplay fun
            if (i % 11 === 0) {
                const pad = this.createBlock(x + 6, laneY + 0.1, 0, 6, 0.2, 12, 0x00ffcc, ['static', 'launch']);
            }
        }

        // Finish platform
        const finishX = startX + 20 + totalSegments * segmentLength + 20;
        this.createBlock(finishX, laneY, 0, 20, groundHeight, 12, 0x00ff66, ['static', 'finish']);

        // Add a simple elevated visual background platform for parallax
        for (let i = 0; i < 8; i++) {
            const bx = startX + i * 60;
            this.createBlock(bx, laneY + 20 + (i % 2) * 8, -40, 40, 1, 200, 0x112244, ['static']);
        }
    }

    // NEW: Amazing Digital Circus map
    setupCircus() {
        // Main circus floor (circular ring)
        const ringRadius = 60;
        const ringThickness = 12;
        // Create a large flat ring by adding several blocks approximating a ring
        for (let a = 0; a < 360; a += 15) {
            const rad = THREE.MathUtils.degToRad(a);
            const x = Math.cos(rad) * (ringRadius);
            const z = Math.sin(rad) * (ringRadius);
            // Use long thin blocks arranged around circle
            const w = 6;
            const h = 1.5;
            const d = 16;
            const bx = x;
            const bz = z;
            const block = this.createBlock(bx, 0.5, bz, w, h, d, 0xffcc77, ['static']);
            block.rotation.y = -rad;
        }

        // Center stage
        this.createBlock(0, 1.5, 0, 18, 1.5, 18, 0xff4444, ['static', 'spawn']);
        // Big Tent Poles (decor)
        this.createBlock(-24, 8, -24, 2, 16, 2, 0x882222, ['static']);
        this.createBlock(24, 8, -24, 2, 16, 2, 0x882222, ['static']);
        this.createBlock(-24, 8, 24, 2, 16, 2, 0x882222, ['static']);
        this.createBlock(24, 8, 24, 2, 16, 2, 0x882222, ['static']);

        // Colorful banners around ring
        for (let i = 0; i < 12; i++) {
            const ang = (i / 12) * Math.PI * 2;
            const x = Math.cos(ang) * (ringRadius - 6);
            const z = Math.sin(ang) * (ringRadius - 6);
            const banner = this.createBlock(x, 6, z, 2, 6, 0.5, 0x66ccff, ['static']);
            banner.rotation.y = ang + Math.PI / 8;
        }

        // Trampoline acts (bouncy pads)
        this.createBlock(-12, 1.0, 12, 8, 1, 8, 0x00ccff, ['static', 'launch']);
        this.createBlock(12, 1.0, -12, 8, 1, 8, 0x00ccff, ['static', 'launch']);

        // Tightrope challenge: sequence of narrow planks above ground
        for (let i = 0; i < 12; i++) {
            const px = -40 + i * 6;
            const pz = 0;
            const plank = this.createBlock(px, 6 + (i % 2) * 0.5, pz, 5, 0.5, 1.2, 0x443322, ['static']);
            // Slight rotation for wobble aesthetic
            plank.rotation.z = Math.sin(i * 0.5) * 0.06;
        }

        // Clown bumper area: soft moving bumpers (represented as static colored parts here)
        const bumperAreaX = 40;
        const bumperAreaZ = 20;
        for (let i = 0; i < 6; i++) {
            const bx = bumperAreaX + (i % 3) * 6;
            const bz = bumperAreaZ + Math.floor(i / 3) * 6;
            this.createBlock(bx, 1.2, bz, 4, 2.4, 4, 0xff66ff, ['static']);
        }

        // Carousel: circular platform with decorative center pole
        const cx = -40;
        const cz = -40;
        this.createBlock(cx, 1.0, cz, 14, 1.0, 14, 0x3333aa, ['static']);
        this.createBlock(cx, 4.5, cz, 1, 8, 1, 0xffff00, ['static']);

        // Funhouse mirrors (teleporters) that send you to random area of circus
        for (let i = 0; i < 3; i++) {
            const tx = Math.cos(i * 2.0) * 28;
            const tz = Math.sin(i * 2.0) * 28;
            const tp = this.createBlock(tx, 0.6, tz, 4, 0.2, 4, 0x00ff88, ['static', 'teleport']);
            // teleport destinations scatter inside ring
            const destX = (Math.random() - 0.5) * (ringRadius - 20);
            const destZ = (Math.random() - 0.5) * (ringRadius - 20);
            tp.userData = { destination: new THREE.Vector3(destX, 5, destZ), name: "Funhouse Warp" };
        }

        // Spotlights: decorative light posts (non-collidable)
        for (let i = 0; i < 6; i++) {
            const ang = i / 6 * Math.PI * 2;
            const lx = Math.cos(ang) * (ringRadius - 10);
            const lz = Math.sin(ang) * (ringRadius - 10);
            const pole = this.createBlock(lx, 8, lz, 1, 16, 1, 0x222222, ['static']);
            // Add a small glowing platform on top (visual only)
            const glow = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), new THREE.MeshBasicMaterial({ color: 0xffffaa, emissive: 0xffffaa }));
            glow.position.set(lx, 16.2, lz);
            this.mapGroup.add(glow);
        }

        // Prize podium (finish area) - winning platform near center
        this.createBlock(8, 2, 8, 6, 2, 6, 0xffee66, ['static', 'finish']);
    }

    // Simple Minecraft-like map: lime green baseplate and blocky trees
    setupMinecraft() {
        // Lime green baseplate (large, thin)
        const baseSize = 400;
        const baseHeight = 2;
        // Use a bright lime green color typical of Minecraft grass
        const limeGreen = 0x7CFC00; // LawnGreen
        const base = this.createBlock(0, -1, 0, baseSize, baseHeight, baseSize, limeGreen, ['static']);
        base.name = 'Minecraft Baseplate';

        // Create a grid of simple blocky trees
        // Tree parameters (blocky, stacked cubes)
        const treeSpacing = 16;
        const start = -120;
        const end = 120;
        for (let x = start; x <= end; x += treeSpacing) {
            for (let z = start; z <= end; z += treeSpacing) {
                // Random chance to spawn tree to make it sparse
                if (Math.random() < 0.25) {
                    // Trunk (stack of 2 brown blocks)
                    const trunkColor = 0x8B5A2B;
                    this.createBlock(x, 0.5, z, 2, 2, 2, trunkColor, ['static']);
                    this.createBlock(x, 2.5, z, 2, 2, 2, trunkColor, ['static']);
                    // Leaves: 3x3 cube of green blocks atop trunk
                    const leafColor = 0x228B22;
                    for (let lx = -1; lx <= 1; lx++) {
                        for (let lz = -1; lz <= 1; lz++) {
                            for (let ly = 0; ly <= 2; ly++) {
                                // center leaves sit on top of trunk at y=4.5
                                const px = x + lx * 2;
                                const pz = z + lz * 2;
                                const py = 4.5 + ly * 2;
                                // Slight randomness to avoid perfect cubes everywhere
                                const jitter = (Math.random() - 0.5) * 0.2;
                                const leaf = this.createBlock(px + jitter, py + jitter, pz + jitter, 2, 2, 2, leafColor, ['static']);
                                // Occasionally hollow center
                                if (Math.random() < 0.06) {
                                    leaf.userData.decor = 'hollow';
                                }
                            }
                        }
                    }
                }
            }
        }

        // Spawn pad in center
        this.createBlock(0, 1.5, 0, 6, 1, 6, 0x00ff00, ['static', 'spawn']);
    }

    setupSpace() {
        // Baseplate
        this.createBlock(0, 0, 0, 80, 2, 80, 0x333333);

        // Launcher
        this.createBlock(0, 1.25, 0, 8, 0.5, 8, 0xff00ff, ['static', 'launch']);

        // High Platform
        this.createBlock(0, 400, 0, 40, 1, 40, 0xffffff);
        this.createBlock(0, 405, 0, 4, 8, 4, 0xffff00);
    }

    update(dt) {
        this.animated.forEach(anim => anim.update(dt, anim));
        this.vehicles.forEach(v => v.update(dt, this.collidables));
    }
}