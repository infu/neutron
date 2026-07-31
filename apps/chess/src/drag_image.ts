export function setPieceDragImage(
  dataTransfer: Pick<DataTransfer, "setDragImage">,
  source: ParentNode,
  clientX: number,
  clientY: number,
): boolean {
  const image = source.querySelector<SVGSVGElement>(".chess-piece");
  if (!image) return false;

  const bounds = image.getBoundingClientRect();
  const offsetX = clamp(clientX - bounds.left, 0, bounds.width);
  const offsetY = clamp(clientY - bounds.top, 0, bounds.height);
  dataTransfer.setDragImage(image, offsetX, offsetY);
  return true;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
