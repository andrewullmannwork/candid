/**
 * ComparePlansVisual — 3-card SVG metric used inside Compare ProductHero.
 *
 * Three small fan-shaped "plan cards" with internal stat lines, suggesting a
 * side-by-side comparison without rendering any specific plan data.
 *
 * Per S112 §1.C.1 design dashboard.jsx:180-194 + styles.css .compare-mini-*.
 */
export function ComparePlansVisual() {
  return (
    <div className="flex gap-1.5" aria-hidden="true">
      {[0, 1, 2].map((i) => {
        const transform =
          i === 0
            ? "rotate(-3deg) translateY(2px)"
            : i === 1
              ? "translateY(-2px)"
              : "rotate(3deg) translateY(2px)";
        const z = i === 1 ? 1 : 0;
        const widths = ["100%", "70%", "85%"];
        return (
          <div
            key={i}
            className="w-[38px] h-[56px] bg-white rounded-md p-[6px_5px] flex flex-col gap-1 shadow-[0_2px_6px_rgba(91,33,182,0.15)]"
            style={{ transform, zIndex: z }}
          >
            {widths.map((w, j) => (
              <span
                key={j}
                className="block h-[3px] rounded-full bg-gradient-to-r from-violet-300 to-transparent"
                style={{ width: w }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
