/// <reference types="audioworklet" />

const hasPerformanceApi =
  typeof performance !== 'undefined' && typeof performance.now === 'function';

function getTimeMs(): number {
  if (hasPerformanceApi) {
    return performance.now();
  }
  return (globalThis as unknown as { currentTime: number }).currentTime * 1000;
}

interface WebAssemblyInstantiatedSource {
  instance: WebAssembly.Instance;
  module: WebAssembly.Module;
}

function instantiateWasmModule(
  bytes: ArrayBuffer,
  imports: WebAssembly.Imports,
): Promise<WebAssemblyInstantiatedSource> {
  return WebAssembly.instantiate(bytes, imports) as Promise<WebAssemblyInstantiatedSource>;
}

interface IAudioDenoiser {
  readonly type: string;
  readonly name: string;
  readonly frameSize: number;
  readonly isInitialized: boolean;
  initialize(): Promise<void>;
  processFrame(frame: Float32Array): number;
  getLastVadScore(): number;
  destroy(): void;
}

interface WorkletFilterOpts {
  debug?: boolean;
}

interface RNNoiseWasmData {
  wasmJsCode: string;
  wasmBinary: Uint8Array;
  isSimd?: boolean;
}

interface RNNoiseWasmModule {
  _rnnoise_get_frame_size(): number;
  _rnnoise_create(model?: number): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, output: number, input: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
}

const F32_BYTE_SIZE = 4;
const INT16_SCALE = 0x7fff;

class RNNoiseWasmEngine implements IAudioDenoiser {
  readonly type = 'rnnoise-wasm-simd';
  readonly name: string;
  frameSize = 480;
  private _isInitialized = false;
  private module: RNNoiseWasmModule | null = null;
  private state = 0;
  private pcmInputPtr = 0;
  private pcmOutputPtr = 0;
  private lastVad = 0;
  private debug: boolean;

  constructor(
    private wasmJsCode: string,
    private wasmBinary: Uint8Array,
    private isSimd = false,
    debug = false,
  ) {
    this.name = isSimd ? 'RNNoise WASM (SIMD)' : 'RNNoise WASM';
    this.debug = debug;
    if (this.debug) {
      console.log('[RNNoiseWorklet] WASM engine:', {
        wasmBinarySize: wasmBinary.byteLength,
        isSimd,
      });
    }
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  async initialize(): Promise<void> {
    let jsCode = this.wasmJsCode;
    jsCode = jsCode.replace(/export\s+default\s+Module\s*;?\s*$/g, '');
    jsCode = jsCode.replace(/export\s+default\s+createRNNoiseModule\s*;?\s*$/g, '');
    jsCode = jsCode.replace(/import\.meta\.url/g, '""');
    jsCode = jsCode.replace(/new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*[^)]+\)\.href/g, '"$1"');

    const wasmBinary = this.wasmBinary;

    let createModule: (options: Record<string, unknown>) => Promise<RNNoiseWasmModule>;

    try {
      // eslint-disable-next-line no-implied-eval
      createModule = (0, eval)(
        `(function() { ${jsCode}; return typeof Module !== 'undefined' ? Module : (typeof createRNNoiseModule !== 'undefined' ? createRNNoiseModule : createRnnoiseModule); })()`,
      ) as (options: Record<string, unknown>) => Promise<RNNoiseWasmModule>;
    } catch (e) {
      console.error('[RNNoiseWorklet] Failed to eval Emscripten JS glue:', e);
      throw e;
    }

    this.module = (await createModule({
      wasmBinary: wasmBinary.buffer,
      instantiateWasm: (
        imports: WebAssembly.Imports,
        successCallback: (instance: WebAssembly.Instance) => void,
      ) => {
        instantiateWasmModule(wasmBinary.buffer as ArrayBuffer, imports)
          .then((result) => successCallback(result.instance))
          .catch((err) => console.error('[RNNoiseWorklet] WASM instantiation failed:', err));
        return {};
      },
    })) as RNNoiseWasmModule;

    this.frameSize = this.module._rnnoise_get_frame_size();
    this.state = this.module._rnnoise_create(0);

    if (!this.state) {
      throw new Error('RNNoise _rnnoise_create failed');
    }

    this.pcmInputPtr = this.module._malloc(this.frameSize * F32_BYTE_SIZE);
    this.pcmOutputPtr = this.module._malloc(this.frameSize * F32_BYTE_SIZE);

    if (!this.pcmInputPtr || !this.pcmOutputPtr) {
      this.destroy();
      throw new Error('RNNoise buffer allocation failed');
    }

    this._isInitialized = true;

    if (this.debug) {
      console.log('[RNNoiseWorklet] WASM initialized', {
        frameSize: this.frameSize,
        state: this.state,
      });
    }
  }

  processFrame(frame: Float32Array): number {
    if (!this.module || !this.state) return 0;

    const inputIndex = this.pcmInputPtr / F32_BYTE_SIZE;
    const outputIndex = this.pcmOutputPtr / F32_BYTE_SIZE;

    for (let i = 0; i < this.frameSize; i++) {
      this.module.HEAPF32[inputIndex + i] = frame[i] * INT16_SCALE;
    }

    this.lastVad = this.module._rnnoise_process_frame(
      this.state,
      this.pcmOutputPtr,
      this.pcmInputPtr,
    );

    for (let i = 0; i < this.frameSize; i++) {
      frame[i] = this.module.HEAPF32[outputIndex + i] / INT16_SCALE;
    }

    return this.lastVad;
  }

  getLastVadScore(): number {
    return this.lastVad;
  }

  destroy(): void {
    if (this.module) {
      if (this.state) this.module._rnnoise_destroy(this.state);
      if (this.pcmInputPtr) this.module._free(this.pcmInputPtr);
      if (this.pcmOutputPtr) this.module._free(this.pcmOutputPtr);
    }
    this.module = null;
    this.state = 0;
    this.pcmInputPtr = 0;
    this.pcmOutputPtr = 0;
    this._isInitialized = false;
  }
}

interface WorkletProcessorOptions {
  processorOptions?: {
    filterOpts?: WorkletFilterOpts;
    wasmData?: RNNoiseWasmData;
  };
}

class SimpleRingBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private readIndex = 0;
  private _length = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
  }

  get length(): number {
    return this._length;
  }

  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      if (this._length < this.capacity) {
        this.buffer[this.writeIndex] = samples[i];
        this.writeIndex = (this.writeIndex + 1) % this.capacity;
        this._length++;
      }
    }
  }

  read(dest: Float32Array, offset: number, count: number): number {
    const toRead = Math.min(count, this._length);
    for (let i = 0; i < toRead; i++) {
      dest[offset + i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.capacity;
    }
    this._length -= toRead;
    return toRead;
  }

  clear(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this._length = 0;
  }
}

class RNNoiseWorkletProcessor extends AudioWorkletProcessor {
  private processor?: IAudioDenoiser;
  private isProcessorInitialized = false;
  private isEnabled = true;
  private frameSize = 480;
  private destroyed = false;
  private debugLogs: boolean;
  private filterOptions: WorkletFilterOpts;
  private wasmData?: RNNoiseWasmData;

  private inputBuffer: Float32Array;
  private inputBufferCount = 0;
  private outputBuffer: SimpleRingBuffer;
  private processCallCount = 0;
  private lastLogTime = 0;

  constructor(options?: WorkletProcessorOptions) {
    super();
    this.filterOptions = options?.processorOptions?.filterOpts ?? {};
    this.debugLogs = this.filterOptions.debug ?? false;
    this.wasmData = options?.processorOptions?.wasmData;

    this.inputBuffer = new Float32Array(480);
    this.outputBuffer = new SimpleRingBuffer(4800);

    if (this.debugLogs) {
      console.log('[RNNoiseWorklet] ctor', { hasWasmData: !!this.wasmData });
    }

    void this.initializeProcessor();
    this.setupMessageHandler();
  }

  private async initializeProcessor(): Promise<void> {
    if (!this.wasmData) {
      console.warn('[RNNoiseWorklet] No wasmData; passthrough only');
      this.port.postMessage({
        type: 'PROCESSOR_ERROR',
        error: 'No WASM data — passthrough mode',
      });
      return;
    }

    try {
      const isSimd = this.wasmData.isSimd ?? false;
      this.processor = new RNNoiseWasmEngine(
        this.wasmData.wasmJsCode,
        this.wasmData.wasmBinary,
        isSimd,
        this.debugLogs,
      );
      await this.processor.initialize();

      this.frameSize = this.processor.frameSize;
      this.inputBuffer = new Float32Array(this.frameSize);
      this.inputBufferCount = 0;
      this.outputBuffer = new SimpleRingBuffer(this.frameSize * 10);
      this.isProcessorInitialized = true;

      this.port.postMessage({
        type: 'PROCESSOR_INITIALIZED',
        name: this.processor.name,
        processorType: this.processor.type,
        frameSize: this.frameSize,
        isInitialized: this.isProcessorInitialized,
      });
    } catch (error) {
      console.error('[RNNoiseWorklet] init failed:', error);
      this.port.postMessage({
        type: 'PROCESSOR_ERROR',
        error: String(error),
      });
    }
  }

  private setupMessageHandler(): void {
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'DESTROY') {
        this.destroy();
      } else if (event.data.type === 'SET_ENABLED') {
        const wasEnabled = this.isEnabled;
        this.isEnabled = event.data.enabled;
        if (this.isEnabled && !wasEnabled) {
          this.resetBuffers();
        }
      }
    };
  }

  private resetBuffers(): void {
    this.inputBufferCount = 0;
    this.outputBuffer.clear();
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.destroyed) return false;

    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    this.processCallCount++;

    if (!this.isEnabled || !this.isProcessorInitialized || !this.processor) {
      output.set(input);
      return true;
    }

    let inputOffset = 0;
    while (inputOffset < input.length) {
      const spaceInBuffer = this.frameSize - this.inputBufferCount;
      const samplesToAdd = Math.min(spaceInBuffer, input.length - inputOffset);

      for (let i = 0; i < samplesToAdd; i++) {
        this.inputBuffer[this.inputBufferCount + i] = input[inputOffset + i];
      }

      this.inputBufferCount += samplesToAdd;
      inputOffset += samplesToAdd;

      if (this.inputBufferCount === this.frameSize) {
        this.processor.processFrame(this.inputBuffer);
        this.outputBuffer.write(this.inputBuffer);
        this.inputBufferCount = 0;
      }
    }

    if (this.outputBuffer.length >= output.length) {
      this.outputBuffer.read(output, 0, output.length);
    } else if (this.outputBuffer.length > 0) {
      const available = this.outputBuffer.length;
      this.outputBuffer.read(output, 0, available);
      for (let i = available; i < output.length; i++) {
        output[i] = 0;
      }
    } else {
      output.fill(0);
    }

    const now = getTimeMs();
    if (this.debugLogs && now - this.lastLogTime > 5000) {
      console.log('[RNNoiseWorklet] stats', {
        calls: this.processCallCount,
        outLen: this.outputBuffer.length,
        frameSize: this.frameSize,
      });
      this.lastLogTime = now;
    }

    return true;
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.port.postMessage({
      type: 'DESTROYED',
      finalStats: { processCallCount: this.processCallCount },
    });
    this.destroyed = true;
    this.processor?.destroy();
    this.outputBuffer.clear();
  }
}

registerProcessor('RNNoiseWorklet', RNNoiseWorkletProcessor);
