import * as THREE from 'three';

export function buildScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9fd0ee, 0.0015);

  // Sky Dome Gradient
  const vertexShader = `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const fragmentShader = `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float offset;
    uniform float exponent;
    varying vec3 vWorldPosition;
    void main() {
      float h = normalize(vWorldPosition + offset).y;
      gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
    }
  `;
  const uniforms = {
    topColor: { value: new THREE.Color(0x2a6baf) },
    bottomColor: { value: new THREE.Color(0x9fd0ee) },
    offset: { value: 33 },
    exponent: { value: 0.6 }
  };
  const skyGeo = new THREE.SphereGeometry(1500, 32, 15);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    side: THREE.BackSide,
    depthWrite: false
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  scene.add(sky);

  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 2000);

  // Lighting: warm sun + cool sky fill + subtle bounce light
  const hemi = new THREE.HemisphereLight(0xffffff, 0x4a5b3f, 0.55);
  hemi.color.setHSL(0.6, 0.75, 0.85);
  hemi.groundColor.setHSL(0.095, 0.5, 0.5);
  hemi.position.set(0, 50, 0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.color.setHSL(0.1, 1, 0.95);
  sun.position.set(120, 160, 80);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 800;
  const s = 150;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);

  // Soft sky fill light for shadows and trackside props
  const fillLight = new THREE.DirectionalLight(0xaad4f5, 0.45);
  fillLight.position.set(-100, 70, -90);
  scene.add(fillLight);

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', resize);

  function dispose() {
    window.removeEventListener('resize', resize);
    skyGeo.dispose();
    skyMat.dispose();
    renderer.dispose();
  }

  return { scene, camera, renderer, sun, resize, dispose };
}
