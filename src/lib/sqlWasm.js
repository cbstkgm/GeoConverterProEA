// sql.js WASM dosyasının adresi (GeoPackage yazıcısı için).
// Vite `?url` ile dosyayı derleme çıktısına varlık olarak koyar ve `base` önekli adresini verir.
// sql-wasm-browser.wasm, Vite'ın worker paketinde seçtiği sql-wasm-browser.js yükleyicisiyle eşleşir.
// Node/Vitest altında null döner: sql.js WASM'ı kendi paketinden yükler.
import wasmAdresi from 'sql.js/dist/sql-wasm-browser.wasm?url';

const nodeMu = typeof process !== 'undefined' && Boolean(process.versions?.node);

export const SQL_WASM_URL = nodeMu ? null : wasmAdresi;
