export enum DenoiserType {
  RNNOISE_WASM_SIMD = 'rnnoise-wasm-simd',
}

export enum LoadStatus {
  NOT_LOADED = 'not_loaded',
  LOADING = 'loading',
  LOADED = 'loaded',
  ERROR = 'error',
}

export interface IAudioDenoiser {
  readonly type: DenoiserType;
  readonly name: string;
  readonly isInitialized: boolean;
  readonly frameSize: number;
  initialize(): Promise<void>;
  processFrame(frame: Float32Array): number;
  getLastVadScore(): number;
  destroy(): void;
}

export interface BaseDenoiserConfig {
  debug?: boolean;
  sessionId?: string;
}

export interface RNNoiseWasmConfig extends BaseDenoiserConfig {
  assetsPath?: string;
}

export interface RNNoiseWorkletHostOptions {
  /** Directory URL prefix where `rnnoise.denoise.worklet.js` and `rnnoise-wasm/simd/full/*` are served */
  assetsPath?: string;
  /** Full URL to the bundled worklet script (overrides default `${assetsPath}rnnoise.denoise.worklet.js`) */
  workletUrl?: string;
  debug?: boolean;
}

export interface RNNoiseWasmData {
  wasmJsCode: string;
  wasmBinary: Uint8Array;
  isSimd?: boolean;
}

export const RNNOISE_FRAME_SAMPLES = 480;
