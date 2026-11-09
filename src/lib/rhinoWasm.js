// rhino3dm WASM dosyasının adresi (Rhino .3dm yazıcısı için). sqlWasm.js ile aynı desen:
// Vite `?url` ile dosyayı varlık olarak paketler; Node/Vitest altında null döner ve rhino3dm kendi paketinden yükler.
import wasmAdresi from 'rhino3dm/rhino3dm.wasm?url';

const nodeMu = typeof process !== 'undefined' && Boolean(process.versions?.node);

export const RHINO_WASM_URL = nodeMu ? null : wasmAdresi;
