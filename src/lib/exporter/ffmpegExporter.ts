import type {
	AnnotationRegion,
	AudioRegion,
	CropRegion,
	CursorTelemetryPoint,
	SpeedRegion,
	TrimRegion,
	ZoomRegion,
} from "@/components/video-editor/types";
import { AudioProcessor } from "./audioEncoder";
import { FrameRenderer } from "./frameRenderer";
import { StreamingVideoDecoder } from "./streamingDecoder";
import type { ExportConfig, ExportProgress, ExportResult } from "./types";

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

/**
 * FFmpeg-based exporter with hardware acceleration support.
 * Uses NVENC (NVIDIA), AMF (AMD), or QuickSync (Intel) for GPU encoding.
 * Streams frames to main process incrementally to avoid OOM.
 */
export class FFmpegExporter {
	private config: FFmpegExporterConfig;
	private streamingDecoder: StreamingVideoDecoder | null = null;
	private renderer: FrameRenderer | null = null;
	private audioProcessor: AudioProcessor | null = null;
	private cancelled = false;
	private sessionId: string | null = null;

	constructor(config: FFmpegExporterConfig) {
		this.config = config;
	}

	private getEffectiveFrameRate(sourceFrameRate?: number): number {
		if (!Number.isFinite(sourceFrameRate) || !sourceFrameRate || sourceFrameRate <= 0) {
			return this.config.frameRate;
		}

		const roundedSourceFrameRate = Math.max(1, Math.round(sourceFrameRate));
		return Math.min(this.config.frameRate, roundedSourceFrameRate);
	}

	async export(): Promise<ExportResult> {
		try {
			this.cancelled = false;

			// Initialize streaming decoder
			this.streamingDecoder = new StreamingVideoDecoder();
			const videoInfo = await this.streamingDecoder.loadMetadata(this.config.videoUrl);
			const effectiveFrameRate = this.getEffectiveFrameRate(videoInfo.frameRate);

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
				this.config.speedRegions,
			);
			const totalFrames = Math.ceil(effectiveDuration * effectiveFrameRate);

			console.log("[FFmpegExporter] Total frames:", totalFrames);
			console.log("[FFmpegExporter] Source frame rate:", videoInfo.frameRate);
			console.log("[FFmpegExporter] Effective export frame rate:", effectiveFrameRate);
			console.log("[FFmpegExporter] Using FFmpeg hardware acceleration");

			// Step 1: Start encoding session — stream frames directly into FFmpeg.
			const session = await window.electronAPI.ffmpegStartEncode({
				width: this.config.width,
				height: this.config.height,
				frameRate: effectiveFrameRate,
				bitrate: this.config.bitrate,
				useNVENC: this.config.useNVENC ?? true,
				useAMF: this.config.useAMF ?? false,
				useQuickSync: this.config.useQuickSync ?? false,
			});

			if (!session.success) {
				return { success: false, error: session.error || "Failed to start FFmpeg encode session" };
			}

			const sessionId = session.sessionId!;
			this.sessionId = sessionId;

			// Step 2: Stream frames — decode, render, and push each frame over IPC.
			let frameIndex = 0;

			await this.streamingDecoder.decodeAll(
				effectiveFrameRate,
				this.config.trimRegions,
				this.config.speedRegions,
				async (videoFrame, _exportTimestampUs, sourceTimestampMs) => {
					if (this.cancelled) {
						videoFrame.close();
						return;
					}

					const sourceTimestampUs = sourceTimestampMs * 1000;
					await this.renderer!.renderFrame(videoFrame, sourceTimestampUs);
					videoFrame.close();

					// Extract raw RGBA data from the composite canvas
					const writeResult = await window.electronAPI.ffmpegWriteFrame(
						sessionId,
						this.renderer!.readCompositeRgbaFrame(),
					);
					if (!writeResult.success) {
						throw new Error(writeResult.error || "Failed to stream frame to FFmpeg");
					}

					frameIndex++;
					this.reportProgress(frameIndex, totalFrames, "rendering");
				},
			);

			if (this.cancelled) {
				return { success: false, error: "Export cancelled" };
			}

			// Step 3: Finish encoding — close stdin and let FFmpeg finalize the MP4.
			this.reportProgress(totalFrames, totalFrames, "encoding");

			this.sessionId = null;
			const encodeResult = await window.electronAPI.ffmpegFinishEncode(sessionId);

			if (!encodeResult.success) {
				return { success: false, error: encodeResult.error || "FFmpeg encoding failed" };
			}

			// Step 4: Read the encoded file and construct a Blob
			const arrayBuffer = await window.electronAPI.readEncodedFile(encodeResult.outputPath!);
			const blob = new Blob([arrayBuffer], { type: "video/mp4" });

			return { success: true, blob, encoding: encodeResult.encoding };
		} catch (error) {
			console.error("FFmpeg export error:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.cleanup();
		}
	}

	private reportProgress(
		currentFrame: number,
		totalFrames: number,
		phase: "rendering" | "encoding",
	) {
		if (this.config.onProgress) {
			this.config.onProgress({
				currentFrame,
				totalFrames,
				percentage:
					phase === "rendering"
						? (currentFrame / totalFrames) * 90
						: 90 + (currentFrame / totalFrames) * 10,
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
		const sessionId = this.sessionId;
		this.sessionId = null;
		if (sessionId) {
			void window.electronAPI.ffmpegCancelEncode(sessionId).catch((error) => {
				console.warn("Error cancelling FFmpeg encode session:", error);
			});
		}

		if (this.streamingDecoder) {
			try {
				this.streamingDecoder.destroy();
			} catch (e) {
				console.warn("Error destroying streaming decoder:", e);
			}
			this.streamingDecoder = null;
		}

		if (this.renderer) {
			try {
				this.renderer.destroy();
			} catch (e) {
				console.warn("Error destroying renderer:", e);
			}
			this.renderer = null;
		}

		this.audioProcessor = null;
	}
}
