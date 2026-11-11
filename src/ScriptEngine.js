// ScriptEngine.js - the command library behind the Studio "Block Script" language.
//
// Rule syntax (one per line, see World.parseScript):
//   OnTouch:<block> command? args... [once] [cooldown=3] [chance=50]
//   OnTouchEnd:<block> command? args...
//   OnStart command? args...                 (once, when a round begins)
//   OnTimer:<seconds> command? args...       (every N seconds, synced across players)
//   OnKey:<letter> command? args...          (when the player presses that key)
//   OnDeath command? args...                 (when the local player dies)
//   OnTickUpdate:command? args...            (continuous animation every frame/tick)
//
// A block name can be exact ("door1"), a prefix wildcard ("lava*") or "all".
// Commands are split in three groups:
//   PLAYER_COMMANDS - affect the player that triggered the rule (heal?, speed?, ...)
//   WORLD_COMMANDS  - change blocks (hide?, color?, move?, ...). When fired by a player action
//                     they are broadcast so every client sees the same change.
//   TICK_COMMANDS   - deterministic animations computed from the shared clock (spin?, bob?, ...)
import * as THREE from 'three';

// ---------------------------------------------------------------- helpers

export function findBlocks(world, name) {
    if (!name) return [];
    const items = world.items || [];
    if (name === 'all' || name === '*') return items.filter(o => o.isMesh);
    if (name.endsWith('*')) {
        const prefix = name.slice(0, -1);
        return items.filter(o => o.name && o.name.startsWith(prefix));
    }
    return items.filter(o => o.name === name);
}

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isNaN(n) ? d : n; };
const bool = (v, d = true) => (v === undefined ? d : !/^(false|off|no|0)$/i.test(String(v)));

function setCollide(world, part, on) {
    part.userData.collide = !!on;
    const i = world.collidables.indexOf(part);
    if (on && i === -1) world.collidables.push(part);
    else if (!on && i !== -1) world.collidables.splice(i, 1);
}

function setOpacity(part, opacity) {
    const mats = Array.isArray(part.material) ? part.material : [part.material];
    mats.forEach(m => { if (!m) return; m.transparent = opacity < 1; m.opacity = opacity; m.needsUpdate = true; });
}

function setColor(world, part, hex) {
    const mats = Array.isArray(part.material) ? part.material : [part.material];
    mats.forEach(m => { if (m && m.color) m.color.setHex(hex); });
    if (part.userData && part.userData.serial) part.userData.serial.color = hex;
}

// Hooks main.js installs so the engine can reach things that live in main.js's scope.
export const hooks = {
    explode: null,     // (THREE.Vector3, radius, force, damage)
    sfx: null,         // (name, volume)
    message: null,     // (text) -> system chat line
    giveKey: null,     // (keyId)
    removeKey: null,   // (keyId)
    giveWeapon: null,  // (type) equip rocketlauncher|sword|nokia|buildtool
    removeWeapon: null, // () unequip
    banner: null,      // (text, seconds) big on-screen text
    setSky: null,      // (hexColor)
    openUrl: null,
    setBrightness: null, // (0..1) day/night light level
    broadcast: null,   // (command, args) -> sends a 'script_cmd' to other players
};

// Pulls the generic modifiers (once / cooldown=N / chance=N) out of an args list.
export function extractModifiers(args) {
    const mods = { once: false, cooldown: 0, chance: 100 };
    const rest = [];
    (args || []).forEach(a => {
        const s = String(a);
        if (/^once$/i.test(s)) mods.once = true;
        else if (/^cooldown=/i.test(s)) mods.cooldown = num(s.split('=')[1], 0);
        else if (/^chance=/i.test(s)) mods.chance = num(s.split('=')[1], 100);
        else rest.push(a);
    });
    return { args: rest, mods };
}

// ---------------------------------------------------------------- WORLD commands
// signature: (world, args, ctx) where ctx = { player, target, remote }

export const WORLD_COMMANDS = {
    // ---- visibility / existence
    hide(world, [name]) { findBlocks(world, name).forEach(b => { b.visible = false; setCollide(world, b, false); }); },
    show(world, [name]) { findBlocks(world, name).forEach(b => { b.visible = true; setCollide(world, b, true); }); },
    toggle(world, [name]) {
        findBlocks(world, name).forEach(b => {
            const on = !b.visible; b.visible = on; setCollide(world, b, on);
        });
    },
    delete(world, [name]) { findBlocks(world, name).forEach(b => world.removePart(b)); },
    remove(world, args, ctx) { WORLD_COMMANDS.delete(world, args, ctx); },
    destroy(world, args, ctx) { WORLD_COMMANDS.delete(world, args, ctx); },
    clone(world, [name, dx, dy, dz]) {
        findBlocks(world, name).forEach(b => {
            const s = b.userData.serial || {};
            const c = world.createBlock(
                b.position.x + num(dx, 0), b.position.y + num(dy, 3), b.position.z + num(dz, 0),
                s.w || 1, s.h || 1, s.d || 1, s.color ?? 0xffffff, ['static']);
            c.name = b.name + '_clone';
            c.scale.copy(b.scale); c.rotation.copy(b.rotation);
        });
    },

    // ---- appearance
    color(world, [name, col]) { const hex = world.constructor.parseColorArg(col); findBlocks(world, name).forEach(b => setColor(world, b, hex)); },
    paint(world, args, ctx) { WORLD_COMMANDS.color(world, args, ctx); },
    randomcolor(world, [name]) { findBlocks(world, name).forEach(b => setColor(world, b, Math.floor(Math.random() * 0xffffff))); },
    transparency(world, [name, v]) { const t = Math.min(1, Math.max(0, num(v, 0.5))); findBlocks(world, name).forEach(b => setOpacity(b, 1 - t)); },
    opacity(world, [name, v]) { const o = Math.min(1, Math.max(0, num(v, 1))); findBlocks(world, name).forEach(b => setOpacity(b, o)); },
    glow(world, [name, v]) {
        findBlocks(world, name).forEach(b => {
            const mats = Array.isArray(b.material) ? b.material : [b.material];
            mats.forEach(m => { if (m && m.emissive) { m.emissive.copy(m.color); m.emissiveIntensity = num(v, 1); } });
        });
    },
    unglow(world, [name]) {
        findBlocks(world, name).forEach(b => {
            const mats = Array.isArray(b.material) ? b.material : [b.material];
            mats.forEach(m => { if (m && m.emissive) m.emissiveIntensity = 0; });
        });
    },
    rename(world, [name, newName]) { findBlocks(world, name).forEach(b => { b.name = newName; }); },

    // ---- transform
    move(world, [name, x, y, z]) { findBlocks(world, name).forEach(b => b.position.add(new THREE.Vector3(num(x), num(y), num(z)))); },
    moveto(world, [name, x, y, z]) { findBlocks(world, name).forEach(b => b.position.set(num(x), num(y), num(z))); },
    goto(world, [name, dest]) {
        const d = findBlocks(world, dest)[0];
        if (d) findBlocks(world, name).forEach(b => b.position.copy(d.position));
    },
    rotate(world, [name, x, y, z]) {
        const r = Math.PI / 180;
        findBlocks(world, name).forEach(b => { b.rotation.x += num(x) * r; b.rotation.y += num(y) * r; b.rotation.z += num(z) * r; });
    },
    setrotation(world, [name, x, y, z]) {
        const r = Math.PI / 180;
        findBlocks(world, name).forEach(b => b.rotation.set(num(x) * r, num(y) * r, num(z) * r));
    },
    size(world, [name, x, y, z]) {
        findBlocks(world, name).forEach(b => b.scale.set(num(x, 1), num(y, num(x, 1)), num(z, num(x, 1))));
    },
    grow(world, [name, f]) { findBlocks(world, name).forEach(b => b.scale.multiplyScalar(num(f, 1.2))); },
    shrink(world, [name, f]) { findBlocks(world, name).forEach(b => b.scale.multiplyScalar(1 / Math.max(0.01, num(f, 1.2)))); },
    scatter(world, [name, r]) {
        const range = num(r, 5);
        findBlocks(world, name).forEach(b => { b.position.x += (Math.random() - 0.5) * range * 2; b.position.z += (Math.random() - 0.5) * range * 2; });
    },

    // ---- physics flags
    collide(world, [name, on]) { findBlocks(world, name).forEach(b => setCollide(world, b, bool(on))); },
    cancollide(world, args, ctx) { WORLD_COMMANDS.collide(world, args, ctx); },
    anchor(world, [name, on]) {
        const anchored = bool(on);
        findBlocks(world, name).forEach(b => {
            b.userData.anchored = anchored;
            const i = world.dynamicObjects.indexOf(b);
            if (!anchored) { b.userData.velocityY = 0; if (i === -1) world.dynamicObjects.push(b); }
            else if (i !== -1) world.dynamicObjects.splice(i, 1);
        });
    },
    unanchor(world, [name]) { WORLD_COMMANDS.anchor(world, [name, 'false']); },
    drop(world, [name]) { WORLD_COMMANDS.anchor(world, [name, 'false']); },
    bounce(world, [name, force]) {
        findBlocks(world, name).forEach(b => {
            if (world.dynamicObjects.indexOf(b) === -1) { b.userData.anchored = false; world.dynamicObjects.push(b); }
            b.userData.velocityY = num(force, 30);
        });
    },
    shove(world, [name, x, y, z]) {
        findBlocks(world, name).forEach(b => {
            if (world.dynamicObjects.indexOf(b) === -1) { b.userData.anchored = false; world.dynamicObjects.push(b); }
            b.userData.velocityX = (b.userData.velocityX || 0) + num(x);
            b.userData.velocityY = (b.userData.velocityY || 0) + num(y);
            b.userData.velocityZ = (b.userData.velocityZ || 0) + num(z);
        });
    },

    // ---- spawning / effects
    spawn(world, [name, x, y, z, col, sx, sy, sz]) {
        const hex = col ? world.constructor.parseColorArg(col) : 0xffffff;
        const b = world.createBlock(num(x), num(y, 5), num(z), num(sx, 1), num(sy, num(sx, 1)), num(sz, num(sx, 1)), hex, ['static']);
        if (name) b.name = name;
    },
    spawnrain(world, [name, count, x, z, radius, col]) {
        const n = Math.min(40, Math.max(1, parseInt(count, 10) || 5));
        const hex = col ? world.constructor.parseColorArg(col) : 0xff8800;
        for (let i = 0; i < n; i++) {
            const b = world.createBlock(num(x) + (Math.random() - 0.5) * num(radius, 20), 40 + Math.random() * 15, num(z) + (Math.random() - 0.5) * num(radius, 20), 1.5, 1.5, 1.5, hex, ['static']);
            if (name) b.name = name;
            b.userData.anchored = false; b.userData.velocityY = 0;
            world.dynamicObjects.push(b);
        }
    },
    explode(world, [name, radius, force, damage], ctx) {
        const targets = name ? findBlocks(world, name) : (ctx && ctx.target ? [ctx.target] : []);
        targets.forEach(b => {
            const c = new THREE.Box3().setFromObject(b).getCenter(new THREE.Vector3());
            if (hooks.explode) hooks.explode(c, num(radius, 14), num(force, 55), num(damage, 0));
        });
    },
    explodeat(world, [x, y, z, radius, force, damage]) {
        if (hooks.explode) hooks.explode(new THREE.Vector3(num(x), num(y), num(z)), num(radius, 14), num(force, 55), num(damage, 0));
    },
    sound(world, [name, vol]) { if (hooks.sfx) hooks.sfx(name || 'rocketExplode', vol !== undefined ? num(vol, 0.6) : undefined); },
    playsound(world, args) { WORLD_COMMANDS.sound(world, args); },

    // ---- environment
    sky(world, [col]) { if (hooks.setSky) hooks.setSky(world.constructor.parseColorArg(col)); },
    fog(world, [col, density]) {
        const scene = world.scene;
        if (!scene) return;
        scene.fog = new THREE.FogExp2(world.constructor.parseColorArg(col || 'gray'), num(density, 0.01));
    },
    // brightness? 0.15  -> 0 = pitch black night, 1 = full daylight (lights + skybox)
    brightness(world, [v]) { if (hooks.setBrightness) hooks.setBrightness(Math.min(1, Math.max(0, num(v, 0.5)))); },
    darkness(world, [v]) { if (hooks.setBrightness) hooks.setBrightness(1 - Math.min(1, Math.max(0, num(v, 0.8)))); },
    // night? [brightness] [fogColor] [fogDensity] - one-shot dark, foggy atmosphere
    night(world, [b, col, dens]) {
        if (hooks.setBrightness) hooks.setBrightness(Math.min(1, Math.max(0, num(b, 0.12))));
        if (world.scene) world.scene.fog = new THREE.FogExp2(world.constructor.parseColorArg(col || 'black'), num(dens, 0.03));
    },
    day(world) { if (hooks.setBrightness) hooks.setBrightness(0.75); if (world.scene) world.scene.fog = null; },
    nofog(world) { if (world.scene) world.scene.fog = null; },

    // ---- messages (everyone sees)
    message(world, args) { if (hooks.message) hooks.message(args.join(' ')); },
    announce(world, args) { if (hooks.banner) hooks.banner(args[0] || '', num(args[1], 3)); },
    banner(world, args) { if (hooks.banner) hooks.banner(args[0] || '', num(args[1], 3)); },
};

// Commands that only make sense for the local player (never broadcast).
// signature: (player, args, ctx)
export const PLAYER_COMMANDS = {
    kill(p) { p.fallApart(); },
    heal(p, [n]) { p.health = Math.min(p.maxHealth, p.health + num(n, 25)); },
    fullheal(p) { p.health = p.maxHealth; },
    damage(p, [n]) { p.takeDamage(num(n, 10)); },
    hurt(p, args) { PLAYER_COMMANDS.damage(p, args); },
    sethealth(p, [n]) { p.health = Math.min(p.maxHealth, Math.max(1, num(n, 100))); },
    maxhealth(p, [n]) { p.maxHealth = Math.max(1, num(n, 100)); p.health = Math.min(p.health, p.maxHealth); },
    shield(p, [secs]) {
        p.invulnerableUntil = Date.now() + num(secs, 5) * 1000;
        const orig = p.takeDamage.bind(p);
        if (!p._origTakeDamage) {
            p._origTakeDamage = orig;
            p.takeDamage = (a) => (Date.now() < (p.invulnerableUntil || 0) ? false : p._origTakeDamage(a));
        }
        p.chat('Shield on!');
    },

    // ---- movement
    speed(p, [v, secs]) {
        const base = p._baseSpeed ?? (p._baseSpeed = p.speed);
        p.speed = num(v, base);
        if (secs !== undefined) { clearTimeout(p._speedTimer); p._speedTimer = setTimeout(() => { p.speed = base; }, num(secs) * 1000); }
    },
    jump(p, [v, secs]) {
        const base = p._baseJump ?? (p._baseJump = p.jumpForce);
        p.jumpForce = num(v, base);
        if (secs !== undefined) { clearTimeout(p._jumpTimer); p._jumpTimer = setTimeout(() => { p.jumpForce = base; }, num(secs) * 1000); }
    },
    gravity(p, [v, secs]) {
        const base = p._baseGravity ?? (p._baseGravity = p.gravity);
        p.gravity = num(v, base);
        if (secs !== undefined) { clearTimeout(p._gravTimer); p._gravTimer = setTimeout(() => { p.gravity = base; }, num(secs) * 1000); }
    },
    resetstats(p) {
        if (p._baseSpeed !== undefined) p.speed = p._baseSpeed;
        if (p._baseJump !== undefined) p.jumpForce = p._baseJump;
        if (p._baseGravity !== undefined) p.gravity = p._baseGravity;
    },
    launch(p, [f]) { p.velocity.y = num(f, 60); p.onGround = false; },
    push(p, [x, y, z]) { p.velocity.x += num(x); p.velocity.y += num(y); p.velocity.z += num(z); p.onGround = false; },
    fling(p, [f]) {
        const a = Math.random() * Math.PI * 2, s = num(f, 60);
        p.velocity.set(Math.cos(a) * s, s * 0.6, Math.sin(a) * s); p.onGround = false;
    },
    freeze(p, [secs]) {
        const base = p._baseSpeed ?? (p._baseSpeed = p.speed);
        const baseJ = p._baseJump ?? (p._baseJump = p.jumpForce);
        p.speed = 0; p.jumpForce = 0;
        clearTimeout(p._freezeTimer);
        p._freezeTimer = setTimeout(() => { p.speed = base; p.jumpForce = baseJ; }, num(secs, 3) * 1000);
        p.chat('Frozen!');
    },
    stumble(p, [s]) { if (p.triggerStumble) p.triggerStumble(num(s, 1)); },

    // ---- teleport
    tpxyz(p, [x, y, z]) { p.teleport(new THREE.Vector3(num(x), num(y), num(z))); },
    tprandom(p, [r]) {
        const range = num(r, 30);
        p.teleport(new THREE.Vector3((Math.random() - 0.5) * range * 2, 30, (Math.random() - 0.5) * range * 2));
    },
    tpup(p, [h]) { p.teleport(p.mesh.position.clone().add(new THREE.Vector3(0, num(h, 30), 0))); },
    tpforward(p, [d]) {
        const dir = new THREE.Vector3(Math.sin(p.mesh.rotation.y), 0, Math.cos(p.mesh.rotation.y));
        p.teleport(p.mesh.position.clone().addScaledVector(dir, num(d, 20)));
    },
    // tpswap? <blockA> <blockB> - teleports to whichever of the two blocks is farther away
    tpswap(p, [a, b], ctx) {
        const A = findBlocks(ctx.world, a)[0], B = findBlocks(ctx.world, b)[0];
        if (!A || !B) return;
        const far = p.mesh.position.distanceTo(A.position) < p.mesh.position.distanceTo(B.position) ? B : A;
        const top = new THREE.Box3().setFromObject(far).max.y;
        p.teleport(new THREE.Vector3(far.position.x, top + 1.2, far.position.z));
    },
    respawn(p) { p.fallApart(); },
    spawnpoint(p, [x, y, z], ctx) {
        const pos = x !== undefined ? new THREE.Vector3(num(x), num(y, 5), num(z)) : p.mesh.position.clone();
        ctx.world.customSpawn = pos;
        p.chat('Checkpoint saved!');
    },

    // ---- chat / feedback
    say(p, args) { p.chat(args.join(' ')); },
    chat(p, args) { p.chat(args.join(' ')); },
    dance(p) { p.startDance(); },
    wave(p) { p.startWave(); },
    stopdance(p) { p.stopDance(); },
    shake(p, [s]) { p.triggerStumble(num(s, 1.5)); },

    // ---- tools & keys
    givetool(p, args) {
        const name = args.find(a => a.toLowerCase() !== 'player') || 'Tool';
        if (!p.tools) p.tools = [];
        if (!p.tools.includes(name)) p.tools.push(name);
        p.chat(`Received: ${name}`);
    },
    removetool(p, [name]) { if (p.tools) p.tools = p.tools.filter(t => t !== name); },
    // giveweapon? rocketlauncher|sword|nokia|buildtool  - equips it instantly
    giveweapon(p, [type]) { if (hooks.giveWeapon) hooks.giveWeapon((type || 'rocketlauncher').toLowerCase()); },
    removeweapon() { if (hooks.removeWeapon) hooks.removeWeapon(); },
    givekey(p, [id]) { if (hooks.giveKey) hooks.giveKey(id); p.chat(`Got key: ${id}`); },
    removekey(p, [id]) { if (hooks.removeKey) hooks.removeKey(id); },
    // haskey? <id> <command> <args...> - only runs the nested command if the player owns the key
    haskey(p, [id, cmd, ...rest], ctx) {
        if (!window.__nbloxHeldKeys || !window.__nbloxHeldKeys.has(id)) { p.chat(`You need the "${id}" key.`); return; }
        runCommand(cmd, rest, ctx);
    },
    // iftool? <tool> <command> <args...>
    iftool(p, [tool, cmd, ...rest], ctx) {
        if (!p.tools || !p.tools.includes(tool)) { p.chat(`You need the ${tool}.`); return; }
        runCommand(cmd, rest, ctx);
    },
    // ifhealth? <below|above> <n> <command> <args...>
    ifhealth(p, [mode, n, cmd, ...rest], ctx) {
        const ok = /^below$/i.test(mode) ? p.health < num(n) : p.health > num(n);
        if (ok) runCommand(cmd, rest, ctx);
    },
    // random? <command> <args...> - 50% chance wrapper (use chance=N modifier for other odds)
    random(p, [cmd, ...rest], ctx) { if (Math.random() < 0.5) runCommand(cmd, rest, ctx); },
    // delay? <seconds> <command> <args...>
    delay(p, [secs, cmd, ...rest], ctx) { setTimeout(() => runCommand(cmd, rest, ctx), num(secs, 1) * 1000); },
    // repeat? <times> <interval> <command> <args...>
    repeat(p, [times, interval, cmd, ...rest], ctx) {
        const n = Math.min(100, parseInt(times, 10) || 1);
        for (let i = 0; i < n; i++) setTimeout(() => runCommand(cmd, rest, ctx), i * num(interval, 1) * 1000);
    },
    // chain: several commands in one rule separated by "&&" are handled in the runner.
    open(p, [url]) { if (hooks.openUrl) hooks.openUrl(url); },
};

// Commands whose effect is purely a message/visual for everyone are in WORLD_COMMANDS and get
// broadcast; the names below are the ones the multiplayer layer should NOT re-broadcast because
// they're already deterministic on every client.
export const NO_BROADCAST = new Set(['message', 'announce', 'banner', 'sound', 'playsound']);

// ---------------------------------------------------------------- generic dispatch

// Runs a single command name against ctx = { world, player, target, remote, broadcast }.
// Returns true if the command was recognised.
export function runCommand(name, args, ctx) {
    const cmd = String(name || '').toLowerCase().replace(/\?$/, '');
    if (!cmd) return false;
    // "a && b" chaining is resolved by splitRule(); here we just dispatch.
    if (PLAYER_COMMANDS[cmd] && ctx.player) {
        PLAYER_COMMANDS[cmd](ctx.player, cleanArgs(args), ctx);
        return true;
    }
    if (WORLD_COMMANDS[cmd]) {
        WORLD_COMMANDS[cmd](ctx.world, cleanArgs(args), ctx);
        if (ctx.broadcast && !ctx.remote && hooks.broadcast) hooks.broadcast(cmd, cleanArgs(args));
        return true;
    }
    return false;
}

function cleanArgs(args) { return (args || []).filter(a => String(a).toLowerCase() !== 'player'); }

// Runs a full parsed rule (applies once/cooldown/chance modifiers and "&&" chains).
export function runRule(rule, ctx, ruleState) {
    const { args, mods } = extractModifiers(rule.args);
    const now = Date.now();
    if (mods.once && ruleState.fired) return false;
    if (mods.cooldown && now - (ruleState.lastFire || 0) < mods.cooldown * 1000) return false;
    if (mods.chance < 100 && Math.random() * 100 >= mods.chance) return false;
    ruleState.fired = true; ruleState.lastFire = now;

    // support chaining: "heal? 20 && say? Nice!" -> split args on "&&"
    const groups = [[]];
    args.forEach(a => { if (a === '&&') groups.push([]); else groups[groups.length - 1].push(a); });
    let handled = runCommand(rule.command, groups[0], ctx);
    for (let i = 1; i < groups.length; i++) {
        const [c, ...rest] = groups[i];
        if (c) handled = runCommand(c, rest, ctx) || handled;
    }
    if (!handled) console.warn(`Unknown script command "${rule.command}?" in rule: ${rule.raw}`);
    return handled;
}

// ---------------------------------------------------------------- TICK commands (animations)
// signature: (world, rule, t, tickCount) - t is the shared clock in seconds.
// Everything here is a pure function of the shared clock, so every client agrees.

function base(target, key, value) { if (target.userData[key] === undefined) target.userData[key] = value; return target.userData[key]; }

export const TICK_COMMANDS = {
    // spin? <block> [degreesPerSec] [axis x|y|z]
    spin(world, rule, t) {
        const [name, dps, axis] = rule.args;
        findBlocks(world, name).forEach(b => {
            const a = (axis || 'y').toLowerCase();
            const o = base(b, '_spinBase', { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z });
            b.rotation[a] = o[a] + THREE.MathUtils.degToRad(num(dps, 90)) * t;
        });
    },
    // bob? <block> [amplitude] [period]  - smooth up/down
    bob(world, rule, t) {
        const [name, amp, period] = rule.args;
        findBlocks(world, name).forEach(b => {
            const y0 = base(b, '_bobY', b.position.y);
            b.position.y = y0 + Math.sin((t / num(period, 2)) * Math.PI * 2) * num(amp, 2);
        });
    },
    // slide? <block> <x|y|z> [distance] [period] - back and forth along an axis
    slide(world, rule, t) {
        const [name, axis, dist, period] = rule.args;
        findBlocks(world, name).forEach(b => {
            const a = (axis || 'x').toLowerCase();
            const o = base(b, '_slideBase', { x: b.position.x, y: b.position.y, z: b.position.z });
            b.position[a] = o[a] + Math.sin((t / num(period, 4)) * Math.PI * 2) * num(dist, 8);
        });
    },
    // orbit? <block> <centerBlock> [radius] [period]
    orbit(world, rule, t) {
        const [name, center, radius, period] = rule.args;
        const c = findBlocks(world, center)[0];
        if (!c) return;
        findBlocks(world, name).forEach(b => {
            const ang = (t / num(period, 6)) * Math.PI * 2;
            b.position.x = c.position.x + Math.cos(ang) * num(radius, 10);
            b.position.z = c.position.z + Math.sin(ang) * num(radius, 10);
        });
    },
    // patrol? <block> <x> <z> [period] - ping-pong between its start and an offset
    patrol(world, rule, t) {
        const [name, dx, dz, period] = rule.args;
        findBlocks(world, name).forEach(b => {
            const o = base(b, '_patrolBase', { x: b.position.x, z: b.position.z });
            const k = (Math.sin((t / num(period, 6)) * Math.PI * 2) + 1) / 2;
            b.position.x = o.x + num(dx) * k; b.position.z = o.z + num(dz) * k;
        });
    },
    // pulse? <block> [amount] [period] - gently grows and shrinks
    pulse(world, rule, t) {
        const [name, amt, period] = rule.args;
        findBlocks(world, name).forEach(b => {
            const s0 = base(b, '_pulseScale', b.scale.clone());
            const k = 1 + Math.sin((t / num(period, 1.5)) * Math.PI * 2) * num(amt, 0.2);
            b.scale.copy(s0).multiplyScalar(k);
        });
    },
    // blink? <block> [period] - appears/disappears (also toggles collision)
    blink(world, rule, t) {
        const [name, period] = rule.args;
        const on = Math.floor(t / num(period, 1.4)) % 2 === 0;
        findBlocks(world, name).forEach(b => { b.visible = on; setCollide(world, b, on); });
    },
    // flicker? <block> - rapid unsynchronised-looking but deterministic opacity noise
    flicker(world, rule, t) {
        const [name] = rule.args;
        findBlocks(world, name).forEach(b => setOpacity(b, 0.4 + 0.6 * Math.abs(Math.sin(t * 17) * Math.sin(t * 5.3))));
    },
    // rainbow? <block> [period] - cycles hue
    rainbow(world, rule, t) {
        const [name, period] = rule.args;
        const col = new THREE.Color().setHSL((t / num(period, 4)) % 1, 0.9, 0.55);
        findBlocks(world, name).forEach(b => setColor(world, b, col.getHex()));
    },
    // fade? <block> [period] - smooth opacity pulse
    fade(world, rule, t) {
        const [name, period] = rule.args;
        findBlocks(world, name).forEach(b => setOpacity(b, 0.5 + 0.5 * Math.sin((t / num(period, 3)) * Math.PI * 2)));
    },
    // fall? <block> <maxSteps> [stepSize] - opposite of rise?, sinks then resets
    fall(world, rule, t, tick) {
        const [name, max, step] = rule.args;
        const m = Math.max(1, parseInt(max, 10) || 1);
        findBlocks(world, name).forEach(b => {
            const y0 = base(b, '_fallBaseY', b.position.y);
            b.position.y = y0 - (tick % (m + 1)) * (step !== undefined ? num(step, 1) : 1);
        });
    },
    // shake? <block> [amount] - jitters the block
    shake(world, rule, t) {
        const [name, amt] = rule.args;
        findBlocks(world, name).forEach(b => {
            const o = base(b, '_shakeBase', { x: b.position.x, z: b.position.z });
            b.position.x = o.x + Math.sin(t * 40) * num(amt, 0.15);
            b.position.z = o.z + Math.cos(t * 37) * num(amt, 0.15);
        });
    },
    // wobble? <block> [degrees] [period] - rocks side to side
    wobble(world, rule, t) {
        const [name, deg, period] = rule.args;
        findBlocks(world, name).forEach(b => {
            const o = base(b, '_wobbleBase', b.rotation.z);
            b.rotation.z = o + Math.sin((t / num(period, 2)) * Math.PI * 2) * THREE.MathUtils.degToRad(num(deg, 15));
        });
    },
    // door? <block> <x|y|z> <distance> [period] - opens and closes on a cycle (a trap door / gate)
    door(world, rule, t) {
        const [name, axis, dist, period] = rule.args;
        findBlocks(world, name).forEach(b => {
            const a = (axis || 'y').toLowerCase();
            const o = base(b, '_doorBase', { x: b.position.x, y: b.position.y, z: b.position.z });
            const open = Math.floor(t / num(period, 3)) % 2 === 1;
            b.position[a] = o[a] + (open ? num(dist, 5) : 0);
            setCollide(world, b, !open);
        });
    },
};

// Single-line documentation for the editor's help panel ("Run / Check" lists unknown commands).
export function allCommandNames() {
    return {
        player: Object.keys(PLAYER_COMMANDS),
        world: Object.keys(WORLD_COMMANDS),
        tick: Object.keys(TICK_COMMANDS),
    };
}
