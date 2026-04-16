/**
 * Three.js scene manager.
 * Handles renderer, camera, lights, orbit controls and material assignment.
 */

import * as THREE from 'three';
import { OrbitControls }    from 'three/examples/jsm/controls/OrbitControls.js';
import { FEATURE_COLORS } from '../geometry/buildMap.js';
import { MODEL_RADIUS_MM } from '../utils/helpers.js';

const BASE_THICKNESS_REF = 1.5;

export class SceneManager {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas       = canvas;
    this.renderer     = null;
    this.scene        = null;
    this.camera       = null;
    this.controls     = null;
    this.modelGroup   = null;
    this.wireframe    = false;
    this.materials    = {};
    this.wfMaterials  = {};
    this._animId      = null;
    this._resizeObs   = null;

    this._init();
  }

  _init() {
    const w = this.canvas.parentElement.clientWidth  || 800;
    const h = this.canvas.parentElement.clientHeight || 600;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas:    this.canvas,
      antialias: true,
      alpha:     false,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x87CEEB);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 5000);
    this.camera.position.set(0, MODEL_RADIUS_MM * 3.2, MODEL_RADIUS_MM * 1.4);
    this.camera.lookAt(0, 0, 0);

    // Orbit controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping  = true;
    this.controls.dampingFactor  = 0.08;
    this.controls.minDistance    = 10;
    this.controls.maxDistance    = 2000;
    this.controls.maxPolarAngle  = Math.PI / 2 + 0.05;
    this.controls.target.set(0, BASE_THICKNESS_REF / 2, 0);

    // Lighting — outdoor daylight setup for gray buildings against blue sky
    const hemi = new THREE.HemisphereLight(0x8ecaff, 0xd4c5a0, 0.7);
    this.scene.add(hemi);

    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(ambient);

    // Main sun light — bright white from top-right
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(80, 250, 120);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far  = 1000;
    key.shadow.camera.left = key.shadow.camera.bottom = -MODEL_RADIUS_MM * 2;
    key.shadow.camera.right = key.shadow.camera.top   =  MODEL_RADIUS_MM * 2;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 6; // softer shadow edges
    this.scene.add(key);

    // Cool fill from opposite side
    const fill = new THREE.DirectionalLight(0xc8dcff, 0.5);
    fill.position.set(-60, 60, -100);
    this.scene.add(fill);

    // Rim light from behind for edge definition
    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(0, 40, -150);
    this.scene.add(rim);

    // Ground plane — light neutral to match sky
    const groundGeo = new THREE.PlaneGeometry(MODEL_RADIUS_MM * 8, MODEL_RADIUS_MM * 8);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x7a9aad,
      roughness: 0.95,
      metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Materials
    this._buildMaterials();

    // Resize observer
    this._resizeObs = new ResizeObserver(() => this._onResize());
    this._resizeObs.observe(this.canvas.parentElement);

    // Start render loop
    this._animate();
  }

  _buildMaterials() {
    const cfg = {
      base:      { roughness: 0.55, metalness: 0.0 },
      terrain:   { roughness: 0.55, metalness: 0.0 },
      building:  { roughness: 0.35, metalness: 0.08 },
      water:     { roughness: 0.15, metalness: 0.15 },
      park:      { roughness: 0.7, metalness: 0.0 },
      road:      { roughness: 0.75, metalness: 0.0 },
      path:      { roughness: 0.75, metalness: 0.0 },
      // Debug tier colors
      landmark:  { roughness: 0.3, metalness: 0.1 },
      tallTower: { roughness: 0.3, metalness: 0.1 },
    };

    // Polygon offset per type — higher = pushed further back.
    // Roads/paths on top, then parks, then base/terrain furthest back.
    const polyOff = {
      road: -4, path: -3, park: -2, water: -1,
      building: 0, terrain: 1, base: 2,
    };

    for (const [type, color] of Object.entries(FEATURE_COLORS)) {
      const matCfg = cfg[type] ?? { roughness: 0.5, metalness: 0 };
      const off = polyOff[type] ?? 0;
      this.materials[type] = new THREE.MeshStandardMaterial({
        color,
        roughness:  matCfg.roughness,
        metalness:  matCfg.metalness,
        polygonOffset:       true,
        polygonOffsetFactor: off,
        polygonOffsetUnits:  off,
        side: THREE.FrontSide,
      });

      this.wfMaterials[type] = new THREE.MeshBasicMaterial({
        color,
        wireframe:   true,
        opacity:     0.6,
        transparent: true,
      });
    }
  }

  /** Rebuild materials from current FEATURE_COLORS (call after setInvertedColors). */
  rebuildMaterials() {
    // Dispose old materials
    for (const m of Object.values(this.materials))   m.dispose();
    for (const m of Object.values(this.wfMaterials)) m.dispose();
    this.materials   = {};
    this.wfMaterials = {};
    this._buildMaterials();
  }

  /** The current model group (used by exporters for per-type geometry). */
  get group() { return this.modelGroup; }

  /** Replace the current model with a new THREE.Group. */
  setModel(group) {
    if (this.modelGroup) {
      this.scene.remove(this.modelGroup);
      disposeGroup(this.modelGroup);
    }

    this.modelGroup = group;
    this._applyMaterials(group);
    this.scene.add(group);

    // Auto-fit camera
    const box    = new THREE.Box3().setFromObject(group);
    const centre = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxD   = Math.max(size.x, size.y, size.z);

    this.controls.target.copy(centre);
    this.camera.position.set(
      centre.x,
      centre.y + maxD * 2.0,
      centre.z + maxD * 0.7,
    );
    this.controls.update();
  }

  /** Toggle wireframe display, returns new wireframe state. */
  toggleWireframe() {
    this.wireframe = !this.wireframe;
    if (this.modelGroup) this._applyMaterials(this.modelGroup);
    return this.wireframe;
  }

  /** Reset camera to the default overview position. */
  resetCamera() {
    if (this.modelGroup) {
      const box    = new THREE.Box3().setFromObject(this.modelGroup);
      const centre = box.getCenter(new THREE.Vector3());
      const size   = box.getSize(new THREE.Vector3());
      const maxD   = Math.max(size.x, size.y, size.z);
      this.controls.target.copy(centre);
      this.camera.position.set(
        centre.x,
        centre.y + maxD * 2.0,
        centre.z + maxD * 0.7,
      );
    } else {
      this.camera.position.set(0, MODEL_RADIUS_MM * 3.2, MODEL_RADIUS_MM * 1.4);
      this.controls.target.set(0, 0, 0);
    }
    this.controls.update();
  }

  /**
   * Merge all geometries in the current model into one BufferGeometry
   * (used for STL/3MF export).
   */
  getMergedGeometry() {
    if (!this.modelGroup) return null;

    const geos = [];
    this.modelGroup.updateMatrixWorld(true);

    this.modelGroup.traverse(obj => {
      if (!obj.isMesh || !obj.geometry) return;
      const g = obj.geometry.clone();
      g.applyMatrix4(obj.matrixWorld);
      geos.push(g);
    });

    if (geos.length === 0) return null;
    return mergeBufferGeometries(geos);
  }

  _applyMaterials(group) {
    const matLib = this.wireframe ? this.wfMaterials : this.materials;
    group.traverse(obj => {
      if (!obj.isMesh) return;
      const type = obj.userData.featureType || 'base';
      obj.material      = matLib[type] ?? matLib.base;
      obj.castShadow    = (type === 'building' || type === 'landmark' || type === 'tallTower');
      obj.receiveShadow = (type === 'terrain' || type === 'base');

    });
  }

  _animate() {
    this._animId = requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    const w = this.canvas.parentElement.clientWidth;
    const h = this.canvas.parentElement.clientHeight;
    if (w < 1 || h < 1) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  destroy() {
    cancelAnimationFrame(this._animId);
    this._resizeObs?.disconnect();
    this.renderer.dispose();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

function mergeBufferGeometries(geos) {
  let totalVerts   = 0;
  let totalIndices = 0;

  for (const g of geos) {
    totalVerts   += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : 0;
  }

  const positions = new Float32Array(totalVerts   * 3);
  const indices   = new Uint32Array(totalIndices);
  const normals   = new Float32Array(totalVerts   * 3);

  let vOff = 0, iOff = 0;

  for (const g of geos) {
    const pos = g.attributes.position.array;
    positions.set(pos, vOff * 3);

    if (g.attributes.normal) {
      normals.set(g.attributes.normal.array, vOff * 3);
    }

    if (g.index) {
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i++) {
        indices[iOff + i] = idx[i] + vOff;
      }
      iOff += idx.length;
    }

    vOff += g.attributes.position.count;
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeVertexNormals();

  return merged;
}
