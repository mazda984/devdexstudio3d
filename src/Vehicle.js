import * as THREE from 'three';
import { boxUnwrapUVs, surfaceManager } from './utils.js';

export class Vehicle {
    constructor(scene, x, y, z, color = 0xff0000, explodeOnCrash = true) {
        this.scene = scene;
        this.color = color;
        // Whether hitting something at speed breaks the car apart into pieces.
        // Toggle exposed in the Toolbox UI (see main.js tb-redcar/tb-bluecar handlers).
        this.explodeOnCrash = explodeOnCrash;
        this.destroyed = false; // true once it has crashed and broken apart
        this.dead = false; // true once debris has settled/faded - World removes it then
        this.debris = [];
        this.mesh = new THREE.Group();
        this.mesh.position.set(x, y, z);
        this.mesh.userData = { type: 'vehicle', parent: this };

        // Car Body
        const bodyGeo = new THREE.BoxGeometry(4.5, 2, 8);
        boxUnwrapUVs(bodyGeo);
        const bodyMat = new THREE.MeshStandardMaterial({ 
            map: surfaceManager.textures.studs, 
            color: color,
            roughness: 0.2
        });
        this.body = new THREE.Mesh(bodyGeo, bodyMat);
        this.body.position.y = 1.25;
        this.body.castShadow = true;
        this.mesh.add(this.body);

        // Windshield
        const glassGeo = new THREE.BoxGeometry(4, 1.5, 3);
        const glassMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.6 });
        this.glass = new THREE.Mesh(glassGeo, glassMat);
        this.glass.position.set(0, 2.5, 0.5);
        this.mesh.add(this.glass);

        // Wheels
        const wGeo = new THREE.CylinderGeometry(1, 1, 1, 16);
        wGeo.rotateZ(Math.PI / 2);
        const wMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });

        const wheels = [
            [-2.25, 1, -2.5], [2.25, 1, -2.5],
            [-2.25, 1, 2.5], [2.25, 1, 2.5]
        ];
        
        this.wheels = [];
        wheels.forEach(pos => {
            const w = new THREE.Mesh(wGeo, wMat);
            w.position.set(...pos);
            this.mesh.add(w);
            this.wheels.push(w);
        });

        // Physics State
        this.velocity = 0;
        this.steering = 0;
        this.verticalVel = 0;
        this.driver = null;
        
        // Raycaster for ground
        this.raycaster = new THREE.Raycaster();
        this.down = new THREE.Vector3(0, -1, 0);
        // Raycaster for forward crash detection
        this.frontRay = new THREE.Raycaster();

        this.scene.add(this.mesh);
    }

    update(dt, collidables) {
        if (this.destroyed) {
            this.updateDebris(dt, collidables);
            return;
        }

        // Apply Drag
        this.velocity *= 0.98;
        this.steering *= 0.9;

        // Gravity
        this.verticalVel -= 50 * dt;

        // Forward Collision (crash detection) - cast a ray from the front bumper in the
        // direction of travel; if something solid is close and we're moving fast, crash.
        // Local +Z is "front" here (that's the side the windshield/glass sits on - see
        // constructor), so pressing W drives toward local +Z, matching the windshield.
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);
        const travelDir = fwd.clone().multiplyScalar(Math.sign(this.velocity) || 1);
        if (Math.abs(this.velocity) > 12 && collidables && collidables.length) {
            const bumperOffset = 4 * Math.sign(this.velocity || 1);
            const origin = this.mesh.position.clone()
                .addScaledVector(fwd, bumperOffset)
                .add(new THREE.Vector3(0, 1, 0));
            this.frontRay.set(origin, travelDir);
            const hits = this.frontRay.intersectObjects(collidables);
            const stopDist = Math.abs(this.velocity) * dt + 0.75;
            if (hits.length > 0 && hits[0].distance < stopDist) {
                this.crash();
                return;
            }
        }

        // Movement
        this.mesh.position.addScaledVector(fwd, this.velocity * dt);
        this.mesh.position.y += this.verticalVel * dt;

        // Rotation (Only when moving)
        if (Math.abs(this.velocity) > 1) {
            const turnAmt = this.steering * dt * (this.velocity > 0 ? 1 : -1);
            this.mesh.rotateY(turnAmt);
        }

        // Wheel Animation
        this.wheels.forEach(w => {
            w.rotateX(-this.velocity * dt * 0.5);
        });

        // Ground Collision
        this.raycaster.set(new THREE.Vector3(this.mesh.position.x, this.mesh.position.y + 2, this.mesh.position.z), this.down);
        const hits = this.raycaster.intersectObjects(collidables);
        
        if (hits.length > 0) {
            const dist = hits[0].distance;
            // 2 unit offset for ray origin
            const groundH = this.mesh.position.y + 2 - dist;
            
            if (groundH >= this.mesh.position.y - 0.2) {
                this.mesh.position.y = groundH;
                this.verticalVel = 0;
                // Add slope handling for ramp?
                // Simple tilt based on normal
                // const normal = hits[0].face.normal;
                // const targetQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), normal);
                // this.mesh.quaternion.slerp(targetQ, dt * 5); 
            }
        }

        if (this.mesh.position.y < -100) {
            this.mesh.position.set(1000, 5, 0);
            this.velocity = 0;
            this.verticalVel = 0;
        }
    }

    drive(input, dt) {
        if (this.destroyed) return;
        const accel = 40;
        const maxSpeed = 60;
        
        if (input.w) this.velocity += accel * dt;
        if (input.s) this.velocity -= accel * dt;
        
        this.velocity = Math.max(-maxSpeed/2, Math.min(maxSpeed, this.velocity));

        if (input.a) this.steering = 2;
        else if (input.d) this.steering = -2;
        else this.steering = 0;
    }

    // Breaks the car apart into flying debris chunks. If explodeOnCrash is off, the car
    // just stops dead against whatever it hit instead of shattering.
    crash() {
        if (this.destroyed) return;

        if (!this.explodeOnCrash) {
            // Just a hard stop - bounce back a little so it doesn't clip into the wall.
            this.velocity *= -0.15;
            return;
        }

        this.destroyed = true;
        const impactSpeed = Math.abs(this.velocity);
        this.velocity = 0;
        this.verticalVel = 0;

        // Eject the driver, if any, so they don't get stuck inside the wreck.
        if (this.driver) {
            const d = this.driver;
            d.vehicle = null;
            d.velocity.set((Math.random() - 0.5) * 12, 14, (Math.random() - 0.5) * 12);
            d.position.y += 1.5;
            this.driver = null;
        }

        // Hide the intact car, spawn fragment chunks in its place.
        const origin = this.mesh.position.clone();
        const rot = this.mesh.rotation.y;
        this.body.visible = false;
        this.glass.visible = false;
        this.wheels.forEach(w => w.visible = false);

        const fragGeo = new THREE.BoxGeometry(1.1, 1.1, 1.1);
        const pieceCount = 10;
        for (let i = 0; i < pieceCount; i++) {
            const mat = new THREE.MeshStandardMaterial({
                map: surfaceManager.textures.studs,
                color: i % 3 === 0 ? this.color : 0x222222,
                roughness: 0.4
            });
            const piece = new THREE.Mesh(fragGeo, mat);
            piece.castShadow = true;
            piece.position.copy(origin).add(new THREE.Vector3(
                (Math.random() - 0.5) * 3,
                1 + Math.random() * 1.5,
                (Math.random() - 0.5) * 5
            ));
            piece.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            this.scene.add(piece);

            const speed = 6 + Math.random() * 10 + impactSpeed * 0.3;
            const angle = rot + (Math.random() - 0.5) * Math.PI;
            piece.userData.velocity = new THREE.Vector3(
                Math.sin(angle) * speed,
                8 + Math.random() * 10,
                Math.cos(angle) * speed
            );
            piece.userData.spin = new THREE.Vector3(
                (Math.random() - 0.5) * 6,
                (Math.random() - 0.5) * 6,
                (Math.random() - 0.5) * 6
            );
            this.debris.push(piece);
        }

        this._debrisLife = 0;
    }

    // Simple standalone physics for the wreckage pieces: gravity, a ground bounce/settle,
    // then fade out and remove after a few seconds so wrecks don't pile up forever.
    updateDebris(dt, collidables) {
        this._debrisLife += dt;

        this.debris.forEach(piece => {
            piece.userData.velocity.y -= 40 * dt;
            piece.position.addScaledVector(piece.userData.velocity, dt);
            piece.rotation.x += piece.userData.spin.x * dt;
            piece.rotation.y += piece.userData.spin.y * dt;
            piece.rotation.z += piece.userData.spin.z * dt;

            this.raycaster.set(piece.position.clone().add(new THREE.Vector3(0, 0.5, 0)), this.down);
            const hits = collidables && collidables.length ? this.raycaster.intersectObjects(collidables) : [];
            if (hits.length > 0 && hits[0].distance < 1) {
                piece.position.y = piece.position.y + (1 - hits[0].distance);
                piece.userData.velocity.y = Math.abs(piece.userData.velocity.y) * 0.3;
                piece.userData.velocity.x *= 0.8;
                piece.userData.velocity.z *= 0.8;
                piece.userData.spin.multiplyScalar(0.8);
            }
        });

        if (this._debrisLife > 6) {
            const fadeT = Math.min(1, (this._debrisLife - 6) / 1.5);
            this.debris.forEach(piece => {
                piece.material.transparent = true;
                piece.material.opacity = 1 - fadeT;
            });
            if (fadeT >= 1) {
                this.dispose();
                this.dead = true;
            }
        }
    }

    // Removes every mesh this vehicle owns (intact car + any debris) from the scene.
    dispose() {
        this.scene.remove(this.mesh);
        this.debris.forEach(piece => {
            this.scene.remove(piece);
            piece.geometry.dispose();
            piece.material.dispose();
        });
        this.debris = [];
    }
}