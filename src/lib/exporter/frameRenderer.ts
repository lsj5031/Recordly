import {
	Application,
	BlurFilter,
	Container,
	FillGradient,
	Graphics,
	Sprite,
	Texture,
} from "pixi.js";
import { DropShadowFilter } from "pixi-filters/drop-shadow";
import { MotionBlurFilter } from "pixi-filters/motion-blur";
import type {
	AnnotationRegion,
	CropRegion,
	CursorTelemetryPoint,
	SpeedRegion,
	ZoomRegion,
} from "@/components/video-editor/types";
import { ZOOM_DEPTH_SCALES } from "@/components/video-editor/types";
import {
	DEFAULT_FOCUS,
	ZOOM_SCALE_DEADZONE,
	ZOOM_TRANSLATION_DEADZONE_PX,
} from "@/components/video-editor/videoPlayback/constants";
import {
	DEFAULT_CURSOR_CONFIG,
	PixiCursorOverlay,
	preloadCursorAssets,
} from "@/components/video-editor/videoPlayback/cursorRenderer";
import { findDominantRegion } from "@/components/video-editor/videoPlayback/zoomRegionUtils";
import {
	applyZoomTransform,
	computeFocusFromTransform,
	computeZoomTransform,
	createMotionBlurState,
	type MotionBlurState,
} from "@/components/video-editor/videoPlayback/zoomTransform";
import { getAssetPath, getRenderableAssetUrl } from "@/lib/assetPath";
import { buildAnnotationDisplayObjects } from "./annotationRenderer";
import {
	createExportCanvas,
	type ExportCanvas,
	type ExportCanvasFactory,
	loadTextureSource,
	setCanvasColorSpace,
} from "./renderingEnvironment";

interface FrameRenderConfig {
	width: number;
	height: number;
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	backgroundBlur: number;
	zoomMotionBlur?: number;
	connectZooms?: boolean;
	borderRadius?: number;
	padding?: number;
	cropRegion: CropRegion;
	videoWidth: number;
	videoHeight: number;
	annotationRegions?: AnnotationRegion[];
	speedRegions?: SpeedRegion[];
	previewWidth?: number;
	previewHeight?: number;
	cursorTelemetry?: CursorTelemetryPoint[];
	showCursor?: boolean;
	cursorSize?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	canvasFactory?: ExportCanvasFactory;
	preferOffscreenCanvas?: boolean;
}

interface AnimationState {
	scale: number;
	appliedScale: number;
	focusX: number;
	focusY: number;
	progress: number;
	x: number;
	y: number;
}

function createAnimationState(): AnimationState {
	return {
		scale: 1,
		appliedScale: 1,
		focusX: DEFAULT_FOCUS.cx,
		focusY: DEFAULT_FOCUS.cy,
		progress: 0,
		x: 0,
		y: 0,
	};
}

interface LayoutCache {
	stageSize: {
		width: number;
		height: number;
	};
	videoSize: {
		width: number;
		height: number;
	};
	baseScale: number;
	baseOffset: {
		x: number;
		y: number;
	};
	maskRect: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
}

type GradientPoint = {
	x: number;
	y: number;
};

type ParsedGradientStop = {
	offset: number;
	color: string;
};

function clampUnit(value: number) {
	return Math.max(0, Math.min(1, value));
}

function splitGradientParams(params: string) {
	const parts: string[] = [];
	let depth = 0;
	let current = "";

	for (const char of params) {
		if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth = Math.max(0, depth - 1);
		}

		if (char === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
			continue;
		}

		current += char;
	}

	if (current.trim()) {
		parts.push(current.trim());
	}

	return parts;
}

function parseGradientStop(
	part: string,
	index: number,
	totalParts: number,
): ParsedGradientStop | null {
	const colorMatch = part.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-z]+)/i);
	if (!colorMatch) {
		return null;
	}

	const percentMatch = part.match(/(-?\d+(?:\.\d+)?)%/);
	const offset =
		percentMatch && Number.isFinite(Number(percentMatch[1]))
			? clampUnit(Number(percentMatch[1]) / 100)
			: totalParts > 1
				? index / (totalParts - 1)
				: 0;

	return {
		offset,
		color: colorMatch[1],
	};
}

function parseLinearGradientDirection(direction: string | undefined): {
	start: GradientPoint;
	end: GradientPoint;
} {
	if (!direction) {
		return {
			start: { x: 0, y: 0 },
			end: { x: 0, y: 1 },
		};
	}

	if (direction.startsWith("to ")) {
		const tokens = direction
			.replace(/^to\s+/, "")
			.split(/\s+/)
			.filter(Boolean);
		const horizontal = tokens.includes("left") ? -1 : tokens.includes("right") ? 1 : 0;
		const vertical = tokens.includes("top") ? -1 : tokens.includes("bottom") ? 1 : 0;

		return {
			start: {
				x: clampUnit(0.5 - horizontal / 2),
				y: clampUnit(0.5 - vertical / 2),
			},
			end: {
				x: clampUnit(0.5 + horizontal / 2),
				y: clampUnit(0.5 + vertical / 2),
			},
		};
	}

	if (direction.includes("deg")) {
		const degrees = Number.parseFloat(direction);
		if (Number.isFinite(degrees)) {
			const radians = (degrees * Math.PI) / 180;
			const dx = Math.sin(radians);
			const dy = -Math.cos(radians);

			return {
				start: {
					x: clampUnit(0.5 - dx / 2),
					y: clampUnit(0.5 - dy / 2),
				},
				end: {
					x: clampUnit(0.5 + dx / 2),
					y: clampUnit(0.5 + dy / 2),
				},
			};
		}
	}

	return {
		start: { x: 0, y: 0 },
		end: { x: 0, y: 1 },
	};
}

function parseCssGradient(wallpaper: string): FillGradient | null {
	const gradientMatch = wallpaper.match(/(linear|radial)-gradient\((.+)\)/i);
	if (!gradientMatch) {
		return null;
	}

	const [, type, params] = gradientMatch;
	const parts = splitGradientParams(params);
	if (parts.length === 0) {
		return null;
	}

	const firstPartLooksLikeDirection =
		type === "linear"
			? parts[0]?.startsWith("to ") || parts[0]?.includes("deg")
			: parts[0]?.startsWith("circle") ||
				parts[0]?.startsWith("ellipse") ||
				parts[0]?.startsWith("at ");
	const colorParts = firstPartLooksLikeDirection ? parts.slice(1) : parts;
	const colorStops = colorParts
		.map((part, index) => parseGradientStop(part, index, colorParts.length))
		.filter((stop): stop is ParsedGradientStop => stop !== null);

	if (colorStops.length === 0) {
		return null;
	}

	if (type === "linear") {
		const { start, end } = parseLinearGradientDirection(
			firstPartLooksLikeDirection ? parts[0] : undefined,
		);

		return new FillGradient({
			type: "linear",
			start,
			end,
			colorStops,
			textureSpace: "local",
		});
	}

	return new FillGradient({
		type: "radial",
		center: { x: 0.5, y: 0.5 },
		innerRadius: 0,
		outerCenter: { x: 0.5, y: 0.5 },
		outerRadius: 0.75,
		colorStops,
		textureSpace: "local",
	});
}

// Renders video frames with all effects (background, zoom, crop, blur, shadow) to an offscreen canvas for export.

export class FrameRenderer {
	private app: Application | null = null;
	private canvas: ExportCanvas | null = null;
	private backgroundContainer: Container | null = null;
	private cameraContainer: Container | null = null;
	private videoContainer: Container | null = null;
	private cursorContainer: Container | null = null;
	private annotationContainer: Container | null = null;
	private videoSprite: Sprite | null = null;
	private backgroundSprite: Sprite | null = null;
	private maskGraphics: Graphics | null = null;
	private backgroundBlurFilter: BlurFilter | null = null;
	private backgroundGradient: FillGradient | null = null;
	private videoShadowFilter: DropShadowFilter | null = null;
	private blurFilter: BlurFilter | null = null;
	private motionBlurFilter: MotionBlurFilter | null = null;
	private config: FrameRenderConfig;
	private animationState: AnimationState;
	private motionBlurState: MotionBlurState;
	private layoutCache: LayoutCache | null = null;
	private currentVideoTime = 0;
	private lastMotionVector = { x: 0, y: 0 };
	private cursorOverlay: PixiCursorOverlay | null = null;
	private annotationSignature = "";

	constructor(config: FrameRenderConfig) {
		this.config = config;
		this.animationState = createAnimationState();
		this.motionBlurState = createMotionBlurState();
	}

	async initialize(): Promise<void> {
		let cursorOverlayEnabled = true;
		try {
			await preloadCursorAssets();
		} catch (error) {
			cursorOverlayEnabled = false;
			console.warn(
				"[FrameRenderer] Native cursor assets are unavailable; continuing export without cursor overlay.",
				error,
			);
		}

		const canvasFactory = this.config.canvasFactory ?? createExportCanvas;
		const canvas = canvasFactory({
			width: this.config.width,
			height: this.config.height,
			preferOffscreen:
				this.config.preferOffscreenCanvas ??
				(typeof document === "undefined" && typeof OffscreenCanvas !== "undefined"),
		});
		this.canvas = canvas;

		// Try to set colorSpace if supported (may not be available on all platforms)
		setCanvasColorSpace(canvas, "srgb");

		// Initialize PixiJS with optimized settings for export performance
		this.app = new Application();
		await this.app.init({
			canvas,
			width: this.config.width,
			height: this.config.height,
			backgroundAlpha: 0,
			antialias: true,
			resolution: 1,
			autoDensity: true,
		});

		// Setup containers
		this.backgroundContainer = new Container();
		this.cameraContainer = new Container();
		this.videoContainer = new Container();
		this.cursorContainer = new Container();
		this.annotationContainer = new Container();
		this.annotationContainer.sortableChildren = true;
		this.app.stage.addChild(this.backgroundContainer);
		this.app.stage.addChild(this.cameraContainer);
		this.app.stage.addChild(this.annotationContainer);
		this.cameraContainer.addChild(this.videoContainer);
		this.cameraContainer.addChild(this.cursorContainer);

		if (cursorOverlayEnabled) {
			this.cursorOverlay = new PixiCursorOverlay({
				dotRadius: DEFAULT_CURSOR_CONFIG.dotRadius * (this.config.cursorSize ?? 1.4),
				smoothingFactor: this.config.cursorSmoothing ?? DEFAULT_CURSOR_CONFIG.smoothingFactor,
				motionBlur: this.config.cursorMotionBlur ?? 0,
				clickBounce: this.config.cursorClickBounce ?? DEFAULT_CURSOR_CONFIG.clickBounce,
			});
		}

		// Setup background directly in Pixi so export no longer composites it in 2D.
		await this.setupBackground();
		this.backgroundBlurFilter = new BlurFilter();
		this.backgroundBlurFilter.quality = 4;
		this.backgroundBlurFilter.resolution = this.app.renderer.resolution;
		this.backgroundBlurFilter.blur =
			this.config.backgroundBlur > 0 ? this.config.backgroundBlur * 3 : 0;
		this.backgroundContainer.filters =
			this.backgroundBlurFilter.blur > 0 ? [this.backgroundBlurFilter] : [];

		// Setup filters for the video layer directly on the GPU.
		this.videoShadowFilter = new DropShadowFilter({
			alpha: 0.7 * this.config.shadowIntensity,
			blur: Math.max(0, 32 * this.config.shadowIntensity),
			color: 0x000000,
			offset: { x: 0, y: 12 * this.config.shadowIntensity },
			quality: 4,
		});
		this.blurFilter = new BlurFilter();
		this.blurFilter.quality = 5;
		this.blurFilter.resolution = this.app.renderer.resolution;
		this.blurFilter.blur = 0;
		this.motionBlurFilter = new MotionBlurFilter([0, 0], 5, 0);
		this.videoContainer.filters = [
			...(this.config.showShadow && this.config.shadowIntensity > 0
				? [this.videoShadowFilter]
				: []),
			this.blurFilter,
			this.motionBlurFilter,
		];

		// Setup mask
		this.maskGraphics = new Graphics();
		this.videoContainer.addChild(this.maskGraphics);
		this.videoContainer.mask = this.maskGraphics;
		if (this.cursorOverlay) {
			this.cursorContainer.addChild(this.cursorOverlay.container);
		}
	}

	private async setupBackground(): Promise<void> {
		const wallpaper = await this.resolveWallpaperForExport(this.config.wallpaper);
		this.backgroundGradient?.destroy();
		this.backgroundGradient = null;
		const previousBackgroundSprite = this.backgroundSprite;
		this.backgroundSprite = null;
		this.backgroundContainer?.removeChildren().forEach((child) => {
			if (child === previousBackgroundSprite && previousBackgroundSprite instanceof Sprite) {
				const texture = previousBackgroundSprite.texture;
				previousBackgroundSprite.destroy({ children: true, texture: false, textureSource: false });
				if (texture !== Texture.EMPTY) {
					texture.destroy(true);
				}
				return;
			}

			child.destroy({ children: true, texture: false, textureSource: false });
		});

		try {
			if (
				wallpaper.startsWith("file://") ||
				wallpaper.startsWith("data:") ||
				wallpaper.startsWith("/") ||
				wallpaper.startsWith("http")
			) {
				const imageUrl = await this.resolveWallpaperImageUrl(wallpaper);
				const imageSource = await loadTextureSource(imageUrl);
				const texture = Texture.from(imageSource);
				const sprite = new Sprite(texture);
				const sourceWidth = texture.width || 1;
				const sourceHeight = texture.height || 1;
				const imageAspect = sourceWidth / sourceHeight;
				const canvasAspect = this.config.width / this.config.height;

				if (imageAspect > canvasAspect) {
					sprite.height = this.config.height;
					sprite.width = sprite.height * imageAspect;
					sprite.x = (this.config.width - sprite.width) / 2;
					sprite.y = 0;
				} else {
					sprite.width = this.config.width;
					sprite.height = sprite.width / imageAspect;
					sprite.x = 0;
					sprite.y = (this.config.height - sprite.height) / 2;
				}

				this.backgroundSprite = sprite;
				this.backgroundContainer?.addChild(sprite);
			} else if (wallpaper.startsWith("#")) {
				const background = new Graphics();
				background.rect(0, 0, this.config.width, this.config.height).fill(wallpaper);
				this.backgroundContainer?.addChild(background);
			} else if (
				wallpaper.startsWith("linear-gradient") ||
				wallpaper.startsWith("radial-gradient")
			) {
				const gradient = parseCssGradient(wallpaper);
				if (!gradient) {
					console.warn("[FrameRenderer] Could not parse gradient, using black fallback");
					const fallback = new Graphics();
					fallback.rect(0, 0, this.config.width, this.config.height).fill("#000000");
					this.backgroundContainer?.addChild(fallback);
				} else {
					const background = new Graphics();
					background.rect(0, 0, this.config.width, this.config.height).fill(gradient);
					this.backgroundGradient = gradient;
					this.backgroundContainer?.addChild(background);
				}
			} else {
				const fallback = new Graphics();
				fallback.rect(0, 0, this.config.width, this.config.height).fill(wallpaper);
				this.backgroundContainer?.addChild(fallback);
			}
		} catch (error) {
			console.error("[FrameRenderer] Error setting up background, using fallback:", error);
			const fallback = new Graphics();
			fallback.rect(0, 0, this.config.width, this.config.height).fill("#000000");
			this.backgroundContainer?.addChild(fallback);
		}
	}

	private async resolveWallpaperImageUrl(wallpaper: string): Promise<string> {
		if (
			wallpaper.startsWith("file://") ||
			wallpaper.startsWith("data:") ||
			wallpaper.startsWith("http")
		) {
			return wallpaper;
		}

		const resolved = await getAssetPath(wallpaper.replace(/^\/+/, ""));
		if (
			resolved.startsWith("/") &&
			typeof window !== "undefined" &&
			window.location.protocol.startsWith("http")
		) {
			return `${window.location.origin}${resolved}`;
		}

		return resolved;
	}

	private async resolveWallpaperForExport(wallpaper: string): Promise<string> {
		if (!wallpaper) {
			return wallpaper;
		}

		if (
			wallpaper.startsWith("#") ||
			wallpaper.startsWith("linear-gradient") ||
			wallpaper.startsWith("radial-gradient")
		) {
			return wallpaper;
		}

		const looksLikeAbsoluteFilePath =
			wallpaper.startsWith("/") &&
			!wallpaper.startsWith("//") &&
			!wallpaper.startsWith("/wallpapers/") &&
			!wallpaper.startsWith("/app-icons/");

		const wallpaperAsset = looksLikeAbsoluteFilePath ? `file://${encodeURI(wallpaper)}` : wallpaper;

		return getRenderableAssetUrl(wallpaperAsset);
	}

	async renderFrame(videoFrame: VideoFrame, timestamp: number): Promise<void> {
		if (!this.app || !this.videoContainer || !this.cameraContainer || !this.annotationContainer) {
			throw new Error("Renderer not initialized");
		}

		this.currentVideoTime = timestamp / 1000000;

		// Create or update video sprite from VideoFrame
		if (!this.videoSprite) {
			const texture = Texture.from(videoFrame as unknown as ImageBitmap);
			this.videoSprite = new Sprite(texture);
			this.videoContainer.addChild(this.videoSprite);
			if (this.cursorOverlay && this.cursorContainer) {
				this.cursorContainer.addChild(this.cursorOverlay.container);
			}
			if (this.maskGraphics) {
				this.videoContainer.addChild(this.maskGraphics);
			}
		} else {
			// Destroy old texture to avoid memory leaks, then create new one
			const oldTexture = this.videoSprite.texture;
			const newTexture = Texture.from(videoFrame as unknown as ImageBitmap);
			this.videoSprite.texture = newTexture;
			oldTexture.destroy(true);
		}

		// Apply layout
		this.updateLayout();
		if (!this.layoutCache) {
			throw new Error("Frame layout cache was not initialized");
		}

		const timeMs = this.currentVideoTime * 1000;

		if (this.cursorOverlay) {
			this.cursorOverlay.update(
				this.config.cursorTelemetry ?? [],
				timeMs,
				this.layoutCache.maskRect,
				this.config.showCursor ?? true,
				false,
			);
		}

		const TICKS_PER_FRAME = 1;

		let maxMotionIntensity = 0;
		for (let i = 0; i < TICKS_PER_FRAME; i++) {
			const motionIntensity = this.updateAnimationState(timeMs);
			maxMotionIntensity = Math.max(maxMotionIntensity, motionIntensity);
		}

		// Apply transform once with maximum motion intensity from all ticks
		applyZoomTransform({
			cameraContainer: this.cameraContainer,
			blurFilter: this.blurFilter,
			motionBlurFilter: this.motionBlurFilter,
			stageSize: this.layoutCache.stageSize,
			baseMask: this.layoutCache.maskRect,
			zoomScale: this.animationState.scale,
			zoomProgress: this.animationState.progress,
			focusX: this.animationState.focusX,
			focusY: this.animationState.focusY,
			motionIntensity: maxMotionIntensity,
			motionVector: this.lastMotionVector,
			isPlaying: true,
			motionBlurAmount: this.config.zoomMotionBlur ?? 0,
			transformOverride: {
				scale: this.animationState.appliedScale,
				x: this.animationState.x,
				y: this.animationState.y,
			},
			motionBlurState: this.motionBlurState,
			frameTimeMs: timeMs,
		});

		await this.updateAnnotations(timeMs);

		// Render the full export scene in Pixi.
		this.app.renderer.render(this.app.stage);
	}

	private async updateAnnotations(timeMs: number): Promise<void> {
		if (!this.annotationContainer || !this.config.annotationRegions?.length) {
			this.annotationSignature = "";
			this.annotationContainer?.removeChildren().forEach((child) => {
				child.destroy({ children: true, texture: false, textureSource: false });
			});
			return;
		}
		const annotationContainer = this.annotationContainer;

		const previewWidth = this.config.previewWidth || 1920;
		const previewHeight = this.config.previewHeight || 1080;
		const scaleX = this.config.width / previewWidth;
		const scaleY = this.config.height / previewHeight;
		const scaleFactor = (scaleX + scaleY) / 2;
		const activeAnnotations = this.config.annotationRegions
			.filter((annotation) => timeMs >= annotation.startMs && timeMs <= annotation.endMs)
			.sort((left, right) => left.zIndex - right.zIndex);
		const signature = `${scaleFactor}:${activeAnnotations.map((annotation) => annotation.id).join("|")}`;

		if (signature === this.annotationSignature) {
			return;
		}

		this.annotationSignature = signature;
		annotationContainer.removeChildren().forEach((child) => {
			child.destroy({ children: true, texture: false, textureSource: false });
		});

		const displayObjects = await buildAnnotationDisplayObjects(
			this.config.annotationRegions,
			this.config.width,
			this.config.height,
			timeMs,
			scaleFactor,
		);

		for (const displayObject of displayObjects) {
			annotationContainer.addChild(displayObject);
		}
	}

	private updateLayout(): void {
		if (!this.app || !this.videoSprite || !this.maskGraphics || !this.videoContainer) return;

		const { width, height } = this.config;
		const { cropRegion, borderRadius = 0, padding = 0 } = this.config;
		const videoWidth = this.config.videoWidth;
		const videoHeight = this.config.videoHeight;

		// Calculate cropped video dimensions
		const cropStartX = cropRegion.x;
		const cropStartY = cropRegion.y;
		const cropEndX = cropRegion.x + cropRegion.width;
		const cropEndY = cropRegion.y + cropRegion.height;

		const croppedVideoWidth = videoWidth * (cropEndX - cropStartX);
		const croppedVideoHeight = videoHeight * (cropEndY - cropStartY);

		// Calculate scale to fit in viewport
		// Padding is a percentage (0-100), where 50% ~ 0.8 scale
		const paddingScale = 1.0 - (padding / 100) * 0.4;
		const viewportWidth = width * paddingScale;
		const viewportHeight = height * paddingScale;
		const scale = Math.min(viewportWidth / croppedVideoWidth, viewportHeight / croppedVideoHeight);

		this.videoSprite.scale.set(scale);

		const fullVideoDisplayWidth = videoWidth * scale;
		const fullVideoDisplayHeight = videoHeight * scale;
		const croppedDisplayWidth = croppedVideoWidth * scale;
		const croppedDisplayHeight = croppedVideoHeight * scale;
		const centerOffsetX = (width - croppedDisplayWidth) / 2;
		const centerOffsetY = (height - croppedDisplayHeight) / 2;

		const spriteX = centerOffsetX - cropRegion.x * fullVideoDisplayWidth;
		const spriteY = centerOffsetY - cropRegion.y * fullVideoDisplayHeight;
		this.videoSprite.position.set(spriteX, spriteY);

		this.videoContainer.position.set(0, 0);

		// scale border radius by export/preview canvas ratio
		const previewWidth = this.config.previewWidth || 1920;
		const previewHeight = this.config.previewHeight || 1080;
		const canvasScaleFactor = Math.min(width / previewWidth, height / previewHeight);
		const scaledBorderRadius = borderRadius * canvasScaleFactor;

		this.maskGraphics.clear();
		this.maskGraphics.roundRect(
			centerOffsetX,
			centerOffsetY,
			croppedDisplayWidth,
			croppedDisplayHeight,
			scaledBorderRadius,
		);
		this.maskGraphics.fill({ color: 0xffffff });

		// Cache layout info
		this.layoutCache = {
			stageSize: { width, height },
			videoSize: { width: croppedVideoWidth, height: croppedVideoHeight },
			baseScale: scale,
			baseOffset: { x: spriteX, y: spriteY },
			maskRect: {
				x: centerOffsetX,
				y: centerOffsetY,
				width: croppedDisplayWidth,
				height: croppedDisplayHeight,
			},
		};
	}

	private updateAnimationState(timeMs: number): number {
		if (!this.cameraContainer || !this.layoutCache) return 0;

		const { region, strength, blendedScale, transition } = findDominantRegion(
			this.config.zoomRegions,
			timeMs,
			{
				connectZooms: this.config.connectZooms,
			},
		);

		const defaultFocus = DEFAULT_FOCUS;
		let targetScaleFactor = 1;
		let targetFocus = { ...defaultFocus };
		let targetProgress = 0;

		if (region && strength > 0) {
			const zoomScale = blendedScale ?? ZOOM_DEPTH_SCALES[region.depth];
			const regionFocus = region.focus;

			targetScaleFactor = zoomScale;
			targetFocus = regionFocus;
			targetProgress = strength;

			if (transition) {
				const startTransform = computeZoomTransform({
					stageSize: this.layoutCache.stageSize,
					baseMask: this.layoutCache.maskRect,
					zoomScale: transition.startScale,
					zoomProgress: 1,
					focusX: transition.startFocus.cx,
					focusY: transition.startFocus.cy,
				});
				const endTransform = computeZoomTransform({
					stageSize: this.layoutCache.stageSize,
					baseMask: this.layoutCache.maskRect,
					zoomScale: transition.endScale,
					zoomProgress: 1,
					focusX: transition.endFocus.cx,
					focusY: transition.endFocus.cy,
				});

				const interpolatedTransform = {
					scale:
						startTransform.scale +
						(endTransform.scale - startTransform.scale) * transition.progress,
					x: startTransform.x + (endTransform.x - startTransform.x) * transition.progress,
					y: startTransform.y + (endTransform.y - startTransform.y) * transition.progress,
				};

				targetScaleFactor = interpolatedTransform.scale;
				targetFocus = computeFocusFromTransform({
					stageSize: this.layoutCache.stageSize,
					baseMask: this.layoutCache.maskRect,
					zoomScale: interpolatedTransform.scale,
					x: interpolatedTransform.x,
					y: interpolatedTransform.y,
				});
				targetProgress = 1;
			}
		}

		const state = this.animationState;

		const prevScale = state.appliedScale;
		const prevX = state.x;
		const prevY = state.y;

		state.scale = targetScaleFactor;
		state.focusX = targetFocus.cx;
		state.focusY = targetFocus.cy;
		state.progress = targetProgress;

		const projectedTransform = computeZoomTransform({
			stageSize: this.layoutCache.stageSize,
			baseMask: this.layoutCache.maskRect,
			zoomScale: state.scale,
			zoomProgress: state.progress,
			focusX: state.focusX,
			focusY: state.focusY,
		});

		state.appliedScale =
			Math.abs(projectedTransform.scale - prevScale) < ZOOM_SCALE_DEADZONE
				? projectedTransform.scale
				: projectedTransform.scale;
		state.x =
			Math.abs(projectedTransform.x - prevX) < ZOOM_TRANSLATION_DEADZONE_PX
				? projectedTransform.x
				: projectedTransform.x;
		state.y =
			Math.abs(projectedTransform.y - prevY) < ZOOM_TRANSLATION_DEADZONE_PX
				? projectedTransform.y
				: projectedTransform.y;

		this.lastMotionVector = {
			x: state.x - prevX,
			y: state.y - prevY,
		};

		return Math.max(
			Math.abs(state.appliedScale - prevScale),
			Math.abs(state.x - prevX) / Math.max(1, this.layoutCache.stageSize.width),
			Math.abs(state.y - prevY) / Math.max(1, this.layoutCache.stageSize.height),
		);
	}

	getCanvas(): ExportCanvas {
		if (!this.canvas) {
			throw new Error("Renderer not initialized");
		}
		return this.canvas;
	}

	readCompositeRgbaFrame(): Uint8Array {
		if (!this.app) {
			throw new Error("Renderer not initialized");
		}

		const { pixels } = this.app.renderer.extract.pixels(this.app.stage);
		return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	}

	destroy(): void {
		const backgroundTexture = this.backgroundSprite?.texture ?? null;
		if (this.videoSprite) {
			const videoTexture = this.videoSprite.texture;
			this.videoSprite.destroy({ texture: false, textureSource: false });
			videoTexture?.destroy(true);
			this.videoSprite = null;
		}
		this.backgroundSprite = null;
		this.backgroundGradient?.destroy();
		this.backgroundGradient = null;
		if (this.app) {
			this.app.destroy(true, { children: true, texture: false, textureSource: false });
			this.app = null;
		}
		if (backgroundTexture && backgroundTexture !== Texture.EMPTY) {
			backgroundTexture.destroy(true);
		}
		this.canvas = null;
		this.backgroundContainer = null;
		this.cameraContainer = null;
		this.videoContainer = null;
		this.cursorContainer = null;
		this.annotationContainer = null;
		this.maskGraphics = null;
		this.backgroundBlurFilter = null;
		this.videoShadowFilter = null;
		this.blurFilter = null;
		this.motionBlurFilter = null;
		if (this.cursorOverlay) {
			this.cursorOverlay.destroy();
			this.cursorOverlay = null;
		}
	}
}
