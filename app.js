// Lecteur 360 : accueil, vidéo sur une sphère (Three.js), gyroscope, glisser au doigt ou à la souris, mode casque.
// Aucune donnée n'est envoyée nulle part : pas de suivi, pas de cookie, Three.js est servi par le site lui-même.
import * as THREE from './lib/three.module.min.js';
import Hls from './lib/hls.light.min.mjs';

const $ = (id) => document.getElementById(id);
const estTactile = matchMedia('(pointer: coarse)').matches;
const AXE_Z = new THREE.Vector3(0, 0, 1);
const AXE_Y = new THREE.Vector3(0, 1, 0);
const REDRESSE = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);   // caméra : regarde derrière l'écran, pas vers le haut

let videos = [];
let choisie = null;
let sonActif = false;
let scene, camera, renderer, video, texture;
let lacet = 0, tangage = 0;                  // regard au doigt ou à la souris (radians)
let gyro = null;                             // dernière mesure du téléphone { alpha, beta, gamma }
let gyroActif = false, decalageLacet = null;
let attenteGyro = null;
let casque = false;
let hls = null;
let minuterieBarre = null;

// ---------- Accueil ----------

async function chargerListe() {
  try {
    const r = await fetch('videos/videos.json', { cache: 'no-cache' });
    videos = (await r.json()).videos;
  } catch {
    videos = [];
  }
  if (!videos.length) {
    $('description').textContent = 'Aucune vidéo disponible pour le moment.';
    return;
  }
  if (videos.length > 1) {
    const liste = $('choix');
    liste.hidden = false;
    for (const v of videos) {
      const b = document.createElement('button');
      b.textContent = `${v.titre} (${formatTemps(v.duree_s)})`;
      b.dataset.id = v.id;
      b.addEventListener('click', () => choisir(v));
      const li = document.createElement('li');
      li.append(b);
      liste.append(li);
    }
  }
  choisir(videos[0]);
  $('lecture').disabled = false;
}

function choisir(v) {
  choisie = v;
  $('titre-video').textContent = v.titre;
  $('description').textContent = v.description;
  $('fond').src = v.poster;
  for (const b of $('choix').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.id === v.id));
  const lien = $('lien-youtube');
  lien.hidden = !v.youtube;
  if (v.youtube) lien.href = v.youtube;
}

function afficherSon() {
  for (const b of [$('son-accueil'), $('son')]) {
    b.textContent = sonActif ? 'Son activé' : 'Son coupé';
    b.setAttribute('aria-pressed', String(sonActif));
  }
  if (video) video.muted = !sonActif;
}

// ---------- Scène 3D ----------

function preparerScene() {
  if (renderer) return true;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: $('vue'), antialias: false });
  } catch {
    renderer = null;
    return false;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  video = document.createElement('video');
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.muted = true;
  brancherVideo();

  texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  scene = new THREE.Scene();
  const sphere = new THREE.SphereGeometry(10, 96, 64);
  sphere.scale(-1, 1, 1);                    // on regarde la sphère de l'intérieur, sans image miroir
  const globe = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ map: texture }));
  globe.rotation.y = -Math.PI / 2;           // centre de l'image (le nez du planeur) droit devant au départ
  scene.add(globe);

  camera = new THREE.PerspectiveCamera(80, 1, 0.1, 100);
  camera.rotation.order = 'YXZ';
  addEventListener('resize', ajusterTaille);
  brancherGlisser();
  return true;
}

function ajusterTaille() {
  renderer.setSize(innerWidth, innerHeight, false);
  // écran en hauteur : champ vertical plus grand, sinon on voit le monde par une fente
  camera.fov = innerHeight > innerWidth ? 95 : 72;
  camera.updateProjectionMatrix();
}

function regard() {
  if (gyroActif && gyro) {
    const ecran = THREE.MathUtils.degToRad(screen.orientation?.angle ?? window.orientation ?? 0);
    const d = THREE.MathUtils.degToRad;
    const e = new THREE.Euler(d(gyro.beta), d(gyro.alpha), -d(gyro.gamma), 'YXZ');
    const q = new THREE.Quaternion().setFromEuler(e).multiply(REDRESSE)
      .multiply(new THREE.Quaternion().setFromAxisAngle(AXE_Z, -ecran));
    if (decalageLacet === null) decalageLacet = lacet - capDe(q);     // on garde la direction regardée à l'activation
    camera.quaternion.setFromAxisAngle(AXE_Y, decalageLacet).multiply(q);
  } else {
    camera.quaternion.setFromEuler(new THREE.Euler(tangage, lacet, 0, 'YXZ'));
  }
}

function capDe(q) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-f.x, -f.z);
}

function rendre() {
  regard();
  const L = innerWidth, H = innerHeight;
  if (casque) {
    const m = L / 2;
    camera.aspect = m / H;
    camera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    for (const x of [0, m]) {                // même image pour les deux yeux : la vidéo n'est pas stéréoscopique
      renderer.setViewport(x, 0, m, H);
      renderer.setScissor(x, 0, m, H);
      renderer.render(scene, camera);
    }
  } else {
    camera.aspect = L / H;
    camera.updateProjectionMatrix();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, L, H);
    renderer.render(scene, camera);
  }
}

// ---------- Glisser au doigt ou à la souris ----------

function brancherGlisser() {
  const vue = $('vue');
  let appui = null;
  vue.addEventListener('pointerdown', (e) => {
    appui = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now() };
    vue.setPointerCapture(e.pointerId);
  });
  vue.addEventListener('pointermove', (e) => {
    if (!appui) return;
    const k = THREE.MathUtils.degToRad(camera.fov) / innerHeight;
    const dx = (e.clientX - appui.x) * k, dy = (e.clientY - appui.y) * k;
    appui.x = e.clientX;
    appui.y = e.clientY;
    if (gyroActif && gyro && decalageLacet !== null) {
      decalageLacet += dx;                   // le téléphone garde la main sur le haut et le bas
    } else {
      lacet += dx;
      tangage = THREE.MathUtils.clamp(tangage + dy, -1.5, 1.5);
    }
  });
  const relache = (e) => {
    if (!appui) return;
    const bref = Math.hypot(e.clientX - appui.x0, e.clientY - appui.y0) < 8 && performance.now() - appui.t < 350;
    appui = null;
    if (bref) basculerBarre();
  };
  vue.addEventListener('pointerup', relache);
  vue.addEventListener('pointercancel', () => { appui = null; });
}

// ---------- Gyroscope ----------

function surOrientation(e) {
  if (e.alpha === null || e.beta === null || e.gamma === null) return;
  gyro = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
  if (attenteGyro) {
    clearTimeout(attenteGyro);
    attenteGyro = null;
    gyroActif = true;
    afficherMouvement();
  }
}

// iOS n'accorde le gyroscope qu'en réponse directe à un appui : à appeler depuis un clic.
async function activerMouvement({ discret = false } = {}) {
  const D = window.DeviceOrientationEvent;
  if (!D) {
    if (!discret) montrerMessage("Ce navigateur n'a pas accès au gyroscope : glisse au doigt pour regarder autour de toi.");
    return false;
  }
  if (typeof D.requestPermission === 'function') {
    let reponse = 'denied';
    try {
      reponse = await D.requestPermission();
    } catch {
      reponse = 'denied';
    }
    if (reponse !== 'granted') {
      montrerMessage("Mouvement refusé. Pour réessayer, ferme l'onglet puis rouvre la page. Tu peux aussi glisser au doigt.");
      return false;
    }
  }
  clearTimeout(montrerMessage.minuterie);
  $('message').hidden = true;
  decalageLacet = null;
  gyro = null;
  addEventListener('deviceorientation', surOrientation);
  clearTimeout(attenteGyro);
  attenteGyro = setTimeout(() => {           // aucune mesure : pas de capteur, ou page non sécurisée (http)
    attenteGyro = null;
    removeEventListener('deviceorientation', surOrientation);
    gyroActif = false;
    afficherMouvement();
    if (discret) return;
    montrerMessage(isSecureContext
      ? "Ce téléphone ne transmet pas ses mouvements : glisse au doigt pour regarder autour de toi."
      : "Le mouvement a besoin d'une adresse https : glisse au doigt pour regarder autour de toi.");
  }, 2000);
  return true;
}

function couperMouvement() {
  if (camera) {                              // on repart du regard actuel, sans saut
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    lacet = Math.atan2(-f.x, -f.z);
    tangage = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
  }
  removeEventListener('deviceorientation', surOrientation);
  clearTimeout(attenteGyro);
  attenteGyro = null;
  gyroActif = false;
  gyro = null;
  afficherMouvement();
}

function afficherMouvement() {
  const b = $('mouvement');
  b.textContent = gyroActif ? 'Couper le mouvement' : 'Activer le mouvement';
  b.setAttribute('aria-pressed', String(gyroActif));
}

// ---------- Vidéo ----------

function brancherVideo() {
  video.addEventListener('waiting', () => { $('attente').hidden = false; });
  video.addEventListener('playing', () => { $('attente').hidden = true; afficherPause(); });
  video.addEventListener('canplay', () => { $('attente').hidden = true; });
  video.addEventListener('pause', afficherPause);
  video.addEventListener('ended', () => { montrerBarre(true); afficherPause(); });
  video.addEventListener('timeupdate', afficherTemps);
  video.addEventListener('loadedmetadata', afficherTemps);
  video.addEventListener('error', montrerErreurLecture);
}

function demarrer() {
  video.play().catch(() => { afficherPause(); montrerBarre(true); });     // lecture refusée : le bouton reste disponible
}

// La vidéo est découpée en morceaux (HLS). iPhone et iPad lisent ce format eux-mêmes, ailleurs hls.js s'en charge.
function chargerVideo(url) {
  arreterVideo();
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!url.pathname.endsWith('.m3u8') || iOS || !Hls.isSupported()) {
    video.src = url.href;
    demarrer();
    return;
  }
  // tampon limité : on ne télécharge pas toute la vidéo d'avance, pour préserver le forfait 4G
  hls = new Hls({ maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 10 });
  let reprisesMedia = 0;
  hls.on(Hls.Events.MANIFEST_PARSED, demarrer);
  hls.on(Hls.Events.ERROR, (_, d) => {
    if (!d.fatal) return;
    if (d.type === Hls.ErrorTypes.MEDIA_ERROR && reprisesMedia++ < 2) {
      hls.recoverMediaError();
    } else {
      arreterVideo();
      montrerErreurLecture();
    }
  });
  hls.attachMedia(video);
  hls.loadSource(url.href);
}

function arreterVideo() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function montrerErreurLecture() {
  $('attente').hidden = true;
  const m = $('message');
  m.replaceChildren('Cette vidéo ne se lit pas sur cet appareil.');
  if (choisie?.youtube) {
    const a = document.createElement('a');
    a.href = choisie.youtube;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = ' Voir sur YouTube';
    m.append(a);
  }
  m.hidden = false;
}

function montrerMessage(texte, duree = 6000) {
  const m = $('message');
  m.textContent = texte;
  m.hidden = false;
  clearTimeout(montrerMessage.minuterie);
  montrerMessage.minuterie = setTimeout(() => { m.hidden = true; }, duree);
}

function formatTemps(s) {
  if (!Number.isFinite(s)) return '0:00';
  const n = Math.floor(s);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function afficherTemps() {
  $('temps').textContent = `${formatTemps(video.currentTime)} / ${formatTemps(video.duration)}`;
  if (video.duration) $('position').value = String(Math.round(video.currentTime / video.duration * 1000));
}

function afficherPause() {
  $('pause').textContent = video.ended ? 'Revoir' : video.paused ? 'Lecture' : 'Pause';
}

function montrerBarre(garder = false) {
  $('lecteur').classList.remove('discret');
  clearTimeout(minuterieBarre);
  if (!garder) minuterieBarre = setTimeout(cacherBarreSiLecture, 3500);
}

function cacherBarreSiLecture() {
  if (video && !video.paused && !video.ended) $('lecteur').classList.add('discret');
}

function basculerBarre() {
  if ($('lecteur').classList.contains('discret')) montrerBarre();
  else cacherBarreSiLecture();
}

function lancerLecture() {
  if (!choisie) return;
  if (!preparerScene()) {
    $('description').textContent = "Ce navigateur n'affiche pas la 3D (WebGL)."
      + (choisie.youtube ? ' Utilise le lien YouTube ci-dessous.' : '');
    return;
  }
  $('accueil').hidden = true;
  $('lecteur').hidden = false;
  $('message').hidden = true;
  lacet = 0;
  tangage = 0;
  ajusterTaille();
  afficherSon();

  const url = new URL(choisie.fichier, location.href);
  if (url.origin !== location.origin) video.crossOrigin = 'anonymous';   // vidéo hébergée ailleurs : CORS exigé par WebGL
  else video.removeAttribute('crossorigin');
  $('attente').hidden = false;
  chargerVideo(url);
  renderer.setAnimationLoop(rendre);
  montrerBarre();

  const avecGyro = estTactile && !!window.DeviceOrientationEvent;
  $('mouvement').hidden = !avecGyro;
  $('casque').hidden = !avecGyro;
  afficherMouvement();
  if (avecGyro) {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      montrerMessage('Appuie sur « Activer le mouvement », puis tourne ton téléphone.');
    } else {
      activerMouvement({ discret: true });   // Android : pas de permission à demander
    }
  }
}

function quitterLecture() {
  video.pause();
  arreterVideo();
  video.removeAttribute('src');              // plus aucun téléchargement une fois revenu à l'accueil
  video.load();
  renderer.setAnimationLoop(null);
  couperMouvement();
  if (casque) basculerCasque();
  $('lecteur').hidden = true;
  $('accueil').hidden = false;
}

async function basculerCasque() {
  casque = !casque;
  $('casque').setAttribute('aria-pressed', String(casque));
  if (casque) {
    if (!gyroActif) await activerMouvement();
    await document.documentElement.requestFullscreen?.().catch(() => {});
    await screen.orientation?.lock?.('landscape').catch(() => {});
    montrerMessage("Mets le téléphone à l'horizontale et glisse-le dans le casque. Touche l'écran pour revoir les boutons. Si la tête te tourne, retire le casque.", 8000);
    cacherBarreSiLecture();
  } else {
    screen.orientation?.unlock?.();
    if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
  }
}

// ---------- Boutons ----------

$('lecture').addEventListener('click', lancerLecture);
$('son-accueil').addEventListener('click', () => { sonActif = !sonActif; afficherSon(); });
$('son').addEventListener('click', () => { sonActif = !sonActif; afficherSon(); montrerBarre(); });
$('retour').addEventListener('click', quitterLecture);
$('casque').addEventListener('click', basculerCasque);
$('mouvement').addEventListener('click', () => {
  if (gyroActif || attenteGyro) couperMouvement();
  else activerMouvement();
  montrerBarre();
});
$('pause').addEventListener('click', () => {
  if (video.paused || video.ended) video.play();
  else video.pause();
  montrerBarre(video.paused);
});
$('position').addEventListener('input', (e) => {
  if (video.duration) video.currentTime = e.target.value / 1000 * video.duration;
  montrerBarre();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && video && !video.paused) video.pause();
});

chargerListe();
