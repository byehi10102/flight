// What does the MENU render branch actually draw? Dumps every visible
// object in the Three.js scene (layer 1) with geometry + screen position.
import puppeteer from "puppeteer";

const GAME = process.env.GAME_URL || "http://127.0.0.1:4173/?devtest=1";
const LAUNCH = {
  headless: true,
  protocolTimeout: 600000,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
};
const browser = await puppeteer.launch(LAUNCH);
const page = await browser.newPage();
await page.goto(GAME, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForFunction(() => {
  const b = document.getElementById("startBtn");
  return b && !b.disabled && document.getElementById("loadingIndicator").classList.contains("hidden");
}, { timeout: 120000, polling: 500 });
await new Promise((r) => setTimeout(r, 3000));

const dump = await page.evaluate(() => {
  const scene = window.SKY_DEV.threeScene;
  const cam = window.SKY_DEV.threeCamera;
  const flags = {
    state: window.SKY_DEV.currentState,
    jetVisible: window.SKY_DEV.planeModel?.model?.visible,
    jetParent: window.SKY_DEV.planeModel?.model?.parent?.type,
    earth: window.SKY_DEV.menuEarth(),
    containerHidden: document.getElementById("threeContainer").classList.contains("hidden"),
  };
  const out = [];
  scene.traverse((o) => {
    if (!o.visible) return;
    if (o.isMesh || o.isGroup) {
      let onLayer = true;
      try { onLayer = o.layers ? o.layers.test(cam.layers) : true; } catch (e) {}
      const isMesh = !!o.isMesh;
      const g = isMesh && o.geometry ? o.geometry.attributes.position?.count || 0 : 0;
      // project world position to screen
      let ndc = null;
      try {
        const v = new THREE.Vector3();
        o.getWorldPosition(v);
        v.project(cam);
        ndc = [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
      } catch (e) {}
      out.push({
        name: o.name || o.type,
        mesh: isMesh,
        verts: g,
        onLayer,
        ndc,
      });
    }
  });
  return { flags, out };
});
console.log("FLAGS: " + JSON.stringify(dump.flags));
console.log(JSON.stringify(dump.out, null, 1));
await browser.close();
