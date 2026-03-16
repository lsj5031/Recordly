import type { ExportConfig, ExportProgress, ExportResult } from './types';
import { StreamingVideoDecoder } from './streamingDecoder';
import { FrameRenderer } from './frameRenderer';
import { AudioProcessor } from './audioEncoder';
import type { ZoomRegion, CropRegion, TrimRegion, AnnotationRegion, SpeedRegion, AudioRegion, CursorTelemetryPoint } from '@/components/video-editor/types';

interface FFmpegExporterConfig extends ExportConfig {
  videoUrl: string;
  wallpaper: string;
  zoomRegions: ZoomRegion[];
  trimRegions?: TrimRegion[];
  speedRegions?: SpeedRegion[];
  showShadow: boolean;
  shadowIntensity: number;
  backgroundBlur: number;
  zoomMotionBlur?: number;
  connectZooms?: boolean;
  borderRadius?: number;
  padding?: number;
  videoPadding?: number;
  cropRegion: CropRegion;
  annotationRegions?: AnnotationRegion[];
  cursorTelemetry?: CursorTelemetryPoint[];
  showCursor?: boolean;
  cursorSize?: number;
  cursorSmoothing?: number;
  cursorMotionBlur?: number;
  cursorClickBounce?: number;
  audioRegions?: AudioRegion[];
  previewWidth?: number;
  previewHeight?: number;
  onProgress?: (progress: ExportProgress) => void;
  // Hardware encoding options
  useNVENC?: boolean;
  useAMF?: boolean;
  useQuickSync?: boolean;
}

interface FFmpegEncodeResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

/**
 * FFmpeg-based exporter with hardware acceleration support.
 * Uses NVENC (NVIDIA), AMF (AMD), or QuickSync (Intel) for GPU encoding.
 */
export class FFmpegExporter {
  private config: FFmpegExporterConfig;
  private streamingDecoder: StreamingVideoDecoder | null = null;
  private renderer: FrameRenderer | null = null;
  private audioProcessor: AudioProcessor | null = null;
  private cancelled = false;

  constructor(config: FFmpegExporterConfig) {
    this.config = config;
  }

  async export(): Promise<ExportResult> {
    try {
      this.cancelled = false;

      // Initialize streaming decoder
      this.streamingDecoder = new StreamingVideoDecoder();
      const videoInfo = await this.streamingDecoder.loadMetadata(this.config.videoUrl);

      // Initialize frame renderer
      this.renderer = new FrameRenderer({
        width: this.config.width,
        height: this.config.height,
        wallpaper: this.config.wallpaper,
        zoomRegions: this.config.zoomRegions,
        showShadow: this.config.showShadow,
        shadowIntensity: this.config.shadowIntensity,
        backgroundBlur: this.config.backgroundBlur,
        zoomMotionBlur: this.config.zoomMotionBlur,
        connectZooms: this.config.connectZooms,
        borderRadius: this.config.borderRadius,
        padding: this.config.padding,
        cropRegion: this.config.cropRegion,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
        annotationRegions: this.config.annotationRegions,
        speedRegions: this.config.speedRegions,
        previewWidth: this.config.previewWidth,
        previewHeight: this.config.previewHeight,
        cursorTelemetry: this.config.cursorTelemetry,
        showCursor: this.config.showCursor,
        cursorSize: this.config.cursorSize,
        cursorSmoothing: this.config.cursorSmoothing,
        cursorMotionBlur: this.config.cursorMotionBlur,
        cursorClickBounce: this.config.cursorClickBounce,
      });
      await this.renderer.initialize();

      // Calculate frame count
      const effectiveDuration = this.streamingDecoder.getEffectiveDuration(
        this.config.trimRegions,
        this.config.speedRegions
      );
      const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);

      console.log('[FFmpegExporter] Total frames:', totalFrames);
      console.log('[FFmpegExporter] Using FFmpeg hardware acceleration');

      // Step 1: Render all frames and extract raw RGBA data
      const frames: Uint8Array[] = [];
      const frameDuration = 1_000_000 / this.config.frameRate;
      let frameIndex = 0;

      await this.streamingDecoder.decodeAll(
        this.config.frameRate,
        this.config.trimRegions,
        this.config.speedRegions,
        async (videoFrame, _exportTimestampUs, sourceTimestampMs) => {
          if (this.cancelled) {
            videoFrame.close();
            return;
          }

          const timestamp = frameIndex * frameDuration;
          const sourceTimestampUs = sourceTimestampMs * 1000;
          await this.renderer!.renderFrame(videoFrame, sourceTimestampUs);
          videoFrame.close();

          // Extract raw RGBA data from canvas
          const canvas = this.renderer!.getCanvas();
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            frames.push(new Uint8Array(imageData.data.buffer));
          }

          frameIndex++;
          this.reportProgress(frameIndex, totalFrames, 'rendering');
        }
      );

      if (this.cancelled) {
        return { success: false, error: 'Export cancelled' };
      }

      // Step 2: Process audio if present
      const hasAudioRegions = (this.config.audioRegions ?? []).length > 0;
      const hasAudio = videoInfo.hasAudio || hasAudioRegions;
      let audioData: ArrayBuffer | null = null;

      if (hasAudio) {
        // Audio will be handled by FFmpeg merge
        console.log('[FFmpegExporter] Audio present, will merge with FFmpeg');
      }

      // Step 3: Send to Electron for FFmpeg encoding
      this.reportProgress(totalFrames, totalFrames, 'encoding');

      const encodeResult: FFmpegEncodeResult = await window.electronAPI.encodeWithFFmpeg({
        frames,
        width: this.config.width,
        height: this.config.height,
        frameRate: this.config.frameRate,
        bitrate: this.config.bitrate,
        useNVENC: this.config.useNVENC ?? true,
        useAMF: this.config.useAMF ?? false,
        useQuickSync: this.config.useQuickSync ?? false,
        videoUrl: this.config.videoUrl,
        hasAudio,
        trimRegions: this.config.trimRegions,
        speedRegions: this.config.speedRegions,
        audioRegions: this.config.audioRegions,
      });

      if (!encodeResult.success) {
        return { success: false, error: encodeResult.error || 'FFmpeg encoding failed' };
      }

      // Step 4: Read the encoded file and return as blob
      const blobResult = await window.electronAPI.readEncodedFile(encodeResult.outputPath!);

      return { success: true, blob: blobResult };
    } catch (error) {
      console.error('FFmpeg export error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.cleanup();
    }
  }

  private reportProgress(currentFrame: number, totalFrames: number, phase: 'rendering' | 'encoding') {
    if (this.config.onProgress) {
      this.config.onProgress({
        currentFrame,
        totalFrames,
        percentage: phase === 'rendering'
          ? (currentFrame / totalFrames) * 90  // Rendering is 90%
          : 90 + ((currentFrame / totalFrames) * 10),  // Encoding is last 10%
        estimatedTimeRemaining: 0,
        phase,
      });
    }
  }

  cancel(): void {
    this.cancelled = true;
    if (this.streamingDecoder) {
      this.streamingDecoder.cancel();
    }
    if (this.audioProcessor) {
      this.audioProcessor.cancel();
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.streamingDecoder) {
      try {
        this.streamingDecoder.destroy();
      } catch (e) {
        console.warn('Error destroying streaming decoder:', e);
      }
      this.streamingDecoder = null;
    }

    if (this.renderer) {
      try {
        this.renderer.destroy();
      } catch (e) {
        console.warn('Error destroying renderer:', e);
      }
      this.renderer = null;
    }

    this.audioProcessor = null;
  }
}
