import { useCallback, useRef, useState } from "react";

/** Generic drag-to-resize handle. */
export function Resizer({
  direction,
  onDelta,
}: {
  direction: "vertical" | "horizontal";
  onDelta: (delta: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      last.current = direction === "vertical" ? e.clientX : e.clientY;

      const onMove = (ev: MouseEvent) => {
        const pos = direction === "vertical" ? ev.clientX : ev.clientY;
        onDelta(pos - last.current);
        last.current = pos;
      };
      const onUp = () => {
        setDragging(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor =
        direction === "vertical" ? "col-resize" : "row-resize";
    },
    [direction, onDelta],
  );

  return (
    <div
      className={`resizer ${direction} ${dragging ? "dragging" : ""}`}
      onMouseDown={onMouseDown}
    />
  );
}
