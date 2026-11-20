// Interactive player for the G1 stair-climbing clips.
// World frame follows the simulator: z up, x along the stairs; quaternions are stored w, x, y, z.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const LABEL = { success: '成功', failure: '失败' };
const ROBOT_COLORS = { trunk: 0xc3ccd4, head: 0x39444e, leg: 0x8494a5, arm: 0xa7b3be, foot: 0x39444e };

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const state = {
  manifest: null,
  clips: [],
  clip: null,
  poses: null,
  cache: new Map(),
  t: 0,
  playing: true,
  speed: 1,
  follow: false,
  loop: true,
  endHold: 0,
};
window.__viz = state;

let renderer = null, scene, camera, controls, floorMat, stairMat;
const bodies = [];
const lastPelvis = new THREE.Vector3();
const tmpQ0 = new THREE.Quaternion();
const tmpQ1 = new THREE.Quaternion();

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

function initScene() {
  const canvas = $('view3d');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 16 / 10, 0.05, 80);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.8;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.495;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a0, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-1.5, -4.0, 6.0);
  sun.target.position.set(0.8, 0, 0.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -4; sc.right = 4; sc.top = 4; sc.bottom = -4; sc.near = 0.5; sc.far = 16;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  floorMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), floorMat);
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(40, 80, 0x7d8a96, 0x7d8a96);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = 0.001;
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  scene.add(grid);

  new ResizeObserver(resize).observe($('canvasBox'));
  resize();
}

function applyTheme() {
  scene.background = new THREE.Color(cssVar('--scene-bg'));
  floorMat.color.set(cssVar('--scene-floor'));
  if (stairMat) stairMat.color.set(cssVar('--scene-stair'));
}

function resize() {
  const box = $('canvasBox');
  const w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function buildStairs(st) {
  stairMat = new THREE.MeshStandardMaterial({ color: cssVar('--scene-stair'), roughness: 0.85 });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1c2630, transparent: true, opacity: 0.35 });
  for (let i = 1; i <= st.n_steps; i++) {
    const lo = (i - 1) * st.run;
    const hi = i < st.n_steps ? i * st.run : lo + st.top_length;
    const z = i * st.rise;
    const geo = new THREE.BoxGeometry(hi - lo, st.width, z);
    const mesh = new THREE.Mesh(geo, stairMat);
    mesh.position.set(0.5 * (lo + hi), 0, 0.5 * z);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    edges.position.copy(mesh.position);
    scene.add(edges);
  }
}

function buildRobot(manifest) {
  const mats = {};
  for (const [k, c] of Object.entries(ROBOT_COLORS)) {
    mats[k] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.1 });
  }
  for (let b = 0; b < manifest.nbody; b++) {
    const g = new THREE.Group();
    bodies.push(g);
    scene.add(g);
  }
  for (const geom of manifest.geoms) {
    let geo;
    if (geom.type === 'capsule') {
      // The simulator's capsule runs along local z with size = (radius, half length).
      geo = new THREE.CapsuleGeometry(geom.size[0], 2 * geom.size[1], 6, 16);
      geo.rotateX(Math.PI / 2);
    } else if (geom.type === 'sphere') {
      geo = new THREE.SphereGeometry(geom.size[0], 24, 16);
    } else if (geom.type === 'box') {
      geo = new THREE.BoxGeometry(2 * geom.size[0], 2 * geom.size[1], 2 * geom.size[2]);
    } else {
      continue;
    }
    const mesh = new THREE.Mesh(geo, mats[geom.group] || mats.trunk);
    mesh.position.fromArray(geom.pos);
    mesh.quaternion.set(geom.quat[1], geom.quat[2], geom.quat[3], geom.quat[0]);
    mesh.castShadow = true;
    bodies[geom.body].add(mesh);
  }
  // A thin plate under each foot so the sole reads as one surface (the sole is seven thin capsules).
  manifest.body_names.forEach((name, b) => {
    if (!name.endsWith('ankle_roll_link')) return;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.074, 0.02), mats.foot);
    plate.position.set(0.039, 0, -0.025);
    plate.castShadow = true;
    bodies[b].add(plate);
  });
}

function applyPose(t) {
  const { poses, clip, manifest } = state;
  if (!poses || !renderer) return;
  const nb = manifest.nbody;
  const f = Math.min(Math.max(t * manifest.fps, 0), clip.frames - 1);
  const i0 = Math.floor(f), i1 = Math.min(i0 + 1, clip.frames - 1), a = f - i0;
  for (let b = 0; b < nb; b++) {
    const o0 = (i0 * nb + b) * 7, o1 = (i1 * nb + b) * 7;
    const g = bodies[b];
    g.position.set(
      poses[o0] + (poses[o1] - poses[o0]) * a,
      poses[o0 + 1] + (poses[o1 + 1] - poses[o0 + 1]) * a,
      poses[o0 + 2] + (poses[o1 + 2] - poses[o0 + 2]) * a,
    );
    tmpQ0.set(poses[o0 + 4], poses[o0 + 5], poses[o0 + 6], poses[o0 + 3]);
    tmpQ1.set(poses[o1 + 4], poses[o1 + 5], poses[o1 + 6], poses[o1 + 3]);
    g.quaternion.copy(tmpQ0).slerp(tmpQ1, a);
  }
}

function resetView() {
  if (!renderer) return;
  const p = bodies[0].position;
  controls.target.set(0.75, p.y, 0.62);
  camera.position.set(-1.9, p.y - 3.9, 1.95);
  controls.update();
  lastPelvis.copy(p);
}

// ---------------------------------------------------------------------------
// Clips and UI
// ---------------------------------------------------------------------------

function tagHtml(c) {
  return '<span class="tag ' + c.label + '">' + LABEL[c.label] + ' ' + c.n + '</span>';
}

function buildCards() {
  const host = $('groups');
  for (const group of state.manifest.groups) {
    const row = document.createElement('section');
    row.className = 'group';
    row.setAttribute('aria-label', group.version);
    const ver = document.createElement('span');
    ver.className = 'ver';
    ver.textContent = group.version;
    const list = document.createElement('div');
    list.className = 'clips';
    for (const c of group.clips) {
      const clip = { ...c, version: group.version, key: group.version + '/' + c.id };
      const index = state.clips.push(clip) - 1;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'clip';
      btn.id = 'card-' + group.version + '-' + c.id;
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-selected', 'false');
      btn.setAttribute('aria-label', group.version + ' ' + LABEL[c.label] + ' ' + c.n);
      btn.innerHTML = '<img alt="" loading="lazy" src="' + c.thumb + '">' + tagHtml(c);
      btn.addEventListener('click', () => selectClip(index));
      list.appendChild(btn);
    }
    row.append(ver, list);
    host.appendChild(row);
  }
}

async function loadPoses(c) {
  if (state.cache.has(c.key)) return state.cache.get(c.key);
  const res = await fetch(c.bin);
  if (!res.ok) throw new Error('fetch ' + c.bin + ' ' + res.status);
  const arr = new Float32Array(await res.arrayBuffer());
  if (arr.length !== c.frames * state.manifest.nbody * 7) throw new Error('size ' + c.bin);
  state.cache.set(c.key, arr);
  return arr;
}

function setPlaying(on) {
  state.playing = on;
  $('btnPlay').classList.toggle('paused', !on);
}

async function selectClip(i) {
  const c = state.clips[i];
  document.querySelectorAll('.clip').forEach((el, k) => {
    el.setAttribute('aria-selected', String(k === i));
    el.setAttribute('aria-pressed', String(k === i));
  });
  const spinner = $('loading');
  spinner.hidden = false;
  spinner.classList.remove('error');
  const video = $('video');
  video.poster = c.thumb;
  video.src = c.video;
  $('chip').innerHTML = c.version + ' ' + tagHtml(c);
  try {
    const poses = await loadPoses(c);
    state.clip = c;
    state.poses = poses;
  } catch (err) {
    console.error(err);
    spinner.classList.add('error');
    return;
  }
  spinner.hidden = true;
  state.t = 0;
  state.endHold = 0;
  setPlaying(true);
  $('scrub').max = String(c.frames - 1);
  applyPose(0);
  resetView();
}

function seek(t) {
  state.t = Math.min(Math.max(t, 0), state.clip.duration);
  state.endHold = 0;
}

function bindUi() {
  $('btnPlay').addEventListener('click', () => {
    if (!state.clip) return;
    if (!state.playing && state.t >= state.clip.duration - 1e-3) state.t = 0;
    setPlaying(!state.playing);
  });
  $('scrub').addEventListener('input', (e) => { if (state.clip) seek(Number(e.target.value) / state.manifest.fps); });
  $('speed').addEventListener('change', (e) => { state.speed = Number(e.target.value); });
  $('btnFollow').addEventListener('click', (e) => {
    state.follow = !state.follow;
    e.currentTarget.setAttribute('aria-pressed', String(state.follow));
    if (renderer) lastPelvis.copy(bodies[0].position);
  });
  $('btnLoop').addEventListener('click', (e) => {
    state.loop = !state.loop;
    e.currentTarget.setAttribute('aria-pressed', String(state.loop));
  });
  $('btnReset').addEventListener('click', resetView);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || ['INPUT', 'SELECT', 'BUTTON', 'VIDEO'].includes(e.target.tagName)) return;
    e.preventDefault();
    $('btnPlay').click();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (renderer) applyTheme(); });
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  const c = state.clip;
  if (c && state.poses) {
    if (state.playing) {
      state.t += dt * state.speed;
      if (state.t >= c.duration) {
        state.t = c.duration;
        state.endHold += dt;
        if (!state.loop) {
          setPlaying(false);
        } else if (state.endHold > 1.2) {
          state.t = 0;
          state.endHold = 0;
        }
      }
    }
    applyPose(state.t);
    const p = bodies[0].position;
    if (state.follow) {
      const dx = p.x - lastPelvis.x, dy = p.y - lastPelvis.y, dz = p.z - lastPelvis.z;
      controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
      camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
    }
    lastPelvis.copy(p);
    $('scrub').value = String(Math.round(state.t * state.manifest.fps));
    $('timeOut').textContent = state.t.toFixed(1) + ' / ' + c.duration.toFixed(1);
  }
  controls.update();
  renderer.render(scene, camera);
}

async function main() {
  const res = await fetch('data/manifest.json');
  state.manifest = await res.json();
  buildCards();
  bindUi();
  try {
    initScene();
    buildStairs(state.manifest.stairs);
    buildRobot(state.manifest);
    applyTheme();
  } catch (err) {
    // No WebGL: the cards still switch the rendered video.
    console.error(err);
    renderer = null;
  }
  await selectClip(0);
  if (renderer) {
    tick();
  } else {
    $('loading').hidden = false;
    $('loading').classList.add('error');
  }
}

main().catch((err) => {
  console.error(err);
  $('loading').hidden = false;
  $('loading').classList.add('error');
});
