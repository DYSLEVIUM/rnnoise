import { getRNNoiseLogger, LogLevel, type IRNNoiseLogger } from './logger';
import { isRNNoiseWasmRuntimeAvailable, RNNoiseWasmLoader } from './RNNoiseWasmLoader';
import type { RNNoiseWasmData } from './types';

const PROCESSOR_NAME = 'RNNoiseWorklet';
const DEFAULT_ASSETS_PATH = './rnnoise-wasm/';
const DEFAULT_WORKLET_FILE = 'rnnoise.denoise.worklet.js';

export interface RNNoiseWorkletHostInit {
  audioContext: AudioContext;
  track: MediaStreamTrack;
}

export class RNNoiseWorkletHost {
  processedTrack?: MediaStreamTrack;

  private static contextsWithWorklet = new WeakSet<AudioContext>();
  private logger: IRNNoiseLogger;
  private options: { assetsPath: string; workletUrl?: string; debug: boolean };
  private audioContext?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private workletNode?: AudioWorkletNode;
  private originalTrack?: MediaStreamTrack;
  private isEnabled = true;

  constructor(options: { assetsPath?: string; workletUrl?: string; debug?: boolean } = {}) {
    this.logger = getRNNoiseLogger().createChild({ component: 'RNNoiseWorkletHost' });
    this.options = {
      assetsPath: options.assetsPath ?? DEFAULT_ASSETS_PATH,
      workletUrl: options.workletUrl,
      debug: options.debug ?? false,
    };
    if (this.options.debug) {
      this.logger.setLevel(LogLevel.DEBUG);
    }
  }

  static isSupported(): boolean {
    return typeof AudioWorkletNode !== 'undefined' && isRNNoiseWasmRuntimeAvailable();
  }

  async init(opts: RNNoiseWorkletHostInit): Promise<void> {
    await this.initInternal(opts, false);
  }

  async restart(opts: RNNoiseWorkletHostInit): Promise<void> {
    const ctx = opts.audioContext ?? this.audioContext;
    await this.initInternal({ ...opts, audioContext: ctx! }, true);
  }

  async destroy(): Promise<void> {
    this.closeInternal();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.isEnabled = enabled;
    this.workletNode?.port.postMessage({ type: 'SET_ENABLED', enabled });
  }

  async isEnabledState(): Promise<boolean> {
    return this.isEnabled;
  }

  getOriginalTrack(): MediaStreamTrack | undefined {
    return this.originalTrack;
  }

  getProcessedTrack(): MediaStreamTrack | undefined {
    return this.processedTrack;
  }

  private async initInternal(opts: RNNoiseWorkletHostInit, restart: boolean): Promise<void> {
    if (!opts.audioContext || !opts.track) {
      throw new Error('audioContext and track are required');
    }
    if (restart) this.closeInternal();

    this.audioContext = opts.audioContext;
    this.originalTrack = opts.track;

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    if (this.audioContext.state !== 'running') {
      throw new Error(`AudioContext not running (state: ${this.audioContext.state})`);
    }

    await this.loadWorkletModule();

    RNNoiseWasmLoader.setBasePath(this.resolveWasmBasePath());
    const wasmData = await RNNoiseWasmLoader.load();
    await this.createWorkletNode(wasmData);
    this.connectAudioGraph();
  }

  private resolveWasmBasePath(): string {
    const p = this.options.assetsPath;
    return p.endsWith('/') ? p : `${p}/`;
  }

  private workletModuleUrl(): string {
    if (this.options.workletUrl) return this.options.workletUrl;
    const p = this.options.assetsPath.endsWith('/')
      ? this.options.assetsPath
      : `${this.options.assetsPath}/`;
    return `${p}${DEFAULT_WORKLET_FILE}`;
  }

  private async loadWorkletModule(): Promise<void> {
    if (!this.audioContext) return;
    if (RNNoiseWorkletHost.contextsWithWorklet.has(this.audioContext)) {
      return;
    }
    const url = this.workletModuleUrl();
    this.logger.debug(`audioWorklet.addModule(${url})`);
    await this.audioContext.audioWorklet.addModule(url);
    RNNoiseWorkletHost.contextsWithWorklet.add(this.audioContext);
  }

  private async createWorkletNode(wasmData: RNNoiseWasmData): Promise<void> {
    if (!this.audioContext) throw new Error('No AudioContext');
    this.workletNode = new AudioWorkletNode(this.audioContext, PROCESSOR_NAME, {
      outputChannelCount: [1],
      processorOptions: {
        filterOpts: { debug: this.options.debug },
        wasmData,
      },
    });
    this.setupPortLogging();
  }

  private setupPortLogging(): void {
    this.workletNode!.port.onmessage = (event: MessageEvent) => {
      const { type, ...data } = event.data;
      switch (type) {
        case 'DESTROYED':
          this.logger.debug('worklet destroyed', data);
          break;
        case 'PROCESSOR_INITIALIZED':
          this.logger.info('RNNoise worklet processor ready', data);
          break;
        case 'PROCESSOR_ERROR':
          this.logger.error('worklet processor error', undefined, data.error);
          break;
        default:
          if (this.options.debug) this.logger.debug('worklet message', { type, ...data });
      }
    };
  }

  private connectAudioGraph(): void {
    if (!this.audioContext || !this.originalTrack || !this.workletNode) {
      throw new Error('Missing audio graph components');
    }
    this.sourceNode = this.audioContext.createMediaStreamSource(new MediaStream([this.originalTrack]));
    this.sourceNode.connect(this.workletNode);
    const dest = this.audioContext.createMediaStreamDestination();
    this.workletNode.connect(dest);
    this.processedTrack = dest.stream.getTracks()[0];
  }

  private closeInternal(): void {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'DESTROY' });
      this.workletNode.disconnect();
      this.workletNode = undefined;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = undefined;
    }
    this.processedTrack = undefined;
    this.originalTrack = undefined;
    this.audioContext = undefined;
  }
}
