import { FRAME_INTERVAL_MS, MAX_DISPLAY_AGE_MS, MAX_PROCESSING_MS, acceptResult, displayIsFresh } from './watermark/timing';

export type WatermarkState = 'connecting' | 'searching' | 'waiting' | 'motion' | 'repaired' | 'late' | 'error' | 'disabled';

export interface WatermarkStatus {
  state: WatermarkState;
  message: string | null;
  outputFps: number | null;
  latencyMs: number | null;
  p95LatencyMs: number | null;
  droppedFrames: number;
  processedFrames: number;
  fallbackFrames: number;
  detectionConfidence: number | null;
  lastFrameFallback: boolean;
}

interface WorkerResult {
  bitmap?: ImageBitmap;
  error?: string;
  startedAt: number;
  generation: number;
  state: Exclude<WatermarkState, 'connecting' | 'late' | 'error' | 'disabled'>;
  score: number;
  elapsedMs: number;
}

interface ProcessorOptions {
  onStatus: (status: WatermarkStatus) => void;
}

type VideoWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number; width: number; height: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

type ManualCanvasTrack = MediaStreamTrack & { requestFrame?: () => void };

export const watermarkStateLabels: Record<WatermarkState, string> = {
  connecting: '等待远端视频',
  searching: '未可靠定位，保留原画面',
  waiting: '等待历史参考帧',
  motion: '运动差异过大，保留原画面',
  repaired: '使用历史画面修复',
  late: '处理帧过期，已切回原画面',
  error: '处理不可用，已切回原画面',
  disabled: '本机处理已关闭',
};

export function initialWatermarkStatus(state: WatermarkState = 'connecting'): WatermarkStatus {
  return {
    state,
    message: null,
    outputFps: null,
    latencyMs: null,
    p95LatencyMs: null,
    droppedFrames: 0,
    processedFrames: 0,
    fallbackFrames: 0,
    detectionConfidence: null,
    lastFrameFallback: false,
  };
}

export class RemoteWatermarkProcessor {
  private readonly video: HTMLVideoElement;
  private readonly output: HTMLCanvasElement;
  private readonly options: ProcessorOptions;
  private readonly videoWithCallbacks: VideoWithFrameCallbacks;
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private outputTrack: ManualCanvasTrack | null = null;
  private sourceTrack: MediaStreamTrack | null = null;
  private frameCallback: number | null = null;
  private animationFrame: number | null = null;
  private workerTimeout: number | undefined;
  private freshnessTimer: number | undefined;
  private pendingStartReject: ((error: Error) => void) | null = null;
  private stopped = false;
  private failed = false;
  private busy = false;
  private generation = 0;
  private lastMediaTime = -Infinity;
  private nextFrameAt = -Infinity;
  private lastOutputAt = 0;
  private lastStatusAt = 0;
  private lastPublishedState: WatermarkState | null = null;
  private readonly frameTimes: number[] = [];
  private readonly latencySamples: number[] = [];
  private status = initialWatermarkStatus();
  private context: CanvasRenderingContext2D | null = null;

  constructor(video: HTMLVideoElement, output: HTMLCanvasElement, options: ProcessorOptions) {
    this.video = video;
    this.output = output;
    this.options = options;
    this.videoWithCallbacks = video as VideoWithFrameCallbacks;
  }

  async start(): Promise<MediaStream> {
    if (this.stream) return this.stream;
    this.publish(true);
    try {
      await this.waitForVideoFrame();
      if (this.stopped) throw new Error('水印处理已停止');
      if (typeof this.output.captureStream !== 'function') throw new Error('浏览器不支持 Canvas 视频流输出');
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
        throw new Error('浏览器不支持 Worker、OffscreenCanvas 或 ImageBitmap');
      }

      this.output.width = this.video.videoWidth;
      this.output.height = this.video.videoHeight;
      this.context = this.output.getContext('2d', { alpha: false });
      if (!this.context) throw new Error('处理输出 Canvas 不可用');

      this.stream = this.output.captureStream(0);
      this.outputTrack = this.stream.getVideoTracks()[0] as ManualCanvasTrack | undefined ?? null;
      if (!this.outputTrack || typeof this.outputTrack.requestFrame !== 'function') {
        throw new Error('浏览器不支持按处理帧输出 Canvas 视频流');
      }

      this.worker = new Worker(new URL('./watermark/processor.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerResult>) => this.handleWorkerMessage(event.data);
      this.worker.onerror = (event) => this.fail(event.message || '水印处理 Worker 异常');

      const source = this.video.srcObject;
      this.sourceTrack = source instanceof MediaStream ? source.getVideoTracks()[0] ?? null : null;
      this.sourceTrack?.addEventListener('ended', this.handleSourceEnded);
      this.video.addEventListener('resize', this.handleVideoResize);
      this.lastOutputAt = performance.now();
      this.freshnessTimer = window.setInterval(() => this.checkFreshness(), 30);
      this.status = { ...this.status, state: 'searching', message: null };
      this.publish(true);
      this.scheduleFrame();
      return this.stream;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.stopped) this.fail(message);
      throw error;
    }
  }

  get outputStream(): MediaStream | null {
    return this.stream;
  }

  getStatus(): WatermarkStatus {
    return { ...this.status };
  }

  fail(message: string): void {
    if (this.stopped) return;
    this.failed = true;
    this.stopped = true;
    this.cleanup();
    this.status = { ...this.status, state: 'error', message };
    this.publish(true);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
  }

  private waitForVideoFrame(): Promise<void> {
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.videoWidth && this.video.videoHeight) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.video.removeEventListener('loadeddata', check);
        this.video.removeEventListener('resize', check);
        this.video.removeEventListener('error', onError);
        this.pendingStartReject = null;
      };
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const check = () => {
        if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.videoWidth && this.video.videoHeight) {
          settle(resolve);
        }
      };
      const onError = () => settle(() => reject(new Error('读取远端试衣视频失败')));
      const timeout = window.setTimeout(() => settle(() => reject(new Error('等待远端试衣首帧超时'))), 5000);
      this.pendingStartReject = (error) => settle(() => reject(error));
      this.video.addEventListener('loadeddata', check);
      this.video.addEventListener('resize', check);
      this.video.addEventListener('error', onError);
      check();
    });
  }

  private readonly handleSourceEnded = () => this.fail('远端视频轨道已结束，已切回原始流');

  private scheduleFrame(): void {
    if (this.stopped) return;
    if (this.videoWithCallbacks.requestVideoFrameCallback) {
      this.frameCallback = this.videoWithCallbacks.requestVideoFrameCallback((_now, metadata) => {
        this.scheduleFrame();
        this.captureFrame(metadata.mediaTime, performance.now());
      });
      return;
    }
    this.animationFrame = window.requestAnimationFrame((now) => {
      this.scheduleFrame();
      this.captureFrame(this.video.currentTime, now);
    });
  }

  private captureFrame(mediaTime: number, now: number): void {
    if (this.stopped || this.video.paused || this.video.ended || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (mediaTime === this.lastMediaTime) return;
    if (this.busy || now < this.nextFrameAt) {
      this.status = { ...this.status, droppedFrames: this.status.droppedFrames + 1 };
      this.publish();
      return;
    }

    const worker = this.worker;
    if (!worker) return;
    this.busy = true;
    this.lastMediaTime = mediaTime;
    this.nextFrameAt = now + FRAME_INTERVAL_MS;
    const frameGeneration = this.generation;
    this.workerTimeout = window.setTimeout(() => this.fail('水印处理 Worker 连续 2 秒无响应，已切回原始流'), 2000);

    void createImageBitmap(this.video).then((bitmap) => {
      if (this.stopped || this.failed || !this.worker) {
        bitmap.close();
        return;
      }
      this.worker.postMessage({ bitmap, time: mediaTime, startedAt: now, generation: frameGeneration }, [bitmap]);
    }).catch((error: unknown) => {
      this.fail(error instanceof Error ? error.message : String(error));
    });
  }

  private handleWorkerMessage(result: WorkerResult): void {
    window.clearTimeout(this.workerTimeout);
    this.workerTimeout = undefined;
    this.busy = false;
    if (this.stopped || this.failed) {
      result.bitmap?.close();
      return;
    }
    if (result.error) {
      this.fail(result.error);
      return;
    }
    const bitmap = result.bitmap;
    if (!bitmap) {
      this.fail('水印处理 Worker 未返回视频帧');
      return;
    }

    const now = performance.now();
    if (!acceptResult(result.startedAt, now, result.generation, this.generation)) {
      bitmap.close();
      this.status = { ...this.status, droppedFrames: this.status.droppedFrames + 1, state: 'late', message: '处理结果超过 120 ms，当前显示原始流' };
      this.publish(true);
      return;
    }

    try {
      if (this.output.width !== bitmap.width || this.output.height !== bitmap.height) {
        this.output.width = bitmap.width;
        this.output.height = bitmap.height;
      }
      this.context?.drawImage(bitmap, 0, 0);
      this.outputTrack?.requestFrame?.();
    } catch (error) {
      bitmap.close();
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    bitmap.close();

    this.lastOutputAt = now;
    this.frameTimes.push(now);
    this.latencySamples.push(now - result.startedAt);
    while (this.frameTimes.length && now - this.frameTimes[0] > 2000) this.frameTimes.shift();
    while (this.latencySamples.length > 120) this.latencySamples.shift();
    const sortedLatency = [...this.latencySamples].sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1);
    const fallback = result.state !== 'repaired';
    this.status = {
      ...this.status,
      state: result.state,
      message: null,
      outputFps: this.frameTimes.length > 1 ? (this.frameTimes.length - 1) * 1000 / (now - this.frameTimes[0]) : 0,
      latencyMs: now - result.startedAt,
      p95LatencyMs: sortedLatency.length ? sortedLatency[p95Index] : null,
      processedFrames: this.status.processedFrames + (fallback ? 0 : 1),
      fallbackFrames: this.status.fallbackFrames + (fallback ? 1 : 0),
      detectionConfidence: result.score,
      lastFrameFallback: fallback,
    };
    this.publish();
  }

  private checkFreshness(): void {
    if (this.stopped) return;
    const now = performance.now();
    if (!displayIsFresh(this.lastOutputAt, now) && this.status.state !== 'late') {
      this.status = { ...this.status, state: 'late', message: '处理结果已超过 180 ms，当前显示原始流', outputFps: 0 };
      this.publish(true);
    }
    if (now - this.lastOutputAt > 2000) this.fail('水印处理连续 2 秒没有新帧，已切回原始流');
  }

  private publish(force = false): void {
    const now = performance.now();
    if (!force && this.lastPublishedState === this.status.state && now - this.lastStatusAt < 250) return;
    this.lastStatusAt = now;
    this.lastPublishedState = this.status.state;
    this.options.onStatus({ ...this.status });
  }

  private cleanup(): void {
    this.pendingStartReject?.(new Error('水印处理已取消'));
    this.pendingStartReject = null;
    if (this.frameCallback !== null) this.videoWithCallbacks.cancelVideoFrameCallback?.(this.frameCallback);
    if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame);
    window.clearTimeout(this.workerTimeout);
    window.clearInterval(this.freshnessTimer);
    this.video.removeEventListener('resize', this.handleVideoResize);
    this.sourceTrack?.removeEventListener('ended', this.handleSourceEnded);
    this.worker?.terminate();
    this.worker = null;
    this.outputTrack = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private readonly handleVideoResize = () => {
    this.generation += 1;
  };
}
