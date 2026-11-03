import * as THREE from '/vendor/three/three.module.js';

export function createLotteryScene(host, attendees, mode) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = 'lottery-scene';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const group = new THREE.Group();
  group.position.y = -0.25;
  scene.add(group);
  const materials = [];
  const textures = new Set();
  const loader = new THREE.TextureLoader();
  let disposed = false;
  let paused = false;
  let frame = 0;
  let lastTime = 0;

  const sprites = attendees.map((attendee, index) => {
    const material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    const count = attendees.length;
    if (mode === 'orbit') {
      const ring = index % 3;
      const angle = (index / count) * Math.PI * 6;
      const radius = 2.2 + ring * 0.52;
      sprite.position.set(Math.cos(angle) * radius, Math.sin(angle * 2) * 0.5 + (ring - 1) * 0.9, Math.sin(angle) * radius);
    } else {
      const y = 1 - ((index + 0.5) / count) * 2;
      const radius = Math.sqrt(1 - y * y);
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      sprite.position.set(Math.cos(angle) * radius * 3.1, y * 3.1, Math.sin(angle) * radius * 3.1);
    }
    const size = Math.max(0.36, Math.min(0.92, 4.4 / Math.sqrt(Math.max(count, 1))));
    sprite.scale.set(size, size, 1);
    materials.push(material);
    group.add(sprite);
    return { attendee, sprite, material };
  });

  const ringGeometry = new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 160 }, (_, index) => {
      const angle = (index / 160) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle) * 3.7, Math.sin(angle) * 3.7, 0);
    })
  );
  const ringMaterial = new THREE.LineBasicMaterial({ color: 0x83e8ff, transparent: true, opacity: 0.28 });
  const ring = new THREE.LineLoop(ringGeometry, ringMaterial);
  ring.position.y = -0.25;
  ring.rotation.x = Math.PI * 0.35;
  ring.rotation.z = Math.PI * -0.12;
  scene.add(ring);

  function loadTexture(src, fallback) {
    return new Promise((resolve) => {
      loader.load(src, (texture) => {
        if (disposed) texture.dispose();
        else {
          texture.colorSpace = THREE.SRGBColorSpace;
          textures.add(texture);
        }
        resolve(texture);
      }, undefined, () => {
        if (fallback && src !== fallback && !disposed) resolve(loadTexture(fallback));
        else resolve(null);
      });
    });
  }

  const ready = Promise.all(sprites.map(async ({ attendee, sprite, material }) => {
    const texture = await loadTexture(attendee.src, attendee.fallback);
    if (disposed) return;
    material.map = texture;
    material.color.set(texture ? 0xffffff : 0xffd36b);
    material.needsUpdate = true;
    sprite.visible = true;
  }));

  function resize() {
    if (disposed) return;
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.position.z = 4.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(camera.aspect, 1);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }

  const position = new THREE.Vector3();
  function animate(time) {
    if (disposed || paused) return;
    const delta = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
    lastTime = time;
    group.rotation.y += delta * (mode === 'orbit' ? 1.1 : 0.8);
    group.rotation.z = Math.sin(time / 5000) * 0.08;
    group.updateMatrixWorld();
    sprites.forEach(({ sprite, material }) => {
      sprite.getWorldPosition(position);
      material.opacity = 0.42 + ((position.z + 3.4) / 6.8) * 0.58;
    });
    renderer.render(scene, camera);
    frame = requestAnimationFrame(animate);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  frame = requestAnimationFrame(animate);

  return {
    ready,
    pause() {
      paused = true;
      cancelAnimationFrame(frame);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      textures.forEach((texture) => texture.dispose());
      materials.forEach((material) => material.dispose());
      ringGeometry.dispose();
      ringMaterial.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
  };
}
