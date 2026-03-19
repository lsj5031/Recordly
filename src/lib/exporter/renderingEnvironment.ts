export type ExportCanvas = HTMLCanvasElement | OffscreenCanvas;

export type ExportImageSource = HTMLImageElement | ImageBitmap;

export interface ExportCanvasFactoryOptions {
	width: number;
	height: number;
	preferOffscreen?: boolean;
}

export type ExportCanvasFactory = (options: ExportCanvasFactoryOptions) => ExportCanvas;

function canUseDomCanvas() {
	return typeof document !== "undefined" && typeof document.createElement === "function";
}

function canUseDomImage() {
	return typeof Image !== "undefined";
}

export function createExportCanvas({
	width,
	height,
	preferOffscreen = false,
}: ExportCanvasFactoryOptions): ExportCanvas {
	if (preferOffscreen && typeof OffscreenCanvas !== "undefined") {
		return new OffscreenCanvas(width, height);
	}

	if (canUseDomCanvas()) {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}

	if (typeof OffscreenCanvas !== "undefined") {
		return new OffscreenCanvas(width, height);
	}

	throw new Error("No canvas implementation is available for export rendering");
}

export function setCanvasColorSpace(canvas: ExportCanvas, colorSpace: string) {
	try {
		const colorManagedCanvas = canvas as ExportCanvas & { colorSpace?: string };
		if ("colorSpace" in colorManagedCanvas) {
			colorManagedCanvas.colorSpace = colorSpace;
		}
	} catch (error) {
		console.warn("[RenderingEnvironment] colorSpace not supported on this canvas:", error);
	}
}

async function loadImageBitmapSource(url: string): Promise<ImageBitmap> {
	if (typeof fetch !== "function" || typeof createImageBitmap !== "function") {
		throw new Error("ImageBitmap loading is unavailable in this environment");
	}

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch image resource: ${response.status} ${response.statusText}`);
	}

	const blob = await response.blob();
	return createImageBitmap(blob);
}

async function loadHtmlImageSource(url: string): Promise<HTMLImageElement> {
	if (!canUseDomImage()) {
		throw new Error("HTML image loading is unavailable in this environment");
	}

	return new Promise((resolve, reject) => {
		const image = new Image();
		if (
			url.startsWith("http") &&
			typeof window !== "undefined" &&
			window.location.origin &&
			!url.startsWith(window.location.origin)
		) {
			image.crossOrigin = "anonymous";
		}

		image.onload = () => resolve(image);
		image.onerror = (event) => reject(new Error(`Failed to load image: ${url} (${String(event)})`));
		image.src = url;
	});
}

export async function loadTextureSource(url: string): Promise<ExportImageSource> {
	try {
		return await loadImageBitmapSource(url);
	} catch (error) {
		if (!canUseDomImage()) {
			throw error;
		}

		console.warn(
			"[RenderingEnvironment] Falling back to HTMLImageElement loading for export asset:",
			error,
		);
		return loadHtmlImageSource(url);
	}
}
