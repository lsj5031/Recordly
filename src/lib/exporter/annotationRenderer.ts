import { CanvasTextMetrics, Container, Graphics, Sprite, Text, TextStyle, Texture } from "pixi.js";
import { DropShadowFilter } from "pixi-filters/drop-shadow";
import type { AnnotationRegion, ArrowDirection } from "@/components/video-editor/types";
import { loadTextureSource } from "./renderingEnvironment";

const ARROW_PATHS: Record<ArrowDirection, string[]> = {
	up: ["M 50 20 L 50 80", "M 50 20 L 35 35", "M 50 20 L 65 35"],
	down: ["M 50 20 L 50 80", "M 50 80 L 35 65", "M 50 80 L 65 65"],
	left: ["M 80 50 L 20 50", "M 20 50 L 35 35", "M 20 50 L 35 65"],
	right: ["M 20 50 L 80 50", "M 80 50 L 65 35", "M 80 50 L 65 65"],
	"up-right": ["M 25 75 L 75 25", "M 75 25 L 60 30", "M 75 25 L 70 40"],
	"up-left": ["M 75 75 L 25 25", "M 25 25 L 40 30", "M 25 25 L 30 40"],
	"down-right": ["M 25 25 L 75 75", "M 75 75 L 70 60", "M 75 75 L 60 70"],
	"down-left": ["M 75 25 L 25 75", "M 25 75 L 30 60", "M 25 75 L 40 70"],
};

const imageTextureCache = new Map<string, Promise<Texture>>();

function parseSvgPath(pathString: string, scaleX: number, scaleY: number) {
	const commands: Array<{ cmd: string; args: number[] }> = [];
	const parts = pathString.trim().split(/\s+/);

	let index = 0;
	while (index < parts.length) {
		const cmd = parts[index];
		if (cmd === "M" || cmd === "L") {
			const x = Number.parseFloat(parts[index + 1]) * scaleX;
			const y = Number.parseFloat(parts[index + 2]) * scaleY;
			commands.push({ cmd, args: [x, y] });
			index += 3;
		} else {
			index += 1;
		}
	}

	return commands;
}

function getAnnotationFrame(
	annotation: AnnotationRegion,
	canvasWidth: number,
	canvasHeight: number,
) {
	return {
		x: (annotation.position.x / 100) * canvasWidth,
		y: (annotation.position.y / 100) * canvasHeight,
		width: (annotation.size.width / 100) * canvasWidth,
		height: (annotation.size.height / 100) * canvasHeight,
	};
}

async function getImageTexture(content: string): Promise<Texture | null> {
	if (!content || !content.startsWith("data:image")) {
		return null;
	}

	let cachedTexture = imageTextureCache.get(content);
	if (!cachedTexture) {
		cachedTexture = loadTextureSource(content).then((source) => Texture.from(source));
		imageTextureCache.set(content, cachedTexture);
	}

	try {
		return await cachedTexture;
	} catch (error) {
		console.error("[AnnotationRenderer] Failed to load image annotation:", error);
		imageTextureCache.delete(content);
		return null;
	}
}

function createTextContainer(
	annotation: AnnotationRegion,
	canvasWidth: number,
	canvasHeight: number,
	scaleFactor: number,
) {
	const { x, y, width, height } = getAnnotationFrame(annotation, canvasWidth, canvasHeight);
	const content = annotation.textContent ?? annotation.content ?? "";
	const container = new Container();
	container.x = x;
	container.y = y;

	if (!content) {
		return container;
	}

	const fontSize = annotation.style.fontSize * scaleFactor;
	const containerPadding = 8 * scaleFactor;
	const availableWidth = Math.max(1, width - containerPadding * 2);
	const lineHeight = fontSize * 1.4;

	const textStyle = new TextStyle({
		align: annotation.style.textAlign,
		breakWords: true,
		fill: annotation.style.color,
		fontFamily: annotation.style.fontFamily,
		fontSize,
		fontStyle: annotation.style.fontStyle,
		fontWeight: annotation.style.fontWeight,
		lineHeight,
		whiteSpace: "pre-line",
		wordWrap: true,
		wordWrapWidth: availableWidth,
	});

	const metrics = CanvasTextMetrics.measureText(content, textStyle, undefined, true);
	const textBlockHeight = metrics.lines.length * lineHeight;
	const textTop = Math.max(0, (height - textBlockHeight) / 2);
	const lineCenterOffset = lineHeight / 2;

	if (annotation.style.backgroundColor && annotation.style.backgroundColor !== "transparent") {
		const background = new Graphics();
		const verticalPadding = fontSize * 0.1;
		const horizontalPadding = fontSize * 0.2;
		const borderRadius = 4 * scaleFactor;

		for (const [index, line] of metrics.lines.entries()) {
			const lineWidth = metrics.lineWidths[index] ?? metrics.width;
			const lineStartX =
				annotation.style.textAlign === "center"
					? containerPadding + (availableWidth - lineWidth) / 2
					: annotation.style.textAlign === "right"
						? width - containerPadding - lineWidth
						: containerPadding;
			const lineCenterY = textTop + lineCenterOffset + index * lineHeight;
			const backgroundHeight = lineHeight + verticalPadding * 2;
			background
				.roundRect(
					lineStartX - horizontalPadding,
					lineCenterY - backgroundHeight / 2,
					lineWidth + horizontalPadding * 2,
					backgroundHeight,
					borderRadius,
				)
				.fill({ color: annotation.style.backgroundColor });

			if (!line) {
				continue;
			}
		}

		container.addChild(background);
	}

	const text = new Text({
		text: content,
		style: textStyle,
	});
	text.x = containerPadding;
	text.y = textTop;
	container.addChild(text);

	if (annotation.style.textDecoration === "underline") {
		const underline = new Graphics();
		const underlineWidth = Math.max(1, fontSize / 16);

		for (const [index, line] of metrics.lines.entries()) {
			if (!line) {
				continue;
			}

			const lineWidth = metrics.lineWidths[index] ?? metrics.width;
			const lineStartX =
				annotation.style.textAlign === "center"
					? containerPadding + (availableWidth - lineWidth) / 2
					: annotation.style.textAlign === "right"
						? width - containerPadding - lineWidth
						: containerPadding;
			const lineCenterY = textTop + lineCenterOffset + index * lineHeight;
			const underlineY = lineCenterY + fontSize * 0.15;

			underline
				.moveTo(lineStartX, underlineY)
				.lineTo(lineStartX + lineWidth, underlineY)
				.stroke({
					color: annotation.style.color,
					width: underlineWidth,
				});
		}

		container.addChild(underline);
	}

	return container;
}

async function createImageContainer(
	annotation: AnnotationRegion,
	canvasWidth: number,
	canvasHeight: number,
) {
	const { x, y, width, height } = getAnnotationFrame(annotation, canvasWidth, canvasHeight);
	const container = new Container();
	container.x = x;
	container.y = y;

	const texture = await getImageTexture(annotation.imageContent ?? annotation.content ?? "");
	if (!texture) {
		return container;
	}

	const sprite = new Sprite(texture);
	const textureWidth = texture.width || 1;
	const textureHeight = texture.height || 1;
	const imageAspect = textureWidth / textureHeight;
	const boxAspect = width / Math.max(1, height);

	let drawWidth = width;
	let drawHeight = height;
	let drawX = 0;
	let drawY = 0;

	if (imageAspect > boxAspect) {
		drawHeight = width / imageAspect;
		drawY = (height - drawHeight) / 2;
	} else {
		drawWidth = height * imageAspect;
		drawX = (width - drawWidth) / 2;
	}

	sprite.x = drawX;
	sprite.y = drawY;
	sprite.width = drawWidth;
	sprite.height = drawHeight;
	container.addChild(sprite);

	return container;
}

function createFigureContainer(
	annotation: AnnotationRegion,
	canvasWidth: number,
	canvasHeight: number,
	scaleFactor: number,
) {
	const { x, y, width, height } = getAnnotationFrame(annotation, canvasWidth, canvasHeight);
	const container = new Container();
	container.x = x;
	container.y = y;

	if (!annotation.figureData) {
		return container;
	}

	const graphics = new Graphics();
	const padding = 8 * scaleFactor;
	const availableWidth = Math.max(0, width - padding * 2);
	const availableHeight = Math.max(0, height - padding * 2);
	const scale = Math.min(availableWidth / 100, availableHeight / 100);
	const offsetX = padding + (availableWidth - 100 * scale) / 2;
	const offsetY = padding + (availableHeight - 100 * scale) / 2;

	for (const pathString of ARROW_PATHS[annotation.figureData.arrowDirection]) {
		const commands = parseSvgPath(pathString, scale, scale);

		for (const { cmd, args } of commands) {
			if (cmd === "M") {
				graphics.moveTo(offsetX + args[0], offsetY + args[1]);
			} else if (cmd === "L") {
				graphics.lineTo(offsetX + args[0], offsetY + args[1]);
			}
		}
	}

	graphics.stroke({
		cap: "round",
		color: annotation.figureData.color,
		join: "round",
		width: annotation.figureData.strokeWidth * scale,
	});
	graphics.filters = [
		new DropShadowFilter({
			alpha: 0.3,
			blur: Math.max(2, 8 * scale),
			color: 0x000000,
			offset: { x: 0, y: Math.max(1, 4 * scale) },
			quality: 3,
		}),
	];

	container.addChild(graphics);
	return container;
}

export async function buildAnnotationDisplayObjects(
	annotations: AnnotationRegion[],
	canvasWidth: number,
	canvasHeight: number,
	currentTimeMs: number,
	scaleFactor = 1,
) {
	const activeAnnotations = annotations
		.filter(
			(annotation) => currentTimeMs >= annotation.startMs && currentTimeMs <= annotation.endMs,
		)
		.sort((left, right) => left.zIndex - right.zIndex);

	const displayObjects: Container[] = [];

	for (const annotation of activeAnnotations) {
		let displayObject: Container;

		switch (annotation.type) {
			case "text":
				displayObject = createTextContainer(annotation, canvasWidth, canvasHeight, scaleFactor);
				break;
			case "image":
				displayObject = await createImageContainer(annotation, canvasWidth, canvasHeight);
				break;
			case "figure":
				displayObject = createFigureContainer(annotation, canvasWidth, canvasHeight, scaleFactor);
				break;
			default:
				displayObject = new Container();
				break;
		}

		displayObject.zIndex = annotation.zIndex;
		displayObjects.push(displayObject);
	}

	return displayObjects;
}
