/*
  REFACTOR NOTICE:
  Player.js contains character creation, input-linked movement, audio effects, hat modeling,
  and clothing/texture application. To improve maintainability these concerns will be split into:
    - src/player/model.js (mesh + head/GLB attachment)
    - src/player/appearance.js (textures, shirts, faces)
    - src/player/physics.js (movement, collisions, stumble/fall)
    - src/player/audio.js (footsteps, jump, death sounds)
  Tombstone tags below indicate logic planned for relocation.

  Tombstone examples:
    // removed: function legacyStumbleHandler() {}
    // removed: const oldAudioGraph = {}
*/
import * as THREE from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createTorsoTexture, createFaceTexture, boxUnwrapUVs, surfaceManager } from './utils.js';

// Move default face resources and helper to module scope so methods can share them
const defaultFaceUrl = './Untitled65_20260311205720.png';
const _defaultFaceImage = new Image();
_defaultFaceImage.crossOrigin = 'anonymous';
_defaultFaceImage.src = defaultFaceUrl;

// Shared GLB head template & instances list, so we can retrofit existing players/rigs
let _glbHeadTemplate = null;
let _glbHeadLoaded = false;
let _glbHeadLoading = false;
const _glbHeadInstances = [];

/**
 * Attach a cloned GLB head to a player/rig group, hiding the original box head.
 * group: THREE.Group returned by createPlayerMesh
 * head:  the original box head mesh created inside that group
 */
function attachGlbHeadToGroup(group, head) {
    if (!_glbHeadTemplate || !group || !head) return;

    const clone = _glbHeadTemplate.clone(true);
    // Place it where the original head is, keep the same origin
    clone.position.copy(head.position);
    clone.rotation.copy(head.rotation);
    clone.scale.set(1, 1, 1);

    // Make the GLB head use the same face material as the box head's front,
    // so default and custom faces show up on the new mesh as well.
    const headMaterials = head.material;
    let faceMat = null;
    if (Array.isArray(headMaterials) && headMaterials[4]) {
        faceMat = headMaterials[4];
    } else if (headMaterials) {
        faceMat = headMaterials;
    }

    if (faceMat) {
        clone.traverse((child) => {
            if (child.isMesh) {
                child.material = faceMat;
            }
        });
    }

    // Hide the old cube head so only the GLB is visible
    head.visible = false;

    group.add(clone);
}

// Kick off loading the custom head model once and apply it to all current/future characters
function ensureGlbHeadLoaded() {
    if (_glbHeadLoaded || _glbHeadLoading) return;
    _glbHeadLoading = true;

    const loader = new GLTFLoader();
    loader.load(
        './head.glb',
        (gltf) => {
            _glbHeadTemplate = gltf.scene;
            _glbHeadLoaded = true;
            _glbHeadLoading = false;
            // Retrofit any groups that were created before the load completed
            _glbHeadInstances.forEach(({ group, head }) => attachGlbHeadToGroup(group, head));
        },
        undefined,
        (err) => {
            console.warn('Failed to load head.glb:', err);
            _glbHeadLoading = false;
        }
    );
}

// Start loading immediately at module init
ensureGlbHeadLoaded();

/**
 * Composite an image (Image or Canvas) onto a solid background color and return a THREE.CanvasTexture.
 * imageOrCanvas: HTMLImageElement | HTMLCanvasElement
 * colorHex: string color like '#ffffff'
 */
function createTintedFaceTexture(imageOrCanvas, colorHex) {
    const w = imageOrCanvas.width || (imageOrCanvas.videoWidth || 256);
    const h = imageOrCanvas.height || (imageOrCanvas.videoHeight || 256);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Fill background with tint color
    ctx.fillStyle = colorHex || '#ffffff';
    ctx.fillRect(0, 0, w, h);
    // Draw face image preserving alpha
    ctx.drawImage(imageOrCanvas, 0, 0, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.format = THREE.RGBAFormat;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

export function createPlayerMesh(materialsStore) {
    const group = new THREE.Group();

    // Helper to create independent material set for a part
    const createPartMats = (partName, colorHex, frontMat = null) => {
        const col = new THREE.Color(colorHex);
        
        const sideMat = new THREE.MeshStandardMaterial({ color: col });
        const studMat = new THREE.MeshStandardMaterial({ map: surfaceManager.textures.studs, color: col });
        const inletMat = new THREE.MeshStandardMaterial({ map: surfaceManager.textures.inlet, color: col });
        
        // [Right, Left, Top, Bottom, Front, Back]
        // Ensure Front is unique if not provided
        const front = frontMat ? frontMat : sideMat.clone();
        const mats = [sideMat, sideMat, studMat, inletMat, front, sideMat];
        
        if (materialsStore) materialsStore[partName] = mats;
        return mats;
    };

    // Torso
    // Default color blue-ish grey
    const torsoFrontMat = new THREE.MeshStandardMaterial({ map: createTorsoTexture(), color: 0xffffff });
    const torsoGeo = new THREE.BoxGeometry(2, 2, 1);
    boxUnwrapUVs(torsoGeo);
    const torso = new THREE.Mesh(torsoGeo, createPartMats('torso', 0x000000, torsoFrontMat));
    torso.position.set(0, 3, 0);
    group.add(torso);

    // Head
    const headGeo = new THREE.BoxGeometry(1, 1, 1);
    boxUnwrapUVs(headGeo);
    
    // Fix UVs for Head Front (Face 4) to map texture 0..1
    const uvs = headGeo.attributes.uv;
    // BoxGeometry face order: px(0), nx(1), py(2), ny(3), pz(4 front), nz(5 back)
    // Each face uses 4 UV entries: faceIndex * 4 .. faceIndex * 4 + 3
    // Ensure the front face (pz, index 4) maps the full 0..1 UV so the face texture appears on the front.
    const setFaceUV = (faceIndex, a, b, c, d) => {
        const start = faceIndex * 4;
        uvs.setXY(start + 0, a[0], a[1]);
        uvs.setXY(start + 1, b[0], b[1]);
        uvs.setXY(start + 2, c[0], c[1]);
        uvs.setXY(start + 3, d[0], d[1]);
    };

    // Front (+Z) -> full texture area
    setFaceUV(4, [0, 1], [1, 1], [0, 0], [1, 0]);

    // Back (-Z) -> set to a neutral mapping (mirror) to avoid the face showing on the back.
    // This ensures any face texture is only visible on the front.
    setFaceUV(5, [1, 1], [0, 1], [1, 0], [0, 0]);
    uvs.needsUpdate = true;

    // Front material should render transparency so faces with alpha keep shape.
    const headFrontMat = new THREE.MeshStandardMaterial({ 
        // Provide an immediate fallback face texture so the head shows a face right away,
        // and allow the composite/default face to replace it when ready.
        map: createFaceTexture(),
        color: 0xffffff,
        transparent: true,
        alphaTest: 0.01
    });
    
    // When the default face image finishes loading, composite it onto the head color and apply it
    const applyDefaultFace = () => {
        try {
            const headCol = '#ffffff'; // initial head color; player will recolor later if needed
            const tex = createTintedFaceTexture(_defaultFaceImage, headCol);
            // Save state: clear stored data url so presence summary stays small
            headFrontMat.map = tex;
            headFrontMat.needsUpdate = true;
        } catch (err) {
            console.warn('Failed to apply default face texture:', err);
        }
    };

    // If the image already loaded earlier, apply immediately; otherwise hook onload.
    if (_defaultFaceImage.complete) {
        applyDefaultFace();
    } else {
        _defaultFaceImage.onload = applyDefaultFace;
        _defaultFaceImage.onerror = () => console.warn('Failed to load default face image:', defaultFaceUrl);
    }

    const head = new THREE.Mesh(headGeo, createPartMats('head', 0xffffff, headFrontMat));
    head.position.set(0, 4.5, 0); 
    // Rotate the cube head 180 degrees so the front (+Z) face aligns with the model's forward direction
    head.rotation.y = Math.PI;
    group.add(head);

    // Register this group/head so the GLB can replace the cube head when ready
    _glbHeadInstances.push({ group, head });
    if (_glbHeadLoaded) {
        attachGlbHeadToGroup(group, head);
    } else {
        // Ensure load has been kicked off
        ensureGlbHeadLoaded();
    }

    // Helper for limbs
    const createLimb = (x, name, color) => {
        const g = new THREE.Group();
        g.position.set(x, 4, 0); 
        const geo = new THREE.BoxGeometry(1, 2, 1);
        boxUnwrapUVs(geo);
        const m = new THREE.Mesh(geo, createPartMats(name, color));
        m.position.y = -1; 
        g.add(m);
        return g;
    };

    const leftArm = createLimb(-1.5, 'leftArm', 0xffffff);
    group.add(leftArm);

    const rightArm = createLimb(1.5, 'rightArm', 0xffffff);
    group.add(rightArm);

    // Legs helper
    const createLeg = (x, name, color) => {
        const g = new THREE.Group();
        g.position.set(x, 2, 0); 
        const geo = new THREE.BoxGeometry(1, 2, 1);
        boxUnwrapUVs(geo);
        const m = new THREE.Mesh(geo, createPartMats(name, color));
        m.position.y = -1;
        g.add(m);
        return g;
    };

    const leftLeg = createLeg(-0.5, 'leftLeg', 0xffffff);
    group.add(leftLeg);

    const rightLeg = createLeg(0.5, 'rightLeg', 0xffffff);
    group.add(rightLeg);

    return group;
}

export class Player {
    constructor(scene) {
        this.scene = scene;
        this.position = new THREE.Vector3(0, 5, 0);
        this.velocity = new THREE.Vector3();
        this.onGround = false;

        // Configuration
        this.speed = 10;
        this.jumpForce = 35;
        this.gravity = -100;

        // Coyote Time
        this.coyoteTimer = 0;
        this.coyoteMaxTime = 0.15; // 0.15s forgiveness window

        // Stumble / Trip state (landing from high fall)
        this.stumbleTimer = 0;
        this.stumbleDuration = 1.2; // seconds of being stunned
        this.stumbleThreshold = -100; // downward speed (vy) threshold to trigger stumble (now requires ~100)
        this._lastPreLandVy = 0;

        // Ground detection
        this.raycaster = new THREE.Raycaster();
        this.downVector = new THREE.Vector3(0, -1, 0);
        this.tempRayOrigin = new THREE.Vector3();

        // Animation State
        this.animTime = 0;
        this.animState = 'idle';

        // Death / Debris State
        this.isDead = false;
        this.debris = [];
        this.respawnTimer = 0;

        // Health: weapons (rocket splash damage, sword hits) reduce this; hitting 0 triggers
        // the same ragdoll/respawn flow as a kill brick (see takeDamage()/fallApart()).
        this.maxHealth = 100;
        this.health = this.maxHealth;

        // Debug/Dev
        this.forcedAnim = null;

        // Customization
        this.materials = {}; // Stores arrays of materials for each part
        
        // Appearance State for Persistence
        this.appearance = {
            colors: {
                head: '#ffffff',    // head default changed to white
                torso: '#000000',   // default changed to black
                leftArm: '#ffffff',
                rightArm: '#ffffff',
                leftLeg: '#00ff00',  // Noob green
                rightLeg: '#00ff00'
            },
            faceUrl: null,
            shirtUrl: null
        };

        // Audio
        this.setupAudio();

        this.mesh = createPlayerMesh(this.materials);
        this.scene.add(this.mesh);
        
        // Re-assign parts
        this.torso = this.mesh.children[0];
        this.head = this.mesh.children[1];
        this.leftArm = this.mesh.children[2];
        this.rightArm = this.mesh.children[3];
        this.leftLeg = this.mesh.children[4];
        this.rightLeg = this.mesh.children[5];

        this.currentBubble = null;
        this.bubbleTimer = null;
        
        // Vehicle State
        this.vehicle = null;
        
        // Glitch State
        this.activeGlitches = [];
        
        // Re-usable Box3 for collision checks to reduce garbage
        this.playerBox = new THREE.Box3();
        this.tempBox = new THREE.Box3();
        
        // Re-usable OBBs
        this.playerOBB = new OBB();
        this.tempOBB = new OBB();

        // Stuck detection
        this.stuckTimer = 0;

        // Dance State
        this.danceGif = null;

        // Walk phase seed for jittery walk
        this._walkSeed = Math.random() * 10;
        this._walkJitterAcc = 0;
    }

    setupAudio() {
        // WebAudio API directly as per guidelines.
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Bitcrush Effect
        const bufferSize = 4096;
        this.crusher = this.audioCtx.createScriptProcessor(bufferSize, 2, 2);
        this.crusher.bits = 6; 
        this.crusher.normfreq = 0.2; 

        let phaser = 0;
        let lastL = 0;
        let lastR = 0;

        this.crusher.onaudioprocess = (e) => {
            const inputL = e.inputBuffer.getChannelData(0);
            const inputR = e.inputBuffer.getChannelData(1);
            const outputL = e.outputBuffer.getChannelData(0);
            const outputR = e.outputBuffer.getChannelData(1);
            
            const step = Math.pow(0.5, this.crusher.bits);
            
            for (let i = 0; i < inputL.length; i++) {
                phaser += this.crusher.normfreq;
                if (phaser >= 1.0) {
                    phaser -= 1.0;
                    lastL = step * Math.floor(inputL[i] / step + 0.5);
                    lastR = step * Math.floor(inputR[i] / step + 0.5);
                }
                outputL[i] = lastL;
                outputR[i] = lastR;
            }
        };

        this.mixNode = this.audioCtx.createGain();
        this.mixNode.connect(this.crusher);
        this.crusher.connect(this.audioCtx.destination);

        this.loadSound('./walk.mp3').then(buf => this.walkBuffer = buf);
        this.loadSound('./roblox-classic-jump.mp3').then(buf => this.jumpBuffer = buf);
        this.loadSound('./roblox-death-sound_1.mp3').then(buf => this.breakBuffer = buf);
        // Tada sound for finishing levels
        this.loadSound('./tada.wav').then(buf => this.tadaBuffer = buf);

        this.walkSource = null;
    }

    async loadSound(url) {
        const res = await fetch(url);
        const arr = await res.arrayBuffer();
        return await this.audioCtx.decodeAudioData(arr);
    }

    playSound(buffer, loop = false, rate = 1.0) {
        if (!buffer) return;
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.loop = loop;
        source.playbackRate.value = rate;
        source.connect(this.mixNode);
        source.start(0);
        return source;
    }

    triggerStumble(severity = 1.0) {
        // Don't stack stumbles
        if (this.stumbleTimer > 0) return;
        this.stumbleTimer = this.stumbleDuration * severity;
        this.animState = 'stumble';
        // small thud sound (use breakBuffer if available, lower volume by playbackRate)
        this.playSound(this.breakBuffer, false, 0.8);
        // stop walk sound if playing
        if (this.walkSource) {
            this.walkSource.stop();
            this.walkSource = null;
        }

        // Add a small randomized fling impulse when stumbling so the player is knocked back slightly.
        // Severity scales the impulse magnitude.
        try {
            const angle = Math.random() * Math.PI * 2;
            const horizontalSpeed = 6 * severity; // horizontal fling magnitude
            const upSpeed = 6 * Math.min(1.5, severity); // upward bounce
            this.velocity.x += Math.cos(angle) * horizontalSpeed;
            this.velocity.z += Math.sin(angle) * horizontalSpeed;
            this.velocity.y = Math.max(this.velocity.y, upSpeed);
        } catch (e) {
            // fallback: ensure at least an upward nudge
            this.velocity.y = Math.max(this.velocity.y, 4);
        }
    }

    setPartColor(part, colorHex) {
        if (!this.materials[part]) return;
        
        // Update state
        this.appearance.colors[part] = colorHex;
        
        const col = new THREE.Color(colorHex);

        this.materials[part].forEach((mat, i) => {
            // Don't recolor textures that shouldn't be tinted (like shirt front) if we can avoid it
            // i=2 (Top/Studs), i=3 (Bottom/Inlet)
            if (mat.map && mat.map.source && mat.map.image) {
                if (i === 2 || i === 3) mat.color = col;
                else if (i !== 4 || part !== 'torso') mat.color = col; // Don't tint torso front
            } else {
                mat.color = col;
            }
        });
    }

    setFaceTexture(image, dataUrl = null) {
        const texApply = (tex) => {
            // Head is index 4 (Front)
            const mats = this.materials.head;
            if (mats && mats[4]) {
                const mat = mats[4];
                mat.map = tex;
                // After compositing we don't need transparent blending on the material itself,
                // but keep transparent true so any leftover alpha still works.
                mat.transparent = true;
                mat.color = new THREE.Color(0xffffff); // Reset tint for face
                mat.needsUpdate = true;
            }
        };

        // Helper to get current head color (fallback white)
        const headCol = (this.appearance && this.appearance.colors && this.appearance.colors.head) ? this.appearance.colors.head : '#ffffff';

        if (!image && !dataUrl) {
            // Use preloaded default face image, composite onto current head color
            if (_defaultFaceImage && _defaultFaceImage.complete) {
                const tex = createTintedFaceTexture(_defaultFaceImage, headCol);
                // Save state: clear stored data url so presence summary stays small
                this.appearance.faceUrl = null;
                texApply(tex);
            } else {
                // If image not yet loaded, wait for it
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    const tex = createTintedFaceTexture(img, headCol);
                    this.appearance.faceUrl = null;
                    texApply(tex);
                };
                img.src = defaultFaceUrl;
            }
            return;
        }

        // If provided an Image element or a canvas element, composite onto head color
        if (image && (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement)) {
            const tex = createTintedFaceTexture(image, headCol);
            // Save state
            if (dataUrl) this.appearance.faceUrl = dataUrl;
            else if (image.src && image.src.startsWith('data:')) this.appearance.faceUrl = image.src;
            texApply(tex);
            return;
        }

        // If given a data URL string in place of image, load it then composite
        if (dataUrl && typeof dataUrl === 'string') {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const tex = createTintedFaceTexture(img, headCol);
                this.appearance.faceUrl = dataUrl;
                texApply(tex);
            };
            img.src = dataUrl;
            return;
        }
    }

    setShirtTexture(image, dataUrl = null) {
        // Support being passed either an HTMLImageElement / Canvas OR a data URL string.
        const applyTexture = (img, srcUrl = null) => {
            try {
                // Create a CanvasTexture so we can control wrapping and filtering
                const tex = new THREE.CanvasTexture(img);
                tex.minFilter = THREE.LinearFilter;
                tex.magFilter = THREE.LinearFilter;
                tex.colorSpace = THREE.SRGBColorSpace;
                // Use clamp-to-edge so the image is not tiled; we'll center it on the torso UVs
                tex.wrapS = THREE.ClampToEdgeWrapping;
                tex.wrapT = THREE.ClampToEdgeWrapping;
                tex.needsUpdate = true;

                // Save state (store only data URL when provided to keep presence lightweight)
                if (srcUrl) this.appearance.shirtUrl = srcUrl;
                else if (img.src && typeof img.src === 'string' && img.src.startsWith('data:')) this.appearance.shirtUrl = img.src;

                // Torso is index 4 (Front)
                const mats = this.materials.torso;
                if (mats && mats[4]) {
                    // Apply the texture but ensure it doesn't stretch: keep repeat (1,1) and center it.
                    mats[4].map = tex;
                    mats[4].map.center.set(0.5, 0.5);
                    mats[4].map.offset.set(0, 0);
                    mats[4].map.repeat.set(1, 1);
                    mats[4].map.needsUpdate = true;

                    // If the image aspect is not square, adjust the material's UV transform to preserve aspect visually:
                    // We'll scale the texture so the longer side fits the UV, and center the shorter side.
                    try {
                        const imgW = img.width || (img.videoWidth || 1);
                        const imgH = img.height || (img.videoHeight || 1);
                        const aspect = imgW / imgH;
                        // Torso UV area is roughly square for the front face; to avoid squishing we fit the image
                        // by adjusting repeat and offset. If image is wider than tall, fit width; else fit height.
                        if (aspect > 1) {
                            // Wider: scale down Y so image isn't squashed; repeat.x = 1, repeat.y = 1/aspect
                            mats[4].map.repeat.set(1, 1 / aspect);
                            mats[4].map.offset.set(0, 0.5 - (0.5 * (1 / aspect)));
                        } else {
                            // Taller or square: scale down X
                            const inv = aspect === 0 ? 1 : aspect;
                            mats[4].map.repeat.set(inv, 1);
                            mats[4].map.offset.set(0.5 - (0.5 * inv), 0);
                        }
                    } catch (ex) {
                        // If anything goes wrong, fall back to default centered texture
                        mats[4].map.repeat.set(1,1);
                        mats[4].map.offset.set(0,0);
                    }

                    mats[4].color = new THREE.Color(0xffffff);
                    mats[4].needsUpdate = true;
                }
            } catch (err) {
                console.warn('Failed to apply shirt texture:', err);
            }
        };

        // If caller passed a data URL string in place of image, load it first
        if (typeof image === 'string' && image.startsWith('data:')) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => applyTexture(img, image);
            img.onerror = () => console.warn('Failed loading shirt data URL');
            img.src = image;
            return;
        }

        // If dataUrl provided but image is absent, try to load dataUrl
        if ((!image || image instanceof String) && dataUrl && typeof dataUrl === 'string') {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => applyTexture(img, dataUrl);
            img.onerror = () => console.warn('Failed loading shirt data URL');
            img.src = dataUrl;
            return;
        }

        // If an HTMLImageElement or Canvas is provided, apply immediately
        if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement) {
            applyTexture(image, dataUrl);
            return;
        }

        // Fallback: if only a dataUrl was provided (and not as 'image' param), try to load it
        if (dataUrl && typeof dataUrl === 'string') {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => applyTexture(img, dataUrl);
            img.onerror = () => console.warn('Failed loading shirt data URL');
            img.src = dataUrl;
            return;
        }
        
        console.warn('setShirtTexture: unsupported input', image, dataUrl);
    }

    // Create or load a hat from appearance data
    createHat(data = null) {
        // Remove existing hat first
        this.removeHat();

        // 1. Determine hat data source
        const hatData = data || this.appearance.hat;
        
        if (!hatData) return;

        const hatGroup = new THREE.Group();
        hatGroup.name = 'hat';

        if (hatData.type === 'image' && hatData.imageUrl) {
            // Devdex catalog item: render the item's image as a floating
            // billboard plane above the head, rather than a 3D primitive.
            const loader = new THREE.TextureLoader();
            const size = hatData.size || 1.1;
            const plane = new THREE.Mesh(
                new THREE.PlaneGeometry(size, size),
                new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, color: 0xffffff, depthWrite: false }),
            );
            // Sit clearly above the head (not overlapping it) so it can't
            // z-fight/clip into the head geometry from any camera angle.
            plane.position.y = 0.95;
            hatGroup.add(plane);
            hatGroup.scale.set(0.6, 0.6, 0.6);
            // Always face the camera (billboard) - see Player.update(). Kept
            // as a flat plane welded to head rotation it would show its edge
            // or back from many angles, which looked like a broken/doubled
            // copy of the item.
            this._hatBillboardPlane = plane;
            loader.load(
                hatData.imageUrl,
                (tex) => {
                    tex.colorSpace = THREE.SRGBColorSpace;
                    plane.material.map = tex;
                    plane.material.needsUpdate = true;
                },
                undefined,
                (err) => console.warn('Failed to load Devdex catalog item image for hat:', err),
            );
        } else if (hatData.constructed && hatData.parts && hatData.parts.length > 0) {
            // Load custom composed hat
            hatData.parts.forEach((p) => {
                let geo;
                const size = p.scale || [1, 1, 1];
                const color = p.color || '#333333';

                if (p.type === 'box') {
                    geo = new THREE.BoxGeometry(1, 0.5, 1);
                } else if (p.type === 'cylinder') {
                    geo = new THREE.CylinderGeometry(0.5, 0.5, 0.6, 16);
                } else {
                    geo = new THREE.BoxGeometry(1, 0.5, 1);
                }
                
                // Material needs to be cloned if it came from the editor material store, 
                // but here we just create a new one based on color string
                const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
                
                const mesh = new THREE.Mesh(geo, mat);
                if (p.pos) mesh.position.fromArray(p.pos);
                // Rotation arrays are [x, y, z] in radians when coming from Player.js rotation property
                if (p.rot) mesh.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
                if (p.scale) mesh.scale.set(size[0], size[1], size[2]);
                
                hatGroup.add(mesh);
            });
            // Apply a base scale common to all hats (0.6 for player head size)
            hatGroup.scale.set(0.6, 0.6, 0.6);

        } else {
            // Create simple default hat (backwards compatibility/simple mode)
            const colorHex = hatData.color || '#333333';
            const size = hatData.size || 1.5;

            // Simple brim
            const brimGeo = new THREE.CylinderGeometry(size * 1.4, size * 1.4, 0.15, 24);
            const brimMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colorHex) });
            const brim = new THREE.Mesh(brimGeo, brimMat);
            brim.rotation.x = Math.PI / 2;
            brim.position.y = 0.05;
            hatGroup.add(brim);

            // Top (cap)
            const capGeo = new THREE.CylinderGeometry(size * 0.8, size * 0.8, size * 0.9, 24);
            const capMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colorHex) });
            const cap = new THREE.Mesh(capGeo, capMat);
            cap.position.y = 0.6;
            hatGroup.add(cap);

            // Scale down proportional to size parameter
            hatGroup.scale.set(0.6 * (size / 1.5), 0.6 * (size / 1.5), 0.6 * (size / 1.5));
        }

        // 2. Determine attachment point
        // 2. Decide what to attach the hat to. Normally this is the head
        // cube itself. The only exception is when a custom GLB head model
        // has replaced the default box head (in which case this.head is
        // hidden and we look for that replacement by name). Previously this
        // matched the FIRST non-head child of the whole body mesh - which is
        // the torso (added before the head in createPlayerMesh) - so hats
        // ended up welded to the torso instead of the head: they'd sit near
        // chest height, clipped into/behind the body, which is what made
        // equipped items look broken/"merged into" the character.
        let attachTarget = this.head;
        if (this.mesh && this.mesh.children && this.mesh.children.length > 0 && this.head && !this.head.visible) {
            for (const c of this.mesh.children) {
                if (c === this.head) continue;
                if (c.isObject3D && c.name && c.name.toLowerCase().includes('head')) {
                    attachTarget = c;
                    break;
                }
            }
        }

        // 3. Apply stored transforms (offset/rotation)
        const offset = hatData.offset || { x: 0, y: 0.6, z: 0 };
        const rot = hatData.rot || { x: 0, y: 0, z: 0 };

        // If simple hat with no custom offset/rot, use default placement:
        if (!hatData.constructed && (!hatData.offset || !hatData.rot)) {
            if (attachTarget === this.head) {
                 // Use hardcoded offset used previously for cube head alignment
                hatGroup.position.set(0, 5.3 - this.head.position.y, 0); 
            } else {
                // Default offset for GLB head
                hatGroup.position.set(0, 0.6, 0); 
            }
            // For simple hats created outside the editor, ensure we save the determined position back
            offset.x = hatGroup.position.x;
            offset.y = hatGroup.position.y;
            offset.z = hatGroup.position.z;

        } else {
            // Use custom/saved offsets/rotations
            hatGroup.position.set(offset.x, offset.y, offset.z);
            hatGroup.rotation.set(
                THREE.MathUtils.degToRad(rot.x),
                THREE.MathUtils.degToRad(rot.y),
                THREE.MathUtils.degToRad(rot.z)
            );
        }
        
        attachTarget.add(hatGroup);

        // Update appearance state only if we explicitly passed data
        if (data) this.appearance.hat = data;
        this._hat = hatGroup;
    }

    removeHat() {
        if (this._hat && this._hat.parent) {
            this._hat.parent.remove(this._hat);
            // Dispose geometry/materials
            this._hat.traverse(c => {
                if (c.geometry) c.geometry.dispose();
                if (c.material) {
                    if (Array.isArray(c.material)) c.material.forEach(m => m.dispose && m.dispose());
                    else c.material.dispose && c.material.dispose();
                }
            });
            this._hat = null;
        }
        this._hatBillboardPlane = null;
        this.appearance.hat = null;
    }

    chat(message) {
        if (!message) return;
        
        // Remove existing bubble
        if (this.currentBubble) {
            this.head.remove(this.currentBubble);
            if (this.currentBubble.material.map) this.currentBubble.material.map.dispose();
            this.currentBubble.material.dispose();
            this.currentBubble = null;
        }

        // Create Canvas for texture
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 24;
        ctx.font = `bold ${fontSize}px "Comic Sans Custom", "Comic Sans MS", "Comic Sans", cursive`;
        
        const textMetrics = ctx.measureText(message);
        const textWidth = textMetrics.width;
        
        // Bubble dimensions
        const p = 15; 
        const w = Math.max(64, textWidth + p * 2);
        const h = fontSize + p * 2 + 15; // +15 for tail height
        
        canvas.width = w;
        canvas.height = h;

        // Draw
        ctx.font = `bold ${fontSize}px "Comic Sans Custom", "Comic Sans MS", "Comic Sans", cursive`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        // Background (Rounded Rect with tail)
        const r = 10;
        const bh = h - 15;
        
        ctx.fillStyle = 'white';
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 4;

        ctx.beginPath();
        ctx.moveTo(r, 2);
        ctx.lineTo(w - r, 2);
        ctx.quadraticCurveTo(w, 2, w - 2, r);
        ctx.lineTo(w - 2, bh - r);
        ctx.quadraticCurveTo(w - 2, bh, w - r, bh);
        
        // Tail
        ctx.lineTo(w / 2 + 8, bh);
        ctx.lineTo(w / 2, h - 2);
        ctx.lineTo(w / 2 - 8, bh);
        
        ctx.lineTo(r, bh);
        ctx.quadraticCurveTo(2, bh, 2, bh - r);
        ctx.lineTo(2, r);
        ctx.quadraticCurveTo(2, 2, r, 2);
        ctx.closePath();
        
        ctx.fill();
        ctx.stroke();

        // Text
        ctx.fillStyle = 'black';
        ctx.fillText(message, w / 2, bh / 2 + 2);

        // Sprite
        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.colorSpace = THREE.SRGBColorSpace;

        const mat = new THREE.SpriteMaterial({ 
            map: tex, 
            depthTest: false,
            transparent: true 
        });

        const sprite = new THREE.Sprite(mat);
        sprite.renderOrder = 9999;
        const pixelScale = 0.025;
        sprite.scale.set(w * pixelScale, h * pixelScale, 1);
        sprite.position.set(0, 2.5, 0); 

        this.head.add(sprite);
        this.currentBubble = sprite;

        // Auto remove
        if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
        this.bubbleTimer = setTimeout(() => {
            if (this.currentBubble === sprite) {
                this.head.remove(sprite);
                this.currentBubble.material.map.dispose();
                this.currentBubble.material.dispose();
                this.currentBubble = null;
            }
        }, 6000);
    }

    startDance() {
        if (this.animState === 'dance') return;
        this.animState = 'dance';
        // Keep mesh visible so bubbles show, but hide body parts
        this.mesh.visible = true;
        this.setBodyVisible(false);
        // Logic handled in update loop for creating/positioning the GIF
    }

    stopDance() {
        if (this.animState === 'dance') {
            this.animState = 'idle';
            this.mesh.visible = true;
            this.setBodyVisible(true);
            this.removeDanceElement();
        }
    }

    // Simple wave action: toggles a short waving animation on the right arm
    startWave() {
        if (this.animState === 'wave') return;
        this.animState = 'wave';
        this._waveTime = 0;
        this.mesh.visible = true;
        this.setBodyVisible(true); // keep body visible while waving
    }

    stopWave() {
        if (this.animState === 'wave') {
            this.animState = 'idle';
            this._waveTime = 0;
            // Reset arm pose smoothly
            this.rightArm.rotation.x = 0;
        }
    }

    setBodyVisible(visible) {
        Object.values(this.materials).forEach(mats => {
            if (Array.isArray(mats)) {
                mats.forEach(m => m.visible = visible);
            } else {
                mats.visible = visible;
            }
        });
    }

    updateDanceElement(camera) {
        if (!this.danceGif) {
            this.danceGif = document.createElement('img');
            this.danceGif.src = './spongedance-4.gif';
            this.danceGif.style.position = 'absolute';
            this.danceGif.style.transform = 'translate(-50%, -50%)';
            this.danceGif.style.pointerEvents = 'none';
            this.danceGif.style.zIndex = '15'; 
            document.body.appendChild(this.danceGif);
        }

        // Anchor at center of player (approx height 2.5)
        const pos = this.position.clone().add(new THREE.Vector3(0, 2.5, 0)); 
        
        // Project to screen
        pos.project(camera);

        const x = (pos.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-(pos.y * 0.5) + 0.5) * window.innerHeight;

        this.danceGif.style.left = x + 'px';
        this.danceGif.style.top = y + 'px';

        // Approximate scale based on distance
        const dist = camera.position.distanceTo(this.position);
        // Base height ~300px at close range
        const scale = 3000 / Math.max(1, dist); 
        this.danceGif.style.height = Math.max(10, scale) + 'px';
        this.danceGif.style.width = 'auto';

        // Hide if behind camera (z > 1 in NDC is behind far plane, but we want strict behind camera check)
        // NDC z range is -1 to 1. > 1 is beyond far plane.
        // But also check dot product for strict 'behind' check? 
        // Project handles it mostly, but sometimes wraps around.
        // Simple check: is z > 1?
        if (pos.z > 1 || Math.abs(pos.x) > 1.5 || Math.abs(pos.y) > 1.5) {
            this.danceGif.style.display = 'none';
        } else {
            this.danceGif.style.display = 'block';
        }
    }

    removeDanceElement() {
        if (this.danceGif) {
            this.danceGif.remove();
            this.danceGif = null;
        }
    }

    // Reduces health by `amount` (weapon hits) and ragdolls/respawns the player once it
    // reaches 0, exactly like touching a kill brick. Safe to call while already dead/mid-
    // respawn (no-ops). Returns true if this hit was the killing blow.
    takeDamage(amount) {
        if (this.isDead || amount <= 0) return false;
        this.health = Math.max(0, this.health - amount);
        if (this.health <= 0) {
            this.fallApart();
            return true;
        }
        return false;
    }

    fallApart() {
        this.stopDance();
        if (this.isDead) return;
        this.isDead = true;
        this.mesh.visible = false;
        
        // Clear stumble state if we die
        this.stumbleTimer = 0;

        // Stop walk sound if playing
        if (this.walkSource) {
            this.walkSource.stop();
            this.walkSource = null;
        }

        this.playSound(this.breakBuffer);

        // Spawn debris parts
        const parts = [this.head, this.torso, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg];
        
        parts.forEach(part => {
            // Find the actual mesh (handle Groups for limbs)
            let sourceMesh = part;
            if (part.type === 'Group' && part.children.length > 0) sourceMesh = part.children[0];

            const worldPos = new THREE.Vector3();
            sourceMesh.getWorldPosition(worldPos);
            const worldQuat = new THREE.Quaternion();
            sourceMesh.getWorldQuaternion(worldQuat);

            const debrisMesh = new THREE.Mesh(sourceMesh.geometry.clone(), sourceMesh.material);
            debrisMesh.position.copy(worldPos);
            debrisMesh.quaternion.copy(worldQuat);
            
            this.scene.add(debrisMesh);

            // Add physics state
            const vel = this.velocity.clone().multiplyScalar(0.5); // Inherit some velocity
            // Explode outwards
            vel.x += (Math.random() - 0.5) * 20;
            vel.y += Math.random() * 15; 
            vel.z += (Math.random() - 0.5) * 20;

            const angVel = new THREE.Vector3(
                Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
            ).multiplyScalar(10);

            this.debris.push({ mesh: debrisMesh, velocity: vel, angularVelocity: angVel });
        });

        this.respawnTimer = 4.0; // Seconds until respawn
    }

    respawn(world) {
        this.stopDance();
        this.isDead = false;
        this.mesh.visible = true;
        this.health = this.maxHealth;
        
        // Clear stumble state on respawn
        this.stumbleTimer = 0;
        this.animState = 'idle';
        // Reset finish flag so player can trigger finish again after respawn
        this._hasFinished = false;
        // Reset finish flag so player can finish again after respawn
        this._hasFinished = false;

        let spawnPos = new THREE.Vector3(0, 10, 0);
        if (world && world.getSpawnPoint) {
            spawnPos = world.getSpawnPoint();
        } else {
             // Fallback if world arg is missing but we have access via other means?
             // Just default
        }

        this.position.copy(spawnPos);
        this.velocity.set(0, 0, 0);
        this.mesh.position.copy(this.position);
        this.mesh.rotation.set(0,0,0);

        // Cleanup debris
        this.debris.forEach(d => {
            this.scene.remove(d.mesh);
            d.mesh.geometry.dispose();
        });
        this.debris = [];
    }

    update(dt, input, world, camera) {
        // Resume audio context if needed
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

        // Remember vertical velocity before physics integration for landing detection
        const preVy = this.velocity.y;
        this._lastPreLandVy = preVy;

        // Handle Vehicle
        if (this.vehicle) {
            this.stopDance();
            this.mesh.visible = true; // Show player on car
            this.onGround = false; // Disable foot physics
            
            // Pass input to vehicle
            this.vehicle.drive(input, dt);

            // Stick player to vehicle
            const seatPos = this.vehicle.mesh.position.clone().add(new THREE.Vector3(0, 2.5, 0));
            // Rotate player with vehicle
            this.position.copy(seatPos);
            this.mesh.position.copy(seatPos);
            this.mesh.rotation.y = this.vehicle.mesh.rotation.y;
            this.mesh.rotation.x = 0;
            this.mesh.rotation.z = 0;

            // Update animations
            this.leftArm.rotation.x = -0.5;
            this.rightArm.rotation.x = -0.5;
            this.leftLeg.rotation.x = -1.5; // Sitting
            this.rightLeg.rotation.x = -1.5;

            // Dismount
            if (input.jump) {
                this.vehicle.driver = null;
                this.vehicle = null;
                this.velocity.set(0, 20, 0); // Jump off
                this.position.y += 2;
                this.playSound(this.jumpBuffer);
            }
            return;
        }

        const killBricks = world && world.killBricks ? world.killBricks : [];
        const collidablesAll = world && world.collidables ? world.collidables : [];
        // Water material ("Water" in the Properties panel material dropdown) is meant to be
        // swum through, not stood on like a solid block - so it's excluded from the normal
        // solid-collision list and instead handled separately below as a swim volume.
        const isWaterObj = (o) => !!(o && o.userData && o.userData.serial && o.userData.serial.props && o.userData.serial.props.material === 'water');
        const collidables = collidablesAll.filter(o => !isWaterObj(o));
        const waterVolumes = collidablesAll.filter(isWaterObj);

        // Handle Death State
        if (this.isDead) {
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 0) {
                this.respawn(world);
            } else {
                // Update Debris
                const up = new THREE.Vector3(0, 1, 0);

                for (const d of this.debris) {
                    d.velocity.y += this.gravity * dt;
                    d.mesh.position.addScaledVector(d.velocity, dt);
                    
                    // Quaternion Rotation Integration
                    const rotMag = d.angularVelocity.length();
                    if (rotMag > 0.0001) {
                        const axis = d.angularVelocity.clone().normalize();
                        const angle = rotMag * dt;
                        const deltaRot = new THREE.Quaternion().setFromAxisAngle(axis, angle);
                        d.mesh.quaternion.premultiply(deltaRot);
                    }

                    // Dampen rotation to prevent endless spinning
                    d.angularVelocity.multiplyScalar(0.98);
                    d.velocity.multiplyScalar(0.995); // Air resistance

                    // Sleep check
                    if (d.velocity.lengthSq() < 0.5 && d.angularVelocity.lengthSq() < 0.5 && d.mesh.position.y < 5) {
                        // Just stop if moving very slowly near ground
                        d.velocity.set(0,0,0);
                        d.angularVelocity.set(0,0,0);
                    }

                    // Debris Collision
                    const dBox = new THREE.Box3().setFromObject(d.mesh);
                    for (const col of collidables) {
                        const cBox = new THREE.Box3().setFromObject(col);
                        if (dBox.intersectsBox(cBox)) {
                            // Find intersection
                            const inter = dBox.clone().intersect(cBox);
                            const w = inter.max.x - inter.min.x;
                            const h = inter.max.y - inter.min.y;
                            const dep = inter.max.z - inter.min.z;
                            
                            // Find min axis to resolve
                            if (w < h && w < dep) {
                                // X collision
                                const sign = d.mesh.position.x > col.position.x ? 1 : -1;
                                d.mesh.position.x += sign * w;
                                d.velocity.x *= -0.5;
                            } else if (h < w && h < dep) {
                                // Y collision
                                const sign = d.mesh.position.y > col.position.y ? 1 : -1;
                                
                                // Center of Mass Check: Only rest on top if center is within horizontal bounds
                                if (d.mesh.position.x >= cBox.min.x && d.mesh.position.x <= cBox.max.x &&
                                    d.mesh.position.z >= cBox.min.z && d.mesh.position.z <= cBox.max.z) {
                                    
                                    d.mesh.position.y += sign * h;
                                    d.velocity.y *= -0.5;
                                    d.velocity.x *= 0.8; // Friction
                                    d.velocity.z *= 0.8;
                                    d.angularVelocity.multiplyScalar(0.6); // Ground friction for rotation

                                    // Flatten logic: Snap to nearest axis-aligned rotation when on ground
                                    if (sign > 0) {
                                        const up = new THREE.Vector3(0, 1, 0);
                                        const q = d.mesh.quaternion;
                                        
                                        // Check axes
                                        const axes = [
                                            new THREE.Vector3(1, 0, 0).applyQuaternion(q),
                                            new THREE.Vector3(0, 1, 0).applyQuaternion(q),
                                            new THREE.Vector3(0, 0, 1).applyQuaternion(q)
                                        ];
                                        
                                        // Find most vertical axis
                                        let bestAxis = axes[0];
                                        let maxDot = Math.abs(bestAxis.dot(up));
                                        
                                        for (let i = 1; i < 3; i++) {
                                            const dot = Math.abs(axes[i].dot(up));
                                            if (dot > maxDot) {
                                                maxDot = dot;
                                                bestAxis = axes[i];
                                            }
                                        }

                                        // If not flat, push towards flat
                                        if (maxDot < 0.995) {
                                            // Target direction: closest world up/down
                                            const targetDir = up.clone().multiplyScalar(Math.sign(bestAxis.dot(up)));
                                            const correction = new THREE.Quaternion().setFromUnitVectors(bestAxis, targetDir);
                                            
                                            // Slap rotation instantly
                                            const targetQ = correction.multiply(q);
                                            d.mesh.quaternion.copy(targetQ);
                                            
                                            // Stabilize
                                            d.angularVelocity.multiplyScalar(0.5);
                                        }
                                    }
                                }
                            } else {
                                // Z collision
                                const sign = d.mesh.position.z > col.position.z ? 1 : -1;
                                d.mesh.position.z += sign * dep;
                                d.velocity.z *= -0.5;
                            }
                        }
                    }
                    
                    // Kill below world
                    if (d.mesh.position.y < -50) {
                        // let it fall
                    }
                }
            }
            return; // Skip normal update
        }

        const move = input;

        // Check for movement to cancel dance
        if (this.animState === 'dance') {
            // Add deadzone to prevent drift from cancelling dance
            if (Math.abs(move.x) > 0.1 || Math.abs(move.z) > 0.1 || move.jump || input.e) {
                this.stopDance();
            } else {
                // Update GIF position if still dancing
                if (camera) this.updateDanceElement(camera);
                this.velocity.set(0, 0, 0); // Force stop physics-ish
                this.velocity.y += this.gravity * dt; // Still apply gravity
                this.position.y += this.velocity.y * dt;
                
                // Ground collision logic for standing still
                if (this.position.y <= 0) { // Simple floor check fallback or reuse existing
                     // We should let the normal physics run actually, just override the visual model
                }
            }
        }

        // Physics
        // Swimming: figure out if the player's torso is currently inside a Water-material
        // block. Water blocks were already excluded from `collidables` above (so walking
        // into one doesn't stop you like a wall / stand on it like a floor); this is the
        // separate check that makes being inside one actually feel like water instead of
        // just empty space with normal gravity.
        this.inWater = false;
        if (waterVolumes.length > 0) {
            const chestY = this.position.y + 2.2; // roughly torso height
            for (const w of waterVolumes) {
                const wBox = this.tempBox.setFromObject(w);
                if (this.position.x >= wBox.min.x && this.position.x <= wBox.max.x &&
                    this.position.z >= wBox.min.z && this.position.z <= wBox.max.z &&
                    chestY >= wBox.min.y && chestY <= wBox.max.y) {
                    this.inWater = true;
                    break;
                }
            }
        }

        if (this.inWater) {
            // Much lighter "gravity" (near-neutral buoyancy) plus drag, so the player sinks/
            // floats gently instead of plummeting - and holding Jump swims upward for as
            // long as they're submerged, instead of a single hop.
            this.velocity.y += this.gravity * 0.15 * dt;
            this.velocity.y *= Math.pow(0.85, dt * 60);
            if (move.jump) {
                this.velocity.y = Math.max(this.velocity.y, this.swimUpSpeed || 6);
            }
            this.onGround = false;
            this.coyoteTimer = 0;
        } else {
            this.velocity.y += this.gravity * dt;
        }

        // Horizontal Movement
        const moveVec = new THREE.Vector3(move.x, 0, move.z).normalize().multiplyScalar(this.speed);

        // Apply movement with Collision Detection
        // X Axis
        const nextX = this.position.x + moveVec.x * dt;
        if (this.checkCollision(nextX, this.position.y, this.position.z, collidables)) {
            // Collision on X, don't move X
            this.velocity.x = 0;
        } else {
            this.position.x = nextX;
        }

        // Z Axis
        const nextZ = this.position.z + moveVec.z * dt;
        if (this.checkCollision(this.position.x, this.position.y, nextZ, collidables)) {
            // Collision on Z, don't move Z
            this.velocity.z = 0;
        } else {
            this.position.z = nextZ;
        }
        
        // Y Axis (Gravity)
        this.position.y += this.velocity.y * dt;

        // Vehicle Mounting Interaction
        // Check if close to a vehicle and press E (or just collide for now?) 
        // Let's use E key if InputManager supports it, otherwise bump mount is annoying.
        // User didn't specify interaction method, but "working car" usually implies driving.
        if (input.e && world && world.vehicles) {
            for (const v of world.vehicles) {
                if (v.driver) continue;
                const d = this.position.distanceTo(v.mesh.position);
                if (d < 8) {
                    this.vehicle = v;
                    v.driver = this;
                    this.velocity.set(0,0,0);
                    break;
                }
            }
        }

        // Ground Collision (Raycast from Center of Mass)
        let foundGround = false;

        // Only check ground if falling or standing
        if (this.velocity.y <= 0) {
            // Dynamic raycast origin to prevent falling through floor at high speeds
            const fallDist = Math.abs(this.velocity.y * dt);
            const rayOriginOffset = Math.max(2.5, fallDist + 1.5);
            
            this.tempRayOrigin.copy(this.position);
            this.tempRayOrigin.y += rayOriginOffset;
            
            this.raycaster.set(this.tempRayOrigin, this.downVector);
            // Recursive check to ensure we hit child meshes of groups
            const intersects = this.raycaster.intersectObjects(collidables, true);

            if (intersects.length > 0) {
                const hit = intersects[0];
                
                // Valid ground check:
                // 1. Floor is slightly below feet (standard standing/walking)
                // 2. Floor is above feet (we penetrated the floor due to gravity/lag)
                // Range: [feet - 0.5, rayOrigin]
                
                // Note: intersectObjects returns hits sorted by distance.
                // Since we cast from above, the first hit is the highest surface.
                
                if (hit.point.y > this.position.y - 0.6 && hit.point.y <= this.tempRayOrigin.y) {
                    this.position.y = hit.point.y;
                    // If we hit ground hard enough (preVy was large negative), trip
                    if (preVy < this.stumbleThreshold && !this.isDead) {
                        // Zero vertical velocity but mark as stumbled
                        this.velocity.y = 0;
                        this.onGround = true;
                        foundGround = true;
                        this.coyoteTimer = this.coyoteMaxTime;
                        // severity scales with impact speed
                        const severity = Math.min(2, Math.abs(preVy) / Math.abs(this.stumbleThreshold));
                        this.triggerStumble(severity);
                    } else {
                        this.velocity.y = 0;
                        this.onGround = true;
                        foundGround = true;
                        this.coyoteTimer = this.coyoteMaxTime;
                    }
                }
            }
        }
        
        // Head collision (Ceiling)
        if (this.velocity.y > 0) {
             if (this.checkCollision(this.position.x, this.position.y + 1, this.position.z, collidables)) {
                 this.velocity.y = 0;
             }
        }

        if (!foundGround) {
            this.onGround = false;
        }

        // Coyote Timer decay
        if (this.coyoteTimer > 0) {
            this.coyoteTimer -= dt;
        }

        // Handle active stumble (prevent movement, animate)
        if (this.stumbleTimer > 0) {
            this.stumbleTimer -= dt;
            // Lock movement while stumbling
            // Slight jitter/flail for arms and legs
            const t = (this.stumbleTimer / this.stumbleDuration);
            const wobble = (1 - t) * 2.5;
            this.leftArm.rotation.x = Math.PI * 0.5 * wobble;
            this.rightArm.rotation.x = Math.PI * 0.5 * wobble;
            this.leftLeg.rotation.x = Math.PI * 0.2 * wobble;
            this.rightLeg.rotation.x = Math.PI * 0.2 * wobble;

            // Prevent horizontal movement by zeroing move input
            move.x = 0;
            move.z = 0;

            // While stumbling keep player visually on ground
            if (this.stumbleTimer <= 0) {
                // Recover
                this.stumbleTimer = 0;
                this.animState = 'idle';
            } else {
                // Update mesh position and return early (skip normal movement integration)
                this.mesh.position.copy(this.position);
                return;
            }
        }

        // Death Check (Void)
        if (this.position.y < -20) {
            this.fallApart();
            return;
        }

        // Jump
        if (this.coyoteTimer > 0 && move.jump) {
            this.velocity.y = this.jumpForce;
            this.onGround = false;
            this.coyoteTimer = 0; // Prevent multi-jump
            this.playSound(this.jumpBuffer);
        }

        // Visuals
        this.mesh.position.copy(this.position);

        // Push the player straight back out of any block they're overlapping (see
        // resolveOverlap() above) - runs every frame, so a jump that clips into a block's
        // underside gets corrected immediately instead of leaving them wedged inside it.
        if (!this.isDead && !this.vehicle) {
            this.resolveOverlap(collidables);
            this.mesh.position.copy(this.position);
        }

        // Stuck detection: last-resort safety net for the rare case resolveOverlap() can't
        // find a clean way out (e.g. fully enclosed on every side) - teleport up and out.
        if (!this.isDead && !this.vehicle && this.checkCollision(this.position.x, this.position.y, this.position.z, collidables)) {
            this.stuckTimer += dt;
            if (this.stuckTimer >= 2) {
                this.teleport(this.position.clone().add(new THREE.Vector3(0, 15, 0)));
                this.stuckTimer = 0;
                this.chat("Unstuck!");
            }
        } else {
            this.stuckTimer = 0;
        }

        // Hazard Check
        if (killBricks.length > 0) {
            const pBox = new THREE.Box3().setFromObject(this.mesh);
            pBox.expandByScalar(-0.5); // Forgive slightly

            for (const brick of killBricks) {
                const bBox = new THREE.Box3().setFromObject(brick);
                if (pBox.intersectsBox(bBox)) {
                    this.fallApart();
                    return;
                }
            }
        }

        // RigBot Attack Check: any RigBot flagged to attack the player knocks them down on contact.
        const attackingRigs = world && world.attackingRigs ? world.attackingRigs : [];
        if (attackingRigs.length > 0) {
            const pBox = new THREE.Box3().setFromObject(this.mesh);
            pBox.expandByScalar(-0.4);

            for (const rig of attackingRigs) {
                const rBox = new THREE.Box3().setFromObject(rig);
                if (pBox.intersectsBox(rBox)) {
                    this.fallApart();
                    return;
                }
            }
        }

        // Launch Pad Check
        const launchPads = world && world.launchPads ? world.launchPads : [];
        if (launchPads.length > 0) {
            const pBox = new THREE.Box3().setFromObject(this.mesh);
            pBox.expandByScalar(-0.1); 

            for (const pad of launchPads) {
                const bBox = new THREE.Box3().setFromObject(pad);
                if (pBox.intersectsBox(bBox)) {
                    this.velocity.y = 800;
                    this.onGround = false;
                    this.playSound(this.jumpBuffer, false, 0.6);
                }
            }
        }

        // Teleporter Check
        if (world && world.teleporters) {
             const pBox = new THREE.Box3().setFromObject(this.mesh);
             for(const tp of world.teleporters) {
                 const tBox = new THREE.Box3().setFromObject(tp);
                 tBox.expandByScalar(0.5); // Ensure trigger detection when standing on it
                 if (pBox.intersectsBox(tBox)) {
                     if (tp.userData.destination) {
                         this.teleport(tp.userData.destination);
                     }
                 }
             }
        }

        // Block-touch scripts ("OnTouch:<name> command? args..." - see World.parseScript).
        // Each rule fires once per continuous touch (edge-triggered on entering the block),
        // not every single frame while standing on it, so e.g. "place?" doesn't spam
        // infinite parts and "giveTool?" doesn't spam infinite pickup messages.
        if (world && world.scriptRules && world.scriptRules.length > 0) {
            if (!this._scriptTouch) this._scriptTouch = {};
            const pBox = new THREE.Box3().setFromObject(this.mesh);
            world.scriptRules.forEach((rule, idx) => {
                if (rule.event !== 'touch') return;
                const target = (world.items || []).find(o => o.name === rule.blockName);
                const wasTouching = !!this._scriptTouch[idx];
                let touching = false;
                if (target) {
                    const tBox = new THREE.Box3().setFromObject(target);
                    touching = pBox.intersectsBox(tBox);
                }
                this._scriptTouch[idx] = touching;
                if (touching && !wasTouching) {
                    this.runBlockScriptCommand(rule, target, world);
                }
            });
        }

        // Finish Pad Check (Easy Obby end): play tada once and show bubble
        try {
            if (world && world.finishPads && world.finishPads.length > 0 && !this._hasFinished) {
                const pBoxF = new THREE.Box3().setFromObject(this.mesh);
                for (const fp of world.finishPads) {
                    const fBox = new THREE.Box3().setFromObject(fp);
                    if (pBoxF.intersectsBox(fBox)) {
                        // Mark finished so we only trigger once until respawn
                        this._hasFinished = true;
                        // Play tada sound if loaded
                        try { this.playSound(this.tadaBuffer); } catch (e) {}
                        // Chat/bubble feedback
                        this.chat("Finished!");
                        break;
                    }
                }
            }
        } catch (e) {
            // ignore detection errors
        }

        const isMoving = moveVec.lengthSq() > 0.1;

        // Rotation & Animation
        if (input.lookAngle !== undefined) {
            this.mesh.rotation.y = input.lookAngle;
        } else if (isMoving) {
            const angle = Math.atan2(moveVec.x, moveVec.z);
            // Instant turn (Roblox 2006 style)
            this.mesh.rotation.y = angle;
        }

        // Determine Animation State
        if (this.animState !== 'dance') {
            this.animState = 'idle';
            if (!this.onGround) this.animState = 'fall';
            else if (isMoving) this.animState = 'walk';
        }

        // Developer Override
        if (this.forcedAnim) this.animState = this.forcedAnim;

        if (this.animState === 'dance') {
            // Bob head to match gif energy
            const t = Date.now() / 1000;
            this.head.position.y = 4.5 + Math.abs(Math.sin(t * 12)) * 0.3;
            this.head.position.x = Math.sin(t * 6) * 0.5;
            this.head.rotation.z = Math.sin(t * 4) * 0.1;
        } else {
            // Reset head transform
            this.head.position.set(0, 4.5, 0);
            this.head.rotation.z = 0;
        }

        if (this.animState === 'dance') {
            // Logic handled separately
        } else if (this.animState === 'wave') {
            // Simple timed wave: lift right arm and rotate at the elbow-ish
            this._waveTime = (this._waveTime || 0) + dt;
            const t = this._waveTime;
            // Wave for ~2 seconds then stop
            if (t >= 2.0) {
                this.stopWave();
            } else {
                // arm lift
                const lift = Math.min(1.6, 0.8 + Math.sin(t * Math.PI * 2) * 0.6);
                // waving motion
                const waveRot = Math.sin(t * 10) * 0.8;
                this.rightArm.rotation.x = -lift;
                this.rightArm.rotation.z = waveRot * 0.25;
            }
        } else if (this.animState === 'fall') {
            // Jump/Fall Animation - Arms up, Legs Still
            this.leftArm.rotation.x = Math.PI;
            this.rightArm.rotation.x = Math.PI;
            this.leftLeg.rotation.x = 0;
            this.rightLeg.rotation.x = 0;
            
        } else if (this.animState === 'walk') {
            // Janky walk: faster, larger amplitude, less smoothing and a little random jitter
            const walkSpeed = 10.5;
            const amp = 1.6;
            // Slight phase wobble driven by a seeded offset to keep per-player uniqueness
            this.animTime += dt + (Math.sin(this._walkSeed + Date.now() * 0.001) * 0.006);

            // Reduce smoothing so motion is snappier/jankier
            const smoothFactor = Math.min(1, dt * 6.0);

            // Compute base targets
            let tLeftArm = Math.sin(this.animTime * walkSpeed) * amp;
            let tRightArm = -Math.sin(this.animTime * walkSpeed) * amp;
            let tLeftLeg = -Math.sin(this.animTime * walkSpeed) * amp;
            let tRightLeg = Math.sin(this.animTime * walkSpeed) * amp;

            // Add small frame-to-frame jitter that scales inversely with smoothing
            const jitterAmount = (1 - smoothFactor) * 0.6; // more jitter when less smoothing
            const jLA = (Math.random() - 0.5) * jitterAmount;
            const jRA = (Math.random() - 0.5) * jitterAmount;
            const jLL = (Math.random() - 0.5) * jitterAmount;
            const jRL = (Math.random() - 0.5) * jitterAmount;

            tLeftArm += jLA;
            tRightArm += jRA;
            tLeftLeg += jLL;
            tRightLeg += jRL;

            // Apply with lerp to keep transitions visibly uneven
            this.leftArm.rotation.x += (tLeftArm - this.leftArm.rotation.x) * smoothFactor;
            this.rightArm.rotation.x += (tRightArm - this.rightArm.rotation.x) * smoothFactor;
            this.leftLeg.rotation.x += (tLeftLeg - this.leftLeg.rotation.x) * smoothFactor;
            this.rightLeg.rotation.x += (tRightLeg - this.rightLeg.rotation.x) * smoothFactor;
        } else {
            // Idle - Instant reset
            this.animTime = 0;
            this.leftArm.rotation.x = 0;
            this.rightArm.rotation.x = 0;
            this.leftLeg.rotation.x = 0;
            this.rightLeg.rotation.x = 0;
        }

        // Walk Sound Logic (Looping)
        // Sound should only play if actually moving on ground, regardless of forced animation visual
        if (this.onGround && isMoving) {
            if (!this.walkSource && this.walkBuffer) {
                this.walkSource = this.playSound(this.walkBuffer, true);
            }
        } else {
            if (this.walkSource) {
                this.walkSource.stop();
                this.walkSource = null;
            }
        }
        
        this.updateGlitches(dt);

        // Keep the Devdex catalog-item hat (a flat image plane) always facing
        // the camera. Without this it stays welded to the head's rotation, so
        // as the camera orbits around you can end up looking at its back/edge
        // or see it clipped into the head geometry - which from some angles
        // reads as if you're looking at a warped, doubled copy of yourself.
        if (camera && this._hatBillboardPlane) {
            const parent = this._hatBillboardPlane.parent;
            if (parent) {
                parent.updateWorldMatrix(true, false);
                const parentWorldQuat = new THREE.Quaternion();
                parent.getWorldQuaternion(parentWorldQuat);
                this._hatBillboardPlane.quaternion.copy(parentWorldQuat.clone().invert().multiply(camera.quaternion.clone()));
            }
        }
    }

    // Depenetration: if the player's box ends up overlapping a solid block (most commonly
    // from jumping up into the underside of a floating block, or spawning/teleporting into
    // one), push them straight back out along whichever axis has the smallest overlap -
    // every single frame, immediately - instead of just freezing movement and leaving them
    // wedged there. This is what actually gets you unstuck; the 12s teleport-up further
    // below is only a last-resort safety net for the rare case a player is fully enclosed
    // on every side (where there's no clean "out" direction to push them along).
    resolveOverlap(collidables) {
        const pBox = new THREE.Box3(
            new THREE.Vector3(this.position.x - 1.2, this.position.y + 0.6, this.position.z - 1.2),
            new THREE.Vector3(this.position.x + 1.2, this.position.y + 5.5, this.position.z + 1.2)
        );

        let smallestOverlap = Infinity;
        let pushVec = null;

        for (const obj of collidables) {
            if (obj === this.mesh || obj.parent === this.mesh) continue;
            if (Math.abs(obj.position.x - this.position.x) > 20 || Math.abs(obj.position.z - this.position.z) > 20) continue;

            const oBox = new THREE.Box3().setFromObject(obj);
            if (!pBox.intersectsBox(oBox)) continue;

            const overlapX = Math.min(pBox.max.x, oBox.max.x) - Math.max(pBox.min.x, oBox.min.x);
            const overlapY = Math.min(pBox.max.y, oBox.max.y) - Math.max(pBox.min.y, oBox.min.y);
            const overlapZ = Math.min(pBox.max.z, oBox.max.z) - Math.max(pBox.min.z, oBox.min.z);
            if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) continue;

            const minOverlap = Math.min(overlapX, overlapY, overlapZ);
            if (minOverlap >= smallestOverlap) continue;
            smallestOverlap = minOverlap;

            if (minOverlap === overlapY) {
                const objCenterY = (oBox.min.y + oBox.max.y) / 2;
                const dir = (this.position.y + 2.85) < objCenterY ? -1 : 1;
                pushVec = new THREE.Vector3(0, dir * overlapY, 0);
            } else if (minOverlap === overlapX) {
                const objCenterX = (oBox.min.x + oBox.max.x) / 2;
                const dir = this.position.x < objCenterX ? -1 : 1;
                pushVec = new THREE.Vector3(dir * overlapX, 0, 0);
            } else {
                const objCenterZ = (oBox.min.z + oBox.max.z) / 2;
                const dir = this.position.z < objCenterZ ? -1 : 1;
                pushVec = new THREE.Vector3(0, 0, dir * overlapZ);
            }
        }

        if (pushVec) {
            this.position.add(pushVec);
            if (pushVec.y !== 0) this.velocity.y = 0;
            if (pushVec.x !== 0) this.velocity.x = 0;
            if (pushVec.z !== 0) this.velocity.z = 0;
            return true;
        }
        return false;
    }

    checkCollision(x, y, z, collidables) {
        // Player Bounding Box
        // Width 3, Height 5, Depth 1.5 relative to feet (y)
        // Lift 'y' slightly (0.6) to step over small bumps/studs
        this.playerBox.min.set(x - 1.2, y + 0.6, z - 1.2);
        this.playerBox.max.set(x + 1.2, y + 5.5, z + 1.2);

        // Player OBB setup for rotated collision
        // Center of player (approx)
        const pCenter = new THREE.Vector3(x, y + 2.85, z); 
        const pHalfSize = new THREE.Vector3(1.0, 2.25, 1.0); // Slightly smaller than AABB to prevent wall sticking
        this.playerOBB.center.copy(pCenter);
        this.playerOBB.halfSize.copy(pHalfSize);
        this.playerOBB.rotation.identity(); // Player is always upright/axis aligned (mostly)

        for (const obj of collidables) {
            // Ignore self/parts of self if any
            if (obj === this.mesh || obj.parent === this.mesh) continue;
            
            // Basic Distance Check Optimization
            // Objects > 50 studs away probably don't collide
            if (Math.abs(obj.position.x - x) > 50 || Math.abs(obj.position.z - z) > 50) continue;

            // 1. Broadphase AABB Check (World Space)
            this.tempBox.setFromObject(obj);
            
            if (this.playerBox.intersectsBox(this.tempBox)) {
                // Collision detected in AABB
                
                // 2. Narrowphase: Handle Rotated Objects with OBB
                if (obj.rotation.x !== 0 || obj.rotation.y !== 0 || obj.rotation.z !== 0) {
                    if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
                    
                    const geoBox = obj.geometry.boundingBox;
                    const center = new THREE.Vector3();
                    geoBox.getCenter(center);
                    const size = new THREE.Vector3();
                    geoBox.getSize(size);
                    
                    // Half size scaled
                    const halfSize = size.multiply(obj.scale).multiplyScalar(0.5);
                    
                    this.tempOBB.center.copy(center);
                    this.tempOBB.halfSize.copy(halfSize);
                    this.tempOBB.rotation.identity(); // Local rotation is identity
                    
                    // Apply object world matrix to OBB
                    // OBB.applyMatrix4 expects the OBB to be defined in local space initially relative to the matrix origin?
                    // Actually OBB implementation transforms center and extracts basis from matrix
                    this.tempOBB.applyMatrix4(obj.matrixWorld);
                    
                    if (this.playerOBB.intersectsOBB(this.tempOBB)) {
                        return true;
                    }
                    
                    // If OBB check fails, we are inside AABB but not OBB -> No collision
                    continue; 
                }
                
                // If not rotated, AABB intersection is sufficient
                return true;
            }
        }
        return false;
    }

    glitchPart(object) {
        let target = object;
        // If target is a mesh inside a limb group (which is direct child of player mesh)
        if (target.parent && target.parent !== this.mesh && target.parent.isGroup) {
            target = target.parent;
        }
        if (target === this.mesh) return; // Don't glitch root
        
        if (this.activeGlitches.find(g => g.target === target)) return;

        const effects = ['spin', 'fling', 'explode', 'resize'];
        const effect = effects[Math.floor(Math.random() * effects.length)];

        this.activeGlitches.push({
            target: target,
            effect: effect,
            timer: 3.0,
            originalState: {
                pos: target.position.clone(),
                rot: target.rotation.clone(),
                scale: target.scale.clone()
            }
        });

        // Use jump sound for glitch effect
        this.playSound(this.jumpBuffer, false, 2.0);
    }

    updateGlitches(dt) {
        for (let i = this.activeGlitches.length - 1; i >= 0; i--) {
            const g = this.activeGlitches[i];
            g.timer -= dt;

            if (g.timer <= 0) {
                // Restore
                g.target.position.copy(g.originalState.pos);
                g.target.rotation.copy(g.originalState.rot);
                g.target.scale.copy(g.originalState.scale);
                this.activeGlitches.splice(i, 1);
                continue;
            }

            if (g.effect === 'spin') {
                const t = 3.0 - g.timer;
                g.target.rotation.x = g.originalState.rot.x + t * 20;
                g.target.rotation.y = g.originalState.rot.y + t * 15;
            } else if (g.effect === 'fling') {
                // Jitter position
                g.target.position.copy(g.originalState.pos).add(new THREE.Vector3(
                    (Math.random()-0.5), (Math.random()-0.5), (Math.random()-0.5)
                ).multiplyScalar(2));
            } else if (g.effect === 'explode') {
                 g.target.scale.setScalar(1 + Math.random() * 3);
            } else if (g.effect === 'resize') {
                 const s = 1.5 + Math.sin(Date.now() * 0.02) * 1.0;
                 g.target.scale.setScalar(s);
            }
        }
    }

    teleport(pos) {
        this.position.copy(pos);
        this.mesh.position.copy(pos);
        this.velocity.set(0, 0, 0);
        this.onGround = false;
        // Reset rotation if needed, or keep
        this.playSound(this.jumpBuffer, false, 1.5); // high pitch jump for tp
    }

    // Executes one parsed block-script rule (see World.parseScript) that just fired.
    // `target` is the touched block's mesh (may be undefined if the named block
    // couldn't be found - e.g. renamed/deleted after the script was written).
    runBlockScriptCommand(rule, target, world) {
        const args = rule.args || [];
        // A trailing "player"/"Player" argument is just a readability marker in the
        // script syntax (e.g. "kill? player") - strip it before reading real args.
        const realArgs = args.filter((a) => a.toLowerCase() !== 'player');

        switch (rule.command) {
            case 'kill': {
                this.fallApart();
                break;
            }
            case 'givetool': {
                const toolName = realArgs[0] || 'Tool';
                if (!this.tools) this.tools = [];
                if (!this.tools.includes(toolName)) this.tools.push(toolName);
                this.chat(`Received: ${toolName}`);
                break;
            }
            case 'tpto': {
                const destName = realArgs[0];
                const dest = destName ? (world.items || []).find(o => o.name === destName) : null;
                if (dest) {
                    const box = new THREE.Box3().setFromObject(dest);
                    const topY = box.max.y;
                    this.teleport(new THREE.Vector3(dest.position.x, topY + 1.2, dest.position.z));
                } else {
                    console.warn(`tpTo?: no block named "${destName}" found`);
                }
                break;
            }
            case 'place': {
                // place? "<partName>" player                             - on top of the touched block
                // place? "<partName>" tpTo:<otherBlockName> player       - on top of a DIFFERENT block
                // place? "<partName>" tpTo:<otherBlockName> anchor player - same, but the new
                //   part spawns with Anchored OFF (falls/pushes like any other unanchored
                //   part instead of staying fixed in place - e.g. lava that should drip/fall).
                const partName = realArgs.find(a => !/^tpto:/i.test(a) && !/^anchor$/i.test(a) && !/^player$/i.test(a));
                const tpToArg = realArgs.find(a => /^tpto:/i.test(a));
                const wantsUnanchored = realArgs.some(a => /^anchor$/i.test(a));
                let spawnPos = null;
                if (tpToArg) {
                    const destName = tpToArg.slice(tpToArg.indexOf(':') + 1);
                    const dest = (world.items || []).find(o => o.name === destName);
                    if (dest) {
                        const dBox = new THREE.Box3().setFromObject(dest);
                        spawnPos = { x: dest.position.x, y: dBox.max.y + 0.5, z: dest.position.z };
                    } else {
                        console.warn(`place?: tpTo target "${destName}" not found`);
                    }
                }
                if (!spawnPos) {
                    if (!target) break;
                    const box = new THREE.Box3().setFromObject(target);
                    spawnPos = { x: target.position.x, y: box.max.y + 0.5, z: target.position.z };
                }
                if (!world || typeof world.createBlock !== 'function') break;
                const newPart = world.createBlock(spawnPos.x, spawnPos.y, spawnPos.z, 1, 1, 1, 0xffffff, ['static']);
                if (partName) newPart.name = partName;
                if (wantsUnanchored) {
                    // Same bookkeeping loadFromData's _applyAnchorState does for a saved
                    // Anchored=false part: mark it, zero its fall speed, and register it with
                    // the gravity/push physics loop (and, on Publish, this also makes it
                    // serialize back out with anchored:false - see World.serialize()).
                    newPart.userData.anchored = false;
                    newPart.userData.velocityY = 0;
                    if (world.dynamicObjects && world.dynamicObjects.indexOf(newPart) === -1) {
                        world.dynamicObjects.push(newPart);
                    }
                }
                break;
            }
            default:
                console.warn(`Unknown block-script command "${rule.command}?" in rule: ${rule.raw}`);
        }
    }

    mount(vehicle) {
        if (this.vehicle) return;
        this.vehicle = vehicle;
        this.onGround = false;
    }

    serializeAppearance() {
        // Return only lightweight metadata for presence (avoid embedding large data URLs)
        return {
            colors: this.appearance.colors || {},
            hasFace: !!this.appearance.faceUrl,
            hasShirt: !!this.appearance.shirtUrl
        };
    }

    deserializeAppearance(data) {
        if (!data) return;

        // Hat Loading
        if (data.hat) {
            // createHat now loads either simple or complex geometry
            this.createHat(data.hat);
        }
        
        // Colors
        if (data.colors) {
            for (const [part, col] of Object.entries(data.colors)) {
                this.setPartColor(part, col);
            }
        }
        
        // Textures
        if (data.faceUrl) {
            const img = new Image();
            img.onload = () => this.setFaceTexture(img, data.faceUrl);
            img.src = data.faceUrl;
        }
        if (data.shirtUrl) {
            const img = new Image();
            img.onload = () => this.setShirtTexture(img, data.shirtUrl);
            img.src = data.shirtUrl;
        }
    }
}