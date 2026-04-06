import { simd } from 'wasm-feature-detect';
import { getRNNoiseLogger, type IRNNoiseLogger } from './logger';
import type { RNNoiseWasmData } from './types';

const DEFAULT_BASE = './rnnoise-wasm/';
const SIMD_SUBDIR = 'simd/full/';
const JS_NAME = 'rnnoise_simd.js';
const WASM_NAME = 'rnnoise_simd.wasm';

class RNNoiseWasmLoaderImpl {
  private basePath = DEFAULT_BASE;
  private wasmData: RNNoiseWasmData | null = null;
  private loadPromise: Promise<RNNoiseWasmData> | null = null;
  private logger: IRNNoiseLogger;

  constructor() {
    this.logger = getRNNoiseLogger().createChild({ component: 'RNNoiseWasmLoader' });
  }

  setBasePath(path: string): void {
    this.basePath = path.endsWith('/') ? path : `${path}/`;
  }

  async load(): Promise<RNNoiseWasmData> {
    if (this.wasmData) return this.wasmData;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<RNNoiseWasmData> {
    const isSimdSupported = await simd();
    if (!isSimdSupported) {
      throw new Error(
        'RNNoise WASM SIMD build requires WebAssembly SIMD in this browser.',
      );
    }

    const jsUrl = `${this.basePath}${SIMD_SUBDIR}${JS_NAME}`;
    const wasmUrl = `${this.basePath}${SIMD_SUBDIR}${WASM_NAME}`;

    this.logger.info('Loading RNNoise WASM (SIMD)', { jsUrl, wasmUrl });

    let jsResponse: Response;
    let wasmResponse: Response;
    try {
      [jsResponse, wasmResponse] = await Promise.all([
        fetch(jsUrl, { cache: 'default' }),
        fetch(wasmUrl, { cache: 'default' }),
      ]);
    } catch (e) {
      const msg = `Network error loading RNNoise WASM from ${this.basePath}${SIMD_SUBDIR}`;
      this.logger.error(msg, { jsUrl, wasmUrl }, e);
      throw new Error(`${msg}: ${e}`);
    }

    if (!jsResponse.ok) {
      throw new Error(`Failed to fetch ${JS_NAME}: HTTP ${jsResponse.status}`);
    }
    if (!wasmResponse.ok) {
      throw new Error(`Failed to fetch ${WASM_NAME}: HTTP ${wasmResponse.status}`);
    }

    const [wasmJsCode, wasmBinary] = await Promise.all([
      jsResponse.text(),
      wasmResponse.arrayBuffer().then((b) => new Uint8Array(b)),
    ]);

    if (!wasmJsCode?.length) throw new Error('RNNoise JS glue is empty');
    if (!wasmBinary?.byteLength) throw new Error('RNNoise WASM binary is empty');

    this.wasmData = { wasmJsCode, wasmBinary, isSimd: isSimdSupported };
    this.logger.info('RNNoise WASM loaded', {
      jsSize: wasmJsCode.length,
      wasmSize: wasmBinary.byteLength,
      isSimd: isSimdSupported,
    });
    return this.wasmData;
  }

  getData(): RNNoiseWasmData | null {
    return this.wasmData;
  }

  isLoaded(): boolean {
    return this.wasmData !== null;
  }

  reset(): void {
    this.wasmData = null;
    this.loadPromise = null;
  }

  static isSupported(): boolean {
    return typeof WebAssembly !== 'undefined';
  }
}

export const RNNoiseWasmLoader = new RNNoiseWasmLoaderImpl();

export function isRNNoiseWasmRuntimeAvailable(): boolean {
  return RNNoiseWasmLoaderImpl.isSupported();
}
