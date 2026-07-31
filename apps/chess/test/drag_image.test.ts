import { expect, test } from "bun:test";
import { setPieceDragImage } from "../src/drag_image.ts";

test("Chess uses only the transparent piece SVG as its native drag image", () => {
  const piece = {
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 80,
      height: 80,
    }),
  } as SVGSVGElement;
  const source = {
    querySelector: (selector: string) =>
      selector === ".chess-piece" ? piece : null,
  } as unknown as ParentNode;
  const calls: Array<{ image: Element; x: number; y: number }> = [];
  const transfer = {
    setDragImage(image: Element, x: number, y: number) {
      calls.push({ image, x, y });
    },
  };

  expect(setPieceDragImage(transfer, source, 42, 71)).toBe(true);
  expect(calls).toEqual([{ image: piece, x: 32, y: 51 }]);
});

test("Chess drag-image offsets stay inside the piece bounds", () => {
  const piece = {
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 80,
      height: 80,
    }),
  } as SVGSVGElement;
  const source = {
    querySelector: () => piece,
  } as unknown as ParentNode;
  const offsets: number[][] = [];
  const transfer = {
    setDragImage(_image: Element, x: number, y: number) {
      offsets.push([x, y]);
    },
  };

  setPieceDragImage(transfer, source, -20, 140);
  expect(offsets).toEqual([[0, 80]]);
});

test("Chess safely keeps the browser fallback when no piece image exists", () => {
  const source = { querySelector: () => null } as unknown as ParentNode;
  let calls = 0;
  const transfer = {
    setDragImage() {
      calls += 1;
    },
  };

  expect(setPieceDragImage(transfer, source, 0, 0)).toBe(false);
  expect(calls).toBe(0);
});
